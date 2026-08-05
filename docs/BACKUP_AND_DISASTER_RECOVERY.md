# Pintag — Backup & Disaster Recovery

Canonical procedure for protecting Pintag's irreplaceable production assets —
above all the **professionally edited listing photos** in the Supabase Storage
bucket `property-images`. Deleting database rows (as the 2026-08-03 incident did)
never touches Storage, but Storage itself has **no second copy** unless we make
one. This document is that safety net.

> **Everything here is read-only against production.** The backup path only runs
> `SELECT`/`\copy` on `storage.objects` and public `GET`s on the bucket. No step
> writes to the database or to Storage. Restore (which *does* write) is a
> separate, deliberate, admin-only procedure — see [§4](#4-restore-if-storage-is-ever-lost).

## What is backed up
| Asset | Where it lives | Backed up by |
|---|---|---|
| Edited listing photos | Storage bucket `property-images` (public-read) | this procedure |
| Agent photos | Storage bucket `agent-photos` | same tools, `--bucket`-adjust |
| Database (listings, parties, leads, …) | Postgres | Supabase automated PITR + a periodic `pg_dump` (out of scope here; see note in §5) |

The tools:
- `scripts/backup-property-images.py` — download + verify engine (stdlib only).
- `scripts/backup-production-assets.sh` — one-command wrapper (manifest → download → verify → timestamped folder).

---

## 1. How to export the Storage manifest
The manifest is the source-of-truth list of every object with its size,
timestamps, and checksum. Export it from the production SQL editor (**Download
CSV** → `property-images-manifest.csv`):

```sql
select
  name                        as object_path,
  (metadata->>'size')::bigint as file_size_bytes,
  metadata->>'mimetype'       as mimetype,
  coalesce(metadata->>'eTag', metadata->>'etag') as etag_checksum,
  created_at,
  updated_at
from storage.objects
where bucket_id = 'property-images'
order by name;
```
Totals (sanity check):
```sql
select count(*) as total_files,
       round(sum((metadata->>'size')::numeric)/1073741824.0, 3) as total_gb
from storage.objects where bucket_id = 'property-images';
```
The wrapper script does this export for you via `psql \copy` — no manual step
needed when you use `backup-production-assets.sh`.

## 2. How to download every object
The bucket is **public-read**, so no keys are required.

**One command (recommended):**
```bash
PINTAG_PROD_DB_URL="postgresql://postgres.eoladhcljbpbhnrmmpev:<pw>@<pooler-host>:5432/postgres" \
  ./scripts/backup-production-assets.sh
# → ./backups/property-images-<UTC-timestamp>/
```

**Manual (if you already have the manifest CSV):**
```bash
python3 scripts/backup-property-images.py \
  --manifest property-images-manifest.csv \
  --out ./property-images-backup
```
Downloads stream from `…/storage/v1/object/public/property-images/<name>`, retry
with backoff, and **skip any file already present at the correct size** — an
interrupted run resumes cleanly.

## 3. How to verify the backup
Verification is built into the run and can be repeated without downloading:
```bash
python3 scripts/backup-property-images.py \
  --manifest property-images-manifest.csv \
  --out ./property-images-backup --verify-only
```
For every object it checks **present**, **local size == manifest size**, computes
a **SHA-256**, and confirms the **eTag/MD5** when the eTag is a plain MD5. It
writes `verified-manifest.csv` / `.json` and prints:
```
manifest files ........ N
verified OK ........... N
size/checksum mismatch  0
missing / failed ...... 0
```
**A backup is valid only when `verified OK == manifest files` and mismatch/failed
are both 0.** The script exits non-zero otherwise, so a partial backup can never
be mistaken for a complete one (safe to alert on in cron/CI).

## 4. Restore if Storage is ever lost
Restore **writes** to Storage, so it requires admin credentials and is done
deliberately. Object **names are preserved**, so restoring to the same bucket
makes every existing `properties.images` URL resolve again with no DB change.

Prerequisites: the verified backup folder, and the project **`service_role`** key
(Storage writes are gated to `is_pintag_admin` / service role). Never commit or
paste this key anywhere persistent.

```bash
# Re-upload every backed-up object to the same path (idempotent: upsert).
SVC="<service_role_key>"           # keep out of shell history / files
BASE="https://eoladhcljbpbhnrmmpev.supabase.co/storage/v1/object/property-images"
cd property-images-backup/objects
find . -type f ! -name 'verified-manifest.*' | sed 's|^\./||' | while read -r f; do
  curl -s -X POST "$BASE/$f" \
    -H "Authorization: Bearer $SVC" \
    -H "x-upsert: true" \
    -H "Content-Type: $(file --mime-type -b "$f")" \
    --data-binary @"$f" >/dev/null \
    && echo "restored $f" || echo "FAILED  $f"
done
```
After restore, re-run the **manifest export + `--verify-only`** against production
to confirm `storage.objects` matches the backup (count + sizes). If only specific
listings' galleries were lost, restore just those files (the manifest maps each
file's `object_path`).

> If the whole Supabase project is lost (not just Storage), recreate the bucket
> `property-images` (public-read, admin-only write per
> `supabase/migrations/…_storage_admin_only_cyrora.sql`) **before** running the
> restore loop.

## 5. How often to back up
| Situation | Frequency |
|---|---|
| Normal operations | **Weekly** full asset backup (automated). |
| Active editing / bulk photo uploads | **Daily**, or immediately after a large upload session. |
| Before any risky operation | **On demand** — before migrations, bulk edits, or recovery work. |

Because the download step is **incremental** (skips unchanged files by size), a
scheduled run is cheap after the first full pull — only new/changed objects are
fetched. Wire `backup-production-assets.sh` into a scheduler (cron, a CI nightly
job, or a Pintag scheduled task) and alert on any non-zero exit.

## 6. Where backups are stored
**At least one copy must live off Supabase.** Recommended layout:
1. **Primary off-site copy** — a dedicated object store you control (e.g. a
   separate cloud bucket, or encrypted external/NAS storage). This is the copy
   that survives a Supabase-account-level loss.
2. **Second copy** — a different location/provider from #1 (a second region or a
   physically separate drive), following 3-2-1: **3** copies, **2** media, **1**
   off-site.
3. Keep the **`verified-manifest.csv`** alongside each copy — it is what proves a
   copy is complete and untampered (SHA-256 per file).

Do **not** treat the live Supabase bucket as a backup of itself, and do not store
the only copy on the same machine that talks to production.

---

### Quick reference
```bash
# full, verified, timestamped backup in one command:
PINTAG_PROD_DB_URL="postgresql://postgres.<ref>:<pw>@<host>:5432/postgres" \
  ./scripts/backup-production-assets.sh --out-root /path/to/offsite/backups
```
Backup is complete when the summary shows `size/checksum mismatch 0` and
`missing / failed 0`, and a copy is stored off Supabase.
