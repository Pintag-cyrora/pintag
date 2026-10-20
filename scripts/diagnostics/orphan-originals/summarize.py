#!/usr/bin/env python3
"""Validate and summarise the output of 3-reconcile.sql / 4-source-health.sql (READ-ONLY inputs, local files only).

Reads the psql --csv files, checks that the report is internally consistent and reconciles to the stage-2 total, and writes
  reconcile-objects.csv   per-object report, re-written with a fixed column whitelist (this is the downloadable artifact)
  reconcile-summary.md    aggregate counts and sizes per category (this goes in the job summary; no object names)
Exit status 1 when anything does not reconcile: then reconcile-objects.csv is NOT written (only the summary, which says why).
"""
import argparse
import csv
import re
import sys

COLUMNS = [
    "object_name", "size_bytes", "storage_created_at", "name_upload_ts", "ref_listing", "ref_unit", "ref_agent", "ref_registry",
    "gallery_assignment_hits", "gallery_assignment_last_date", "gallery_assignment_record", "gallery_assignment_op", "gallery_assignment_listing",
    "deleted_snapshot_hits", "deleted_snapshot_last_date", "deleted_snapshot_record", "deleted_snapshot_op", "deleted_snapshot_property",
    "import_record_hits", "import_record_last_date", "import_record_record", "import_record_listing",
    "listing_snapshot_hits", "listing_snapshot_last_date", "listing_snapshot_record", "listing_snapshot_listing",
    "import_image_hits", "import_image_last_date", "import_image_record", "import_image_listing",
    "duplicate_of_live_object", "duplicate_candidate_count", "renditions_present", "evidence_count", "matched_sources",
    "category", "explanation",
]
CATEGORIES = [   # (name, flagged, meaning)
    ("history_gallery_assignment_only", False, "named only in gallery-recovery assign/unassign history"),
    ("history_deleted_listing_snapshot_only", False, "was in the gallery of a deleted listing (full-row snapshot) only"),
    ("history_import_record_only", False, "named only in a saved Smart Import raw payload"),
    ("history_listing_snapshot_only", False, "named only in a saved gallery snapshot"),
    ("history_import_image_only", False, "named only in the import-image mapping"),
    ("duplicate_of_live_image_only", False, "same eTag and size as a live-referenced object (candidate only, not proof)"),
    ("no_evidence_uploaded_before_provenance", False, "no history; uploaded before the first recorded gallery snapshot (INFERRED provenance start; inconclusive)"),
    ("no_evidence_uploaded_after_provenance", False, "no history; uploaded after the first recorded gallery snapshot (INFERRED; probably never saved)"),
    ("multiple_evidence", True, "matches two or more sources: flagged, not forced into one"),
    ("unclassifiable_no_evidence", True, "no history and no usable upload time or provenance start: cannot be classified"),
]
KNOWN = {c[0] for c in CATEGORIES}
SOURCES = ["gallery_assignments.photo_paths", "properties_row_snapshots.row_data->images", "import_records.raw_payload", "listing_image_snapshots", "import_images"]
HITS = ["gallery_assignment_hits", "deleted_snapshot_hits", "import_record_hits", "listing_snapshot_hits", "import_image_hits"]


def human(n):
    n = float(n)
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{int(n)} bytes" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024


def agg(rs):
    """(objects, bytes, objects with unknown size) for a list of report rows."""
    return len(rs), sum(int(r["size_bytes"]) for r in rs if r["size_bytes"] != ""), sum(1 for r in rs if r["size_bytes"] == "")


def cell(t):
    c, b, unk = t
    return f"{c} | {human(b)}" + (f" (+{unk} unknown size)" if unk else "")


SIZE_BUCKETS = [("under 100 KB", 0, 100 * 1024), ("100-500 KB", 100 * 1024, 500 * 1024), ("500 KB-1 MB", 500 * 1024, 1024 * 1024),
                ("1-2 MB", 1024 * 1024, 2 * 1024 * 1024), ("2 MB and over", 2 * 1024 * 1024, None)]


def bucket(size):
    if size == "":
        return "unknown size"
    v = int(size)
    for label, lo, hi in SIZE_BUCKETS:
        if v >= lo and (hi is None or v < hi):
            return label


