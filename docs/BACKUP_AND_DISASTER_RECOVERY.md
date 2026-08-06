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

## 5b. Recovery objectives (RPO / RTO) — committed, not aspirational
*Defined 2026-08-06 as part of the L1 Production Safe baseline.*

| Objective | Target | Provided by |
|---|---|---|
| **RPO — platform-level failure** (bad write, bad migration, accidental delete) | **≤ 5 minutes** | Supabase **PITR** — must be enabled in Dashboard → Database → Backups (operator step; verify it is ON before reopening) |
| **RPO — catastrophic / account-level loss** (Supabase account or region gone) | **≤ 7 days** | The weekly off-platform backup to R2 (`backup.yml`); tighten to nightly by changing its cron once volume warrants |
| **RTO — full restore, drilled** | **≤ 2 hours** | `scripts/restore-production.sh` + the runbook below; the automated drill's 60-minute job timeout proves substantial headroom every quarter |

**These numbers only count while the drill stays green.** The quarterly
**DR Restore Drill** (`.github/workflows/restore-drill.yml`, also runnable on
demand) restores the latest R2 snapshot into a scratch database, runs
`restore-validation.sql`, and compares row counts against the values recorded
at backup time — any mismatch fails the run and notifies. A backup that has
never been restored does not count as a backup; after the drill, every backup
has been.

Key model: dumps are age-encrypted to **two recipients** listed in
`ops/backup.age.pub` — the offline **master** key (real disasters, human use
only) and a **drill** key held solely as the `BACKUP_AGE_DRILL_KEY` secret so
CI can prove restorability without ever touching the master key. Setup:
`ops/README.md`.

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

## 7. The complete-backup system (GitHub Actions → Cloudflare R2)
Beyond the manual Storage backup above, the scheduled workflow
`.github/workflows/backup.yml` produces a **full** production backup weekly and
uploads it to **Cloudflare R2** (off-Supabase, zero egress). Layout:
`backup-YYYY-MM-DD/{database,storage,verification,metadata}` with the photo pool
stored once at `R2:<bucket>/storage/objects` (immutable, append-only) and
referenced by each day's `storage/manifest.csv`.

Components:
- `scripts/backup-database.sh` — dump + schema + extensions + migrations + RLS +
  functions + auto-discovered relationship CSVs + reference exports.
- `scripts/verify-db-backup.py` — fail-closed row-count verification.
- `scripts/restore-production.sh` + `scripts/restore-validation.sql` — restore + report.
- `scripts/create-backup-ro-role.sql` — least-privilege read-only DB role.

**One-time provisioning (setup):**
1. Create the R2 bucket + a **scoped Object-Read+Write token** (no Delete; retention via lifecycle).
2. Run `scripts/create-backup-ro-role.sql` in prod; put its URL in `PINTAG_PROD_DB_URL`.
3. `age-keygen -o backup-age-key.txt` → keep the **private** key offline; commit the **public** key to `ops/backup.age.pub`.
4. Create Supabase Storage S3 access keys (read) for the incremental pool sync.
5. Add secrets to the `production-backup` GitHub Environment: `PINTAG_PROD_DB_URL`,
   `R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET`,
   `SUPABASE_S3_ENDPOINT/…_ACCESS_KEY_ID/…_SECRET_ACCESS_KEY`.

## 8. Database scope — restorable vs reference vs recreated (NO AMBIGUITY)
| Component | Classification | How |
|---|---|---|
| `public` schema: tables, data, functions, RLS policies, triggers, indexes | ✅ **Fully restorable** | `pg_restore database/full.dump` |
| Extensions | ✅ Fully restorable (recreate) | `database/extensions.txt` → `CREATE EXTENSION` |
| Applied migration head | ✅ Reference for alignment | `database/migrations.csv` |
| **Photo files** (`property-images`) | ✅ **Fully restorable** | R2 pool → bucket, **names preserved** ⇒ image URLs resolve |
| `storage.objects` metadata rows | ✅ Recreated on re-upload | re-uploading files recreates them; `manifest.csv` is the reference |
| Relationship tables (CSV) | ✅ Fully restorable (table-level) | `\copy` each CSV back |
| **`auth.users` (accounts)** | ⚠️ **Reference only** | GoTrue-managed; cannot `pg_restore` into a managed project; **re-provision admin manually** (`FIRST_ADMIN_ONBOARDING.md`) |
| `auth` internals (sessions, identities, MFA factors) | ❌ **Not restored** | transient; recreated on login/enrollment |
| Supabase project config (Site URL, redirect URLs, SMTP, MFA toggle, API keys) | 🔧 **Recreated manually** | dashboard settings — keep current values documented |
| Edge Functions | 🔧 Recreated manually | deploy from `supabase/functions/` |
| Cloudflare worker + DNS | 🔧 Recreated manually | `og-listing-preview.js` + CF config |

## 9. Relationship tables — auto-discovered (evolves with the schema)
`backup-database.sh` exports a CSV for **every** public table that (a) has a
foreign key to `properties`/`parties`/`contacts`/`owners`, or (b) carries a
`property_id`/`listing_id`/`party_id`/`contact_id`/`owner_id`/`managed_by_party_id`
column — **plus** an explicit core set (`properties, properties_removal_log,
parties, contacts, owners, leads, lead_events, unit_types, listing_events,
admin_accounts, listings`). The exact set captured each run is recorded in
`database/relationships/_INCLUDED_TABLES.txt`.
**Maintenance:** a new relationship table is picked up automatically if it uses a
FK or a standard `*_id` column. Only a table that references a listing via a
**non-standard, non-FK** column needs a one-line addition to the `core` list in
`backup-database.sh`. (The full `pg_dump` always contains every table regardless.)

## 10. Restore validation report
Every restore (drill or real) runs `restore-validation.sql` and prints:
`property / party / owner / contact / lead / lead_events` counts, `storage
object count`, `migration_head`, `rls_policies_present`, `functions_present`.
`restore-production.sh` compares counts to `metadata/backup.json` and emits:
```
✓ Database restored   ✓ Storage restored   ✓ Relationships restored
✓ Security restored   ✓ Ready for production
```
Any mismatch prints `✗` and exits non-zero — a failed restore can't be mistaken for success.

## 11. Retention (GFS, via R2 lifecycle rules — server-side, no delete token)
- Per-date DB+metadata snapshots: **12 weekly**, **12 monthly**, **2 yearly**.
- Photo object pool: **permanent** (append-only; each photo is unique). Prune only objects unreferenced by any retained manifest.

## 12. Roadmap — Backup Health Dashboard (Phase 2, not yet built)
A simple read-only dashboard sourced from the R2 `metadata/backup.json` files:
last successful backup, last verification result, backup size, DB size, storage
size, photo count, listing count, and last DR-drill restore status. Deferred
until the Phase-1 backup + a successful DR drill are complete.

---

### Quick reference
```bash
# full, verified, timestamped backup in one command:
PINTAG_PROD_DB_URL="postgresql://postgres.<ref>:<pw>@<host>:5432/postgres" \
  ./scripts/backup-production-assets.sh --out-root /path/to/offsite/backups
```
Backup is complete when the summary shows `size/checksum mismatch 0` and
`missing / failed 0`, and a copy is stored off Supabase.
