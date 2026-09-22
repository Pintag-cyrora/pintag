-- ============================================================================
-- INTELLIGENCE UNIT-TYPE DEMAND REGRESSION ASSERTIONS
-- (supabase/migrations/20260922000000_intelligence_unit_type_demand.sql)
--
-- Run against a throwaway PostgreSQL instance seeded by
-- schema_intelligence_unit_type_demand.sql and then migrated by the file
-- above:
--
--     bash tests/security/regression/run-intelligence-unit-type-demand-pg.sh
--
-- Covers the 10 required scenarios from the product spec:
--  1. unit-type click -> attribution (whatsapp_click/call_click counted per unit_type_id)
--  2. unit-type lead -> demand (leads_created counted per unit_type_id)
--  3. property-level lead NOT assigned a unit type (unit_type_id null -> excluded)
--  4. multiple unit types stay separate (two distinct rows, not merged)
--  5. conversion/signal population uses only that unit type's own counts
--  6. deleted unit type doesn't break historical analytics (no crash, cleanly excluded)
--  7. insufficient sample -> no strong conclusion (JS layer; SQL just reports raw counts, see unit-type-demand.test.js)
--  8. unit-type demand contributes to demand/supply analysis (available_unit_types supply read)
--  9. existing property-level Intelligence metrics unchanged
-- 10. existing Intelligence reports remain backward compatible (additive-only field; see report-composer.test.js)
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
\echo '=== Fixture: 3 properties (2 bookable, 1 sold), 4 unit types across them ==='

INSERT INTO properties (id, title_en, property_type, transaction_type, district_en, status, market_status, workflow_status, bedrooms) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Sisattanak Building', 'apartment', 'for_rent', 'Sisattanak',   'active', 'available', 'active', NULL),
  ('22222222-0000-0000-0000-000000000002', 'Chanthabouly Villa',  'apartment', 'for_rent', 'Chanthabouly', 'active', 'available', 'active', NULL),
  ('33333333-0000-0000-0000-000000000003', 'Sold Building',       'apartment', 'for_rent', 'Sisattanak',   'active', 'sold',      'active', NULL);

INSERT INTO unit_types (id, property_id, name_en, bedrooms, price_amount, price_currency, price_frequency, is_available, available_count) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001', 'Room Type A', 2, 400, 'USD', 'monthly', true,  1),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '22222222-0000-0000-0000-000000000002', 'Room Type B', 1, 300, 'USD', 'monthly', true,  5),
  ('cccccccc-0000-0000-0000-00000000000c', '33333333-0000-0000-0000-000000000003', 'Room Type C', 3, 900, 'USD', 'monthly', true,  3),  -- parent SOLD -- must be excluded from supply
  ('dddddddd-0000-0000-0000-00000000000d', '11111111-0000-0000-0000-000000000001', 'Room Type D', 0, 250, 'USD', 'monthly', false, 0),  -- itself unavailable
  ('eeeeeeee-0000-0000-0000-00000000000e', '11111111-0000-0000-0000-000000000001', 'Room Type E (soon deleted)', 2, 350, 'USD', 'monthly', true, 2);

\echo ''
\echo '=== Fixture: mixed unit-type and property-level activity on 2026-07-01 ==='

-- UT-A: 3 whatsapp_click + 1 call_click + 1 lead = signal 5
INSERT INTO lead_events (listing_id, unit_type_id, event_type, created_at) VALUES
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'whatsapp_click', '2026-07-01 09:00:00+00'),
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'whatsapp_click', '2026-07-01 09:05:00+00'),
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'whatsapp_click', '2026-07-01 09:10:00+00'),
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'call_click',      '2026-07-01 09:15:00+00');
INSERT INTO leads (property_id, unit_type_id, created_at) VALUES
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-07-01 09:20:00+00');

-- UT-B: 2 whatsapp_click, no leads = signal 2 (below MIN_UNIT_TYPE_SIGNAL_SAMPLE)
INSERT INTO lead_events (listing_id, unit_type_id, event_type, created_at) VALUES
  ('22222222-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-00000000000b', 'whatsapp_click', '2026-07-01 10:00:00+00'),
  ('22222222-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-00000000000b', 'whatsapp_click', '2026-07-01 10:05:00+00');

-- Property-level activity on the SAME property as UT-A (unit_type_id NULL --
-- a general inquiry, never a specific unit) -- REQUIRED 3.
INSERT INTO lead_events (listing_id, unit_type_id, event_type, created_at) VALUES
  ('11111111-0000-0000-0000-000000000001', NULL, 'whatsapp_click', '2026-07-01 11:00:00+00');
