#!/usr/bin/env python3
"""Validate and summarise the output of 5-gallery-listing-state.sql (local files only; READ-ONLY inputs).

Reads the psql --csv file (one row per unreferenced original, with or without Gallery Recovery history), checks that it is internally
consistent and that its row count equals the stage-2 object total, and writes
  gallery-listing-summary.md   aggregate counts / sizes / distinct-listing COUNTS (this goes in the job summary; no identifiers)
  gallery-listing-detail.csv   the PRIVATE per-object review file: only objects WITH history, only the minimum identifiers
                               (object_name, listing_id, record_id) plus the classification -- for the short-lived private artifact
Exit status 1 on any inconsistency: then the detail file is NOT written and every message names row numbers, never an identifier.
"""
import argparse
import csv
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import summarize as S  # noqa: E402  (shared CSV reader and size formatting)

IN_COLS = ["object_name", "size_bytes", "has_history", "latest_op", "listing_id", "record_id", "record_date", "tied_records", "tied_listings", "listing_state",
           "photo_in_gallery", "listing_gallery_size", "listing_changed_after_record", "confidence", "recorded_via"]
DETAIL_COLS = ["object_name", "latest_op", "outcome", "listing_id", "record_id", "record_date", "tied_records", "tied_listings", "listing_gallery_size",
               "listing_changed_after_record", "confidence", "recorded_via", "size_bytes"]
OPS = ["assign", "unassign", "ambiguous", "other"]
STATES = ["listing_missing", "listing_soft_deleted", "listing_active", "no_usable_listing_id"]
LABEL = {"listing_missing": "missing listing (no properties row)", "listing_soft_deleted": "soft-deleted listing (deleted_at set)",
         "listing_active": "active listing; its gallery no longer references the photo", "no_usable_listing_id": "record has no usable listing id"}
