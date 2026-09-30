-- ============================================================================
-- ANALYTICS LAOS-CALENDAR + LEAD DRILL-DOWN REGRESSION ASSERTIONS
-- (supabase/migrations/20260921030000_analytics_laos_calendar_days.sql and
--  20260921040000_analytics_history_and_lead_drilldown.sql)
-- ============================================================================
--     bash tests/security/regression/run-analytics-laos-calendar-days-pg.sh
--
-- Seeds real timestamptz rows at the exact instants around the 17:00 UTC /
-- Vientiane-midnight boundary and asserts every analytics RPC buckets them by
-- the Asia/Vientiane calendar day, that lead drill-down attributes each row to
-- the right listing (current -> snapshot -> removal log -> unknown id), that
-- legacy / unattributed lead_events are kept separate from CRM leads, that
-- keyset paging is exact, that summaries and drill-down agree, and that ACLs
-- and search_path are hardened.
--
-- Laos calendar day D == [D-1 17:00Z, D 17:00Z).
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

CREATE OR REPLACE FUNCTION assert_eq(p_actual text, p_expected text, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'REGRESSION FAILED: % (expected %, got %)', p_what, p_expected, p_actual;
  END IF;
  RAISE NOTICE '  ok  %', p_what;
END $$;

-- ── Fixture ────────────────────────────────────────────────────────────────
-- Properties: A/B current, C soft-deleted, D hard-deleted with snapshots,
-- E hard-deleted with removal-log only, F unknown everywhere.
INSERT INTO parties (id, name_en) VALUES ('11111111-0000-0000-0000-000000000001', 'Agent One');
INSERT INTO contacts (id, role, name, phone, whatsapp, is_verified)
  VALUES ('22222222-0000-0000-0000-000000000001', 'agent', 'Contact Person', '+85620999888', '+85620999888', true);

INSERT INTO properties (id, slug, title_en, status, workflow_status, property_type, district_en, view_count, created_at, deleted_at) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'villa-alpha', 'Villa Alpha', 'active', 'active', 'house',  'Chanthabouly', 30, '2026-07-01T05:00:00Z', NULL),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'condo-beta',  'Condo Beta',  'active', 'active', 'condo',  'Sikhottabong', 25, '2026-07-01T05:00:00Z', NULL),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'gamma-soft',  'Gamma Soft',  'active', 'active', 'house',  'Chanthabouly', 5,  '2026-07-01T05:00:00Z', '2026-09-10T00:00:00Z');
-- D: no properties row, two snapshots (the newer one must win).
INSERT INTO properties_row_snapshots (property_id, op, row_data, created_at) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'soft_delete', '{"title_en":"Delta Old","slug":"delta-old","workflow_status":"draft"}', '2026-08-06T00:00:00Z'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'hard_delete', '{"title_en":"Delta Snap","slug":"delta-snap","workflow_status":"active"}', '2026-08-07T00:00:00Z');
-- E: no properties row, no snapshot, only the removal log.
INSERT INTO properties_removal_log (property_id, title_en, status_at_removal, removed_at)
  VALUES ('aaaaaaaa-0000-0000-0000-00000000000e', 'Echo Log', 'active', '2026-08-03T00:00:00Z');
-- F: nothing anywhere.