INSERT INTO leads (property_id, unit_type_id, created_at) VALUES
  ('11111111-0000-0000-0000-000000000001', NULL, '2026-07-01 11:05:00+00');

-- UT-E (soon to be deleted): 2 whatsapp_click today, BEFORE deletion.
INSERT INTO lead_events (listing_id, unit_type_id, event_type, created_at) VALUES
  ('11111111-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-00000000000e', 'whatsapp_click', '2026-07-01 12:00:00+00'),
  ('11111111-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-00000000000e', 'whatsapp_click', '2026-07-01 12:05:00+00');

\echo ''
\echo '=== REQUIRED 1/2/4/5: unit-type click/lead attribution, multiple unit types stay separate ==='

DO $$
DECLARE
  m jsonb; segs jsonb; seg_a jsonb; seg_b jsonb; n_segs int;
BEGIN
  SELECT metrics INTO m FROM intelligence_daily_metrics('2026-07-01', '2026-07-01') WHERE day = '2026-07-01';
  segs := m->'unit_type_demand_segments';

  seg_a := (SELECT s FROM jsonb_array_elements(segs) s WHERE s->>'unit_type_id' = 'aaaaaaaa-0000-0000-0000-00000000000a');
  seg_b := (SELECT s FROM jsonb_array_elements(segs) s WHERE s->>'unit_type_id' = 'bbbbbbbb-0000-0000-0000-00000000000b');

  PERFORM assert(seg_a IS NOT NULL, 'REQUIRED 1/2: unit type A appears in unit_type_demand_segments');
  PERFORM assert((seg_a->>'whatsapp_clicks')::int = 3, 'REQUIRED 1: unit type A whatsapp_clicks = 3, attributed correctly');
  PERFORM assert((seg_a->>'call_clicks')::int = 1, 'REQUIRED 1: unit type A call_clicks = 1, attributed correctly');
  PERFORM assert((seg_a->>'leads_created')::int = 1, 'REQUIRED 2: unit type A leads_created = 1, attributed correctly');
  PERFORM assert(seg_a->>'unit_type_name' = 'Room Type A', 'unit type A''s current name resolved live');
  PERFORM assert((seg_a->>'bedrooms')::int = 2, 'unit type A''s current bedrooms resolved live');
  PERFORM assert(seg_a->>'district' = 'Sisattanak', 'unit type A''s property context (district) resolved live via the property join');

  PERFORM assert(seg_b IS NOT NULL, 'REQUIRED 4: unit type B ALSO appears, as its own separate row');
  PERFORM assert((seg_b->>'whatsapp_clicks')::int = 2, 'REQUIRED 4/5: unit type B''s own count (2) is not merged with unit type A''s (3) -- each row uses only its own population');
  PERFORM assert(seg_a->>'unit_type_id' <> seg_b->>'unit_type_id', 'REQUIRED 4: the two unit types remain distinguishable, never collapsed into one row');

  SELECT count(*) INTO n_segs FROM jsonb_array_elements(segs);
  PERFORM assert(n_segs = 3, format('exactly 3 unit-type rows exist today (A, B, E) before E is deleted -- got %s', n_segs));
END $$;

\echo ''
\echo '=== REQUIRED 3: a property-level lead/click (unit_type_id NULL) never appears in unit_type_demand_segments ==='

DO $$
DECLARE m jsonb; segs jsonb; any_null_row jsonb;
BEGIN
  SELECT metrics INTO m FROM intelligence_daily_metrics('2026-07-01', '2026-07-01') WHERE day = '2026-07-01';
  segs := m->'unit_type_demand_segments';
  any_null_row := (SELECT s FROM jsonb_array_elements(segs) s WHERE s->>'unit_type_id' IS NULL);
  PERFORM assert(any_null_row IS NULL, 'no row in unit_type_demand_segments ever has a null unit_type_id -- property-level activity is structurally excluded, not filtered by heuristic');
END $$;

\echo ''
\echo '=== REQUIRED 9: existing property-level metrics (whatsapp_clicks total, leads_created total) are unaffected by the new field ==='

