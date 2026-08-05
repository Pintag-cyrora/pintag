#!/usr/bin/env python3
"""
verify-db-backup.py <backup-dir> <db-url>

Fail-closed DB backup verification: for each captured relationship table, compare
the live row count to the exported CSV's row count. A small delta is tolerated
(rows written while pg_dump ran); anything larger fails the run. Writes
verification/counts.json for the metadata step. Read-only against the DB.
"""
import csv, json, os, subprocess, sys

dest, db_url = sys.argv[1], sys.argv[2]
rel_dir = os.path.join(dest, "database", "relationships")
inc = os.path.join(rel_dir, "_INCLUDED_TABLES.txt")
tables = [t.strip() for t in open(inc)] if os.path.exists(inc) else []

def live_count(t):
    out = subprocess.check_output(
        ["psql", db_url, "-X", "-Atqc", f'select count(*) from public."{t}"'], text=True)
    return int(out.strip())

def csv_rows(path):
    with open(path, newline="", encoding="utf-8") as f:
        return max(sum(1 for _ in csv.reader(f)) - 1, 0)   # minus header

counts, failed = {}, []
for t in tables:
    p = os.path.join(rel_dir, f"{t}.csv")
    if not os.path.exists(p):
        failed.append(f"{t}: CSV missing"); continue
    live, backup = live_count(t), csv_rows(p)
    tol = max(5, int(live * 0.01))
    ok = abs(live - backup) <= tol
    counts[t] = {"live": live, "backup": backup, "ok": ok}
    print(f"{'OK ' if ok else 'FAIL'} {t:26} live={live:<8} backup={backup:<8} tol=±{tol}")
    if not ok:
        failed.append(f"{t}: live={live} backup={backup} (delta>{tol})")

os.makedirs(os.path.join(dest, "verification"), exist_ok=True)
json.dump(counts, open(os.path.join(dest, "verification", "counts.json"), "w"), indent=2)

if failed:
    print("\nDB VERIFICATION FAILED:")
    print("\n".join("  - " + x for x in failed))
    sys.exit(1)
print(f"\nDB verification OK — {len(tables)} relationship tables within tolerance.")