-- Tie fixture: three leads for one listing at the IDENTICAL instant, alone on Laos 2026-07-10
INSERT INTO properties (id, slug, title_en, status, workflow_status, created_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000099', 'tie-listing', 'Tie Listing', 'active', 'active', '2026-07-01T05:00:00Z');

INSERT INTO unit_types (id, property_id, name_en)
  VALUES ('33333333-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Studio');

-- Lead events + their CRM leads (created together, same instant, like the trigger).
-- helper: one lead_event, optionally with a leads row.
CREATE OR REPLACE FUNCTION seed_event(
  p_key text, p_at timestamptz, p_listing uuid, p_type text, p_with_lead boolean,
  p_session text DEFAULT NULL, p_agent uuid DEFAULT NULL, p_contact uuid DEFAULT NULL,
  p_unit uuid DEFAULT NULL, p_status text DEFAULT 'new'
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_event uuid := gen_random_uuid();
BEGIN
  INSERT INTO lead_events (id, listing_id, agent_id, event_type, session_id, contact_id, unit_type_id, created_at)
    VALUES (v_event, p_listing, p_agent, p_type, p_session, p_contact, p_unit, p_at);
  IF p_with_lead THEN
    INSERT INTO leads (property_id, party_id, lead_event_id, status, contact_method, contact_id,
                       recipient_type, recipient_verified, unit_type_id, customer_name, customer_phone, notes,
                       created_at, updated_at)
      VALUES (p_listing, p_agent, v_event, p_status, regexp_replace(p_type, '_click$', ''), p_contact,
              CASE WHEN p_contact IS NOT NULL THEN 'agent' END, CASE WHEN p_contact IS NOT NULL THEN true END,
              p_unit, 'Secret Buyer ' || p_key, '+85620555' || p_key, 'private note ' || p_key,
              p_at, p_at);
  END IF;
  RETURN v_event;
END $$;

-- Official leads
SELECT seed_event('001', '2026-09-16T16:59:59Z', 'aaaaaaaa-0000-0000-0000-00000000000a', 'whatsapp_click', true,  's1',
                  '11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', 'closed');
UPDATE leads SET updated_at = '2026-09-17T16:59:59Z' WHERE customer_name = 'Secret Buyer 001';  -- closed on Laos 09-17
SELECT seed_event('002', '2026-09-16T17:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000a', 'call_click',      true, 's2', '11111111-0000-0000-0000-000000000001');
SELECT seed_event('003', '2026-09-17T16:59:59.999999Z', 'aaaaaaaa-0000-0000-0000-00000000000b', 'messenger_click', true, 's3');
SELECT seed_event('004', '2026-09-17T17:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000a', 'whatsapp_click',  true, 's4');
SELECT seed_event('005', '2026-09-18T02:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000a', 'line_click',      true, 's5');
SELECT seed_event('006', '2026-09-18T03:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000c', 'telegram_click',  true, 's6');
SELECT seed_event('007', '2026-09-18T04:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000d', 'contact_click',   true, 's7');
SELECT seed_event('008', '2026-09-18T05:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000e', 'whatsapp_click',  true, 's8');
SELECT seed_event('009', '2026-09-18T06:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000f', 'whatsapp_click',  true, 's9');
-- Two leads at the exact same instant (keyset tie-break)
SELECT seed_event('014', '2026-09-18T09:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000b', 'whatsapp_click',  true, 's14');
SELECT seed_event('015', '2026-09-18T09:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000b', 'whatsapp_click',  true, 's15');
SELECT seed_event('tie' || g, '2026-07-10T05:00:00Z', 'aaaaaaaa-0000-0000-0000-000000000099', 'whatsapp_click', true, 'stie' || g) FROM generate_series(1, 3) g;
-- Legacy events (listing, NO leads row)
SELECT seed_event('010', '2026-09-17T18:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000a', 'whatsapp_click',  false, 's10');
SELECT seed_event('011', '2026-09-16T20:00:00Z', 'aaaaaaaa-0000-0000-0000-00000000000d', 'whatsapp_click',  false, 's11');
SELECT seed_event('016', '2026-06-24T22:21:11Z', 'aaaaaaaa-0000-0000-0000-00000000000a', 'whatsapp_click',  false, 's16');
-- Unattributed event (no listing, no leads row)
SELECT seed_event('012', '2026-09-18T07:00:00Z', NULL, 'whatsapp_click', false, 's12');
-- Lead with NO event and NO property (listing detached)
INSERT INTO leads (property_id, party_id, lead_event_id, status, contact_method, customer_name, customer_phone, created_at, updated_at)
  VALUES (NULL, NULL, NULL, 'new', 'whatsapp', 'Secret Buyer 013', '+85620555013', '2026-09-18T08:00:00Z', '2026-09-18T08:00:00Z');

-- page_views around the boundary, plus the first-touch row for session s1
INSERT INTO page_views (session_id, visitor_id, is_returning, page, referrer_source, created_at) VALUES
  ('s1', 'vs1', false, 'index.html',   'facebook', '2026-09-16T16:00:00Z'),  -- Laos 09-16 23:00
  ('b1', 'vb1', false, 'index.html',   'direct',   '2026-09-16T16:59:59Z'),  -- Laos 09-16 23:59:59
  ('b2', 'vb2', true,  'index.html',   'direct',   '2026-09-16T17:00:00Z'),  -- Laos 09-17 00:00:00
  ('b2', 'vb2', true,  'listing.html', 'direct',   '2026-09-17T16:59:59Z');  -- Laos 09-17 23:59:59
-- listing_events around the boundary
INSERT INTO listing_events (property_id, session_id, event_type, created_at) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'b1', 'view', '2026-09-16T16:59:59Z'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'b2', 'view', '2026-09-16T17:00:00Z'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'b3', 'view', '2026-09-17T18:00:00Z');

-- Mid-day (12:00-12:03 Laos == 05:00-05:03Z) golden fixture on Laos 2026-08-06
INSERT INTO page_views (session_id, visitor_id, is_returning, page, referrer, referrer_source, utm_source, utm_medium, utm_campaign, device_type, browser, os, lang, created_at) VALUES
  ('gA', 'gv1', true,  'index.html',   'https://www.google.com/search', 'google',   NULL,       NULL, NULL,     'mobile',  'chrome', 'ios',   'en', '2026-08-06T05:00:00Z'),
  ('gA', 'gv1', true,  'listing.html', 'https://www.google.com/search', 'google',   NULL,       NULL, NULL,     'mobile',  'chrome', 'ios',   'en', '2026-08-06T05:01:00Z'),
  ('gB', 'gv2', false, 'index.html',   NULL,                            'direct',   NULL,       NULL, NULL,     'desktop', 'safari', 'macos', 'lo', '2026-08-06T05:02:00Z'),
  ('gC', 'gv3', false, 'index.html',   'https://m.facebook.com/x',      'facebook', 'facebook', 'cpc', 'summer', 'desktop', 'chrome', 'win',   'en', '2026-08-06T05:03:00Z');
INSERT INTO search_events (session_id, district, property_type, transaction_type, result_count, created_at) VALUES
  ('gA', 'Chanthabouly', 'house', 'rent', 0, '2026-08-06T05:00:00Z'),
  ('gB', 'Chanthabouly', 'condo', 'sale', 5, '2026-08-06T05:01:00Z'),
  ('gC', 'Sikhottabong', 'house', 'rent', 2, '2026-08-06T05:02:00Z');
INSERT INTO ui_events (session_id, element_id, event_type, label, created_at) VALUES
  ('gA', 'agent-profile-link', 'click', 'Agent profile', '2026-08-06T05:00:00Z'),
  ('gB', 'agent-profile-link', 'click', 'Agent profile', '2026-08-06T05:01:00Z'),
  ('gA', '50',                 'scroll', NULL,           '2026-08-06T05:02:00Z');
INSERT INTO listing_events (property_id, session_id, event_type, created_at)
  SELECT 'aaaaaaaa-0000-0000-0000-00000000000b', 'gA', 'impression', '2026-08-06T05:00:00Z' FROM generate_series(1,5);
INSERT INTO listing_events (property_id, session_id, event_type, created_at)
  SELECT 'aaaaaaaa-0000-0000-0000-00000000000b', 'gA', 'click', '2026-08-06T05:00:00Z' FROM generate_series(1,2);
INSERT INTO listing_events (property_id, session_id, event_type, created_at)
  SELECT 'aaaaaaaa-0000-0000-0000-00000000000a', 'gB', 'view', '2026-08-06T05:00:00Z' FROM generate_series(1,2);
-- properties created around the Laos-midnight boundary on 08-06/08-07
INSERT INTO properties (id, title_en, created_at) VALUES
  (gen_random_uuid(), 'New On 0806 last second', '2026-08-06T16:59:59Z'),
  (gen_random_uuid(), 'New On 0807 first second', '2026-08-06T17:00:00Z');

-- Ranked-list fixture: 12 distinct listings x 12 distinct agents, one lead each on Laos 2026-08-05
INSERT INTO parties (id, name_en)
  SELECT ('44444444-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'Agent X' || g FROM generate_series(1, 12) g;
INSERT INTO properties (id, title_en, status, workflow_status, created_at)
  SELECT ('55555555-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'Listing X' || g, 'active', 'active', '2026-07-01T05:00:00Z' FROM generate_series(1, 12) g;
SELECT seed_event('x' || g, '2026-08-05T05:00:00Z'::timestamptz + (g || ' minutes')::interval,
                  ('55555555-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'whatsapp_click', true, 'sx' || g,
                  ('44444444-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid)
FROM generate_series(1, 12) g;

-- Long history: one page_view per Laos day for 1,200 consecutive days ending 2026-06-30
INSERT INTO page_views (session_id, visitor_id, page, created_at)
  SELECT 'h' || g, 'hv' || g, 'index.html', (timestamp '2023-03-19 12:00:00' + (g || ' days')::interval) AT TIME ZONE 'Asia/Vientiane'
  FROM generate_series(0, 1199) g;

-- ── Auth context: staff vs non-staff ───────────────────────────────────────
-- TEST-ONLY: lets this script's own reference queries (raw counts used to
-- cross-check the RPCs) run as `authenticated`. The RPCs are SECURITY DEFINER
-- and never rely on it; production grants no table access through these functions.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000ad01', false);

\echo ''
\echo '=== A. Laos-midnight boundary: every day bucket is the Asia/Vientiane day ==='
DO $$
DECLARE r record; rows_seen int := 0;
BEGIN
  -- traffic_by_day: zero-filled, Laos days
  PERFORM assert_eq((SELECT count(*)::text FROM analytics_traffic_by_day('2026-09-16', '2026-09-19')), '3',
    'traffic_by_day zero-fills every Laos day in [09-16, 09-19)');
  PERFORM assert_eq((SELECT page_views::text FROM analytics_traffic_by_day('2026-09-16', '2026-09-19') WHERE day = '2026-09-16'), '2',
    '16:00Z and 16:59:59Z page_views are on Laos 09-16 (the 17:00:00Z one is NOT: UTC bucketing would say 3)');
  PERFORM assert_eq((SELECT page_views::text FROM analytics_traffic_by_day('2026-09-16', '2026-09-19') WHERE day = '2026-09-17'), '2',
    '17:00:00Z and 16:59:59Z-next-day page_views are both on Laos 09-17');
  PERFORM assert_eq((SELECT page_views::text FROM analytics_traffic_by_day('2026-09-16', '2026-09-19') WHERE day = '2026-09-18'), '0',
    'a day with no traffic is still returned, as zero');
  PERFORM assert_eq((SELECT sessions::text FROM analytics_traffic_by_day('2026-09-16', '2026-09-19') WHERE day = '2026-09-17'), '1',
    'sessions are counted per Laos day (b2 spans both rows)');
  PERFORM assert_eq((SELECT returning_visitors::text FROM analytics_traffic_by_day('2026-09-16', '2026-09-19') WHERE day = '2026-09-17'), '1',
    'returning_visitors is bucketed by Laos day');
  PERFORM assert((SELECT (created_at AT TIME ZONE 'UTC')::date <> (created_at AT TIME ZONE 'Asia/Vientiane')::date
                  FROM page_views WHERE created_at = '2026-09-16T17:00:00Z' LIMIT 1),
    'sanity: the 17:00:00Z row really is a different UTC vs Laos date (the case the old code got wrong)');

  -- session_stats
  PERFORM assert_eq((analytics_session_stats('2026-09-16', '2026-09-17') ->> 'page_views'), '2', 'session_stats [09-16,09-17) page_views');
  PERFORM assert_eq((analytics_session_stats('2026-09-17', '2026-09-18') ->> 'page_views'), '2', 'session_stats [09-17,09-18) page_views');

  -- listing_engagement views_by_day: zero-filled; counts on Laos days
  PERFORM assert_eq((SELECT string_agg((e ->> 'day') || '=' || (e ->> 'views'), ',' ORDER BY e ->> 'day')
                     FROM jsonb_array_elements(analytics_listing_engagement('2026-09-16', '2026-09-19') -> 'views_by_day') e),
    '2026-09-16=1,2026-09-17=1,2026-09-18=1', 'views_by_day buckets 16:59:59Z / 17:00:00Z / next-day 18:00Z on Laos 16 / 17 / 18');

  -- contact-click counts moved server-side and bucketed the same way
  PERFORM assert_eq((analytics_listing_engagement('2026-09-18', '2026-09-19') ->> 'wa_clicks'), '7',
    'wa_clicks (all whatsapp lead_events incl. legacy + unattributed) on Laos 09-18');
  PERFORM assert_eq((analytics_listing_engagement('2026-09-17', '2026-09-18') ->> 'call_clicks'), '1', 'call_clicks on Laos 09-17');
  PERFORM assert_eq((analytics_listing_engagement('2026-08-06', '2026-08-07') ->> 'agent_profile_clicks'), '2', 'agent_profile_clicks on golden day');

  -- funnel: closed uses updated_at, on the Laos day
  PERFORM assert_eq((SELECT sessions::text FROM analytics_funnel('2026-09-17', '2026-09-18') WHERE stage = 'closed'), '1',
    'funnel closed counted on the Laos day of updated_at (16:59:59Z -> 09-17)');
  PERFORM assert_eq((SELECT sessions::text FROM analytics_funnel('2026-09-16', '2026-09-17') WHERE stage = 'closed'), '0',
    'funnel closed NOT counted on 09-16');
  PERFORM assert_eq((SELECT sessions::text FROM analytics_funnel('2026-09-16', '2026-09-17') WHERE stage = 'landed'), '2',
    'funnel landed sessions on Laos 09-16 (s1, b1)');

  -- leads_breakdown day buckets
  PERFORM assert_eq((analytics_leads_breakdown('2026-09-16', '2026-09-17') ->> 'total'), '1', 'leads 09-16 = 1 (16:59:59Z)');
  PERFORM assert_eq((analytics_leads_breakdown('2026-09-17', '2026-09-18') ->> 'total'), '2', 'leads 09-17 = 2 (17:00:00Z and 16:59:59.999999Z-next-day)');
  PERFORM assert_eq((analytics_leads_breakdown('2026-09-18', '2026-09-19') ->> 'total'), '9', 'leads 09-18 = 9');
  PERFORM assert_eq((SELECT string_agg((e ->> 'day') || ':' || (e ->> 'value') || '/' || (e ->> 'legacy') || '/' || (e ->> 'unattributed'), ',' ORDER BY e ->> 'day')
                     FROM jsonb_array_elements(analytics_leads_breakdown('2026-09-16', '2026-09-19') -> 'by_day') e),
    '2026-09-16:1/0/0,2026-09-17:2/1/0,2026-09-18:9/1/1', 'by_day zero-filled with leads/legacy/unattributed per Laos day');
END $$;

\echo ''
\echo '=== B. Today / all-time / custom / empty / invalid ranges ==='
RESET ROLE;
DO $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Vientiane')::date;
        v_start timestamptz := ((now() AT TIME ZONE 'Asia/Vientiane')::date)::timestamp AT TIME ZONE 'Asia/Vientiane';
BEGIN
  PERFORM seed_event('t1', v_start - interval '1 second', 'aaaaaaaa-0000-0000-0000-00000000000b', 'whatsapp_click', true, 'st1');
  PERFORM seed_event('t2', v_start,                       'aaaaaaaa-0000-0000-0000-00000000000b', 'whatsapp_click', true, 'st2');
END $$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000ad01', false);
DO $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Vientiane')::date;
        b jsonb := analytics_history_bounds();
        v_total bigint; v_legacy bigint; v_unattr bigint; v_sum bigint;
        r jsonb;
BEGIN
  PERFORM assert_eq(analytics_leads_breakdown(v_today, v_today + 1) ->> 'total', '1', 'Today = [today, today+1): includes 00:00:00 Laos, excludes 1s earlier');
  PERFORM assert_eq(analytics_leads_breakdown(v_today - 1, v_today) ->> 'total', '1', 'Yesterday = the row 1s before Laos midnight');
  PERFORM assert_eq(b ->> 'tz', 'Asia/Vientiane', 'bounds reports the tz');
  PERFORM assert_eq(b ->> 'today', v_today::text, 'bounds.today is the Laos date');
  PERFORM assert_eq(b -> 'sources' -> 'lead_events' ->> 'first_day', '2026-06-25', 'bounds: oldest lead_event 2026-06-24T22:21Z is Laos 06-25');
  PERFORM assert_eq(b -> 'sources' -> 'leads' ->> 'first_day', '2026-07-10', 'bounds: first lead is Laos 2026-07-10 (the tie fixture)');
  PERFORM assert_eq(b ->> 'earliest_day', (SELECT ((min(created_at)) AT TIME ZONE 'Asia/Vientiane')::date::text FROM page_views),
    'bounds.earliest_day is the true earliest day across all tables (the 1,200-day page_views history)');

  -- ALL TIME: from earliest_day to tomorrow, nothing dropped, parts add up
  r := analytics_leads_breakdown((b ->> 'earliest_day')::date, v_today + 1);
  SELECT count(*) INTO v_total FROM leads;
  SELECT count(*) INTO v_legacy FROM lead_events le WHERE listing_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.lead_event_id = le.id);
  SELECT count(*) INTO v_unattr FROM lead_events le WHERE listing_id IS NULL AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.lead_event_id = le.id);
  PERFORM assert_eq(r ->> 'total', v_total::text, 'ALL TIME: total = every leads row (no 90-day cap)');
  PERFORM assert_eq(r ->> 'legacy_events', v_legacy::text, 'ALL TIME: legacy_events = every listing-bearing lead_event with no leads row');
  PERFORM assert_eq(r ->> 'unattributed_events', v_unattr::text, 'ALL TIME: unattributed_events counted separately');
  SELECT COALESCE(sum((e ->> 'value')::bigint), 0) INTO v_sum FROM jsonb_array_elements(r -> 'by_day') e;
  PERFORM assert_eq(v_sum::text, v_total::text, 'ALL TIME: sum(by_day.value) = total');
  PERFORM assert_eq(jsonb_array_length(r -> 'by_day')::text, (v_today + 1 - (b ->> 'earliest_day')::date)::text,
    'ALL TIME: by_day has one entry per Laos day from earliest_day to today');
  PERFORM assert((SELECT (analytics_session_stats((b ->> 'earliest_day')::date, v_today + 1) ->> 'page_views')::bigint = count(*) FROM page_views),
    'ALL TIME: session_stats counts every page_view ever recorded');

  -- custom single-day, empty and invalid ranges
  PERFORM assert_eq(analytics_leads_breakdown('2026-09-17', '2026-09-18') ->> 'total', '2', 'custom single day [09-17,09-18)');
  PERFORM assert_eq(analytics_leads_breakdown('2026-09-16', '2026-09-19') ->> 'total', '12', 'custom multi-day range');
  PERFORM assert_eq(analytics_leads_breakdown('2026-09-17', '2026-09-17') ->> 'total', '0', 'empty range [d,d) is valid and zero');
  PERFORM assert_eq(jsonb_array_length(analytics_leads_breakdown('2026-09-17', '2026-09-17') -> 'by_day')::text, '0', 'empty range has no day entries');
  BEGIN PERFORM analytics_leads_breakdown('2026-09-18', '2026-09-17'); PERFORM assert(false, 'inverted range must raise');
  EXCEPTION WHEN SQLSTATE '22023' THEN PERFORM assert(true, 'inverted range raises 22023 (visible error, not silent zeros)'); END;
  BEGIN PERFORM analytics_traffic_by_day(NULL, '2026-09-17'); PERFORM assert(false, 'NULL start must raise');
  EXCEPTION WHEN SQLSTATE '22023' THEN PERFORM assert(true, 'NULL bound raises 22023'); END;
END $$;

\echo ''
\echo '=== C. Lead attribution: which listing generated each lead / event ==='
DO $$
DECLARE r jsonb; row_a jsonb;
BEGIN
  r := analytics_lead_activity('2026-09-18', '2026-09-19');
  PERFORM assert_eq(r -> 'totals' ->> 'leads', '9', 'day totals.leads = 9 (same as the summary)');
  PERFORM assert_eq(r -> 'totals' ->> 'legacy_events', '1', 'day totals.legacy_events = 1');
  PERFORM assert_eq(r -> 'totals' ->> 'unattributed_events', '1', 'day totals.unattributed_events = 1');
  PERFORM assert_eq(jsonb_array_length(r -> 'rows')::text, '11', 'day rows = 9 leads + 1 legacy + 1 unattributed');
  PERFORM assert_eq(r ->> 'has_more', 'false', 'no more pages');

  -- multiple leads on the same listing on the same day
  PERFORM assert_eq((SELECT count(*)::text FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000a'), '3',
    'listing A has 3 rows on 09-18 (2 CRM leads + 1 legacy event)');
  PERFORM assert_eq((SELECT count(*)::text FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000a' AND e ->> 'kind' = 'lead'), '2',
    'of which 2 are official leads');
  PERFORM assert_eq((SELECT count(*)::text FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000b'), '2',
    'listing B has the two same-instant leads');

  -- current listing
  SELECT e INTO row_a FROM jsonb_array_elements(analytics_lead_activity('2026-09-16', '2026-09-17') -> 'rows') e LIMIT 1;
  PERFORM assert_eq(row_a ->> 'listing_title', 'Villa Alpha', 'current listing resolves to its title');
  PERFORM assert_eq(row_a ->> 'listing_resolution', 'current', 'resolution = current');
  PERFORM assert_eq(row_a ->> 'is_deleted', 'false', 'current listing is not deleted');
  PERFORM assert_eq(row_a ->> 'property_id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'property id preserved');
  PERFORM assert_eq(row_a ->> 'unit_type_name', 'Studio', 'unit type name resolved');
  PERFORM assert_eq(row_a ->> 'agent_name', 'Agent One', 'agent (operational identity) resolved');
  PERFORM assert_eq(row_a ->> 'contact_name', 'Contact Person', 'recipient contact display name resolved');
  PERFORM assert_eq(row_a ->> 'contact_action', 'whatsapp_click', 'contact action shown');
  PERFORM assert_eq(row_a ->> 'channel', 'whatsapp', 'channel shown');
  PERFORM assert_eq(row_a ->> 'lead_status', 'closed', 'CRM status shown for a lead');
  PERFORM assert_eq(row_a ->> 'kind', 'lead', 'kind = lead');
  PERFORM assert_eq(row_a ->> 'first_touch_source', 'facebook', 'first-touch source from the session''s earliest page_view');
  PERFORM assert_eq(row_a ->> 'laos_day', '2026-09-16', 'laos_day reported');
  PERFORM assert((row_a ->> 'lead_id') IS NOT NULL AND (row_a ->> 'lead_event_id') IS NOT NULL, 'lead and event ids both present');

  -- all contact actions are included (not just WhatsApp)
  PERFORM assert((SELECT array_agg(DISTINCT e ->> 'contact_action' ORDER BY e ->> 'contact_action')
                  FROM jsonb_array_elements(analytics_lead_activity('2026-09-16', '2026-09-19') -> 'rows') e)
                 @> ARRAY['call_click','contact_click','line_click','messenger_click','telegram_click','whatsapp_click'],
    'every contact action type appears in the drill-down');
END $$;

\echo ''
\echo '=== D. Deleted listings: current -> snapshot -> removal log -> unknown id ==='
DO $$
DECLARE r jsonb;
BEGIN
  r := analytics_lead_activity('2026-09-18', '2026-09-19');
  PERFORM assert_eq((SELECT e ->> 'listing_title' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000c'), 'Gamma Soft', 'soft-deleted listing keeps its title');
  PERFORM assert_eq((SELECT e ->> 'listing_resolution' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000c'), 'soft_deleted', 'resolution = soft_deleted');
  PERFORM assert_eq((SELECT e ->> 'is_deleted' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000c'), 'true', 'soft-deleted flagged is_deleted');
  PERFORM assert_eq((SELECT e ->> 'listing_title' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000d' AND e ->> 'kind' = 'lead'), 'Delta Snap', 'hard-deleted listing resolves from the LATEST snapshot');
  PERFORM assert_eq((SELECT e ->> 'listing_resolution' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000d' AND e ->> 'kind' = 'lead'), 'snapshot', 'resolution = snapshot');
  PERFORM assert_eq((SELECT e ->> 'listing_title' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000e'), 'Echo Log', 'no snapshot -> removal log title');
  PERFORM assert_eq((SELECT e ->> 'listing_resolution' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000e'), 'removal_log', 'resolution = removal_log');
  PERFORM assert_eq((SELECT e ->> 'listing_title' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000f'), 'Unknown listing aaaaaaaa', 'nothing anywhere -> "Unknown listing <id prefix>"');
  PERFORM assert_eq((SELECT e ->> 'listing_resolution' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000f'), 'unknown', 'resolution = unknown');
  PERFORM assert_eq((SELECT e ->> 'property_id' FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'listing_resolution' = 'unknown'), 'aaaaaaaa-0000-0000-0000-00000000000f', 'the listing id is ALWAYS preserved, even when unresolvable');
  PERFORM assert((SELECT bool_and((e ->> 'is_deleted')::boolean) FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'listing_resolution' IN ('snapshot','removal_log','unknown','soft_deleted')),
    'every non-current resolution is flagged is_deleted');
  -- 4 leads/events point at non-current listings on 09-18: C, D(lead), E, F
  PERFORM assert_eq(r -> 'totals' ->> 'deleted_listing_rows', '4', 'totals.deleted_listing_rows counts rows whose listing is gone/soft-deleted');
  -- the summary agrees
  PERFORM assert_eq(analytics_leads_breakdown('2026-09-18', '2026-09-19') ->> 'by_listing_deleted', '4', 'leads_breakdown.by_listing_deleted agrees');
END $$;

\echo ''
\echo '=== E. Legacy and unattributed events: preserved, labelled, never counted as leads ==='
DO $$
DECLARE r jsonb; leg jsonb; un jsonb; before_cnt bigint; after_cnt bigint;
BEGIN
  SELECT count(*) INTO before_cnt FROM leads;
  r := analytics_lead_activity('2026-09-17', '2026-09-19');
  SELECT e INTO leg FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'kind' = 'legacy_event' AND e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000a';
  PERFORM assert(leg IS NOT NULL, 'legacy event for listing A is listed');
  PERFORM assert((leg ->> 'lead_id') IS NULL, 'legacy event has NO lead id (no leads row is fabricated)');
  PERFORM assert((leg ->> 'lead_status') IS NULL, 'legacy event has no CRM status');
  PERFORM assert_eq(leg ->> 'listing_title', 'Villa Alpha', 'legacy event retains its listing attribution');
  PERFORM assert((leg ->> 'lead_event_id') IS NOT NULL, 'legacy event carries its lead_event id');
  PERFORM assert_eq(leg ->> 'contact_action', 'whatsapp_click', 'legacy event action shown');
  PERFORM assert_eq(leg ->> 'laos_day', '2026-09-18', 'legacy event 17:00Z+ is on Laos 09-18');
  SELECT e INTO un FROM jsonb_array_elements(r -> 'rows') e WHERE e ->> 'kind' = 'unattributed_event';
  PERFORM assert(un IS NOT NULL, 'unattributed event is listed');
  PERFORM assert((un ->> 'property_id') IS NULL AND (un ->> 'listing_title') IS NULL, 'unattributed event has no listing (and none is invented)');
  PERFORM assert((SELECT e ->> 'lead_id' IS NOT NULL AND e ->> 'lead_event_id' IS NULL AND e ->> 'property_id' IS NULL
                  FROM jsonb_array_elements(analytics_lead_activity('2026-09-18', '2026-09-19') -> 'rows') e WHERE e ->> 'kind' = 'lead' AND e ->> 'property_id' IS NULL),
    'a lead whose listing was detached and that has no event is still a lead row (no listing, no event)');
  -- not counted as leads anywhere
  PERFORM assert_eq(analytics_leads_breakdown('2026-09-17', '2026-09-18') ->> 'total', '2', 'summary total excludes the 09-17 legacy event');
  PERFORM assert_eq(analytics_leads_breakdown('2026-09-17', '2026-09-18') ->> 'legacy_events', '1', 'summary reports the legacy event separately');
  SELECT count(*) INTO after_cnt FROM leads;
  PERFORM assert_eq(after_cnt::text, before_cnt::text, 'reading the drill-down creates no leads rows');
END $$;

\echo ''
\echo '=== F. Per-listing drill-down ==='
DO $$
DECLARE r jsonb;
BEGIN
  r := analytics_lead_activity('2026-06-01', '2026-10-01', 'aaaaaaaa-0000-0000-0000-00000000000a');
  PERFORM assert((SELECT bool_and(e ->> 'property_id' = 'aaaaaaaa-0000-0000-0000-00000000000a') FROM jsonb_array_elements(r -> 'rows') e), 'listing filter returns only that listing');
  PERFORM assert_eq(r -> 'totals' ->> 'distinct_listings', '1', 'distinct_listings = 1');
  PERFORM assert_eq(r -> 'totals' ->> 'leads', '4', 'listing A has 4 CRM leads over the period');
  PERFORM assert_eq(r -> 'totals' ->> 'legacy_events', '2', 'listing A has 2 legacy events (incl. the old June one)');
  PERFORM assert_eq(r -> 'totals' ->> 'unattributed_events', '0', 'unattributed events never match a listing filter');
  PERFORM assert_eq(r ->> 'property_id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'response echoes the filter');
END $$;

\echo ''
\echo '=== G. Keyset paging: exact, no gaps, no duplicates, ties broken ==='
DO $$
DECLARE fulls jsonb; page jsonb; cur jsonb := NULL; ids text[] := '{}'; full_ids text[]; n int := 0; pages int := 0;
BEGIN
  fulls := analytics_lead_activity('2026-09-16', '2026-09-19', NULL, 500);
  SELECT array_agg(COALESCE(e ->> 'lead_id', e ->> 'lead_event_id') ORDER BY ord) INTO full_ids
    FROM jsonb_array_elements(fulls -> 'rows') WITH ORDINALITY AS t(e, ord);
  PERFORM assert_eq(jsonb_array_length(fulls -> 'rows')::text, '15', 'unpaged 3-day range = 12 leads + 2 legacy + 1 unattributed');
  LOOP
    page := analytics_lead_activity('2026-09-16', '2026-09-19', NULL, 4,
                                    (cur ->> 'at')::timestamptz, (cur ->> 'id')::uuid);
    pages := pages + 1;
    SELECT ids || array_agg(COALESCE(e ->> 'lead_id', e ->> 'lead_event_id') ORDER BY ord) INTO ids
      FROM jsonb_array_elements(page -> 'rows') WITH ORDINALITY AS t(e, ord);
    EXIT WHEN (page ->> 'has_more') <> 'true';
    cur := page -> 'next_cursor';
    PERFORM assert(cur IS NOT NULL, 'has_more => next_cursor present');
    EXIT WHEN pages > 20;
  END LOOP;
  PERFORM assert_eq(pages::text, '4', 'limit 4 over 15 rows = 4 pages');
  PERFORM assert(ids = full_ids, 'concatenated pages == unpaged result, same order');
  PERFORM assert_eq((SELECT count(DISTINCT x)::text FROM unnest(ids) x), '15', 'no duplicates across pages');
  PERFORM assert((page -> 'next_cursor') = 'null'::jsonb, 'last page has null next_cursor');
  PERFORM assert_eq(page -> 'totals' ->> 'leads', '12', 'totals describe the whole range on every page');
  -- ordering: newest first
  PERFORM assert((SELECT bool_and((e ->> 'event_at')::timestamptz >= lead_at) FROM (
      SELECT e, lead((e ->> 'event_at')::timestamptz) OVER (ORDER BY ord) AS lead_at
      FROM jsonb_array_elements(fulls -> 'rows') WITH ORDINALITY AS t(e, ord)) s WHERE lead_at IS NOT NULL),
    'rows are newest-first');
  -- same-instant rows straddling a page boundary: limit 1 walks them one by one
  cur := NULL; ids := '{}'; pages := 0;
  LOOP
    page := analytics_lead_activity('2026-09-18', '2026-09-19', 'aaaaaaaa-0000-0000-0000-00000000000b', 1,
                                    (cur ->> 'at')::timestamptz, (cur ->> 'id')::uuid);
    pages := pages + 1;
    ids := ids || (page -> 'rows' -> 0 ->> 'lead_id');
    EXIT WHEN (page ->> 'has_more') <> 'true';
    cur := page -> 'next_cursor';
    EXIT WHEN pages > 5;
  END LOOP;
  PERFORM assert_eq(pages::text, '2', 'two leads at the identical instant are returned on two pages');
  PERFORM assert_eq((SELECT count(DISTINCT x)::text FROM unnest(ids) x), '2', 'the tie-break never skips or repeats a same-instant row');
  -- three leads at one identical instant, walked one per page
  cur := NULL; ids := '{}'; pages := 0;
  LOOP
    page := analytics_lead_activity('2026-07-10', '2026-07-11', NULL, 1, (cur ->> 'at')::timestamptz, (cur ->> 'id')::uuid);
    pages := pages + 1;
    ids := ids || (page -> 'rows' -> 0 ->> 'lead_id');
    EXIT WHEN (page ->> 'has_more') <> 'true';
    cur := page -> 'next_cursor';
    EXIT WHEN pages > 6;
  END LOOP;
  PERFORM assert_eq(pages::text, '3', 'three leads at one identical instant take three pages of 1');
  PERFORM assert_eq((SELECT count(DISTINCT x)::text FROM unnest(ids) x), '3', 'the (event_at, id) keyset never skips or repeats a tied row');
  -- limit clamping and cursor validation
  PERFORM assert_eq(jsonb_array_length(analytics_lead_activity('2026-09-16', '2026-09-19', NULL, 0) -> 'rows')::text, '1', 'p_limit 0 is clamped to 1');
  PERFORM assert_eq(jsonb_array_length(analytics_lead_activity('2026-09-16', '2026-09-19', NULL, 100000) -> 'rows')::text, '15', 'p_limit is clamped to <=500 (and returns everything that exists)');
  BEGIN PERFORM analytics_lead_activity('2026-09-16', '2026-09-19', NULL, 5, now(), NULL); PERFORM assert(false, 'half a cursor must raise');
  EXCEPTION WHEN SQLSTATE '22023' THEN PERFORM assert(true, 'a half-specified cursor raises 22023'); END;
END $$;

\echo ''
\echo '=== H. Ranked lists stay top-10 but are honest about the rest ==='
DO $$
DECLARE r jsonb := analytics_leads_breakdown('2026-08-01', '2026-08-31');
BEGIN
  PERFORM assert_eq(r ->> 'total', '12', '12 leads on 2026-08-05');
  PERFORM assert_eq(jsonb_array_length(r -> 'by_listing')::text, '10', 'by_listing stays a top 10');
  PERFORM assert_eq(r ->> 'by_listing_total', '12', 'by_listing_total = "of N" (12 distinct listings)');
  PERFORM assert_eq(r ->> 'by_listing_other', '2', 'by_listing_other = leads on the 2 listings outside the top 10');
  PERFORM assert_eq(r ->> 'by_listing_unattributed', '0', 'no unattributed leads in this window');
  PERFORM assert_eq(jsonb_array_length(r -> 'by_agent')::text, '10', 'by_agent stays a top 10');
  PERFORM assert_eq(r ->> 'by_agent_total', '12', 'by_agent_total = 12');
  PERFORM assert_eq(r ->> 'by_agent_other', '2', 'by_agent_other = 2');
  r := analytics_leads_breakdown('2026-09-18', '2026-09-19');
  PERFORM assert_eq(r ->> 'by_listing_unattributed', '1', 'the lead with no property is in the unattributed bucket, not dropped');
  PERFORM assert_eq(r ->> 'by_agent_unassigned', '9', 'leads with no agent are counted as unassigned, not dropped');
  PERFORM assert((SELECT COALESCE(sum((e ->> 'value')::int), 0) FROM jsonb_array_elements(r -> 'by_listing') e)
                 + (r ->> 'by_listing_other')::int + (r ->> 'by_listing_unattributed')::int = (r ->> 'total')::int,
    'top + other + unattributed = total (by_listing)');
  PERFORM assert((SELECT COALESCE(sum((e ->> 'value')::int), 0) FROM jsonb_array_elements(r -> 'by_agent') e)
                 + (r ->> 'by_agent_other')::int + (r ->> 'by_agent_unassigned')::int = (r ->> 'total')::int,
    'top + other + unassigned = total (by_agent)');
  PERFORM assert((SELECT bool_and(e ->> 'property_id' IS NOT NULL) FROM jsonb_array_elements(r -> 'by_listing') e), 'each ranked listing carries its property_id');
END $$;

\echo ''
\echo '=== I. Invariants: summary <-> drill-down <-> series ==='
DO $$
DECLARE d date; s jsonb; a jsonb;
BEGIN
  FOR d IN SELECT generate_series('2026-09-16'::date, '2026-09-18'::date, interval '1 day')::date LOOP
    s := analytics_leads_breakdown(d, d + 1);
    a := analytics_lead_activity(d, d + 1);
    PERFORM assert_eq(a -> 'totals' ->> 'leads', s ->> 'total', d || ': drill-down totals.leads = summary total');
    PERFORM assert_eq(a -> 'totals' ->> 'legacy_events', s ->> 'legacy_events', d || ': legacy count agrees');
    PERFORM assert_eq(a -> 'totals' ->> 'unattributed_events', s ->> 'unattributed_events', d || ': unattributed count agrees');
    PERFORM assert_eq(jsonb_array_length(a -> 'rows')::text,
      ((s ->> 'total')::int + (s ->> 'legacy_events')::int + (s ->> 'unattributed_events')::int)::text, d || ': row count = leads + legacy + unattributed');
  END LOOP;
  PERFORM assert((SELECT sum(page_views) FROM analytics_traffic_by_day('2026-09-16', '2026-09-19'))
                 = (analytics_session_stats('2026-09-16', '2026-09-19') ->> 'page_views')::bigint,
    'sum(traffic_by_day.page_views) = session_stats.page_views');
  PERFORM assert((SELECT sum((e ->> 'views')::int) FROM jsonb_array_elements(analytics_listing_engagement('2026-09-16', '2026-09-19') -> 'views_by_day') e)
                 = (analytics_listing_engagement('2026-09-16', '2026-09-19') ->> 'views_total')::int,
    'sum(views_by_day) = views_total');
END $$;

\echo ''
\echo '=== J. Existing summary metrics remain correct (mid-day fixture, Laos 2026-08-06) ==='
DO $$
DECLARE ss jsonb := analytics_session_stats('2026-08-06', '2026-08-07');
        ts jsonb := analytics_traffic_sources('2026-08-06', '2026-08-07');
        lb jsonb := analytics_location_breakdown('2026-08-06', '2026-08-07');
        bh jsonb := analytics_behavior('2026-08-06', '2026-08-07');
        sb jsonb := analytics_search_breakdown('2026-08-06', '2026-08-07');
        le jsonb := analytics_listing_engagement('2026-08-06', '2026-08-07');
        ai jsonb := analytics_admin_insights('2026-08-06', '2026-08-07');
BEGIN
  PERFORM assert_eq(ss ->> 'page_views', '4', 'session_stats.page_views');
  PERFORM assert_eq(ss ->> 'sessions', '3', 'session_stats.sessions');
  PERFORM assert_eq(ss ->> 'unique_visitors', '3', 'session_stats.unique_visitors');
  PERFORM assert_eq(ss ->> 'returning_visitors', '1', 'session_stats.returning_visitors');
  PERFORM assert_eq(ss ->> 'bounce_rate', '66.7', 'session_stats.bounce_rate');
  PERFORM assert_eq(ss ->> 'avg_pages_per_session', '1.33', 'session_stats.avg_pages_per_session');
  PERFORM assert_eq(ss ->> 'avg_session_duration_seconds', '20', 'session_stats.avg_session_duration_seconds');
  PERFORM assert_eq(ts -> 'by_source' ->> 'google', '2', 'traffic_sources.by_source google');
  PERFORM assert_eq(ts -> 'by_source' ->> 'direct', '1', 'traffic_sources.by_source direct');
  PERFORM assert_eq(ts -> 'campaigns' -> 0 ->> 'campaign', 'summer', 'traffic_sources.campaigns');
  PERFORM assert_eq(ts -> 'top_referrers' -> 0 ->> 'label', 'google.com', 'traffic_sources.top_referrers host');
  PERFORM assert_eq(lb -> 'device' ->> 'mobile', '2', 'location.device mobile');
  PERFORM assert_eq(lb -> 'lang' ->> 'lo', '1', 'location.lang lo');
  PERFORM assert_eq(bh -> 'entry' -> 0 ->> 'label', 'index.html', 'behavior.entry');
  PERFORM assert_eq(bh -> 'entry' -> 0 ->> 'value', '3', 'behavior.entry count');
  PERFORM assert_eq(bh -> 'scroll' ->> '50', '1', 'behavior.scroll 50');
  PERFORM assert_eq(bh -> 'top_clicks' -> 0 ->> 'label', 'Agent profile', 'behavior.top_clicks');
  PERFORM assert_eq(sb ->> 'total', '3', 'search.total');
  PERFORM assert_eq(sb ->> 'zero_result', '1', 'search.zero_result');
  PERFORM assert_eq(sb -> 'by_district' -> 0 ->> 'label', 'Chanthabouly', 'search.by_district top');
  PERFORM assert_eq(le ->> 'views_total', '2', 'listing_engagement.views_total');
  PERFORM assert_eq(le -> 'top_ctr' -> 0 ->> 'value', '40.0', 'listing_engagement.top_ctr 2 clicks / 5 impressions');
  PERFORM assert_eq(le ->> 'most_viewed_total', '1', 'listing_engagement.most_viewed_total');
  PERFORM assert_eq(le -> 'most_viewed' -> 0 ->> 'label', 'Villa Alpha', 'listing_engagement.most_viewed label');
  PERFORM assert_eq(ai ->> 'new_listings', '1', 'admin_insights.new_listings counts 16:59:59Z (Laos 08-06) but not 17:00:00Z (Laos 08-07)');
  PERFORM assert_eq(analytics_admin_insights('2026-08-07', '2026-08-08') ->> 'new_listings', '1', '... which lands on Laos 08-07');
END $$;

\echo ''
\echo '=== K. Full history: no 90-day (or 1000-day) cap inside the RPCs ==='
DO $$
DECLARE n int; mn date; mx date; s bigint; b jsonb := analytics_history_bounds();
BEGIN
  SELECT count(*), min(day), max(day), sum(page_views) INTO n, mn, mx, s
    FROM analytics_traffic_by_day((b ->> 'earliest_day')::date, (b ->> 'today')::date + 1);
  PERFORM assert(n > 1200, 'traffic_by_day returns > 1,200 daily rows in one call (the client chunks at <=900 for PostgREST; SQL does not truncate)');
  PERFORM assert_eq(n::text, ((b ->> 'today')::date + 1 - (b ->> 'earliest_day')::date)::text, 'one row per day, contiguous, first to last');
  PERFORM assert_eq(mn::text, b ->> 'earliest_day', 'first row = earliest_day');
  PERFORM assert_eq(s::text, (SELECT count(*)::text FROM page_views), 'every page_view in the whole history is counted exactly once');
  PERFORM assert_eq((SELECT count(*)::text FROM analytics_traffic_by_day('2026-09-01', '2026-09-01')), '0', 'empty range returns no rows');
END $$;

\echo ''
\echo '=== L. Privacy: no buyer names/phones, no contact phones, in any analytics output ==='
DO $$
DECLARE txt text;
BEGIN
  txt := analytics_lead_activity('2026-06-01', '2026-10-01', NULL, 500)::text
      || analytics_leads_breakdown('2026-06-01', '2026-10-01')::text
      || analytics_admin_insights('2026-06-01', '2026-10-01')::text;
  PERFORM assert(txt NOT LIKE '%Secret Buyer%', 'no leads.customer_name value appears');
  PERFORM assert(txt NOT LIKE '%+85620555%', 'no leads.customer_phone value appears');
  PERFORM assert(txt NOT LIKE '%private note%', 'no leads.notes value appears');
  PERFORM assert(txt NOT LIKE '%+85620999888%', 'no contacts.phone / whatsapp value appears');
  PERFORM assert(txt NOT LIKE '%customer_%' AND txt NOT LIKE '%"phone"%' AND txt NOT LIKE '%whatsapp":%', 'no phone/customer keys are emitted');
END $$;

\echo ''
\echo '=== M. ACL, SECURITY DEFINER, search_path, index, no UTC bucketing left ==='
RESET ROLE;
DO $$
DECLARE f text; fns text[] := ARRAY[
  'analytics_traffic_by_day(date,date)','analytics_funnel(date,date)','analytics_session_stats(date,date)',
  'analytics_traffic_sources(date,date)','analytics_listing_engagement(date,date)','analytics_search_breakdown(date,date)',
  'analytics_behavior(date,date)','analytics_location_breakdown(date,date)','analytics_leads_breakdown(date,date)',
  'analytics_admin_insights(date,date)','analytics_history_bounds()',
  'analytics_lead_activity(date,date,uuid,integer,timestamptz,uuid)'];
  def text; cfg text[];
BEGIN
  FOREACH f IN ARRAY fns LOOP
    PERFORM assert((SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure), f || ' is SECURITY DEFINER');
    SELECT proconfig INTO cfg FROM pg_proc WHERE oid = f::regprocedure;
    PERFORM assert(cfg @> ARRAY['search_path=public, pg_temp'], f || ' pins search_path = public, pg_temp');
    PERFORM assert(NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE'), f || ': anon cannot EXECUTE');
    PERFORM assert(has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'), f || ': authenticated can EXECUTE');
    PERFORM assert(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               WHERE p.oid = f::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
      f || ': no PUBLIC EXECUTE grant');
    def := pg_get_functiondef(f::regprocedure);
    PERFORM assert(def LIKE '%is_pintag_staff(auth.uid())%', f || ' is gated through is_pintag_staff(auth.uid())');
    PERFORM assert(def !~ 'created_at::date' AND def !~ 'updated_at::date', f || ' has no bare created_at::date / updated_at::date bucketing');
    PERFORM assert(def !~ '(?i)AT TIME ZONE ''UTC''' AND def !~ '(?i)time zone ''(?!Asia/Vientiane)', f || ' uses no other timezone literal');
  END LOOP;
  PERFORM assert(NOT has_function_privilege('anon', 'analytics_listing_labels(uuid[])'::regprocedure, 'EXECUTE')
             AND NOT has_function_privilege('authenticated', 'analytics_listing_labels(uuid[])'::regprocedure, 'EXECUTE'),
    'the internal analytics_listing_labels helper is callable by no client role');
  PERFORM assert((SELECT NOT prosecdef FROM pg_proc WHERE oid = 'analytics_listing_labels(uuid[])'::regprocedure), 'helper is SECURITY INVOKER (only ever reached from the DEFINER functions)');
  PERFORM assert(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_leads_lead_event_id'), 'idx_leads_lead_event_id exists');
  PERFORM assert(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_leads_lead_event_id' AND indexdef LIKE '%(lead_event_id)%'), 'index is on leads(lead_event_id)');
END $$;

\echo ''
\echo '=== N. Access control at runtime ==='
SET ROLE anon;
DO $$
BEGIN
  BEGIN PERFORM analytics_lead_activity('2026-09-16', '2026-09-19'); PERFORM assert(false, 'anon must be denied');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM assert(true, 'anon cannot call analytics_lead_activity (permission denied)'); END;
  BEGIN PERFORM analytics_history_bounds(); PERFORM assert(false, 'anon must be denied');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM assert(true, 'anon cannot call analytics_history_bounds'); END;
  BEGIN PERFORM analytics_leads_breakdown('2026-09-16', '2026-09-19'); PERFORM assert(false, 'anon must be denied');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM assert(true, 'anon cannot call analytics_leads_breakdown'); END;
  BEGIN PERFORM analytics_listing_labels(ARRAY[gen_random_uuid()]); PERFORM assert(false, 'anon must be denied');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM assert(true, 'anon cannot call the internal helper'); END;
END $$;
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ff', false);  -- signed in but NOT staff
DO $$
BEGIN
  BEGIN PERFORM analytics_lead_activity('2026-09-16', '2026-09-19'); PERFORM assert(false, 'non-staff must be denied');
  EXCEPTION WHEN OTHERS THEN PERFORM assert(SQLERRM LIKE 'Access denied%', 'a signed-in NON-staff user is refused by the is_pintag_staff gate'); END;
  BEGIN PERFORM analytics_history_bounds(); PERFORM assert(false, 'non-staff must be denied');
  EXCEPTION WHEN OTHERS THEN PERFORM assert(SQLERRM LIKE 'Access denied%', 'non-staff refused: analytics_history_bounds'); END;
  BEGIN PERFORM analytics_traffic_by_day('2026-09-16', '2026-09-19'); PERFORM assert(false, 'non-staff must be denied');
  EXCEPTION WHEN OTHERS THEN PERFORM assert(SQLERRM LIKE 'Access denied%', 'non-staff refused: analytics_traffic_by_day'); END;
END $$;

-- search_path hijack: a temp table named like a real one must NOT shadow it
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000ad01', false);
CREATE TEMP TABLE page_views (id uuid, session_id text, visitor_id text, is_returning boolean, page text, created_at timestamptz);
INSERT INTO pg_temp.page_views VALUES (gen_random_uuid(), 'evil', 'evil', false, 'evil', '2026-09-16T05:00:00Z');
CREATE TEMP TABLE leads (id uuid, created_at timestamptz);
DO $$
BEGIN
  PERFORM assert_eq((SELECT page_views::text FROM analytics_traffic_by_day('2026-09-16', '2026-09-17') WHERE day = '2026-09-16'), '2',
    'a pg_temp.page_views cannot shadow public.page_views inside the SECURITY DEFINER function');
  PERFORM assert_eq(analytics_leads_breakdown('2026-09-16', '2026-09-17') ->> 'total', '1', 'a pg_temp.leads cannot shadow public.leads');
END $$;
DROP TABLE pg_temp.page_views;
DROP TABLE pg_temp.leads;
RESET ROLE;

\echo ''
\echo 'ALL ANALYTICS LAOS-CALENDAR / DRILL-DOWN ASSERTIONS PASSED'