def breakdowns(rows, totals, cutoff_day, errors):
    """Aggregate-only tables (counts, sizes, distinct-id COUNTS). Never prints a name, path, id, title, contact or payload.
    Every table is checked against the category totals above it; a mismatch is an error, not a quiet inconsistency."""
    out = ["", "### Breakdowns (aggregate only: no object names, paths, record or listing ids)", ""]
    by_cat = {c[0]: [r for r in rows if r["category"] == c[0]] for c in CATEGORIES}

    def check(label, groups, cat_names):
        want = [0, 0, 0]
        for cn in cat_names:
            want = [x + y for x, y in zip(want, totals[cn])]
        got = [sum(g[i] for g in groups) for i in range(3)]
        if got != want:
            errors.append(f"breakdown '{label}' does not add up to its categories: {got} vs {want}")

    # 1. gallery-recovery history
    g = by_cat["history_gallery_assignment_only"]
    out += [f"#### 1. `history_gallery_assignment_only` ({len(g)} objects): by recovery operation and date of the MOST RECENT matching record", "",
            "| Operation | Date | Objects | Size | Distinct latest assignment records | Distinct listings (of those records) |", "|---|---|---:|---:|---:|---:|"]
    groups = {}
    for r in g:
        groups.setdefault((r["gallery_assignment_op"] or "(none)", r["gallery_assignment_last_date"][:10] or "(none)"), []).append(r)
    sizes = []
    for (op, day), rs in sorted(groups.items()):
        t = agg(rs); sizes.append(t)
        recs = {r["gallery_assignment_record"] for r in rs if r["gallery_assignment_record"]}
        lsts = {r["gallery_assignment_listing"] for r in rs if r["gallery_assignment_listing"]}
        out.append(f"| {op} | {day} | {cell(t)} | {len(recs)} | {len(lsts)} |")
    check("gallery by operation/date", sizes, ["history_gallery_assignment_only"])
    all_recs = {r["gallery_assignment_record"] for r in g if r["gallery_assignment_record"]}
    all_lsts = {r["gallery_assignment_listing"] for r in g if r["gallery_assignment_listing"]}
    multi = sum(1 for r in g if int(r["gallery_assignment_hits"] or 0) > 1)
    out += ["", f"Overall: {len(all_recs)} distinct latest assignment records and {len(all_lsts)} distinct listings. {multi} of {len(g)} objects are named more than once "
            "in assignment history (only the most recent record is counted per object, so older records are not included). Dates are in the database session time zone.", ""]

    # 2. multiple evidence
    m = by_cat["multiple_evidence"]
    out += [f"#### 2. `multiple_evidence` ({len(m)} objects, FLAGGED): by combination of evidence sources", "", "| Evidence sources | Objects | Size |", "|---|---:|---:|"]
    groups = {}
    for r in m:
        groups.setdefault(r["matched_sources"], []).append(r)
    sizes = []
    for combo, rs in sorted(groups.items()):
        t = agg(rs); sizes.append(t)
        out.append(f"| `{combo}` | {cell(t)} |")
    check("multiple_evidence by sources", sizes, ["multiple_evidence"])
    out += ["", "`duplicate_candidate` is the eTag+size candidate, not a history source. These objects are not forced into a single category.", ""]

    # 3. duplicate candidates
    d = by_cat["duplicate_of_live_image_only"]
    out += [f"#### 3. `duplicate_of_live_image_only` ({len(d)} objects): CANDIDATES only (same eTag and size as a live-referenced object); not proof of anything", "",
            "| Matching live object | Objects | Size |", "|---|---:|---:|"]
    uniq = [r for r in d if int(r["duplicate_candidate_count"]) == 1]
    amb = [r for r in d if int(r["duplicate_candidate_count"]) > 1]
    tu, ta = agg(uniq), agg(amb)
    out += [f"| unique (exactly one live object matches) | {cell(tu)} |", f"| ambiguous (more than one live object matches) | {cell(ta)} |"]
    check("duplicates by match uniqueness", [tu, ta], ["duplicate_of_live_image_only"])
    live_distinct = len({r["duplicate_of_live_object"] for r in uniq})
    out += ["", f"The {len(uniq)} unique candidates point at {live_distinct} distinct live objects (a live object can have several unreferenced copies).", "",
            "| Size bucket | Objects | Size |", "|---|---:|---:|"]
    labels = [b[0] for b in SIZE_BUCKETS] + ["unknown size"]
    sizes = []
    for lab in labels:
        t = agg([r for r in d if bucket(r["size_bytes"]) == lab]); sizes.append(t)
        out.append(f"| {lab} | {cell(t)} |")
    check("duplicates by size bucket", sizes, ["duplicate_of_live_image_only"])
    out += ["", "A matching eTag and size does not show an object is unused, abandoned or safe to remove.", ""]

    # 4. no history
    before, after = by_cat["no_evidence_uploaded_before_provenance"], by_cat["no_evidence_uploaded_after_provenance"]
    unk = by_cat["unclassifiable_no_evidence"]
    out += [f"#### 4. No-history objects ({len(before) + len(after) + len(unk)}): by upload month (from the file name), split at the INFERRED provenance cutoff", "",
            f"Inferred cutoff: {cutoff_day or 'unknown'} (earliest `listing_image_snapshots` row). It is an inference, not proof that an object is abandoned or was never saved.", "",
            "| Upload month | Before cutoff: objects | Before: size | After cutoff: objects | After: size |", "|---|---:|---:|---:|---:|"]
    months = sorted({(r["name_upload_ts"][:7] or "unknown") for r in before + after})
    bs, as_ = [], []
    for mo in months:
        tb_ = agg([r for r in before if (r["name_upload_ts"][:7] or "unknown") == mo])
        ta_ = agg([r for r in after if (r["name_upload_ts"][:7] or "unknown") == mo])
        bs.append(tb_); as_.append(ta_)
        out.append(f"| {mo} | {tb_[0]} | {human(tb_[1])} | {ta_[0]} | {human(ta_[1])} |")
    check("no-evidence before cutoff by month", bs, ["no_evidence_uploaded_before_provenance"])
    check("no-evidence after cutoff by month", as_, ["no_evidence_uploaded_after_provenance"])
    if cutoff_day:   # coarse day-level consistency of the split with the cutoff
        for r in before:
            if r["name_upload_ts"][:10] > cutoff_day:
                errors.append("a 'before cutoff' object has an upload date after the cutoff")
                break
        for r in after:
            if r["name_upload_ts"][:10] < cutoff_day:
                errors.append("an 'after cutoff' object has an upload date before the cutoff")
                break
    out += ["", f"`unclassifiable_no_evidence` (no usable upload time or no cutoff): {cell(agg(unk))}.", ""]
    return out


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        rd = csv.DictReader(fh)
        # a short row gives None values, a long one an extra list under key None: both are flagged, never silently repaired
        out = []
        for row in rd:
            ragged = None in row or any(v is None for v in row.values())
            clean = {k: (v if v is not None else "") for k, v in row.items() if k is not None}
            clean["__ragged__"] = ragged
            out.append(clean)
        return rd.fieldnames or [], out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--objects", required=True)
    ap.add_argument("--health")
    ap.add_argument("--expected", type=int, help="object count the stage-2 diagnostic reported")
    ap.add_argument("--out-objects", default="reconcile-objects.csv")
    ap.add_argument("--out-summary", default="reconcile-summary.md")
    a = ap.parse_args(argv)

    errors = []
    header, rows = read_csv(a.objects)
    if header != COLUMNS:
        errors.append("report columns differ from the expected whitelist: " + ", ".join(sorted(set(header) ^ set(COLUMNS))))
        rows = []
    seen = set()
    totals = {c[0]: [0, 0, 0] for c in CATEGORIES}   # objects, bytes, objects with unknown size
    renditions = {"with": 0, "without": 0}
    for idx, r in enumerate(rows, start=1):
        name = r["object_name"]
        who = f"row {idx}"   # errors name the row number, never the object (these messages go to the workflow log)
        if r.pop("__ragged__", False):
            errors.append(f"malformed row (wrong number of fields) at {who}")
            continue
        if name in seen:
            errors.append(f"duplicate object name at {who}")
        seen.add(name)
        cat = r["category"]
        if r["size_bytes"] != "" and not re.fullmatch(r"[0-9]{1,15}", r["size_bytes"]):
            errors.append(f"malformed size_bytes at {who}")
            continue
        if cat not in KNOWN:
            errors.append(f"unknown category at {who}")
            continue
        if any(r[k] != "f" for k in ("ref_listing", "ref_unit", "ref_agent", "ref_registry")):
            errors.append(f"{who} is marked as currently referenced, so it is not an unreferenced original")
        try:
            hist = sum(1 for k in HITS if int(r[k] or 0) > 0)
            ev = int(r["evidence_count"])
            dup = int(r["duplicate_candidate_count"] or 0) > 0
        except ValueError:
            errors.append(f"non-numeric count for {who}")
            continue
        if ev != hist + (1 if dup else 0) or ev != len([s for s in r["matched_sources"].split(",") if s]):
            errors.append(f"evidence_count does not match the matched sources for {who}")
        if (ev >= 2) != (cat == "multiple_evidence"):
            errors.append(f"category contradicts evidence_count at {who}")
        t = totals[cat]
        t[0] += 1
        if r["size_bytes"] == "":
            t[2] += 1
        else:
            t[1] += int(r["size_bytes"])
        renditions["with" if r["renditions_present"] else "without"] += 1
    n = len(rows)
    if sum(t[0] for t in totals.values()) != n:
        errors.append("category counts do not add up to the number of rows")
    if a.expected is not None and n != a.expected:
        errors.append(f"the reconciliation lists {n} objects but the stage-2 diagnostic counted {a.expected}")

    health_lines, warnings, cutoff_day = [], [], ""
    if a.health:
        try:
            _, health = read_csv(a.health)
            if any(h.pop("__ragged__", False) for h in health):
                raise ValueError("ragged source-health row")
            got = {h["source"]: h for h in health}
            cutoff_day = (got.get("listing_image_snapshots") or {}).get("first_date", "")[:10]
            if set(got) != set(SOURCES):
                errors.append("source-health must list exactly the five history sources; got: " + ", ".join(sorted(got)))
            health_lines = ["", "### How much history could be read", "", "| Source | Rows | Readable | Unreadable | Status | First | Last |", "|---|---:|---:|---:|---|---|---|"]
            for h in health:
                total, usable = int(h["rows_total"]), int(h["rows_usable"])
                status = "EMPTY (0 rows)" if total == 0 else "OK" if total == usable else ("UNREADABLE (none usable)" if usable == 0 else f"PARTIAL ({total - usable} unreadable)")
                health_lines.append(f"| `{h['source']}` | {h['rows_total']} | {h['rows_usable']} | {h['rows_unusable']} | {status} | {h['first_date'][:10]} | {h['last_date'][:10]} |")
                if total > 0 and usable == 0:   # a whole source that cannot be searched would make "no evidence" meaningless
                    errors.append(f"history source {h['source']} has {total} rows and none is readable: the no-evidence categories would be misleading")
                elif total > usable:
                    warnings.append(f"WARNING: {total - usable} of {total} `{h['source']}` rows hold no readable path and could match nothing.")
            health_lines += [""] + [f"- {w}" for w in warnings] + ["", "Unreadable rows hold no usable path string (null, scalar or empty), so they could match nothing."]
        except (OSError, KeyError, ValueError, csv.Error) as e:
            errors.append(f"source-health file unreadable or malformed ({type(e).__name__})")
    else:
        errors.append("no source-health file: history coverage is unknown")

    breakdown_lines = breakdowns(rows, totals, cutoff_day, errors) if not errors else []

    if not errors:   # the downloadable per-object report exists only for a reconciliation that fully checked out
        with open(a.out_objects, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(COLUMNS)
            for r in sorted(rows, key=lambda r: (r["category"], r["object_name"])):
                w.writerow([r[c] for c in COLUMNS])

    out = ["## Reconciliation of the unreferenced originals (read-only)", ""]
    if errors:
        out += ["**RECONCILIATION FAILED - do not rely on these numbers:**", ""] + [f"- {e}" for e in errors] + [""]
    else:
        out += [f"**{n} objects. Counts reconcile to the stage-2 total" + (f" ({a.expected})" if a.expected is not None else "") + " and every object has exactly one category.**", ""]
    out += ["| Category | Objects | Size | Flag |", "|---|---:|---:|---|"]
    for name, flagged, _ in CATEGORIES:
        c, b, unk = totals[name]
        out.append(f"| `{name}` | {c} | {human(b)}" + (f" (+{unk} unknown size)" if unk else "") + f" | {'FLAGGED' if flagged and c else ''} |")
    tb = sum(t[1] for t in totals.values())
    out += [f"| **total** | **{sum(t[0] for t in totals.values())}** | **{human(tb)}** | |", "",
            f"Renditions: {renditions['with']} objects have at least one rendition file, {renditions['without']} have none.", "",
            "Category meanings:", ""] + [f"- `{n_}`: {m}" for n_, _, m in CATEGORIES]
    out += ["", "Provenance start is an INFERENCE: the earliest `listing_image_snapshots` row (see its First date below), not a documented launch date. "
            "The `no_evidence_*` categories are therefore hypotheses about why an object is unreferenced, not findings.",
            "", "No object is deleted or moved by this report. `duplicate_of_live_image_only` is a candidate only (same eTag and size), "
            "never proof that an object is safe to remove."]

    out += breakdown_lines + health_lines
    with open(a.out_summary, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")
    for e in errors:
        print("RECONCILIATION ERROR:", e, file=sys.stderr)
    return 1 if errors else 0


def safe_main(argv):
    """Never let an unexpected failure print a traceback: its text could carry a row's content into the workflow log."""
    try:
        return main(argv)
    except Exception as e:   # noqa: BLE001 - deliberate catch-all, reports the exception TYPE only
        print(f"RECONCILIATION ERROR: unexpected {type(e).__name__} while summarising (details withheld: they could contain report data)", file=sys.stderr)
        try:
            a = argparse.ArgumentParser()
            a.add_argument("--out-summary", default="reconcile-summary.md")
            args, _ = a.parse_known_args(argv)
            with open(args.out_summary, "w", encoding="utf-8") as fh:
                fh.write(f"## Reconciliation of the unreferenced originals (read-only)\n\n**RECONCILIATION FAILED - do not rely on these numbers:**\n\n- unexpected {type(e).__name__} while summarising\n")
        except OSError:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(safe_main(sys.argv[1:]))
