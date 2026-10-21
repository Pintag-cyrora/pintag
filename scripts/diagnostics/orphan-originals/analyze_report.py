#!/usr/bin/env python3
"""READ-ONLY local analysis of the reconciliation artifact (reconcile-objects.csv, optionally reconcile-summary.md).

Run it on your own computer against the downloaded artifact; see README.md in this folder. It needs only Python 3 and the
standard library: no database, no credentials, no network. It writes nothing except an optional --out text file, which must be a NEW file (never an input, never an existing
file unless --overwrite, and even then never an input).

It focuses on the two groups that need a decision before any cleanup:
  A. objects named in gallery-recovery history (category history_gallery_assignment_only, plus multiple_evidence rows that
     include gallery_assignment), and
  B. eTag+size duplicate candidates (category duplicate_of_live_image_only, plus multiple_evidence rows that include
     duplicate_candidate),
including their overlap, how strong each piece of evidence is, and what the report CANNOT tell you.

Privacy: the output is aggregate only (counts, sizes, dates, ranges). It never prints an object name, path, record id, listing
id, live-object name or any other value taken from those columns, and error messages name row numbers only.
It never deletes, moves or modifies anything, and it says nothing is "safe to delete": it lists what to check next.
"""
import argparse
import collections
import datetime
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import summarize as S  # noqa: E402  (reuses the report's column whitelist, categories and CSV reader)

ADMIN = re.compile(r"^[0-9]{13}-[a-z0-9]{6}\.jpg$")
ADDPROP = re.compile(r"^[0-9]{13}-")


def pattern(name):
    return "admin upload (<ms>-<rand6>.jpg)" if ADMIN.match(name) else "add-property upload (<ms>-<filename>)" if ADDPROP.match(name) else "other name"


OPS = {"assign", "unassign"}
SOURCES = {"gallery_assignment", "deleted_listing_snapshot", "import_record", "listing_snapshot", "import_image", "duplicate_candidate"}


def op_of(r):
    """Only the two real operations are ever printed; any other text in that column is shown as '(other)'."""
    return r["gallery_assignment_op"] if r["gallery_assignment_op"] in OPS else "(other)"


def combo_of(r):
    parts = [x for x in r["matched_sources"].split(",") if x]
    return ",".join(parts) if parts and all(x in SOURCES for x in parts) else "(other)"


def day(ts):
    try:
        return datetime.date.fromisoformat(ts[:10])
    except ValueError:
        return None


def sz(r):
    return int(r["size_bytes"]) if r["size_bytes"] != "" else 0


def tot(rs):
    unk = sum(1 for r in rs if r["size_bytes"] == "")
    return f"{len(rs)} objects, {S.human(sum(sz(r) for r in rs))}" + (f" (+{unk} unknown size)" if unk else "")


def bucketed(values, edges):
    """edges = [(label, lo, hi)] with hi exclusive (None = open); returns an ordered list of (label, count)."""
    out = []
    for label, lo, hi in edges:
        out.append((label, sum(1 for v in values if v >= lo and (hi is None or v < hi))))
    return out


def lines_for(title, pairs, indent="    "):
    out = [title]
    out += [f"{indent}{k}: {v}" for k, v in pairs]
    return out


def load(objects_path):
    header, rows = S.read_csv(objects_path)
    problems = []
    if header != S.COLUMNS:
        problems.append("the CSV columns are not the expected report columns (wrong file?)")
        return [], problems
    ok = []
    for i, r in enumerate(rows, start=1):
        if r.pop("__ragged__", False):
            problems.append(f"malformed row (wrong number of fields) at row {i}")
            continue
        try:
            if r["size_bytes"] != "":
                int(r["size_bytes"])
            for k in ("gallery_assignment_hits", "duplicate_candidate_count", "evidence_count"):
                int(r[k] or 0)
        except ValueError:
            problems.append(f"non-numeric count or size at row {i}")
            continue
        if r["category"] not in S.KNOWN:
            problems.append(f"unknown category at row {i}")
            continue
        ok.append(r)
    if len({r["object_name"] for r in ok}) != len(ok):
        problems.append("duplicate object rows")
    return ok, problems