DO $$
DECLARE m jsonb;
BEGIN
  SELECT metrics INTO m FROM intelligence_daily_metrics('2026-07-01', '2026-07-01') WHERE day = '2026-07-01';
  -- Total whatsapp_clicks that day: UT-A(3) + UT-B(2) + property-level(1) + UT-E(2) = 8.
  -- This aggregate does NOT filter by unit_type_id at all (pre-existing
  -- behavior, byte-for-byte unchanged by this migration) -- proving the new
  -- unit-type dimension is purely additive, not a narrower replacement.
  PERFORM assert((m->>'whatsapp_clicks')::int = 8, format('existing whatsapp_clicks scalar total unaffected: expected 8, got %s', m->>'whatsapp_clicks'));
  PERFORM assert((m->>'leads_created')::int = 2, format('existing leads_created scalar total unaffected: expected 2 (UT-A''s lead + the property-level lead), got %s', m->>'leads_created'));
END $$;

\echo ''
\echo '=== REQUIRED 8: available_unit_types (point_in_time_supply_snapshot) — genuinely bookable unit-type supply only ==='

DO $$
DECLARE snap jsonb; avail jsonb;
BEGIN
  snap := point_in_time_supply_snapshot();
  avail := snap->'active_inventory'->'available_unit_types';

  PERFORM assert((avail->>'aaaaaaaa-0000-0000-0000-00000000000a')::int = 1, 'unit type A (bookable parent, is_available, available_count=1) appears with its real count');
  PERFORM assert((avail->>'bbbbbbbb-0000-0000-0000-00000000000b')::int = 5, 'unit type B (bookable parent) appears with its real count');
  PERFORM assert(avail->'cccccccc-0000-0000-0000-00000000000c' IS NULL, 'unit type C is EXCLUDED: its parent property is sold (market_status), even though the unit type itself is marked available');
  PERFORM assert(avail->'dddddddd-0000-0000-0000-00000000000d' IS NULL, 'unit type D is EXCLUDED: it is itself marked unavailable (is_available=false), regardless of its parent');
END $$;

\echo ''
\echo '=== REQUIRED 6: deleting a unit type never breaks intelligence_daily_metrics(), and cleanly disappears from future reads ==='

DO $$
DECLARE m_before jsonb; seg_e_before jsonb;
BEGIN
  SELECT metrics INTO m_before FROM intelligence_daily_metrics('2026-07-01', '2026-07-01') WHERE day = '2026-07-01';
  seg_e_before := (SELECT s FROM jsonb_array_elements(m_before->'unit_type_demand_segments') s WHERE s->>'unit_type_id' = 'eeeeeeee-0000-0000-0000-00000000000e');
  PERFORM assert(seg_e_before IS NOT NULL, 'sanity check: unit type E is present BEFORE deletion');
END $$;

DELETE FROM unit_types WHERE id = 'eeeeeeee-0000-0000-0000-00000000000e';

DO $$
DECLARE m_after jsonb; segs_after jsonb; seg_e_after jsonb; null_ut_events int;
BEGIN
  -- The call itself must not raise -- proving no crash on a dangling
  -- reference (there isn't one: ON DELETE SET NULL already reverted every
  -- lead_events row that pointed at E).
  SELECT metrics INTO m_after FROM intelligence_daily_metrics('2026-07-01', '2026-07-01') WHERE day = '2026-07-01';
  segs_after := m_after->'unit_type_demand_segments';
  seg_e_after := (SELECT s FROM jsonb_array_elements(segs_after) s WHERE s->>'unit_type_id' = 'eeeeeeee-0000-0000-0000-00000000000e');

  PERFORM assert(seg_e_after IS NULL, 'REQUIRED 6: unit type E no longer appears after deletion -- cleanly excluded, not a dangling/broken row');

  SELECT count(*) INTO null_ut_events FROM lead_events WHERE unit_type_id IS NULL AND created_at::date = '2026-07-01';
  PERFORM assert(null_ut_events = 3, 'REQUIRED 6: ON DELETE SET NULL reverted E''s 2 lead_events rows to unit_type_id=NULL (joining the 1 pre-existing property-level row = 3 total), exactly the same "undercount, never crash" discipline used elsewhere in this pipeline');

  -- REQUIRED 9 again, post-deletion: the scalar whatsapp_clicks total is
  -- UNCHANGED (still 8) -- deleting a unit type never loses the underlying
  -- fact that a click happened, only the unit-type DIMENSION of it.
  PERFORM assert((m_after->>'whatsapp_clicks')::int = 8, 'existing whatsapp_clicks scalar total is STILL 8 after the deletion -- the fact survives, only the unit-type attribution is lost, exactly as designed');
END $$;

DROP FUNCTION assert(boolean, text);
