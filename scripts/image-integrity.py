#!/usr/bin/env python3
# Pintag Image Integrity Check — read-only. Verifies that the image registry
# (property_images), the listings (properties.images), and Supabase Storage
# (storage.objects) all agree. Prints a clear report and EXITS NON-ZERO on any
# anomaly, so a scheduled run fails loudly instead of silently passing.
#
# It touches nothing: only SELECTs. Runs against a read-only connection.
#
# Usage:
#   PINTAG_PROD_DB_URL=postgres://... python3 scripts/image-integrity.py
#   # optional strict hash check against a trusted sha256 manifest
#   #   (path<TAB>sha256 per line, e.g. from `rclone hashsum SHA256`):
#   python3 scripts/image-integrity.py --checksums checksums.sha256
#
# Definitions (chosen for a DR registry):
#   missing_files  = ACTIVE registry rows in our bucket with no storage object
#                    (a photo the listing shows but whose file is gone).
#   orphaned_files = storage objects with NO registry row in ANY status
#                    (an object we cannot map to any listing — the real DR risk;
#                    objects merely removed from a gallery are still mapped via a
#                    status='removed' row and are NOT counted as orphaned).
#   invalid_property        = registry rows whose property_id is not a listing.
#   listings_missing_images = properties.images URLs (our bucket) with no object.
#   cover/order issues      = a listing whose active images don't have exactly
#                             one cover, or whose cover isn't at display_order 0.

import os, sys, json, subprocess, argparse

METRICS_SQL = r"""
WITH
active AS (SELECT * FROM property_images WHERE status='active'),
obj    AS (SELECT name FROM storage.objects WHERE bucket_id='property-images'),
listing_urls AS (
  SELECT p.id AS property_id,
         regexp_replace(u.url,'^.*/property-images/','') AS path
  FROM properties p,
       LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(p.images)='array' THEN p.images ELSE '[]'::jsonb END) AS u(url)
  WHERE u.url LIKE '%/property-images/%'
),
cover_stats AS (
  SELECT property_id,
         count(*) AS n,
         count(*) FILTER (WHERE is_cover) AS covers,
         count(*) FILTER (WHERE is_cover AND display_order<>0) AS cover_not_first
  FROM active GROUP BY property_id
)
SELECT json_build_object(
  'listings',                (SELECT count(*) FROM properties),
  'registered',             (SELECT count(*) FROM active),
  'registered_all',          (SELECT count(*) FROM property_images),
  'storage_objects',        (SELECT count(*) FROM obj),
  'hash_coverage',          (SELECT count(*) FROM active WHERE sha256 IS NOT NULL),
  'missing_files',          (SELECT count(*) FROM active a
                              WHERE a.storage_bucket='property-images'
                                AND NOT EXISTS (SELECT 1 FROM obj o WHERE o.name=a.storage_path)),
  'orphaned_files',         (SELECT count(*) FROM obj o
                              WHERE NOT EXISTS (SELECT 1 FROM property_images pi WHERE pi.storage_path=o.name)),
  'invalid_property',       (SELECT count(*) FROM active a
                              WHERE NOT EXISTS (SELECT 1 FROM properties p WHERE p.id=a.property_id)),
  'listings_missing_images',(SELECT count(*) FROM listing_urls lu
                              WHERE NOT EXISTS (SELECT 1 FROM obj o WHERE o.name=lu.path)),
  'cover_wrong',            (SELECT count(*) FROM cover_stats WHERE n>0 AND covers<>1),
  'cover_not_first',        (SELECT coalesce(sum(cover_not_first),0) FROM cover_stats)
);
"""

def psql_json(db_url, sql):
    out = subprocess.check_output(
        ["psql", db_url, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
        text=True).strip()
    return json.loads(out)

def hash_mismatches(db_url, checksums_path):
    # trusted { path: sha256 } from an off-line hashsum of the actual bytes
    trusted = {}
    with open(checksums_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) >= 2:
                trusted[parts[-1].split("/")[-1]] = parts[0].lower()
    rows = subprocess.check_output(
        ["psql", db_url, "-X", "-A", "-t", "-q", "-F", "\t", "-c",
         "SELECT storage_path, sha256 FROM property_images WHERE status='active' AND sha256 IS NOT NULL"],
        text=True).strip().splitlines()
    mismatches = 0
    for r in rows:
        if not r:
            continue
        path, sha = r.split("\t")
        t = trusted.get(path) or trusted.get(path.split("/")[-1])
        if t is not None and t != (sha or "").lower():
            mismatches += 1
    return mismatches

def fmt(n):
    return f"{n:,}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checksums", help="trusted sha256 manifest (path<TAB>sha256)")
    ap.add_argument("--allow-orphans", type=int, default=0,
                    help="tolerate up to N orphaned objects before failing (default 0)")
    args = ap.parse_args()

    db_url = os.environ.get("PINTAG_PROD_DB_URL") or os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: set PINTAG_PROD_DB_URL (read-only connection).", file=sys.stderr)
        return 2

    m = psql_json(db_url, METRICS_SQL)
    hmis = hash_mismatches(db_url, args.checksums) if args.checksums else 0

    verified = m["registered"] - m["missing_files"] - hmis
    problems = []
    if m["missing_files"] > 0:           problems.append(f'{m["missing_files"]} missing file(s)')
    if m["orphaned_files"] > args.allow_orphans: problems.append(f'{m["orphaned_files"]} orphaned object(s)')
    if m["invalid_property"] > 0:        problems.append(f'{m["invalid_property"]} image(s) with no valid listing')
    if m["listings_missing_images"] > 0: problems.append(f'{m["listings_missing_images"]} listing image ref(s) missing from storage')
    if m["cover_wrong"] > 0:             problems.append(f'{m["cover_wrong"]} listing(s) without exactly one cover')
    if m["cover_not_first"] > 0:         problems.append(f'{m["cover_not_first"]} cover(s) not at position 0')
    if hmis > 0:                         problems.append(f'{hmis} sha256 mismatch(es)')

    status = "HEALTHY" if not problems else "FAILED"
    lines = [
        "Pintag Image Integrity Check",
        f'Listings:            {fmt(m["listings"]):>10}',
        f'Registered images:   {fmt(m["registered"]):>10}',
        f'Images verified:     {fmt(verified):>10}',
        f'Missing files:       {fmt(m["missing_files"]):>10}',
        f'Orphaned files:      {fmt(m["orphaned_files"]):>10}',
        f'Hash mismatches:     {fmt(hmis):>10}',
        f'Hash coverage:       {fmt(m["hash_coverage"])} / {fmt(m["registered"])}',
        f"STATUS: {status}",
    ]
    print("\n".join(lines))
    if problems:
        print("\nAnomalies:", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
