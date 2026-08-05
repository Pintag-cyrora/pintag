#!/usr/bin/env python3
"""
backup-property-images.py — read-only backup + verification for the Pintag
`property-images` Supabase Storage bucket.

WHAT IT DOES (nothing is ever written to Supabase or the database):
  1. Reads a manifest CSV exported from `storage.objects` (see the SQL in the
     runbook: columns object_path,file_size_bytes,mimetype,etag_checksum,
     created_at,updated_at).
  2. Downloads every object from the PUBLIC bucket URL (no keys needed —
     property-images is public-read).
  3. Verifies each file: HTTP 200, local byte-size == manifest size, computes a
     local SHA-256, and (when the manifest eTag is a plain MD5) checks it.
  4. Writes verified-manifest.csv / .json and prints a pass/fail summary.

SAFE TO RE-RUN: a file already present with the correct size is not
re-downloaded (only re-hashed), so an interrupted run resumes cleanly.

Usage:
  python3 backup-property-images.py \
    --manifest property-images-manifest.csv \
    --out ./property-images-backup
  # verify an existing backup without downloading:
  python3 backup-property-images.py --manifest m.csv --out ./backup --verify-only
"""
import argparse, csv, hashlib, json, os, sys, time, urllib.parse, urllib.request

DEFAULT_BASE = ("https://eoladhcljbpbhnrmmpev.supabase.co"
                "/storage/v1/object/public/property-images")
CHUNK = 1 << 20  # 1 MiB


def sha256_and_size(path):
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(CHUNK), b""):
            h.update(b); n += len(b)
    return h.hexdigest(), n


def download(url, dest, retries=4):
    """Stream url -> dest with retries/backoff. Returns (http_status, err)."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pintag-backup/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
                tmp = dest + ".part"
                with open(tmp, "wb") as out:
                    for b in iter(lambda: r.read(CHUNK), b""):
                        out.write(b)
                os.replace(tmp, dest)
                return r.status, None
        except urllib.error.HTTPError as e:
            if e.code in (404, 403):     # not retryable
                return e.code, str(e)
            err = f"HTTP {e.code}"
        except Exception as e:           # network/timeout — retry
            err = str(e)
        time.sleep(2 ** attempt)
    return 0, err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="CSV exported from storage.objects")
    ap.add_argument("--out", default="./property-images-backup")
    ap.add_argument("--base", default=DEFAULT_BASE, help="public bucket base URL")
    ap.add_argument("--verify-only", action="store_true", help="do not download; verify local files")
    args = ap.parse_args()

    with open(args.manifest, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        print("Manifest is empty — nothing to back up.", file=sys.stderr); sys.exit(2)

    results = []
    ok = mismatch = failed = etag_ok = etag_na = 0
    total_bytes = 0
    t0 = time.time()

    for i, row in enumerate(rows, 1):
        path = (row.get("object_path") or row.get("name") or "").strip()
        if not path:
            continue
        exp_size = int(row.get("file_size_bytes") or 0) if (row.get("file_size_bytes") or "").strip() else None
        etag = (row.get("etag_checksum") or "").strip().strip('"')
        dest = os.path.join(args.out, path)
        status, err = None, None

        need_dl = not (os.path.exists(dest) and exp_size is not None
                       and os.path.getsize(dest) == exp_size)
        if args.verify_only:
            need_dl = False
        if need_dl:
            url = args.base.rstrip("/") + "/" + urllib.parse.quote(path, safe="/")
            status, err = download(url, dest)

        present = os.path.exists(dest)
        if not present:
            failed += 1
            results.append({"object_path": path, "status": "MISSING",
                            "http": status, "error": err, "expected_size": exp_size})
            print(f"[{i}/{len(rows)}] FAIL  {path}  ({err or status})")
            continue

        digest, local_size = sha256_and_size(dest)
        total_bytes += local_size
        size_ok = (exp_size is None) or (local_size == exp_size)
        # eTag is an MD5 only for single-part uploads (32 hex, no '-')
        etag_md5_match = None
        if etag and len(etag) == 32 and "-" not in etag:
            with open(dest, "rb") as fh:
                md5 = hashlib.md5(fh.read()).hexdigest()
            etag_md5_match = (md5 == etag.lower())
            etag_ok += 1 if etag_md5_match else 0
        else:
            etag_na += 1

        if size_ok and (etag_md5_match is not False):
            ok += 1; state = "OK"
        else:
            mismatch += 1; state = "SIZE/CHECKSUM MISMATCH"
        results.append({"object_path": path, "status": state, "http": status,
                        "expected_size": exp_size, "local_size": local_size,
                        "sha256": digest, "manifest_etag": etag,
                        "etag_md5_match": etag_md5_match})
        if state != "OK":
            print(f"[{i}/{len(rows)}] {state}  {path}  exp={exp_size} local={local_size}")

    # write verified manifests
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "verified-manifest.json"), "w") as jf:
        json.dump(results, jf, indent=2)
    with open(os.path.join(args.out, "verified-manifest.csv"), "w", newline="") as cf:
        w = csv.DictWriter(cf, fieldnames=list(results[0].keys()))
        w.writeheader(); w.writerows(results)

    print("\n================ BACKUP VERIFICATION SUMMARY ================")
    print(f"manifest files ........ {len(rows)}")
    print(f"verified OK ........... {ok}")
    print(f"size/checksum mismatch  {mismatch}")
    print(f"missing / failed ...... {failed}")
    print(f"eTag(MD5) confirmed ... {etag_ok}   (eTag not MD5-comparable: {etag_na})")
    print(f"bytes on disk ......... {total_bytes:,}  ({total_bytes/1048576:.1f} MiB)")
    print(f"elapsed ............... {time.time()-t0:.0f}s")
    print("verified-manifest.csv / .json written to", args.out)
    if failed or mismatch:
        print(">>> INCOMPLETE — investigate the FAIL/MISMATCH lines above and re-run.")
        sys.exit(1)
    print(">>> COMPLETE — every manifest object is backed up and verified.")


if __name__ == "__main__":
    main()
