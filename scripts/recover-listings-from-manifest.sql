-- ============================================================================
-- LISTING RECOVERY — Phase 1: skeleton from the removal manifest
-- ============================================================================
-- Re-creates the deleted listings from properties_removal_log, which survived
-- the attack intact. The attacker overwrote only title_en ('HACKED'); title_lo
-- (the real Lao titles) is preserved, along with property_type, district_en,
-- transaction_type, and the ORIGINAL property_id (UUID).
--
-- What this recovers now: id (original UUID), title_lo, property_type,
-- district_en, transaction_type. Everything else (price, bedrooms, sizes,
-- images, description, village, coordinates, amenities, contact/owner/agent,
-- slug, SEO/AI content) is NOT in the manifest and is left NULL — to be
-- enriched in Phase 2 from Storage photos, web/Wayback caches, Facebook
-- sources, and the agents. Nothing is fabricated.
--
-- SAFETY:
--   * Idempotent — never overwrites an existing row (NOT EXISTS on id).
--   * Recovered rows are created as DRAFT (workflow_status/status='draft'), so
--     incomplete listings are NOT shown publicly until you review, enrich, and
--     publish each one.
--   * Transactional — inspect with the counts, then COMMIT or ROLLBACK.
--   * Only recovers rows that still have a real title_lo (skips the few whose
--     title_lo was also NULL — nothing to restore there).
-- ============================================================================

-- PRE-CHECK (run first, outside the transaction): which NOT NULL columns must
-- the INSERT satisfy? If any appears here that isn't in the INSERT below and
-- has no default, add it with a sensible value before running.
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='properties' AND is_nullable='NO' AND column_default IS NULL
--   ORDER BY column_name;

BEGIN;

INSERT INTO properties
  (id, title_lo, property_type, district_en, transaction_type,
   workflow_status, status, market_status)
SELECT
  r.property_id,
  r.title_lo,
  r.property_type,
  r.district_en,
  r.transaction_type,
  'draft', 'draft', 'available'
FROM properties_removal_log r
WHERE r.title_lo IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.id = r.property_id);

-- What happened (inspect before committing):
SELECT
  (SELECT count(*) FROM properties_removal_log WHERE title_lo IS NOT NULL) AS manifest_recoverable,
  (SELECT count(*) FROM properties)                                        AS properties_total_now,
  (SELECT count(*) FROM properties WHERE workflow_status='draft')          AS drafts_now;

-- If the counts look right:
COMMIT;
-- If anything looks wrong:
-- ROLLBACK;

-- ── PHASE 2 ENRICHMENT (manual, after this) ─────────────────────────────────
-- For each recovered draft (join back to properties_removal_log by id for the
-- attributes above), fill in from surviving sources, then publish:
--   * Images   → Supabase Storage bucket `property-images` (still intact;
--                match files to listings by property_id / slug in the path).
--   * Price / description / bedrooms / sizes → Wayback Machine + Google cache
--                of the old public listing pages; Facebook source posts; agents.
--   * Titles (en/zh) → translate from the recovered title_lo, or from caches.
--   * Publish → set workflow_status='active' only once a listing is complete.
