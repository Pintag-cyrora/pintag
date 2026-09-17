-- ============================================================================
-- INTELLIGENCE VIENTIANE-CALENDAR REGRESSION ASSERTIONS
-- (supabase/migrations/20260918000000_intelligence_vientiane_calendar.sql)
-- ============================================================================
-- Run against a throwaway PostgreSQL instance seeded by
-- schema_intelligence_vientiane_calendar.sql and then migrated by the file
-- above:
--
--     bash tests/security/regression/run-intelligence-vientiane-calendar-pg.sh
--
-- Seeds real timestamptz rows at the exact instants around the 17:00 UTC /
-- Vientiane-midnight boundary and asserts intelligence_daily_metrics()
-- buckets them into the correct Vientiane calendar day -- not the UTC day
-- the pre-fix version would have used. Covers ui_events (gallery_events,
-- map_events), listing_events (impressions/views), search_events (search
-- totals + customer-intent + bedroom-intent segments), a month boundary, a
-- leap-year boundary, and ensure_daily_metrics_snapshot()'s finalization
-- cutoff.
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
\echo '=== A. ui_events (gallery_events/map_events) bucket by Vientiane day, not UTC ==='

-- The exact four boundary instants from the investigation/task.
INSERT INTO ui_events (element_id, element_type, created_at, session_id) VALUES
  ('gallery-thumbnail', 'thumbnail', '2026-09-16T16:59:00Z', 's1'), -- Sep 16 Vientiane (16:59 UTC, last minute before crossover)
  ('gallery-thumbnail', 'thumbnail', '2026-09-16T17:00:00Z', 's2'), -- Sep 17 Vientiane (the exact crossover instant)
  ('gallery-thumbnail', 'thumbnail', '2026-09-16T23:59:00Z', 's3'), -- Sep 17 Vientiane
  ('gallery-thumbnail', 'thumbnail', '2026-09-17T00:05:00Z', 's4'), -- Sep 17 Vientiane (well past crossover)
  ('map-open-link',     'button',    '2026-09-16T16:59:00Z', 's5'), -- Sep 16 Vientiane
  ('map-open-link',     'button',    '2026-09-16T17:00:00Z', 's6'); -- Sep 17 Vientiane

DO $$
DECLARE m16 jsonb; m17 jsonb;
BEGIN
  SELECT metrics INTO m16 FROM intelligence_daily_metrics('2026-09-16', '2026-09-17') WHERE day = '2026-09-16';
  SELECT metrics INTO m17 FROM intelligence_daily_metrics('2026-09-16', '2026-09-17') WHERE day = '2026-09-17';

  PERFORM assert((m16->>'gallery_events')::int = 1,
    '2026-09-16 16:59 UTC is the ONLY gallery event on the Sep 16 Vientiane day (expected 1, not the pre-fix 1-of-4 UTC-day grouping)');
  PERFORM assert((m17->>'gallery_events')::int = 3,
    '2026-09-16 17:00/23:59 UTC and 2026-09-17 00:05 UTC are all on the Sep 17 Vientiane day (expected 3)');
  PERFORM assert((m16->>'map_events')::int = 1, '16:59 UTC map-open-link stays on Sep 16 Vientiane');
  PERFORM assert((m17->>'map_events')::int = 1, '17:00 UTC map-open-link crosses to Sep 17 Vientiane');
END $$;

\echo ''
\echo '=== B. listing_events (impressions/views) bucket the same way -- not gallery-specific ==='

INSERT INTO properties (id, property_type, transaction_type, district_en, status)
VALUES ('11111111-0000-0000-0000-000000000001', 'apartment', 'for_rent', 'Sisattanak', 'active');

INSERT INTO listing_events (property_id, event_type, created_at) VALUES
  ('11111111-0000-0000-0000-000000000001', 'impression', '2026-09-16T16:59:00Z'), -- Sep 16 Vientiane
  ('11111111-0000-0000-0000-000000000001', 'impression', '2026-09-16T17:00:00Z'), -- Sep 17 Vientiane
  ('11111111-0000-0000-0000-000000000001', 'view',       '2026-09-16T23:59:00Z'), -- Sep 17 Vientiane
  ('11111111-0000-0000-0000-000000000001', 'view',       '2026-09-17T00:05:00Z'); -- Sep 17 Vientiane

DO $$
DECLARE m16 jsonb; m17 jsonb;
BEGIN
  SELECT metrics INTO m16 FROM intelligence_daily_metrics('2026-09-16', '2026-09-17') WHERE day = '2026-09-16';
  SELECT metrics INTO m17 FROM intelligence_daily_metrics('2026-09-16', '2026-09-17') WHERE day = '2026-09-17';

  PERFORM assert((m16->>'listing_impressions')::int = 1, '16:59 UTC impression stays on Sep 16 Vientiane');
  PERFORM assert((m17->>'listing_impressions')::int = 1, '17:00 UTC impression crosses to Sep 17 Vientiane');
  PERFORM assert((m17->>'listing_views')::int = 2, 'both 23:59 UTC and 00:05 UTC views land on Sep 17 Vientiane');
  PERFORM assert((m16->>'listing_views')::int = 0, 'Sep 16 Vientiane has no views (both are past the crossover)');
  PERFORM assert(m17->'views_by_district'->>'Sisattanak' = '2',
    'the district breakdown (a JOIN through properties) uses the same Vientiane bucketing as the plain totals');
