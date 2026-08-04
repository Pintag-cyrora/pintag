-- ============================================================================
-- PHOTO RECOVERY — match surviving Storage photos back to recovered listings
-- ============================================================================
-- The property photos survived the attack (deleting DB rows never touches
-- Storage). What was destroyed is the LINK: images were referenced only by the
-- deleted properties.images arrays, and admin.html uploads them FLAT as
-- `<epoch_ms>-<rand>.<ext>` (admin.html:3660) — the path/filename contains NO
-- property UUID. So there is no signal for a fully-automatic UUID match.
--
-- SIGNALS ACTUALLY AVAILABLE, best → worst:
--   1. External evidence (HIGH): Wayback Machine / Google cache of the old
--      listing pages contain <img src=".../property-images/<file>"> next to the
--      listing's title/slug. This is the only signal that maps a file to a
--      SPECIFIC listing with high confidence — see "STEP E".
--   2. Upload-time clustering (MEDIUM): a listing's photos were uploaded in one
--      burst, seconds/minutes apart. Grouping orphaned files by upload-time gaps
--      reconstructs probable per-listing galleries — but which listing each
--      cluster belongs to still needs a human/Wayback assignment.
--   3. Size/mimetype metadata (LOW): weak; only helps dedupe.
-- Image hashes are NOT stored by Supabase; folder structure is flat (no help).
--
-- This script does the SQL-automatable part (inventory, orphan detection,
-- clustering, confidence, guarded attach + verification). Assigning a cluster
-- to a listing is a human step (STEP C), because the identifier is gone.
--
-- NOTE: production `properties.images` is JSONB (a JSON array of URL strings) —
-- NOT text[]. All checks below use jsonb operators (`::text` scan for the
-- filename; `jsonb_typeof`/`jsonb_array_length` guarded by CASE so a non-array
-- value can never raise an error), and STEP D writes with `jsonb_build_array`.
-- ============================================================================

-- ── STEP A — Inventory every surviving photo ────────────────────────────────
SELECT count(*)                                   AS total_photos,
       min(created_at)                            AS earliest_upload,
       max(created_at)                            AS latest_upload,
       round(sum((metadata->>'size')::numeric)/1048576.0, 1) AS total_mb
FROM storage.objects WHERE bucket_id = 'property-images';

-- ── STEP B — Orphaned photos (not referenced by any surviving listing) ──────
-- These are the deleted listings' photos — the recovery target. (Recovered
-- drafts have NULL images, and the 5 survivors reference only their own few.)
WITH photos AS (
  SELECT name, created_at,
         (metadata->>'size')::bigint AS size_bytes,
         metadata->>'mimetype'       AS mimetype
  FROM storage.objects WHERE bucket_id = 'property-images'
)
SELECT count(*) AS orphaned_photos
FROM photos p
WHERE NOT EXISTS (
  SELECT 1 FROM properties pr
  WHERE pr.images IS NOT NULL
    AND pr.images::text LIKE '%' || p.name || '%'   -- JSONB: scan the array's text for the filename
);

-- ── STEP C — Reconstruct probable galleries by upload-time clustering ───────
-- Each cluster ≈ one listing's photo set (uploaded together). Review each
-- cluster's files, then assign it to a recovered listing in STEP D.
-- Tune the gap (default 10 min) to how your uploads actually burst.
WITH photos AS (
  SELECT name, created_at, (metadata->>'size')::bigint AS size_bytes
  FROM storage.objects WHERE bucket_id = 'property-images'
),
orphans AS (
  SELECT p.* FROM photos p
  WHERE NOT EXISTS (
    SELECT 1 FROM properties pr
    WHERE pr.images IS NOT NULL
      AND pr.images::text LIKE '%' || p.name || '%')
),
gapped AS (
  SELECT *,
    CASE WHEN lag(created_at) OVER (ORDER BY created_at) IS NULL
           OR created_at - lag(created_at) OVER (ORDER BY created_at) > interval '10 minutes'
         THEN 1 ELSE 0 END AS is_new_cluster
  FROM orphans
),
clustered AS (
  SELECT *, sum(is_new_cluster) OVER (ORDER BY created_at) AS cluster_id FROM gapped
)
SELECT cluster_id,
       count(*)                              AS photos,
       min(created_at)                       AS cluster_start,
       max(created_at)                       AS cluster_end,
       -- confidence heuristic for "this cluster is one real listing gallery":
       CASE
         WHEN count(*) BETWEEN 3 AND 20 THEN 'MEDIUM'   -- a plausible gallery size
         WHEN count(*) BETWEEN 1 AND 2  THEN 'LOW'      -- too few to be sure
         ELSE 'REVIEW'                                  -- unusually large; may be several listings
       END                                   AS cluster_confidence,
       array_agg(name ORDER BY created_at)   AS files
