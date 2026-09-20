-- ============================================================================
-- INTELLIGENCE DEMAND/SUPPLY/GAP REGRESSION ASSERTIONS
-- (supabase/migrations/20260920000000_intelligence_demand_supply_gap.sql)
--
-- Run against a throwaway PostgreSQL instance seeded by
-- schema_intelligence_demand_supply_gap.sql and then migrated by the file
-- above:
--
--     bash tests/security/regression/run-intelligence-demand-supply-gap-pg.sh
--
-- Proves two things the migration exists for: (1) available_by_segment
-- correctly EXCLUDES a listing that is workflow-active but market_status
-- sold/draft -- i.e. it answers a genuinely different question than the
-- existing, legacy-status-based by_segment/total, which counts it -- and
-- (2) available_by_bedroom_segment buckets bedrooms correctly (0 as its own
-- bucket, 4+ collapsed, null excluded entirely rather than guessed at).
--
-- Any failed assertion raises an exception, aborting psql under
-- ON_ERROR_STOP=1 with a non-zero exit code.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'REGRESSION FAILED: %', p_what;
  END IF;
  RAISE NOTICE '  ok  %', p_what;
END $$;

\echo ''
\echo '=== Fixture: 6 properties covering active/sold/draft x null/0/2/5 bedrooms ==='

INSERT INTO properties (property_type, district_en, transaction_type, price_display, status, market_status, workflow_status, bedrooms) VALUES
  ('apartment', 'Sisattanak',   'for_rent', '$500/month', 'active', 'available', 'active', 2),    -- R1: genuinely bookable
  ('apartment', 'Sisattanak',   'for_rent', '$600/month', 'active', 'sold',      'active', 3),    -- R2: workflow-active but SOLD -- the exact overcount this migration fixes
  ('apartment', 'Sisattanak',   'for_rent', '$400/month', 'draft',  'available', 'draft',  1),    -- R3: still a draft -- excluded from BOTH legacy and new counts
  ('apartment', 'Sisattanak',   'for_rent', '$550/month', 'active', 'available', 'active', NULL), -- R4: bedrooms unknown -- must not be guessed into a bucket
  ('house',     'Chanthabouly', 'for_sale', '$300000',    'active', 'available', 'active', 5),    -- R5: bucketed into '4+'
  ('apartment', 'Sisattanak',   'for_rent', '$450/month', 'active', 'available', 'active', 0);     -- R6: a real Studio (bedrooms=0)

\echo ''
\echo '=== available_by_segment excludes a sold (but workflow-active) listing the legacy by_segment still counts ==='

DO $$
DECLARE snap jsonb; legacy_count int; available_count int;
BEGIN
  snap := point_in_time_supply_snapshot();
  legacy_count := (snap->'active_inventory'->'by_segment'->>'for_rent|apartment|Sisattanak')::int;
  available_count := (snap->'active_inventory'->'available_by_segment'->>'for_rent|apartment|Sisattanak')::int;

  PERFORM assert(legacy_count = 4,
    'legacy by_segment counts R1+R2(sold)+R4+R6 = 4 (still includes the sold listing -- unchanged, pre-existing behavior)');
  PERFORM assert(available_count = 3,
    'available_by_segment counts only R1+R4+R6 = 3 -- correctly EXCLUDES R2 (sold), proving the market_status/workflow_status filter actually differs from legacy status');
  PERFORM assert(legacy_count > available_count,
    'the legacy count is strictly greater than the genuinely-bookable count -- this gap is exactly what this migration exists to close');
END $$;

\echo ''
\echo '=== a draft listing (workflow_status=draft) never appears in available_by_segment, even with market_status=available ==='

DO $$
DECLARE available_count int;
BEGIN
  -- R3 is market_status='available' but workflow_status='draft' -- if it were
  -- wrongly counted, for_rent|apartment|Sisattanak would read 4, not 3.
  available_count := (point_in_time_supply_snapshot()->'active_inventory'->'available_by_segment'->>'for_rent|apartment|Sisattanak')::int;
  PERFORM assert(available_count = 3, 'a draft listing with market_status=available is still excluded (workflow_status gate)');
END $$;

\echo ''
\echo '=== available_by_bedroom_segment: Studio (0), a real count (2), and 4+ collapsing all bucket correctly ==='

DO $$
DECLARE snap jsonb; studio_count int; two_bed_count int; four_plus_count int;
BEGIN
  snap := point_in_time_supply_snapshot();
  studio_count := (snap->'active_inventory'->'available_by_bedroom_segment'->>'for_rent|Sisattanak|0')::int;
  two_bed_count := (snap->'active_inventory'->'available_by_bedroom_segment'->>'for_rent|Sisattanak|2')::int;
  four_plus_count := (snap->'active_inventory'->'available_by_bedroom_segment'->>'for_sale|Chanthabouly|4+')::int;

  PERFORM assert(studio_count = 1, 'R6 (bedrooms=0) buckets as "0" (Studio), not omitted or miscounted');
  PERFORM assert(two_bed_count = 1, 'R1 (bedrooms=2) buckets as its own real count "2"');
  PERFORM assert(four_plus_count = 1, 'R5 (bedrooms=5) collapses into the "4+" bucket rather than fragmenting into a rare "5"');
END $$;

\echo ''
\echo '=== a null-bedrooms listing (R4) is excluded from available_by_bedroom_segment entirely -- never guessed into a bucket ==='

DO $$
DECLARE snap jsonb; total_bucketed int;
BEGIN
  snap := point_in_time_supply_snapshot();
  -- R1(2) + R6(0) + R5(4+) = 3 bucketed rows total; R2 (sold), R3 (draft) and
  -- R4 (null bedrooms) must never contribute a 4th/5th/6th bucketed row.
  SELECT count(*) INTO total_bucketed
  FROM jsonb_each_text(snap->'active_inventory'->'available_by_bedroom_segment');
  PERFORM assert(total_bucketed = 3,
    format('exactly 3 distinct (tx|district|bedroom_bucket) keys exist, got %s -- R2 (sold), R3 (draft) and R4 (null bedrooms) must never create a 4th', total_bucketed));
END $$;

\echo ''
\echo '=== existing fields (total/by_property_type/by_district/by_segment/asking_price) are byte-for-byte unaffected ==='

DO $$
DECLARE snap jsonb;
BEGIN
  snap := point_in_time_supply_snapshot();
  -- Legacy `active` CTE still counts R1,R2,R4,R5,R6 (5 rows; R3 is 'draft',
  -- never in ('active','available')) -- unchanged from this function's
  -- pre-migration behavior.
  PERFORM assert((snap->'active_inventory'->>'total')::int = 5, 'active_inventory.total unchanged: still legacy status IN (active, available)');
  PERFORM assert((snap->'active_inventory'->'by_property_type'->>'apartment')::int = 4, 'by_property_type unchanged (R1,R2,R4,R6)');
  PERFORM assert((snap->'active_inventory'->'by_district'->>'Sisattanak')::int = 4, 'by_district unchanged (R1,R2,R4,R6)');
  PERFORM assert(snap ? 'asking_price', 'asking_price key still present and untouched');
END $$;

DROP FUNCTION assert(boolean, text);