END $$;

\echo ''
\echo '=== C. search_events: totals AND customer-intent/bedroom-intent segments bucket correctly ==='

INSERT INTO search_events (district, property_type, transaction_type, bedrooms, result_count, created_at) VALUES
  ('Sisattanak', 'apartment', 'for_rent', 2, 5, '2026-09-16T16:59:00Z'), -- Sep 16 Vientiane
  ('Sisattanak', 'apartment', 'for_rent', 2, 5, '2026-09-16T17:00:00Z'); -- Sep 17 Vientiane

DO $$
DECLARE m16 jsonb; m17 jsonb; seg16 jsonb; seg17 jsonb;
BEGIN
  SELECT metrics INTO m16 FROM intelligence_daily_metrics('2026-09-16', '2026-09-17') WHERE day = '2026-09-16';
  SELECT metrics INTO m17 FROM intelligence_daily_metrics('2026-09-16', '2026-09-17') WHERE day = '2026-09-17';

  PERFORM assert((m16->'search'->>'total')::int = 1, '16:59 UTC search stays on Sep 16 Vientiane');
  PERFORM assert((m17->'search'->>'total')::int = 1, '17:00 UTC search crosses to Sep 17 Vientiane');

  SELECT jsonb_array_element(m16->'customer_intent_segments', 0) INTO seg16;
  SELECT jsonb_array_element(m17->'customer_intent_segments', 0) INTO seg17;
  PERFORM assert(seg16 IS NOT NULL AND (seg16->>'search_count')::int = 1,
    'the Sep 16 Vientiane customer-intent segment sees exactly its own search');
  PERFORM assert(seg17 IS NOT NULL AND (seg17->>'top_bedroom_count')::int = 2,
    'the Sep 17 Vientiane bedroom-intent field is populated from the search that crossed into it, not left behind on Sep 16');
END $$;

\echo ''
\echo '=== D. month boundary: Jan 31 late-UTC crosses into February Vientiane ==='

INSERT INTO ui_events (element_id, element_type, created_at) VALUES
  ('gallery-thumbnail', 'thumbnail', '2026-01-31T17:00:00Z'); -- 2026-02-01 00:00 Vientiane

DO $$
DECLARE mjan jsonb; mfeb jsonb;
BEGIN
  SELECT metrics INTO mjan FROM intelligence_daily_metrics('2026-01-31', '2026-02-01') WHERE day = '2026-01-31';
  SELECT metrics INTO mfeb FROM intelligence_daily_metrics('2026-01-31', '2026-02-01') WHERE day = '2026-02-01';
  PERFORM assert(coalesce((mjan->>'gallery_events')::int, 0) = 0,
    '2026-01-31 17:00 UTC does NOT count toward Jan 31 Vientiane');
  PERFORM assert((mfeb->>'gallery_events')::int = 1,
    '2026-01-31 17:00 UTC counts toward Feb 1 Vientiane -- a real month-boundary crossing');
END $$;

\echo ''
\echo '=== E. leap-year boundary: Feb 28 late-UTC crosses into Feb 29 (2028 is a leap year) ==='

INSERT INTO ui_events (element_id, element_type, created_at) VALUES
  ('gallery-thumbnail', 'thumbnail', '2028-02-28T17:00:00Z'); -- 2028-02-29 00:00 Vientiane

DO $$
DECLARE m28 jsonb; m29 jsonb;
BEGIN
  SELECT metrics INTO m28 FROM intelligence_daily_metrics('2028-02-28', '2028-02-29') WHERE day = '2028-02-28';
  SELECT metrics INTO m29 FROM intelligence_daily_metrics('2028-02-28', '2028-02-29') WHERE day = '2028-02-29';
  PERFORM assert(coalesce((m28->>'gallery_events')::int, 0) = 0, '2028-02-28 17:00 UTC does not stay on Feb 28 Vientiane');
  PERFORM assert((m29->>'gallery_events')::int = 1, '2028-02-28 17:00 UTC correctly lands on the leap day, Feb 29 Vientiane');
END $$;

\echo ''
\echo '=== F. ensure_daily_metrics_snapshot() finalizes using the SAME Vientiane "today", not CURRENT_DATE ==='

-- A single DO block so `now()` (frozen for the whole block, per Postgres's
-- transaction-timestamp semantics) is identical for both the function call
-- and the independently-computed expectation -- no clock-race between them.
DO $$
DECLARE expected_v_end date; actual_max_day date;
BEGIN
  expected_v_end := (now() AT TIME ZONE 'Asia/Vientiane')::date - 1;
  PERFORM ensure_daily_metrics_snapshot(expected_v_end - 2, '2999-01-01'::date);
  SELECT max(day) INTO actual_max_day FROM daily_metrics_snapshot;
  PERFORM assert(actual_max_day = expected_v_end,
    format('finalizes up to (now() AT TIME ZONE Asia/Vientiane)::date - 1 = %s, not CURRENT_DATE - 1 (got %s)', expected_v_end, actual_max_day));
  PERFORM assert(NOT EXISTS (SELECT 1 FROM daily_metrics_snapshot WHERE day > expected_v_end),
    'never finalizes the current Vientiane day or later, exactly like the pre-fix CURRENT_DATE-based guard did for UTC');
END $$;

DROP FUNCTION assert(boolean, text);
