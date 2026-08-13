# Pintag Image Disaster Recovery — Registry & Runbook

Goal: if we lose the production database or image storage tomorrow, we can still
determine **exactly which image belongs to which listing**, in what order, with
which cover, and restore the library — from an independent, off-site copy.

This system **elevates** Pintag's existing provenance + R2 backup rather than
replacing it. Image identity no longer depends on a filename or URL.

---

## 1. Architecture

| Layer | Role | Source of truth? |
|---|---|---|
| `properties.images` (jsonb URL array, `[0]`=cover) | Display **cache** the frontend reads | No — derived cache |
| **`property_images`** (new table) | **Authoritative registry**: immutable `id`, `property_id`, path, order, `is_cover`, `sha256`, size/mime/dims, `status` | **Yes** |
| `listing_image_snapshots` / `import_images` | Append-only **history/provenance** | Historical record |
| Cloudflare **R2** (off-Supabase, separate creds, age-encrypted) | Independent **backup** of DB dump + registry manifest + image bytes | Recovery copy |

**Key property:** `property_images.id` (UUID) + `property_id` + `sha256` identify
an image even if its filename/path changes. The registry is **derived from
`properties.images` by a database trigger** (`trg_property_images_sync`), so the
app keeps a single writer (`properties.images`) and the registry stays in sync
on every upload / reorder / cover change / delete — with no app-code change and
no competing writer.

## 2. What each piece does

- **Migration** `supabase/migrations/20260813000000_property_images_registry.sql`
  — creates `property_images`, the sync function + trigger, the DR rebuild
  function, and an **idempotent backfill** from existing data. Additive; never
  touches storage or `properties.images`.
- **Sync** — `pintag_sync_property_images(property, images)` upserts a row per
  current image (order + cover from position) and **soft-removes** (never
  deletes) rows whose object left the gallery, preserving the UUID→listing map
  forever.
- **Hashing pass** `scripts/image-hash-backfill.py` — fills `sha256`/size/mime/
  dims by reading bytes off the public CDN. Resumable, metadata-only writes.
- **Integrity** `scripts/image-integrity.py` + `.github/workflows/image-integrity.yml`
  — weekly read-only check; **fails loudly** on missing/orphaned/invalid/cover-order
  anomalies.
- **Backup** `.github/workflows/backup.yml` — now also exports the registry
  (`registry/property_images.{csv,json}`), age-encrypted, into the weekly R2
  snapshot alongside the DB dump, storage manifest, and image bytes.
- **DR proof** `scripts/dr-image-restore.sql` — run in a scratch/restored DB;
  rebuilds each listing's gallery from the registry and asserts order + cover.

## 3. Applying to production (safe, additive)

1. The migration is applied via the gated **`apply-migration.yml`** workflow
   (dry-run first, manual `APPLY` confirmation). It requires `SUPABASE_ACCESS_TOKEN`
   and `SUPABASE_DB_PASSWORD`.
   - **Note:** that workflow's safety gate authorizes one migration id at a time
     (`EXPECTED_MIGRATION`). Apply `20260812000000_property_available_from` first,
     then bump `EXPECTED_MIGRATION`/`EXPECTED_MIGRATION_FILE` to
     `20260813000000_property_images_registry` and run it. The backfill runs
     inside the migration and is idempotent.
2. After the migration, run the hashing pass (in the `production-backup` env):
   `python3 scripts/image-hash-backfill.py --limit 1000` — re-run until it
   reports nothing left (resumable).
3. Run the integrity check (`image-integrity.yml`, manual dispatch) — expect
   `STATUS: HEALTHY` (orphaned>0 only if old removed-from-gallery objects exist;
   those are still mapped via `status='removed'` rows, so they are NOT orphaned).

Nothing here deletes or renames a storage object or edits `properties.images`.

## 4. Disaster-recovery procedure (tested in a scratch DB, never prod)

```
property ──▶ property_images row ──▶ storage object (path + sha256)
          ──▶ display_order ──▶ is_cover
```

