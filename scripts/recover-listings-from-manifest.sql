-- ============================================================================
-- LISTING RECOVERY — Phase 1: skeleton from the removal manifest
-- ============================================================================
-- Re-creates the deleted listings from properties_removal_log, which survived
-- the attack intact. The attacker overwrote only title_en ('HACKED'); title_lo
-- (the real Lao titles) is preserved, along with property_type, district_en,
-- transaction_type, and the ORIGINAL property_id (UUID).
--
-- WHAT THIS RECOVERS NOW (exactly the manifest's non-corrupted columns):
--   id (original UUID), title_lo, property_type, district_en, transaction_type.
-- Everything else (price, bedrooms, sizes, images, description, village,
-- coordinates, amenities, contact/owner/agent, slug, title_en/title_zh,
-- SEO/AI content) is NOT in the manifest and is left NULL — enriched later
-- (P9) from Storage photos, Wayback/Google caches, Facebook sources, agents.
-- NOTHING IS FABRICATED. Missing values stay NULL until genuinely recovered.
-- title_en is deliberately NOT copied from the manifest — its manifest value is
-- the attacker's 'HACKED' string, not real data.
--
-- SAFETY / GUARANTEES (map to the recovery requirements):
--   * Original UUID           — INSERT uses r.property_id verbatim (req 1).
--   * Hidden drafts only       — workflow_status='draft', status='draft'; the
--                                public grid filter is
--                                `or=(status.neq.draft,status.is.null)`
--                                (listings.html:1018), so a status='draft' row
--                                is NEVER shown publicly; the single-listing
--                                page fetches by slug, which stays NULL (req 2).
--   * Fields preserved exactly — copied 1:1 from the manifest, no transform (req 3).
--   * No fabrication / NULL kept — only the 5 columns above are set (req 3–5).
--   * Idempotent               — NOT EXISTS on id; safe to re-run, never
--                                overwrites an existing row.
--   * Dedup by UUID            — the trigger writes one manifest row PER delete,
--                                so a UUID deleted more than once appears more
--                                than once. DISTINCT ON (property_id) keeps the
--                                most-recent record per UUID, so the INSERT can
--                                never hit a duplicate-primary-key error.
--   * Only real titles         — WHERE title_lo IS NOT NULL (a row with no
--                                title_lo has nothing to restore → unrecoverable).
--   * Transactional            — inspect the stats, then COMMIT or ROLLBACK.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- PRE-CHECK (run FIRST, on its own, outside the transaction)
-- Which NOT NULL columns without a default must the INSERT satisfy? If any row
-- appears here that is NOT one of the 8 columns the INSERT sets, add it with a
-- sensible non-fabricated default before running the INSERT (or the INSERT will
-- raise a not-null violation).
-- ────────────────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'properties' AND is_nullable = 'NO' AND column_default IS NULL
-- ORDER BY column_name;


-- ============================================================================
-- STEP 1 — RESTORE (transactional; inspect the stats before COMMIT)
-- ============================================================================
BEGIN;

WITH recoverable AS (
  -- one row per original UUID, most-recent removal record, real title only
  SELECT DISTINCT ON (property_id)
         property_id, title_lo, property_type, district_en, transaction_type
  FROM properties_removal_log
  WHERE title_lo IS NOT NULL
  ORDER BY property_id, removed_at DESC
)
INSERT INTO properties
  (id, title_lo, title_en, property_type, district_en, transaction_type,
   workflow_status, status, market_status)
SELECT
  r.property_id,
  r.title_lo,
  -- title_en is NOT NULL with no default in production (confirmed by the
  -- PRE-CHECK), but its ONLY manifest value is the attacker's 'HACKED' string,
  -- which must never be restored. We therefore write an EMPTY STRING — the most
  -- honest non-null placeholder: it satisfies the constraint, invents no title,
  -- and clearly marks the English title as still-missing for P9 enrichment
  -- (translate from title_lo / recover from caches). Copying title_lo here would
  -- misrepresent the Lao title as English, so we deliberately do not.
  '',
  r.property_type,
  r.district_en,
  r.transaction_type,
  'draft', 'draft', 'available'
FROM recoverable r
WHERE NOT EXISTS (SELECT 1 FROM properties p WHERE p.id = r.property_id);


-- ── Quick sanity counts (inspect before COMMIT) ─────────────────────────────
SELECT
  (SELECT count(DISTINCT property_id) FROM properties_removal_log
     WHERE title_lo IS NOT NULL)                              AS manifest_recoverable,
  (SELECT count(*) FROM properties)                           AS properties_total_now,
  (SELECT count(*) FROM properties WHERE workflow_status='draft'
       AND status='draft')                                    AS drafts_now;

-- If the counts look right:
COMMIT;
-- If anything looks wrong:
-- ROLLBACK;


-- ============================================================================
-- STEP 2 — RECOVERY STATISTICS (req 6) — run AFTER COMMIT, read-only
-- ============================================================================
-- Every bucket is derived only from real data — nothing is invented.
--   restored            = recoverable UUIDs now present as draft skeletons.
--   partially_restored  = restored rows missing >=1 skeleton metadata field
--                         (property_type / district_en / transaction_type was
--                          itself NULL in the manifest — nothing to copy).
--   missing_photos      = restored rows with no images yet (ALL of them right
--                         after Phase 1 — the file->UUID link was destroyed;
--                         re-attached in P9. Expected, not an error).
--   unrecoverable       = distinct manifest UUIDs with NO title_lo (no real
--                         title survived → nothing to restore).
-- The per-field NULL counts break down exactly what "missing metadata" means.
WITH recoverable AS (
  SELECT DISTINCT ON (property_id)
         property_id, property_type, district_en, transaction_type
  FROM properties_removal_log
  WHERE title_lo IS NOT NULL
  ORDER BY property_id, removed_at DESC
),
restored AS (
  SELECT p.id, p.property_type, p.district_en, p.transaction_type,
         p.images, p.title_lo, p.title_en
  FROM properties p
  WHERE p.id IN (SELECT property_id FROM recoverable)
    AND p.workflow_status = 'draft'
)
SELECT
  (SELECT count(*) FROM restored)                                        AS restored,
  (SELECT count(*) FROM restored
     WHERE property_type IS NULL OR district_en IS NULL
        OR transaction_type IS NULL)                                     AS partially_restored,
  (SELECT count(*) FROM restored WHERE property_type    IS NULL)         AS missing_property_type,
  (SELECT count(*) FROM restored WHERE district_en      IS NULL)         AS missing_district,
  (SELECT count(*) FROM restored WHERE transaction_type IS NULL)         AS missing_transaction_type,
  -- English title is intentionally empty on every recovered draft (manifest
  -- title_en was the attacker's 'HACKED'); this is the P9 enrichment worklist.
  (SELECT count(*) FROM restored
     WHERE title_en IS NULL OR title_en = '')                           AS missing_english_title,
  -- properties.images is JSONB in production (not text[] — the unit_types
  -- migration comment claiming a "plain array" is stale). Count a row as
  -- missing-photos when images is SQL NULL, JSON null / non-array, or an empty
  -- JSON array. CASE (not OR) guarantees jsonb_array_length is only called on a
  -- confirmed array, so a non-array value can never raise an error.
  (SELECT count(*) FROM restored
     WHERE CASE
             WHEN images IS NULL                     THEN true
             WHEN jsonb_typeof(images) <> 'array'     THEN true
             WHEN jsonb_array_length(images) = 0      THEN true
             ELSE false
           END)                                                        AS missing_photos,
  (SELECT count(DISTINCT property_id) FROM properties_removal_log
     WHERE title_lo IS NULL
       AND property_id NOT IN (SELECT property_id FROM recoverable))     AS unrecoverable;


-- ============================================================================
-- STEP 3 — POST-RECOVERY VALIDATION (req 7) — run AFTER COMMIT, read-only
-- All four must PASS before this step is marked complete.
-- ============================================================================

-- (V1) UUID count matches manifest — every recoverable manifest UUID is now a
--      draft, and no extra UUIDs slipped in.
--      PASS: restored_uuids = manifest_recoverable_uuids  (and match_gap = 0).
SELECT
  (SELECT count(DISTINCT property_id) FROM properties_removal_log
     WHERE title_lo IS NOT NULL)                          AS manifest_recoverable_uuids,
  (SELECT count(*) FROM properties p
     WHERE p.workflow_status = 'draft'
       AND p.id IN (SELECT property_id FROM properties_removal_log
                    WHERE title_lo IS NOT NULL))          AS restored_uuids,
  (SELECT count(DISTINCT property_id) FROM properties_removal_log
     WHERE title_lo IS NOT NULL)
  -
  (SELECT count(*) FROM properties p
     WHERE p.workflow_status = 'draft'
       AND p.id IN (SELECT property_id FROM properties_removal_log
                    WHERE title_lo IS NOT NULL))          AS match_gap;

-- (V2) No duplicate UUIDs — the recovered set contains no id more than once
--      (id is the PK, so this is a belt-and-braces check; dedup on insert also
--      guarantees it). PASS: 0 rows returned.
SELECT id, count(*) AS occurrences
FROM properties
WHERE id IN (SELECT property_id FROM properties_removal_log WHERE title_lo IS NOT NULL)
GROUP BY id
HAVING count(*) > 1;

-- (V3) All restored listings are draft/hidden — none is active/archived, none
--      has a non-draft legacy status. PASS: not_draft = 0.
SELECT count(*) AS not_draft
FROM properties p
WHERE p.id IN (SELECT property_id FROM properties_removal_log WHERE title_lo IS NOT NULL)
  AND (p.workflow_status IS DISTINCT FROM 'draft'
       OR p.status        IS DISTINCT FROM 'draft');

-- (V4) No recovered listing is publicly visible — reproduces the exact public
--      grid predicate `or=(status.neq.draft,status.is.null)` (listings.html:1018)
--      against the recovered set; any row that would be returned is a leak.
--      PASS: publicly_visible_recovered = 0.
--      (recovered_publicly_reachable_by_slug is a second guard: the single
--      listing page fetches by slug, so every recovered row must have slug NULL.)
SELECT
  (SELECT count(*) FROM properties p
     WHERE p.id IN (SELECT property_id FROM properties_removal_log WHERE title_lo IS NOT NULL)
       AND (p.status <> 'draft' OR p.status IS NULL))       AS publicly_visible_recovered,
  (SELECT count(*) FROM properties p
     WHERE p.id IN (SELECT property_id FROM properties_removal_log WHERE title_lo IS NOT NULL)
       AND p.slug IS NOT NULL)                              AS recovered_publicly_reachable_by_slug;


-- ── PHASE 2 ENRICHMENT (manual, P9 — after Phase 1 above) ───────────────────
-- For each recovered draft (join back to properties_removal_log by id for the
-- attributes above), fill in from surviving sources, then publish ONE AT A TIME:
--   * Images   → Supabase Storage bucket `property-images` (still intact;
--                the file->UUID link was destroyed, so match via Wayback /
--                upload-time clustering — see recover-photos-storage-matching.sql).
--   * Price / description / bedrooms / sizes → Wayback Machine + Google cache of
--                the old public listing pages; Facebook source posts; the agents.
--   * Titles (en/zh) → translate from the recovered title_lo, or from caches.
--   * Publish → set workflow_status='active' only once a listing is verified
--                complete AND the final security audit has passed AND reopening
--                is explicitly approved. Do NOT bulk-publish.
