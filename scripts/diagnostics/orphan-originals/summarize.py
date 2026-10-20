#!/usr/bin/env python3
"""Validate and summarise the output of 3-reconcile.sql / 4-source-health.sql (READ-ONLY inputs, local files only).

Reads the psql --csv files, checks that the report is internally consistent and reconciles to the stage-2 total, and writes
  reconcile-objects.csv   per-object report, re-written with a fixed column whitelist (this is the downloadable artifact)
  reconcile-summary.md    aggregate counts and sizes per category (this goes in the job summary; no object names)
Exit status 1 when anything does not reconcile (the files are still written so the failure can be read).
"""
import argparse
import csv
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
    ("no_evidence_uploaded_before_provenance", False, "no history; uploaded before gallery provenance existed (inconclusive)"),
    ("no_evidence_uploaded_after_provenance", False, "no history; uploaded after provenance began (probably never saved)"),
    ("multiple_evidence", True, "matches two or more sources: flagged, not forced into one"),
    ("unclassifiable_no_evidence", True, "no history and no usable upload time or provenance start: cannot be classified"),
]
KNOWN = {c[0] for c in CATEGORIES}
HITS = ["gallery_assignment_hits", "deleted_snapshot_hits", "import_record_hits", "listing_snapshot_hits", "import_image_hits"]


def human(n):
    n = float(n)
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{int(n)} bytes" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        rd = csv.DictReader(fh)
        return rd.fieldnames or [], list(rd)


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
    for r in rows:
        name = r["object_name"]
        if name in seen:
            errors.append(f"duplicate object row: {name!r}")
        seen.add(name)
        cat = r["category"]
        if cat not in KNOWN:
            errors.append(f"unknown category {cat!r} for {name!r}")
            continue
        if any(r[k] != "f" for k in ("ref_listing", "ref_unit", "ref_agent", "ref_registry")):
            errors.append(f"{name!r} is marked as currently referenced, so it is not an unreferenced original")
        try:
            hist = sum(1 for k in HITS if int(r[k] or 0) > 0)
            ev = int(r["evidence_count"])
            dup = int(r["duplicate_candidate_count"] or 0) > 0
        except ValueError:
            errors.append(f"non-numeric count for {name!r}")
            continue
        if ev != hist + (1 if dup else 0) or ev != len([s for s in r["matched_sources"].split(",") if s]):
            errors.append(f"evidence_count does not match the matched sources for {name!r}")
        if (ev >= 2) != (cat == "multiple_evidence"):
            errors.append(f"category {cat!r} contradicts evidence_count {ev} for {name!r}")
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
    out += ["", "No object is deleted or moved by this report. `duplicate_of_live_image_only` is a candidate only (same eTag and size), "
            "never proof that an object is safe to remove."]

    if a.health:
        try:
            _, health = read_csv(a.health)
            out += ["", "### How much history could be read", "", "| Source | Rows | Readable | Unreadable | First | Last |", "|---|---:|---:|---:|---|---|"]
            for h in health:
                out.append(f"| `{h['source']}` | {h['rows_total']} | {h['rows_usable']} | {h['rows_unusable']} | {h['first_date'][:10]} | {h['last_date'][:10]} |")
            out += ["", "Unreadable rows hold no usable path string (null, scalar or empty), so they could match nothing."]
        except (OSError, KeyError, csv.Error) as e:
            errors.append(f"source-health file unreadable: {e}")
            out += ["", f"Source-health file unreadable: {e}"]
    with open(a.out_summary, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")
    for e in errors:
        print("RECONCILIATION ERROR:", e, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
