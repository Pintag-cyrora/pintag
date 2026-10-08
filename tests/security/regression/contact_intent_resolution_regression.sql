-- ============================================================================
-- CONTACT INTENT FUNNEL v2 — RESOLUTION REGRESSION
-- (supabase/migrations/20261009000000_analytics_contact_intent_resolution.sql)
-- ============================================================================
-- Terms & utilities, Price & deposit, resolution answer_on_site / escalate_to_agent, topic deposit,
-- "Ask the agent" clicks. Range under test: Laos 2026-10-15 (distinct from the v1 fixtures, which live
-- on 2026-10-07/08 and are NOT touched). Each visitor is its own session (rNN):
--
--   r01 Ask -> Terms answered on site
--   r02 Ask -> Terms escalated -> taps "Ask the agent" (cta, resolution+topic) + lead
--   r03 Ask -> Terms escalated, never contacts the agent
--   r04 Ask -> Price answered, topic deposit
--   r05 Ask -> Price escalated (deposit not listed) -> "Ask the agent" (topic deposit) + lead
--   r06 Ask -> Price with NO resolution (a row written before this change)
--   r07 Ask -> Price (topic price) + Terms answered + Where
--   r08 Ask -> Price escalated AND Price answered (same visit, both buckets)
--   r09 Ask -> Terms with a FORGED resolution/topic (normalised away)
--   r10 a Terms tap from a session that never opened Ask (not a visit)
--   r11 Ask -> a bare "Ask the agent" click (no escalated tap before it) + lead
--   r12 Ask -> Terms escalated -> then a plain CALL (no resolution) + call lead
--   r13 a NULL-session Terms tap (ignored)
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'REGRESSION FAILED: %', p_what; END IF;
  RAISE NOTICE '  ok  %', p_what;
