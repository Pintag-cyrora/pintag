-- ============================================================================
-- ANALYTICS SCALE PROBE (all-time ranges over production-sized-and-then-some data)
-- ============================================================================
-- Loaded into a SEPARATE throwaway database by
-- run-analytics-laos-calendar-days-pg.sh (schema + both migrations applied,
-- no fixture rows). Generates a deterministic data set roughly 30x today's
-- production volume for leads/lead_events and 40x for page_views:
--     300,000 page_views (100,000 sessions)   200,000 listing_events
--      30,000 lead_events (~26,000 leads)      30,000 search_events
--      60,000 ui_events                          500 listings, 50 agents
-- spread over 800 days, then asserts every all-time analytics RPC finishes
-- well inside the 8 s statement_timeout that Supabase applies to the
-- `authenticated` role (budget here: ANALYTICS_SCALE_BUDGET_MS, default 4000,
-- i.e. half the real limit), that no result is silently truncated, and that
-- the summaries still agree with the raw tables.
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on

CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'SCALE REGRESSION FAILED: %', p_what; END IF;
  RAISE NOTICE '  ok  %', p_what;
END $$;

SELECT setseed(0.42);

INSERT INTO parties (id, name_en) SELECT gen_random_uuid(), 'Agent ' || g FROM generate_series(1, 50) g;
INSERT INTO properties (id, slug, title_en, status, workflow_status, property_type, district_en, view_count, created_at)
  SELECT gen_random_uuid(), 'l' || g, 'Listing ' || g, 'active', 'active',
         (ARRAY['house','condo','land'])[1 + g % 3], (ARRAY['Chanthabouly','Sikhottabong','Xaythany'])[1 + g % 3],
         g % 40, timestamp '2024-06-01' + (g || ' hours')::interval
  FROM generate_series(1, 500) g;

-- 300k page_views over 800 days ending 2026-09-29, 3 views per session
INSERT INTO page_views (session_id, visitor_id, is_returning, page, referrer_source, device_type, browser, os, lang, created_at)
  SELECT 'ps' || (g / 3), 'pv' || (g / 6), (g % 5 = 0), (ARRAY['index.html','listings.html','listing.html'])[1 + g % 3],
         (ARRAY['direct','google','facebook','line'])[1 + g % 4], (ARRAY['mobile','desktop'])[1 + g % 2],
         (ARRAY['chrome','safari'])[1 + g % 2], (ARRAY['ios','android','win'])[1 + g % 3], (ARRAY['en','lo'])[1 + g % 2],
         timestamptz '2026-09-29 23:00:00+07' - (random() * 800 * 86400 || ' seconds')::interval
  FROM generate_series(1, 300000) g;

INSERT INTO listing_events (property_id, session_id, event_type, created_at)
  SELECT (SELECT id FROM properties OFFSET (g % 500) LIMIT 1), 'ps' || (g % 100000),
         (ARRAY['view','impression','click','save','share'])[1 + g % 5],
         timestamptz '2026-09-29 23:00:00+07' - (random() * 800 * 86400 || ' seconds')::interval
  FROM generate_series(1, 200000) g;

INSERT INTO search_events (session_id, district, property_type, transaction_type, result_count, created_at)
  SELECT 'ps' || (g % 100000), (ARRAY['Chanthabouly','Sikhottabong','Xaythany'])[1 + g % 3], (ARRAY['house','condo'])[1 + g % 2],
         (ARRAY['rent','sale'])[1 + g % 2], g % 7, timestamptz '2026-09-29 23:00:00+07' - (random() * 800 * 86400 || ' seconds')::interval
  FROM generate_series(1, 30000) g;

INSERT INTO ui_events (session_id, element_id, event_type, label, created_at)
  SELECT 'ps' || (g % 100000), (ARRAY['agent-profile-link','25','50','75','100','cta'])[1 + g % 6],
         (ARRAY['click','scroll'])[1 + g % 2], 'x', timestamptz '2026-09-29 23:00:00+07' - (random() * 800 * 86400 || ' seconds')::interval
  FROM generate_series(1, 60000) g;

-- 30k lead_events (sessions share page_views sessions so first-touch really joins); ~7/8 get a CRM lead
WITH props AS (SELECT array_agg(id) AS ids FROM properties), agents AS (SELECT array_agg(id) AS ids FROM parties)
INSERT INTO lead_events (id, listing_id, agent_id, event_type, session_id, created_at)
  SELECT gen_random_uuid(),
         CASE WHEN g % 200 = 0 THEN NULL ELSE (SELECT ids[1 + g % 500] FROM props) END,
         (SELECT ids[1 + g % 50] FROM agents),
         (ARRAY['whatsapp_click','call_click','messenger_click','line_click'])[1 + g % 4],
         'ps' || (g % 100000),
         timestamptz '2026-09-29 23:00:00+07' - (random() * 800 * 86400 || ' seconds')::interval
  FROM generate_series(1, 30000) g;
INSERT INTO leads (property_id, party_id, lead_event_id, status, contact_method, created_at, updated_at)
  SELECT le.listing_id, le.agent_id, le.id, 'new', regexp_replace(le.event_type, '_click$', ''), le.created_at, le.created_at
  FROM (SELECT *, row_number() OVER (ORDER BY created_at) rn FROM lead_events WHERE listing_id IS NOT NULL) le
  WHERE le.rn % 8 <> 0;