TOUCHED = {"changed_after_record", "not_changed_after_record", "unknown"}
CONF = {"high", "medium", "low", "n/a"}
VIA = {"by-listing", "gallery-editor", "move", "no-matching", "(other)"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def agg(rs):
    return len(rs), sum(int(r["size_bytes"]) for r in rs if r["size_bytes"] != ""), sum(1 for r in rs if r["size_bytes"] == "")


def cell(t):
    return f"{t[0]} | {S.human(t[1])}" + (f" (+{t[2]} unknown size)" if t[2] else "")


def listings(rs):
    return len({r["listing_id"] for r in rs if r["listing_id"]})


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--objects", required=True)
    ap.add_argument("--expected", type=int, required=True, help="object count the stage-2 diagnostic reported")
    ap.add_argument("--out-detail", default="gallery-listing-detail.csv")
    ap.add_argument("--out-summary", default="gallery-listing-summary.md")
    a = ap.parse_args(argv)
    errors, rows = [], []
    header, raw = S.read_csv(a.objects)
    if header != IN_COLS:
        errors.append("the query output does not have the expected columns")
        raw = []
    seen = set()
    for i, r in enumerate(raw, start=1):
        who = f"row {i}"
        if r.pop("__ragged__", False):
            errors.append(f"malformed row (wrong number of fields) at {who}")
            continue
        bad = []
        if r["size_bytes"] != "" and not re.fullmatch(r"[0-9]{1,15}", r["size_bytes"]):
            bad.append("size_bytes")
        for k in ("tied_records", "tied_listings", "listing_gallery_size"):
            if r[k] != "" and not re.fullmatch(r"[0-9]{1,9}", r[k]):
                bad.append(k)
        if r["has_history"] not in ("t", "f") or r["photo_in_gallery"] not in ("t", "f"):
            bad.append("boolean")
        if r["latest_op"] not in OPS + [""] or r["listing_state"] not in STATES + [""]:
            bad.append("vocabulary")
        if r["listing_changed_after_record"] not in TOUCHED | {""} or r["confidence"] not in CONF | {""} or r["recorded_via"] not in VIA | {""}:
            bad.append("vocabulary")
        if bad:
            errors.append(f"malformed value at {who} ({', '.join(sorted(set(bad)))})")
            continue
        hist = r["has_history"] == "t"
        amb = r["latest_op"] == "ambiguous"
        if hist == (r["latest_op"] == ""):
            errors.append(f"history flag and operation disagree at {who}")
        elif amb and (r["listing_id"] or r["record_id"] or r["listing_state"] or int(r["tied_records"] or 0) < 2):
            errors.append(f"ambiguous row carries a pick or too few tied records at {who}")
        elif hist and not amb and (not r["record_id"] or not r["listing_state"]):
            errors.append(f"history row without a record or listing state at {who}")
        elif hist and not amb and r["listing_state"] != "no_usable_listing_id" and not UUID.match(r["listing_id"]):
            errors.append(f"history row with a malformed listing id at {who}")
        elif not hist and (r["listing_id"] or r["record_id"] or r["listing_state"]):
            errors.append(f"row without history carries a record at {who}")
        elif r["photo_in_gallery"] == "t":
            errors.append(f"object is still referenced by its listing's gallery at {who}: the population definition is inconsistent")
        else:
            if r["object_name"] in seen:
                errors.append(f"duplicate object at {who}")
            seen.add(r["object_name"])
            rows.append(r)
    if not errors and len(rows) != a.expected:
        errors.append(f"the query returned {len(rows)} objects but the stage-2 diagnostic counted {a.expected}")

    out = ["## Gallery Recovery records vs current listing galleries (read-only, aggregate only: no identifiers)", ""]
    detail = []
    if not errors:
        H = [r for r in rows if r["has_history"] == "t"]
        by = {op: [r for r in H if r["latest_op"] == op] for op in OPS}
        out += [f"**{len(rows)} objects. Counts reconcile to the stage-2 total ({a.expected}).** {len(H)} have Gallery Recovery history; {len(rows) - len(H)} have none.", "",
                "| Latest record | Objects | Size | Distinct listings |", "|---|---:|---:|---:|"]
        tot = [agg(by[op]) for op in OPS] + [agg([r for r in rows if r["has_history"] == "f"])]
        names = {"assign": "assign (main focus)", "unassign": "unassign (already detached by an operator)", "ambiguous": "ambiguous (conflicting records tied at the latest instant)",
                 "other": "other operation"}
        for op, t in zip(OPS, tot):
            out.append(f"| {names[op]} | {cell(t)} | {listings(by[op]) if op != 'ambiguous' else 'n/a'} |")
        out.append(f"| no Gallery Recovery history | {cell(tot[-1])} | n/a |")
        if sum(t[0] for t in tot) != len(rows) or sum(t[1] for t in tot) != sum(int(r["size_bytes"]) for r in rows if r["size_bytes"] != ""):
            errors.append("latest-record groups do not add up to the population")

        for op, title in (("assign", "assign"), ("unassign", "unassign")):
            g = by[op]
            out += ["", f"### Latest record = {title}: what happened to the listing ({len(g)} objects)", "", "| Outcome | Objects | Size | Distinct listings |", "|---|---:|---:|---:|"]
            sub = []
            for st in STATES:
                rs = [r for r in g if r["listing_state"] == st]
                t = agg(rs); sub.append(t)
                out.append(f"| {LABEL[st]} | {cell(t)} | {listings(rs)} |")
            if [sum(x[i] for x in sub) for i in range(3)] != list(agg(g)):
                errors.append(f"outcomes for '{op}' do not add up to the group")
            act = [r for r in g if r["listing_state"] == "listing_active"]
            if op == "assign" and act:
                out += ["", f"Active listings where the photo is absent ({len(act)} objects, {listings(act)} listings):", "", "| Current gallery size | Objects | Size |", "|---|---:|---:|"]
                parts = []
                for lab, lo, hi in (("empty gallery", 0, 1), ("1-5 photos", 1, 6), ("6-15 photos", 6, 16), ("16+ photos", 16, None)):
                    rs = [r for r in act if r["listing_gallery_size"] != "" and int(r["listing_gallery_size"]) >= lo and (hi is None or int(r["listing_gallery_size"]) < hi)]
                    t = agg(rs); parts.append(t); out.append(f"| {lab} | {cell(t)} |")
                t = agg([r for r in act if r["listing_gallery_size"] == ""]); parts.append(t); out.append(f"| unknown | {cell(t)} |")
                if [sum(x[i] for x in parts) for i in range(3)] != list(agg(act)):
                    errors.append("gallery-size buckets do not add up")
                for field, vocab, head in (("listing_changed_after_record", ["changed_after_record", "not_changed_after_record", "unknown"], "Listing changed after the record"),
                                           ("confidence", ["high", "medium", "low", "n/a"], "Recovery confidence"), ("recorded_via", sorted(VIA), "How it was recorded")):
                    out += ["", f"| {head} | Objects | Size |", "|---|---:|---:|"]
                    parts = []
                    for v in vocab:
                        t = agg([r for r in act if r[field] == v]); parts.append(t); out.append(f"| {v} | {cell(t)} |")
                    if [sum(x[i] for x in parts) for i in range(3)] != list(agg(act)):
                        errors.append(f"{field} breakdown does not add up")
        amb = by["ambiguous"]
        out += ["", f"### Ambiguous latest record ({len(amb)} objects)", ""]
        if amb:
            out += ["| Records tied at the latest instant | Objects |", "|---|---:|"]
            for lab, lo, hi in (("2", 2, 3), ("3-5", 3, 6), ("6 or more", 6, None)):
                out.append(f"| {lab} | {sum(1 for r in amb if int(r['tied_records']) >= lo and (hi is None or int(r['tied_records']) < hi))} |")
            out += ["", f"Tied records name {sum(1 for r in amb if int(r['tied_listings'] or 0) > 1)} objects with more than one different listing; no listing is picked for them."]
        else:
            out += ["None: no object has conflicting records tied at its latest instant."]
        out += ["", "Notes: an object counts as referenced by a listing only through `properties.images`, and the 551-object population is defined as referenced by no listing, so",
                "'photo present' is zero by construction (a non-zero value fails this run). Only each object's LATEST record is used; older records are not counted. Gallery Recovery",
                "does not log edits made elsewhere in the admin, so an 'assign' whose photo later left the gallery may have no matching 'unassign'. Nothing here shows an object is safe to delete.",
                "Dates and 'changed after the record' use the database session time zone and `properties.updated_at` (unknown if absent)."]
        for r in sorted(H, key=lambda r: (r["latest_op"], r["listing_state"], r["object_name"])):
            detail.append({"object_name": r["object_name"], "latest_op": r["latest_op"], "outcome": r["listing_state"] or "ambiguous_latest_record", "listing_id": r["listing_id"],
                           "record_id": r["record_id"], "record_date": r["record_date"], "tied_records": r["tied_records"], "tied_listings": r["tied_listings"],
                           "listing_gallery_size": r["listing_gallery_size"], "listing_changed_after_record": r["listing_changed_after_record"], "confidence": r["confidence"],
                           "recorded_via": r["recorded_via"], "size_bytes": r["size_bytes"]})
    if errors:
        out = [out[0], "", "**RECONCILIATION FAILED - do not rely on these numbers:**", ""] + [f"- {e}" for e in errors]
        detail = []
    else:
        tmp = a.out_detail + ".tmp"   # write aside and rename: a crash can never leave a partial detail file under the real name
        try:
            with open(tmp, "w", newline="", encoding="utf-8") as fh:
                w = csv.DictWriter(fh, fieldnames=DETAIL_COLS)
                w.writeheader()
                w.writerows(detail)
            os.replace(tmp, a.out_detail)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    with open(a.out_summary, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")
    for e in errors:
        print("GALLERY RECONCILIATION ERROR:", e, file=sys.stderr)
    return 1 if errors else 0


def safe_main(argv):
    try:
        return main(argv)
    except Exception as e:   # noqa: BLE001 - the exception TYPE only: its text could contain report data
        print(f"GALLERY RECONCILIATION ERROR: unexpected {type(e).__name__} (details withheld: they could contain report data)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(safe_main(sys.argv[1:]))
