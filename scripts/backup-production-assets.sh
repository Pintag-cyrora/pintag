#!/usr/bin/env bash
# backup-production-assets.sh — Pintag's standard, READ-ONLY production asset
# backup. Exports the property-images Storage manifest from the production DB,
# downloads every object from the public bucket, verifies the copy, and leaves a
# timestamped, self-describing backup folder.
#
# NOTHING is ever written to production: the only DB access is a SELECT/\copy
# against storage.objects, and the only Storage access is public GETs.
#
# Run from your own machine (needs network to the production Session Pooler and
# to the public bucket — this cannot run from a sandboxed Claude Code session).
#
# Usage:
#   PINTAG_PROD_DB_URL="postgresql://postgres.eoladhcljbpbhnrmmpev:<pw>@<pooler-host>:5432/postgres" \
#   ./scripts/backup-production-assets.sh [--out-root ./backups]
#
# Requirements: bash, psql, python3 (stdlib only).
# Exit code is non-zero if verification finds any missing/mismatched file, so
# this is safe to wire into cron / CI and alert on failure.

set -euo pipefail

BUCKET="property-images"
OUT_ROOT="./backups"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-root) OUT_ROOT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${PINTAG_PROD_DB_URL:?Set PINTAG_PROD_DB_URL to the production Session Pooler connection string (read-only use)}"

command -v psql   >/dev/null || { echo "psql not found"   >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }

TS="$(date -u +%Y%m%d-%H%M%SZ)"
DEST="${OUT_ROOT%/}/${BUCKET}-${TS}"
mkdir -p "$DEST"
MANIFEST="$DEST/manifest.csv"

echo "== Pintag production asset backup =="
echo "bucket:      $BUCKET"
echo "destination: $DEST"
echo

# ── 1. Export the Storage manifest (read-only SELECT via \copy) ──────────────
echo "== Exporting Storage manifest from storage.objects (read-only) =="
psql "$PINTAG_PROD_DB_URL" -v ON_ERROR_STOP=1 -c "\copy ( \
  select name as object_path, \
         (metadata->>'size')::bigint as file_size_bytes, \
         metadata->>'mimetype' as mimetype, \
         coalesce(metadata->>'eTag', metadata->>'etag') as etag_checksum, \
         created_at, updated_at \
  from storage.objects where bucket_id = '${BUCKET}' order by name \
) TO '${MANIFEST}' WITH (FORMAT csv, HEADER true)"

FILE_COUNT="$(( $(wc -l < "$MANIFEST") - 1 ))"
echo "manifest rows: $FILE_COUNT  ->  $MANIFEST"
if [[ "$FILE_COUNT" -le 0 ]]; then
  echo "Manifest is empty — aborting (nothing to back up, or wrong project)." >&2
  exit 1
fi

# ── 2 & 3. Download every object, then verify ────────────────────────────────
echo
echo "== Downloading + verifying every object =="
python3 "$SCRIPT_DIR/backup-property-images.py" \
  --manifest "$MANIFEST" \
  --out "$DEST/objects"

echo
echo "== Independent verification pass (no downloads) =="
python3 "$SCRIPT_DIR/backup-property-images.py" \
  --manifest "$MANIFEST" \
  --out "$DEST/objects" \
  --verify-only

# ── 4. Record a small backup receipt ─────────────────────────────────────────
cat > "$DEST/BACKUP_INFO.txt" <<EOF
Pintag production asset backup
bucket:        $BUCKET
taken_at_utc:  $TS
manifest_files: $FILE_COUNT
objects_dir:   objects/
manifest:      manifest.csv
verification:  objects/verified-manifest.csv (+ .json)
EOF

echo
echo "== DONE =="
echo "Backup folder: $DEST"
echo "Store at least one copy OFF Supabase (see docs/BACKUP_AND_DISASTER_RECOVERY.md)."