END $$;
CREATE OR REPLACE FUNCTION assert_eq(p_actual text, p_expected text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'REGRESSION FAILED: % (expected %, got %)', p_what, p_expected, p_actual; END IF;
  RAISE NOTICE '  ok  %', p_what;
END $$;

INSERT INTO properties (id, slug, title_en, status, workflow_status, property_type, district_en, created_at)
VALUES ('aaaaaaaa-0000-0000-0000-00000000000a', 'villa-alpha', 'Villa Alpha', 'active', 'active', 'house', 'Chanthabouly', '2026-07-01T05:00:00Z')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION rx_meta(p_intent text, p_surface text, p_resolution text DEFAULT NULL, p_topic text DEFAULT NULL, p_channel text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('intent', p_intent, 'lang', 'en', 'surface', p_surface,
    'resolution', p_resolution, 'topic', p_topic, 'channel', p_channel,
    'availability', jsonb_build_object('available', true, 'reason', NULL, 'scope', 'property')))
$$;
CREATE OR REPLACE FUNCTION rx_ui(p_sess text, p_el text, p_at timestamptz, p_meta jsonb, p_type text DEFAULT 'contact_intent')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO ui_events (session_id, page, element_id, element_type, event_type, label, property_id, metadata, created_at)
  VALUES (p_sess, 'listing.html', p_el, p_type, 'click', p_el, 'aaaaaaaa-0000-0000-0000-00000000000a', p_meta, p_at)
$$;
CREATE OR REPLACE FUNCTION rx_lead(p_sess text, p_type text, p_at timestamptz) RETURNS void LANGUAGE sql AS $$
  INSERT INTO lead_events (session_id, listing_id, event_type, created_at) VALUES (p_sess, 'aaaaaaaa-0000-0000-0000-00000000000a', p_type, p_at)
$$;

DO $$
DECLARE T constant timestamptz := '2026-10-15T03:00:00Z'; O constant text := 'contact_intent_open';
BEGIN
  -- r01
  PERFORM rx_ui('r01', O, T, rx_meta('open','panel'));
  PERFORM rx_ui('r01', 'contact_intent_terms', T + interval '5 s', rx_meta('terms','panel','answer_on_site','terms'));
  -- r02
  PERFORM rx_ui('r02', O, T, rx_meta('open','sheet'));
  PERFORM rx_ui('r02', 'contact_intent_terms', T + interval '5 s', rx_meta('terms','sheet','escalate_to_agent','terms'));
  PERFORM rx_ui('r02', 'contact_intent_contact_agent', T + interval '20 s', rx_meta('contact_agent','answer','escalate_to_agent','terms','whatsapp'), 'cta');
  PERFORM rx_lead('r02', 'whatsapp_click', T + interval '21 s');
  -- r03
  PERFORM rx_ui('r03', O, T, rx_meta('open','panel'));
  PERFORM rx_ui('r03', 'contact_intent_terms', T + interval '5 s', rx_meta('terms','panel','escalate_to_agent','terms'));
  -- r04
  PERFORM rx_ui('r04', O, T, rx_meta('open','panel'));
  PERFORM rx_ui('r04', 'contact_intent_price', T + interval '5 s', rx_meta('price','panel','answer_on_site','deposit'));
  -- r05
  PERFORM rx_ui('r05', O, T, rx_meta('open','panel'));
  PERFORM rx_ui('r05', 'contact_intent_price', T + interval '5 s', rx_meta('price','panel','escalate_to_agent','deposit'));
  PERFORM rx_ui('r05', 'contact_intent_contact_agent', T + interval '30 s', rx_meta('contact_agent','answer','escalate_to_agent','deposit','whatsapp'), 'cta');
  PERFORM rx_lead('r05', 'whatsapp_click', T + interval '31 s');
  -- r06 (no resolution at all)
  PERFORM rx_ui('r06', O, T, rx_meta('open','panel'));
  PERFORM rx_ui('r06', 'contact_intent_price', T + interval '5 s', rx_meta('price','panel'));
  -- r07
  PERFORM rx_ui('r07', O, T, rx_meta('open','panel'));
  PERFORM rx_ui('r07', 'contact_intent_price', T + interval '5 s', rx_meta('price','panel','answer_on_site','price'));
  PERFORM rx_ui('r07', 'contact_intent_terms', T + interval '9 s', rx_meta('terms','panel','answer_on_site','terms'));
  PERFORM rx_ui('r07', 'contact_intent_location', T + interval '12 s', rx_meta('location','panel'));
  -- r08
  PERFORM rx_ui('r08', O, T, rx_meta('open','panel'));
  PERFORM rx_ui('r08', 'contact_intent_price', T + interval '5 s', rx_meta('price','panel','escalate_to_agent','deposit'));
  PERFORM rx_ui('r08', 'contact_intent_price', T + interval '15 s', rx_meta('price','panel','answer_on_site','deposit'));
  -- r09 forged values
  PERFORM rx_ui('r09', O, T, rx_meta('open','panel'));
  PERFORM rx_ui('r09', 'contact_intent_terms', T + interval '5 s', rx_meta('terms','panel','drop table x','nonsense'));
  -- r10 no Ask
  PERFORM rx_ui('r10', 'contact_intent_terms', T, rx_meta('terms','panel','escalate_to_agent','terms'));
  -- r11 bare ask-the-agent click after an open
  PERFORM rx_ui('r11', O, T, rx_meta('open','panel'));
  PERFORM rx_ui('r11', 'contact_intent_contact_agent', T + interval '10 s', rx_meta('contact_agent','answer','escalate_to_agent','terms','whatsapp'), 'cta');
  PERFORM rx_lead('r11', 'whatsapp_click', T + interval '11 s');
  -- r12 escalated, then a plain call
  PERFORM rx_ui('r12', O, T, rx_meta('open','sheet'));
  PERFORM rx_ui('r12', 'contact_intent_terms', T + interval '5 s', rx_meta('terms','sheet','escalate_to_agent','terms'));
  PERFORM rx_ui('r12', 'contact_intent_contact_agent', T + interval '40 s', rx_meta('contact_agent','sheet',NULL,NULL,'call'), 'cta');
  PERFORM rx_lead('r12', 'call_click', T + interval '41 s');
  -- r13 NULL session
  PERFORM rx_ui(NULL, 'contact_intent_terms', T, rx_meta('terms','panel','escalate_to_agent','terms'));
END $$;

CREATE TABLE rr_result (k text PRIMARY KEY, j jsonb);
GRANT ALL ON rr_result TO authenticated;
CREATE OR REPLACE FUNCTION rr(p_k text, VARIADIC p_path text[]) RETURNS text LANGUAGE sql AS $$ SELECT j #>> p_path FROM rr_result WHERE k = p_k $$;
CREATE TABLE rr_counts_before AS SELECT (SELECT count(*) FROM ui_events) AS ui, (SELECT count(*) FROM lead_events) AS ld;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000ad01', false);
INSERT INTO rr_result VALUES ('main', analytics_contact_intent_funnel('2026-10-15', '2026-10-16'));
RESET ROLE;

\echo '=== A. Visits, and the v1 keys keep their meaning ==='
SELECT assert_eq(rr('main','ask','visits'), '11', 'visits: r01-r09, r11, r12 (r10 never opened Ask; r13 has no session)');
SELECT assert_eq(rr('main','contact_intent','price_visits'), '5', 'price_visits is still "any Price tap": r04, r05, r06, r07, r08');
SELECT assert_eq(rr('main','contact_intent','where_visits'), '1', 'where_visits unchanged');

\echo ''
\echo '=== B. Terms & utilities ==='
SELECT assert_eq(rr('main','contact_intent','terms_visits'), '6', 'terms_visits: r01, r02, r03, r07, r09, r12 (not r10/r13)');
SELECT assert_eq(rr('main','resolution','terms','answer_on_site'), '2', 'Terms answered on site: r01, r07');
SELECT assert_eq(rr('main','resolution','terms','escalate_to_agent'), '3', 'Terms escalated: r02, r03, r12');
SELECT assert_eq(rr('main','resolution','terms','unspecified'), '1', 'a FORGED resolution is normalised away: r09 is "unspecified", not a made-up bucket');

\echo ''
\echo '=== C. Price & deposit ==='
SELECT assert_eq(rr('main','resolution','price','answer_on_site'), '3', 'Price answered: r04, r07, r08');
SELECT assert_eq(rr('main','resolution','price','escalate_to_agent'), '2', 'Price escalated (deposit not listed): r05, r08');
SELECT assert_eq(rr('main','resolution','price','unspecified'), '1', 'Price with no resolution (pre-change rows): r06');
SELECT assert_eq(rr('main','resolution','deposit_topic','answer_on_site'), '2', 'topic deposit answered: r04, r08');
SELECT assert_eq(rr('main','resolution','deposit_topic','escalate_to_agent'), '2', 'topic deposit escalated: r05, r08');

\echo ''
\echo '=== D. Self-service no longer counts an unanswered question ==='
SELECT assert_eq(rr('main','contact_intent','self_service_visits'), '6', 'self-service: r01, r04, r06 (no resolution = unchanged), r07, r08 (it also got an answer), r09 (forged = not escalated)');
SELECT assert_eq(rr('main','contact_intent','escalated_visits'), '5', 'escalated visits: r02, r03, r05, r08, r12');
SELECT assert_eq(rr('main','resolution','escalated_visits'), '5', 'same number under the resolution block');
SELECT assert_eq(rr('main','contact_intent','intent_chosen_visits'), '11', 'every visit chose something (escalated taps count as a chosen intent)');

\echo ''
\echo '=== E. "Ask the agent" clicks and escalation -> contact ==='
SELECT assert_eq(rr('main','resolution','ask_agent_clicks','visits'), '3', 'visits that tapped an Ask-the-agent button: r02, r05, r11');
SELECT assert_eq(rr('main','resolution','ask_agent_clicks','terms'), '2', '...about terms: r02, r11');
SELECT assert_eq(rr('main','resolution','ask_agent_clicks','deposit'), '1', '...about the deposit: r05');
SELECT assert_eq(rr('main','resolution','escalated_then_contact_visits'), '3', 'escalated, then contacted the agent: r02, r05, r12 (r03/r08 never did; r11 never escalated first)');
SELECT assert_eq(rr('main','high_intent','agent_contact_visits'), '4', 'agent contact: r02, r05, r11 (WhatsApp) + r12 (Call)');
SELECT assert_eq(rr('main','high_intent','call_visits'), '1', 'the plain call is still a Call');
SELECT assert_eq(rr('main','high_intent','whatsapp_visits'), '3', 'Ask-the-agent clicks are WhatsApp contact: r02, r05, r11');
SELECT assert_eq(rr('main','high_intent','contact_click_visits'), '4', 'leads: r02, r05, r11, r12');
SELECT assert_eq(rr('main','high_intent','contact_clicks'), '4', 'four leads, one each');
SELECT assert_eq(rr('main','high_intent','agent_contact_via_menu_visits'), '1', 'only r12 contacted from the sheet itself; answer-box clicks are not menu rows');
SELECT assert_eq(rr('main','clicks','total'), '4', 'range-wide contact clicks agree');
SELECT assert_eq(rr('main','clicks','via_ask','total'), '4', 'all four came after an Ask open');

\echo ''
\echo '=== F. Invariants the dashboard relies on ==='
SELECT assert((rr('main','contact_intent','self_service_visits')::int <= rr('main','ask','visits')::int)
          AND (rr('main','contact_intent','intent_chosen_visits')::int <= rr('main','ask','visits')::int)
          AND (rr('main','high_intent','high_intent_visits')::int <= rr('main','contact_intent','intent_chosen_visits')::int)
          AND (rr('main','high_intent','agent_contact_visits')::int <= rr('main','high_intent','high_intent_visits')::int)
          AND (rr('main','resolution','escalated_then_contact_visits')::int <= rr('main','resolution','escalated_visits')::int),
  'self-service <= chosen <= visits; high-intent <= chosen; agent contact <= high-intent; escalated-then-contact <= escalated');
SELECT assert(NOT EXISTS (SELECT 1 FROM rr_result WHERE j::text ~ '"r[0-9]{2}"' OR j::text ~* 'drop table|nonsense'),
  'no session ids and no forged text reach the output');
SELECT assert((SELECT ui = (SELECT count(*) FROM ui_events) AND ld = (SELECT count(*) FROM lead_events) FROM rr_counts_before), 'read-only: nothing was written');

\echo ''
\echo '=== G. Same ACL / gate as v1 (CREATE OR REPLACE kept the grants) ==='
DO $$
DECLARE f text := 'analytics_contact_intent_funnel(date,date)'; cfg text[];
BEGIN
  PERFORM assert((SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure), 'still SECURITY DEFINER');
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid = f::regprocedure;
  PERFORM assert(cfg @> ARRAY['search_path=public, pg_temp'], 'still pins search_path');
  PERFORM assert(NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE'), 'anon still cannot EXECUTE');
  PERFORM assert(has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'), 'authenticated can EXECUTE');
  PERFORM assert(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                             WHERE p.oid = f::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), 'no PUBLIC EXECUTE');
  PERFORM assert(pg_get_functiondef(f::regprocedure) LIKE '%is_pintag_staff(auth.uid())%', 'still gated by is_pintag_staff(auth.uid())');
  PERFORM assert((SELECT count(*) FROM pg_proc WHERE proname = 'analytics_contact_intent_funnel') = 1, 'exactly one overload (REPLACED, not duplicated)');
END $$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ff', false);
DO $$ BEGIN
  BEGIN PERFORM analytics_contact_intent_funnel('2026-10-15','2026-10-16'); PERFORM assert(false, 'non-staff must be denied');
  EXCEPTION WHEN OTHERS THEN PERFORM assert(SQLERRM LIKE 'Access denied%', 'non-staff is still refused'); END;
END $$;
RESET ROLE;

\echo ''
\echo 'ALL CONTACT INTENT RESOLUTION ASSERTIONS PASSED'