FROM clustered
GROUP BY cluster_id
ORDER BY cluster_start;

-- ── STEP D — Attach a confirmed cluster to a listing (GUARDED, never overwrite)
-- After you've matched a cluster to a recovered listing (via the photos +
-- Wayback/knowledge), attach its files. Only fills an EMPTY images array, so it
-- can never clobber data and is safe to re-run. Build the URL list from the
-- cluster's `files` in STEP C.
--
--   UPDATE properties
--   SET images = jsonb_build_array(               -- JSONB column, not text[]
--     'https://eoladhcljbpbhnrmmpev.supabase.co/storage/v1/object/public/property-images/<file1>',
--     'https://eoladhcljbpbhnrmmpev.supabase.co/storage/v1/object/public/property-images/<file2>'
--     -- ... in display order
--   )
--   WHERE id = '<recovered-listing-uuid>'
--     -- guard: only fill when currently empty, never overwrite (safe to re-run)
--     AND (images IS NULL
--          OR jsonb_typeof(images) <> 'array'
--          OR jsonb_array_length(images) = 0);

-- ── STEP E — HIGH-confidence remap from Wayback (external, not SQL) ─────────
-- The one path that assigns files to a SPECIFIC listing automatically:
--   1. Get old snapshots:  http://web.archive.org/cdx/search/cdx?url=pintag.io/listing.html*&output=json&fl=original,timestamp
--      (and pintag.io/listings.html* for the search-grid cards).
--   2. Fetch each snapshot; extract the slug/title and its
--      <img src=".../property-images/<file>"> URLs.
--   3. Match slug/title → a recovered listing (title_lo from the manifest);
--      the file URLs are that listing's real gallery in the real order → run
--      STEP D with confidence = HIGH.
-- Google cache and shared WhatsApp/Facebook link previews (og:image) are
-- secondary sources for the cover photo.

-- ── STEP F — Verification / report ──────────────────────────────────────────
-- Progress: how many listings now have photos vs. still empty.
SELECT
  count(*) FILTER (WHERE CASE WHEN jsonb_typeof(images)='array'
                              THEN jsonb_array_length(images) > 0 ELSE false END) AS listings_with_photos,
  count(*) FILTER (WHERE CASE WHEN images IS NULL                 THEN true
                              WHEN jsonb_typeof(images) <> 'array' THEN true
                              WHEN jsonb_array_length(images) = 0  THEN true
                              ELSE false END)                                     AS listings_without_photos,
  count(*)                                                                        AS listings_total
FROM properties;

-- Report buckets:
--   * "matched automatically (HIGH)"  = listings attached via STEP E Wayback evidence.
--   * "requires manual review (MEDIUM)" = STEP C clusters not yet Wayback-confirmed.
--   * "no matching photos"            = recovered listings with no assignable cluster left.
-- Remaining orphaned photos after attachment (should trend to 0 as you assign):
WITH photos AS (SELECT name FROM storage.objects WHERE bucket_id='property-images')
SELECT count(*) AS unassigned_photos_remaining
FROM photos p
WHERE NOT EXISTS (SELECT 1 FROM properties pr
  WHERE pr.images IS NOT NULL AND pr.images::text LIKE '%'||p.name||'%');
