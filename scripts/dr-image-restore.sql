-- ============================================================================
-- DR proof: reconstruct listings' galleries from the image registry alone.
-- ============================================================================
-- Run this against a RESTORED SCRATCH database (never production) after loading
-- a backup — e.g. inside the restore-drill scratch Postgres. It proves the
-- chain the whole system exists to guarantee:
--
--     property  ->  property_images row  ->  storage object (path/sha256)
--                ->  correct display order  ->  correct cover image
--
-- SELECT-only by default (safe). It compares what the registry would rebuild
-- against the listing's own images array and reports any divergence. The
-- optional Section D shows the actual disaster reconstruction and is commented
-- out — uncomment ONLY in a scratch DB.
--
-- FAIL SIGNAL: if Section C returns any rows, the registry does NOT faithfully
-- reproduce a listing's gallery — investigate before trusting the backup.
-- ============================================================================

\echo '== A. Coverage =='
SELECT
  (SELECT count(*) FROM properties)                                   AS listings,
  (SELECT count(*) FROM property_images)                              AS registry_rows_all,
  (SELECT count(*) FROM property_images WHERE status='active')        AS registry_rows_active,
  (SELECT count(*) FROM property_images WHERE sha256 IS NOT NULL)     AS rows_with_sha256,
  (SELECT count(DISTINCT property_id) FROM property_images WHERE status='active') AS listings_with_registry_images;

\echo '== B. Sample reconstruction (registry -> ordered gallery, cover first) =='
SELECT p.id AS property_id,
       left(coalesce(p.title_en, p.title_lo, ''), 40) AS title,
       rebuild_images_from_registry(p.id) AS rebuilt_gallery
FROM properties p
WHERE EXISTS (SELECT 1 FROM property_images pi WHERE pi.property_id=p.id AND pi.status='active')
ORDER BY p.created_at DESC
LIMIT 10;

\echo '== C. Divergence check (MUST be empty): registry rebuild vs listing images =='
-- Compares the registry's rebuilt array (active, our-bucket + external) to the
-- listing's stored images array. Any row here is a listing the registry would
-- NOT reconstruct identically (wrong order, missing image, or wrong cover).
WITH rebuilt AS (
  SELECT p.id AS property_id,
         rebuild_images_from_registry(p.id) AS reg,
         CASE WHEN jsonb_typeof(p.images)='array' THEN p.images ELSE '[]'::jsonb END AS live
  FROM properties p
)
SELECT property_id, live, reg
FROM rebuilt
WHERE live <> reg
  AND jsonb_array_length(live) > 0;   -- ignore listings with no images

\echo '== C2. Cover consistency (MUST be empty): registry cover != listing images[0] =='
SELECT pi.property_id, pi.storage_url AS registry_cover, p.images->>0 AS listing_cover_url
FROM property_images pi
JOIN properties p ON p.id = pi.property_id
WHERE pi.status='active' AND pi.is_cover
  AND jsonb_typeof(p.images)='array' AND jsonb_array_length(p.images) > 0
  AND regexp_replace(coalesce(p.images->>0,''),'^.*/property-images/','') <> pi.storage_path
  AND (p.images->>0) <> pi.storage_url;

-- ============================================================================
-- D. (OPTIONAL, SCRATCH DB ONLY) Actual disaster reconstruction demo.
-- Simulates "properties.images was wiped" and rebuilds it from the registry.
-- DO NOT run against production. Uncomment to demonstrate in the drill:
-- ============================================================================
-- BEGIN;
--   UPDATE properties SET images = '[]'::jsonb;                       -- simulate loss
--   UPDATE properties p SET images = rebuild_images_from_registry(p.id)
--     WHERE EXISTS (SELECT 1 FROM property_images pi WHERE pi.property_id=p.id AND pi.status='active');
--   \echo 'Rebuilt galleries for listings from the registry:'
--   SELECT count(*) FROM properties WHERE jsonb_array_length(images) > 0;
-- ROLLBACK;   -- prove it without persisting; use COMMIT only in a throwaway DB