def check_summary(rows, summary_path):
    """Cross-check the CSV's category counts against reconcile-summary.md. Returns a list of mismatches (category names only)."""
    with open(summary_path, encoding="utf-8") as fh:
        text = fh.read()
    want = {m.group(1): int(m.group(2)) for m in re.finditer(r"^\| `([a-z_]+)` \| (\d+) \|", text, re.M)}
    got = collections.Counter(r["category"] for r in rows)
    bad = [f"{c}: summary {want.get(c, 0)}, CSV {got.get(c, 0)}" for c in sorted(S.KNOWN) if want.get(c, 0) != got.get(c, 0)]
    m = re.search(r"^\| \*\*total\*\* \| \*\*(\d+)\*\*", text, re.M)
    if not m or int(m.group(1)) != len(rows):
        bad.append(f"total: summary {m.group(1) if m else None}, CSV {len(rows)}")
    return bad


def analyze(rows):
    out = []
    by = collections.defaultdict(list)
    for r in rows:
        by[r["category"]].append(r)
    out += ["== Report ==", f"  {tot(rows)}"]
    out += [f"  {c[0]}: {tot(by[c[0]])}" for c in S.CATEGORIES if by[c[0]]]

    G = [r for r in rows if int(r["gallery_assignment_hits"] or 0) > 0]
    D = [r for r in rows if int(r["duplicate_candidate_count"] or 0) > 0]
    GD = [r for r in G if int(r["duplicate_candidate_count"] or 0) > 0]
    other_multi = [r for r in by["multiple_evidence"] if r not in G and r not in D]

    # ---------------------------------------------------------------- A. gallery history
    out += ["", "== A. Gallery-history matches =="]
    out += [f"  objects named in gallery assignment history: {tot(G)} (of which gallery-history only: {len(by['history_gallery_assignment_only'])})"]
    ops = collections.Counter(op_of(r) for r in G)
    out += lines_for("  by the operation of the MOST RECENT matching record:", [(k, f"{v} ({tot([r for r in G if op_of(r) == k])})") for k, v in sorted(ops.items())])
    hits = [int(r["gallery_assignment_hits"]) for r in G]
    out += lines_for("  how often an object is named in assignment history (list entries):",
                     bucketed(hits, [("once", 1, 2), ("2-3 times", 2, 4), ("4 or more times", 4, None)]))
    recs = {r["gallery_assignment_record"] for r in G if r["gallery_assignment_record"]}
    lsts = collections.Counter(r["gallery_assignment_listing"] for r in G if r["gallery_assignment_listing"])
    out += [f"  distinct latest assignment records: {len(recs)}; distinct listings behind them: {len(lsts)}"]
    out += lines_for("  objects per listing (listings counted per size of their group):",
                     bucketed(list(lsts.values()), [("1 object", 1, 2), ("2-5 objects", 2, 6), ("6-20 objects", 6, 21), ("21+ objects", 21, None)]))
    if lsts:
        out += [f"  the largest single listing accounts for {max(lsts.values())} of {len(G)} objects"]
    dates = [day(r["gallery_assignment_last_date"]) for r in G]
    dates = [d for d in dates if d]
    if dates:
        out += [f"  most recent matching record dates: {min(dates)} to {max(dates)} across {len(set(dates))} distinct days (database session time zone)"]
    gaps, no_gap = [], 0
    for r in G:
        a, u = day(r["gallery_assignment_last_date"]), day(r["name_upload_ts"]) or day(r["storage_created_at"])
        if a and u:
            gaps.append((a - u).days)
        else:
            no_gap += 1
    out += lines_for("  days from upload to the most recent matching record:", bucketed(gaps, [
        ("NEGATIVE (object uploaded AFTER the record that names it: inconsistent, investigate)", -10**6, 0), ("0-1 day", 0, 2), ("2-7 days", 2, 8), ("8-30 days", 8, 31), ("over 30 days", 31, None)]))
    if no_gap:
        out += [f"    ({no_gap} objects have no usable upload or record date)"]
    out += lines_for("  upload month of these objects:", sorted(collections.Counter((day(r["name_upload_ts"]) or day(r["storage_created_at"]) or datetime.date(1970, 1, 1)).strftime("%Y-%m") for r in G).items()))
    out += lines_for("  naming pattern:", sorted(collections.Counter(pattern(r["object_name"]) for r in G).items()))
    out += [f"  renditions: {sum(1 for r in G if r['renditions_present'])} have at least one, {sum(1 for r in G if not r['renditions_present'])} have none"]

    # ---------------------------------------------------------------- B. duplicate candidates
    out += ["", "== B. Duplicate candidates (same eTag AND size as a live-referenced object: candidates only, not proof) =="]
    out += [f"  objects with a duplicate candidate: {tot(D)} (duplicate-only: {len(by['duplicate_of_live_image_only'])}, also in other history: {len(D) - len(by['duplicate_of_live_image_only'])})"]
    uniq = [r for r in D if int(r["duplicate_candidate_count"]) == 1]
    amb = [r for r in D if int(r["duplicate_candidate_count"]) > 1]
    out += [f"  exactly one live object matches: {tot(uniq)}", f"  more than one live object matches (ambiguous): {tot(amb)}"]
    if amb:
        out += lines_for("  ambiguity (number of live objects that match):", bucketed([int(r["duplicate_candidate_count"]) for r in amb], [("2", 2, 3), ("3-5", 3, 6), ("6 or more", 6, None)]))
    live = collections.Counter(r["duplicate_of_live_object"] for r in uniq if r["duplicate_of_live_object"])
    out += [f"  the unique matches point at {len(live)} distinct live objects"]
    out += lines_for("  unreferenced copies per live object (unique matches only):", bucketed(list(live.values()), [("1 copy", 1, 2), ("2 copies", 2, 3), ("3 or more copies", 3, None)]))
    out += lines_for("  size:", bucketed([sz(r) for r in D], [("under 100 KB", 0, 102400), ("100-500 KB", 102400, 512000), ("500 KB-1 MB", 512000, 1048576), ("1 MB and over", 1048576, None)]))
    out += lines_for("  upload month:", sorted(collections.Counter((day(r["name_upload_ts"]) or day(r["storage_created_at"]) or datetime.date(1970, 1, 1)).strftime("%Y-%m") for r in D).items()))
    out += lines_for("  naming pattern:", sorted(collections.Counter(pattern(r["object_name"]) for r in D).items()))

    # ---------------------------------------------------------------- overlap and evidence strength
    out += ["", "== Overlap and evidence strength =="]
    out += [f"  in both groups (gallery history AND duplicate candidate): {tot(GD)}",
            f"  gallery history only (no duplicate candidate): {len(G) - len(GD)}",
            f"  duplicate candidate only (no gallery history): {len(D) - len(GD)}",
            f"  multiple_evidence rows outside both groups (other source combinations): {len(other_multi)}"]
    combos = collections.Counter(combo_of(r) for r in by["multiple_evidence"])
    out += lines_for("  multiple_evidence by source combination:", sorted(combos.items()))
    strong_assign = [r for r in G if op_of(r) == "assign"]
    out += ["  evidence ranking (what each kind of evidence does and does not show):",
            f"    - last operation 'assign' ({len(strong_assign)} objects): a recovery record put this photo in a gallery, yet no live listing references it now. Strongest 'was in use' signal; needs the listing's current state.",
            f"    - last operation 'unassign' ({len(G) - len(strong_assign)} objects): the recovery tool deliberately detached it (returned to the pool). Expected leftover; the tool never deletes.",
            f"    - duplicate candidate ({len(D)} objects): identical eTag and size to a live image suggests the same bytes, but says nothing about whether this copy is needed.",
            f"    - both ({len(GD)} objects): the photo was in recovery history and a live copy exists; check whether a listing now uses the live copy instead."]

    # ---------------------------------------------------------------- uncertainties and recommendations
    out += ["", "== Unresolved uncertainties (this report cannot answer them) =="]
    out += ["  - Whether the listing behind each latest assignment record still exists, is published, and shows the photo (the report holds no listing state).",
            "  - Only the MOST RECENT matching record per object is kept; older records and their operations are not in the report.",
            "  - The live object a duplicate candidate matches is identified, but its upload date and listing are not in the report, so copy-vs-original order is unknown.",
            "  - eTag equality implies identical bytes only for single-part uploads; the report does not include the eTag format or a content hash.",
            "  - Dates are in the database session time zone; upload time comes from the file name (client clock) when present.",
            "  - The report reflects one moment: later uploads or edits are not included."]
    if gaps and any(g < 0 for g in gaps):
        out += [f"  - {sum(1 for g in gaps if g < 0)} gallery-history objects look uploaded after the record naming them: check for clock skew or a path reused by a later upload."]
    out += ["", "== Recommended review steps (read-only; nothing here shows an object is safe to delete) =="]
    out += ["  1. For the 'assign' group, run a read-only query for the listings behind the latest records and list which still exist and whether the photo is absent from their gallery; the ones still missing are candidates for re-attachment, not cleanup.",
            "  2. For the 'unassign' group, confirm with whoever ran Gallery Recovery that these were intentionally detached, and keep them until confirmed.",
            "  3. For unique duplicate candidates, compare the stored content hash (or download both and hash) before treating the copy as redundant; for ambiguous ones review by hand.",
            "  4. Review the objects in both groups first: they show recovery activity and a live twin, so they are the cheapest to resolve.",
            "  5. Treat the 'no history' objects separately (see the reconciliation summary): their provenance cutoff is an inference.",
            "  6. Before any deletion is even considered, make an independent copy of the bucket: the R2 mirror (rclone sync) propagates deletions within about a week."]
    return out


