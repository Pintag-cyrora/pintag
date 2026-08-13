#!/usr/bin/env python3
# Image hash/metadata backfill — fills property_images.sha256 / file_size /
# mime_type / width / height for rows that don't have them yet (chiefly
# manual-upload images, which the provenance layer never hashed). It reads each
# object's bytes from the PUBLIC CDN URL (the bucket is public-read), hashes
# them, and UPDATEs only the metadata columns. It NEVER writes, moves, or
# deletes a storage object, and never touches properties.images.
#
# Resumable and idempotent: processes only status='active' rows WHERE sha256 IS
# NULL, in batches. Safe to re-run and safe to interrupt.
#
# Usage (in the production-backup CI environment):
#   PINTAG_PROD_DB_URL=postgres://... python3 scripts/image-hash-backfill.py --limit 500
#
# Pillow is optional: if unavailable, width/height are left NULL and everything
# else still fills.

import os, sys, hashlib, subprocess, argparse, urllib.request

try:
    from PIL import Image  # optional, for width/height
    import io
    _HAVE_PIL = True
except Exception:
    _HAVE_PIL = False


def q(db_url, sql):
    return subprocess.check_output(
        ["psql", db_url, "-X", "-A", "-t", "-q", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql],
        text=True).strip()


def sql_lit(s):
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=500, help="max images to process this run (resumable)")
    ap.add_argument("--timeout", type=int, default=30)
    args = ap.parse_args()

    db_url = os.environ.get("PINTAG_PROD_DB_URL") or os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: set PINTAG_PROD_DB_URL.", file=sys.stderr)
        return 2

    rows = q(db_url,
             "SELECT id, storage_url FROM property_images "
             "WHERE status='active' AND sha256 IS NULL AND storage_url IS NOT NULL "
             "AND storage_bucket='property-images' "
             f"ORDER BY created_at LIMIT {int(args.limit)}")
    if not rows:
        print("Nothing to hash — all active images already have a sha256.")
        return 0

    done = fail = 0
    for line in rows.splitlines():
        if not line.strip():
            continue
        img_id, url = line.split("\t")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pintag-hash-backfill"})
            with urllib.request.urlopen(req, timeout=args.timeout) as resp:
                data = resp.read()
                mime = resp.headers.get("Content-Type")
            sha = hashlib.sha256(data).hexdigest()
            size = len(data)
            w = h = None
            if _HAVE_PIL:
                try:
                    with Image.open(io.BytesIO(data)) as im:
                        w, h = im.size
                except Exception:
                    pass
            # Metadata-only UPDATE; never overwrites a hash that already exists.
            q(db_url,
              "UPDATE property_images SET "
              f"sha256={sql_lit(sha)}, file_size={size}, "
              f"mime_type={sql_lit(mime)}, "
              f"width={w if w is not None else 'NULL'}, height={h if h is not None else 'NULL'}, "
              "updated_at=now() "
              f"WHERE id={sql_lit(img_id)} AND sha256 IS NULL")
            done += 1
        except Exception as e:
            print(f"  ! {img_id} ({url}): {e}", file=sys.stderr)
            fail += 1

    print(f"Hashed {done} image(s); {fail} failure(s). Re-run to continue (resumable).")
    # Failures are surfaced but do not fail the job — transient fetch errors are
    # expected; the next run retries them (still NULL). A hard failure only comes
    # from the integrity check, not from this best-effort enrichment.
    return 0


if __name__ == "__main__":
    sys.exit(main())