ANALYZE;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;  -- TEST-ONLY, for this script's reference counts
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000ad01', false);

\echo ''
\echo '=== Scale: all-time RPC latency and completeness ==='
DO $$
DECLARE
  budget numeric := COALESCE(NULLIF(current_setting('analytics.scale_budget_ms', true), '')::numeric, 4000);
  b jsonb; d0 date; d1 date; t timestamptz; ms numeric; r jsonb; n bigint; tot bigint;
  worst numeric := 0;
BEGIN
  b := analytics_history_bounds();
  d0 := (b ->> 'earliest_day')::date; d1 := (b ->> 'today')::date + 1;
  RAISE NOTICE '  range: % .. % (% days)', d0, d1, d1 - d0;

  t := clock_timestamp(); PERFORM analytics_traffic_by_day(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  traffic_by_day        % ms', round(ms);
  PERFORM assert(ms < budget, 'traffic_by_day all-time under budget');

  t := clock_timestamp(); r := analytics_session_stats(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  session_stats         % ms', round(ms);
  PERFORM assert(ms < budget, 'session_stats all-time under budget');
  SELECT count(*) INTO n FROM page_views;
  PERFORM assert((r ->> 'page_views')::bigint = n, 'session_stats counts every one of the ' || n || ' page_views');

  t := clock_timestamp(); PERFORM analytics_funnel(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  funnel                % ms', round(ms);
  PERFORM assert(ms < budget, 'funnel all-time under budget');

  t := clock_timestamp(); PERFORM analytics_traffic_sources(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  traffic_sources       % ms', round(ms);
  PERFORM assert(ms < budget, 'traffic_sources all-time under budget');

  t := clock_timestamp(); r := analytics_listing_engagement(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  listing_engagement    % ms', round(ms);
  PERFORM assert(ms < budget, 'listing_engagement all-time under budget');
  SELECT count(*) INTO n FROM listing_events WHERE event_type = 'view';
  PERFORM assert((r ->> 'views_total')::bigint = n, 'listing_engagement counts every view');

  t := clock_timestamp(); PERFORM analytics_search_breakdown(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  search_breakdown      % ms', round(ms);
  PERFORM assert(ms < budget, 'search_breakdown all-time under budget');

  t := clock_timestamp(); PERFORM analytics_behavior(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  behavior              % ms', round(ms);
  PERFORM assert(ms < budget, 'behavior all-time under budget');

  t := clock_timestamp(); PERFORM analytics_location_breakdown(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  location_breakdown    % ms', round(ms);
  PERFORM assert(ms < budget, 'location_breakdown all-time under budget');

  t := clock_timestamp(); r := analytics_leads_breakdown(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  leads_breakdown       % ms', round(ms);
  PERFORM assert(ms < budget, 'leads_breakdown all-time under budget (first-touch lateral join over every lead)');
  SELECT count(*) INTO n FROM leads;
  PERFORM assert((r ->> 'total')::bigint = n, 'leads_breakdown counts every one of the ' || n || ' leads');
  SELECT count(*) INTO tot FROM lead_events le WHERE listing_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.lead_event_id = le.id);
  PERFORM assert((r ->> 'legacy_events')::bigint = tot, 'legacy_events = ' || tot);

  t := clock_timestamp(); PERFORM analytics_admin_insights(d0, d1);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  admin_insights        % ms', round(ms);
  PERFORM assert(ms < budget, 'admin_insights all-time under budget');

  -- drill-down: the first page of an all-time range, and the all-time totals
  t := clock_timestamp(); r := analytics_lead_activity(d0, d1, NULL, 200);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000; worst := GREATEST(worst, ms);
  RAISE NOTICE '  timing  lead_activity page 1 % ms (200 rows, all-time totals)', round(ms);
  PERFORM assert(ms < budget, 'lead_activity first page of an all-time range under budget');
  PERFORM assert(jsonb_array_length(r -> 'rows') = 200 AND (r ->> 'has_more') = 'true', 'first page is full and says there is more');
  SELECT count(*) INTO n FROM leads;
  PERFORM assert((r -> 'totals' ->> 'leads')::bigint = n, 'lead_activity totals.leads = every lead');
  PERFORM assert((r -> 'totals' ->> 'legacy_events')::bigint = tot, 'lead_activity totals.legacy_events agrees with the raw tables');

  -- a deep page (keyset, not OFFSET) costs the same as page 1
  t := clock_timestamp();
  PERFORM analytics_lead_activity(d0, d1, NULL, 200, (r -> 'next_cursor' ->> 'at')::timestamptz, (r -> 'next_cursor' ->> 'id')::uuid);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000;
  RAISE NOTICE '  timing  lead_activity page 2 % ms', round(ms);
  PERFORM assert(ms < budget, 'lead_activity page 2 under budget');

  -- one busy day
  t := clock_timestamp(); r := analytics_lead_activity(d1 - 30, d1 - 29);
  ms := extract(epoch FROM clock_timestamp() - t) * 1000;
  RAISE NOTICE '  timing  lead_activity one day % ms', round(ms);
  PERFORM assert(ms < 1500, 'a single-day drill-down is fast');

  RAISE NOTICE '  worst all-time RPC: % ms (budget % ms; production timeout is 8000 ms)', round(worst), budget;
END $$;
RESET ROLE;

\echo ''
\echo 'ANALYTICS SCALE PROBE PASSED'