def out_path_problem(out, inputs, overwrite):
    """Why --out may not be written, or None. Checked BEFORE any analysis and again at open time (exclusive create)."""
    for src in inputs:
        if os.path.realpath(out) == os.path.realpath(src) or (os.path.exists(out) and os.path.exists(src) and os.path.samefile(out, src)):
            return "--out is the same file as an input (it would overwrite the artifact); choose a new file name"
    if os.path.lexists(out):
        if not overwrite:
            return "--out already exists; refusing to overwrite it (choose a new file name, or pass --overwrite to replace an existing regular file)"
        if os.path.islink(out) or not os.path.isfile(out):
            return "--out exists and is not a plain file (symlink or directory); refusing even with --overwrite"
    return None


def main(argv):
    ap = argparse.ArgumentParser(description="Aggregate-only analysis of reconcile-objects.csv (read-only, offline).")
    ap.add_argument("--objects", required=True, help="path to the downloaded reconcile-objects.csv")
    ap.add_argument("--summary", help="optional path to reconcile-summary.md to cross-check category counts")
    ap.add_argument("--out", help="optional NEW file to write the same text to (default: stdout only). Never an input file; never an existing file unless --overwrite")
    ap.add_argument("--overwrite", action="store_true", help="allow --out to replace an existing plain file (still never an input file)")
    a = ap.parse_args(argv)
    if a.out:
        problem = out_path_problem(a.out, [p for p in (a.objects, a.summary) if p], a.overwrite)
        if problem:
            print("ANALYSIS ERROR:", problem, file=sys.stderr)
            return 1
    rows, problems = load(a.objects)
    if not problems and a.summary:
        problems += ["CSV and summary disagree - " + p for p in check_summary(rows, a.summary)]
    if problems:
        for p in problems[:20]:
            print("ANALYSIS ERROR:", p, file=sys.stderr)
        return 1
    text = "\n".join(analyze(rows)) + "\n"
    if a.out:   # exclusive create ("x") unless --overwrite: even a race cannot clobber a file that appeared after the check
        with open(a.out, "w" if a.overwrite else "x", encoding="utf-8") as fh:
            fh.write(text)
    sys.stdout.write(text)
    return 0


def safe_main(argv):
    try:
        return main(argv)
    except Exception as e:   # noqa: BLE001 - report the exception TYPE only: its text could contain report data
        print(f"ANALYSIS ERROR: unexpected {type(e).__name__} (details withheld: they could contain report data)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(safe_main(sys.argv[1:]))