1. Pull the latest R2 snapshot (age-decrypt with the offline key). It contains:
   the DB dump, `registry/property_images.json`, the storage manifest, and the
   image bytes under `storage/objects/`.
2. Restore the DB dump into a scratch Postgres (see `restore-drill.yml`).
3. Run `scripts/dr-image-restore.sql`:
   - Section C / C2 must return **no rows** (registry reconstructs each gallery
     and cover exactly).
   - Section D (scratch only) demonstrates rebuilding `properties.images` from
     the registry after simulating total loss:
     `UPDATE properties p SET images = rebuild_images_from_registry(p.id)`.
4. Re-materialize image files keyed by immutable UUID for a clean library:
   for each active registry row, copy `storage/objects/<storage_path>` to
   `property_id/<image_uuid>.<ext>` (identity = UUID, **not** filename).

**This is not considered working until step 3 has actually run green in the
drill.** From this sandbox I cannot reach Supabase/R2, so the drill must run in
CI or on an operator machine.

## 5. Security review

- **RLS**: `property_images` — admin-only read/write (`is_pintag_admin`). Storage
  writes already admin-only; buckets public-read (CDN).
- **Service role**: the browser uses only the anon key + an admin JWT (AAL2); no
  service-role key is exposed client-side. The trigger/functions are
  `SECURITY DEFINER` and run server-side.
- **Backup credentials** live in the protected **`production-backup`** GitHub
  environment (separate S3/R2 keys, distinct from app/prod DB app creds). No
  secrets in the repo.
- **Immutability — do NOT lock the existing working bucket.** The current
  `$R2_BUCKET` holds two different kinds of data with incompatible needs:
  - `storage/objects/**` is written by **`rclone sync`**, which **deletes and
    overwrites** — it is a *mirror* (a prod-side deletion propagates here within
    a week), NOT an archive. Object-lock here **breaks the sync**.
  - `backup-YYYY-MM-DD/**` are append-only per-date snapshots, likely governed by
    a lifecycle/expiry rule configured in the Cloudflare dashboard (not in this
    repo — **verify it before touching retention**).

  So immutability must go on a **dedicated, separate Object-Lock bucket**
  (R2 Object Lock can only be enabled **at bucket creation** — it cannot be
  retro-fitted to `$R2_BUCKET` anyway) with a **bounded retention** (e.g. 90–180
  days, Compliance mode) matched to the recovery window. **Never set indefinite
  retention:** object-lock overrides lifecycle deletion until it expires, so an
  indefinite lock means nothing can ever be pruned (unbounded growth, no cleanup
  path). The weekly job writes an append-only (`rclone copy`, never `sync`) copy
  of the age-encrypted snapshot — and, for deleted-image protection, of the
  object pool — into that locked bucket, with **separate credentials**. Backups
  are **age-encrypted** to an offline master key CI never holds (a drill-only key
  decrypts in CI).
- **Attacker deleting the backup**: with the separate locked bucket (bounded
  retention) + separate credentials + offline decryption key, an
  application/database compromise cannot silently erase or read the off-site
  copy — and, unlike the mirror pool, a prod deletion cannot propagate into it.

## 6. Remaining risks / follow-ups

- Hashing all existing images is I/O-heavy — done incrementally by the resumable
  pass; until complete, hash-coverage < 100% (structural checks still pass).
- `unit_types.images` galleries are not yet in the registry (second pass — same
  trigger pattern on `unit_types`).
- Orphaned-object **cleanup** is intentionally out of scope (we record, never
  delete). Stand up the dedicated locked backup bucket (above) before considering
  any cleanup.
- The image byte pool in `$R2_BUCKET/storage/objects` is a **`rclone sync`
  mirror**, so a production deletion propagates to it within a week — it is not
  by itself a defence against deletion. The dedicated bounded-retention
  Object-Lock bucket is what provides that defence; provision it before relying
  on R2 as the last copy of the images.
