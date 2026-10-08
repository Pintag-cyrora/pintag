-- ============================================================================
-- CONTACT INTENT FUNNEL REGRESSION ASSERTIONS
-- (supabase/migrations/20261008000000_analytics_contact_intent_funnel.sql)
-- ============================================================================
--     bash tests/security/regression/run-contact-intent-funnel-pg.sh
--
-- Controlled fixtures for every path the funnel has to get right. Each visitor
-- is its own session (sNN) so the expected counts are exact and traceable:
--
--   s01 Ask -> self-service only (Where + Price)          panel  en
--   s02 Ask -> WhatsApp (sheet) + lead                    sheet  en
--   s03 Ask -> Call (sheet, channel=call) + lead          sheet  lo
--   s04 Ask -> Book viewing -> WhatsApp (+ lead each)     sheet  zh
--   s05 direct WhatsApp, no Ask (band) + lead
--   s06 direct Call, no Ask: LEGACY contact-phone + lead
--   s07 Ask -> LEGACY contact-phone Call + lead           panel  en
--   s08a multi-unit: Ask -> unit_select -> WhatsApp + lead   (listing PB)
--   s08b multi-unit: Ask -> unit_select, nothing after       (listing PB)
--   s09 repeated opens (3) then Where                     panel  en
--   s10 NULL session: an open, a WhatsApp action, a lead
--   s11 listing HARD-deleted after the fact (open + lead)
--   s12a Ask -> LEGACY mcta-whatsapp row WITHOUT metadata, no lead
--   s12b Ask -> NEW-vocabulary Price row WITHOUT metadata
--   s13 Ask -> Where 25 h later (outside the 24 h window); availability OFF
--   s14 open BEFORE the range, lead inside it (via_ask click, not a visit)
--   s15 Ask + lead, no action row
--   s16 Ask -> WhatsApp action, NO lead (30 s dedup / failed insert)
--   s17 Ask with a junk (string) metadata -> unit_card WhatsApp, no channel
--   s18a open at 16:59:59Z (previous Laos day)
--   s18b open at 17:00:00Z (first instant of the Laos day), NULL metadata
--   s19 SOFT-deleted listing: Ask -> Where                panel  en
--   s20 Ask -> Availability + Photos                      panel  en
--   s21 an open on 2026-10-01 (only feeds first_open_day)
--
-- Laos calendar day D == [D-1 17:00Z, D 17:00Z).  Range under test: 2026-10-08.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'REGRESSION FAILED: %', p_what; END IF;
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

-- ── Fixture helpers ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fx_meta(p_intent text, p_surface text, p_lang text, p_avail boolean, p_channel text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'intent', p_intent, 'lang', p_lang, 'surface', p_surface, 'channel', p_channel,
    'availability', CASE WHEN p_avail IS NULL THEN NULL
                        ELSE jsonb_build_object('available', p_avail, 'reason', NULL, 'scope', 'property') END))
$$;
CREATE OR REPLACE FUNCTION fx_ui(p_sess text, p_prop uuid, p_el text, p_at timestamptz, p_meta jsonb, p_type text DEFAULT 'contact_intent')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO ui_events (session_id, page, element_id, element_type, event_type, label, property_id, metadata, created_at)
  VALUES (p_sess, 'listing.html', p_el, p_type, 'click', p_el, p_prop, p_meta, p_at)
$$;
CREATE OR REPLACE FUNCTION fx_lead(p_sess text, p_prop uuid, p_type text, p_at timestamptz)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO lead_events (session_id, listing_id, event_type, created_at) VALUES (p_sess, p_prop, p_type, p_at)
$$;

-- ── Listings & units ───────────────────────────────────────────────────────
INSERT INTO properties (id, slug, title_en, status, workflow_status, property_type, district_en, created_at, deleted_at) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'villa-alpha', 'Villa Alpha', 'active', 'active', 'house', 'Chanthabouly', '2026-07-01T05:00:00Z', NULL),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'tower-beta',  'Tower Beta',  'active', 'active', 'condo', 'Sikhottabong', '2026-07-01T05:00:00Z', NULL),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'gamma-soft',  'Gamma Soft',  'active', 'active', 'house', 'Chanthabouly', '2026-07-01T05:00:00Z', '2026-10-02T00:00:00Z'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'delta-gone',  'Delta Gone',  'active', 'active', 'house', 'Chanthabouly', '2026-07-01T05:00:00Z', NULL);
INSERT INTO unit_types (id, property_id, name_en) VALUES
  ('bbbbbbbb-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000b', 'Room A'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'Room B');

DO $$
DECLARE
  PA constant uuid := 'aaaaaaaa-0000-0000-0000-00000000000a';
  PB constant uuid := 'aaaaaaaa-0000-0000-0000-00000000000b';
  PS constant uuid := 'aaaaaaaa-0000-0000-0000-00000000000c';
  PD constant uuid := 'aaaaaaaa-0000-0000-0000-00000000000d';
  UA constant text := 'bbbbbbbb-0000-0000-0000-00000000000a';
  UB constant text := 'bbbbbbbb-0000-0000-0000-00000000000b';
  T  constant timestamptz := '2026-10-08T03:00:00Z';   -- 10:00 on Laos 2026-10-08
BEGIN
  -- s01 self-service only
  PERFORM fx_ui('s01', PA, 'contact_intent_open',     T,                       fx_meta('open',     'panel', 'en', true));
  PERFORM fx_ui('s01', PA, 'contact_intent_location', T + interval '5 seconds',  fx_meta('location', 'panel', 'en', true));
  PERFORM fx_ui('s01', PA, 'contact_intent_price',    T + interval '10 seconds', fx_meta('price',    'panel', 'en', true));
  -- s02 Ask -> WhatsApp
  PERFORM fx_ui('s02', PA, 'contact_intent_open',          T,                       fx_meta('open', 'sheet', 'en', true));
  PERFORM fx_ui('s02', PA, 'contact_intent_contact_agent', T + interval '20 seconds', fx_meta('contact_agent', 'sheet', 'en', true, 'whatsapp'), 'cta');
  PERFORM fx_lead('s02', PA, 'whatsapp_click',             T + interval '21 seconds');
  -- s03 Ask -> Call
  PERFORM fx_ui('s03', PA, 'contact_intent_open',          T,                       fx_meta('open', 'sheet', 'lo', true));
  PERFORM fx_ui('s03', PA, 'contact_intent_contact_agent', T + interval '20 seconds', fx_meta('contact_agent', 'sheet', 'lo', true, 'call'), 'cta');
  PERFORM fx_lead('s03', PA, 'call_click',                 T + interval '21 seconds');
  -- s04 Ask -> Book viewing -> WhatsApp
  PERFORM fx_ui('s04', PA, 'contact_intent_open',          T,                       fx_meta('open', 'sheet', 'zh', true));
  PERFORM fx_ui('s04', PA, 'contact_intent_book_tour',     T + interval '10 seconds', fx_meta('book_tour', 'sheet', 'zh', true, 'whatsapp'), 'cta');
  PERFORM fx_lead('s04', PA, 'whatsapp_click',             T + interval '11 seconds');
  PERFORM fx_ui('s04', PA, 'contact_intent_contact_agent', T + interval '60 seconds', fx_meta('contact_agent', 'sheet', 'zh', true, 'whatsapp'), 'cta');
  PERFORM fx_lead('s04', PA, 'whatsapp_click',             T + interval '61 seconds');
  -- s05 direct WhatsApp (no open)
  PERFORM fx_ui('s05', PA, 'contact_intent_contact_agent', T, fx_meta('contact_agent', 'band', 'en', true, 'whatsapp'), 'cta');
  PERFORM fx_lead('s05', PA, 'whatsapp_click',             T + interval '1 second');
  -- s06 direct Call, legacy id, no metadata
  PERFORM fx_ui('s06', PA, 'contact-phone',                T, NULL, 'cta');
  PERFORM fx_lead('s06', PA, 'call_click',                 T + interval '1 second');
  -- s07 Ask -> legacy contact-phone
  PERFORM fx_ui('s07', PA, 'contact_intent_open',          T,                       fx_meta('open', 'panel', 'en', true));
  PERFORM fx_ui('s07', PA, 'contact-phone',                T + interval '30 seconds', NULL, 'cta');
  PERFORM fx_lead('s07', PA, 'call_click',                 T + interval '31 seconds');
  -- s08a multi-unit: unit select then contact
  PERFORM fx_ui('s08a', PB, 'contact_intent_open',         T,                       fx_meta('open', 'sheet', 'en', true));
  PERFORM fx_ui('s08a', PB, 'contact_intent_unit_select',  T + interval '15 seconds', jsonb_set(fx_meta('unit_select', 'unit_card', 'en', true), '{unit_type_id}', to_jsonb(UA)));
  PERFORM fx_ui('s08a', PB, 'contact_intent_contact_agent', T + interval '40 seconds', fx_meta('contact_agent', 'sheet', 'en', true, 'whatsapp'), 'cta');
  PERFORM fx_lead('s08a', PB, 'whatsapp_click',            T + interval '41 seconds');
  -- s08b multi-unit: unit select, nothing after
  PERFORM fx_ui('s08b', PB, 'contact_intent_open',         T,                       fx_meta('open', 'sheet', 'en', true));
  PERFORM fx_ui('s08b', PB, 'contact_intent_unit_select',  T + interval '15 seconds', jsonb_set(fx_meta('unit_select', 'unit_card', 'en', true), '{unit_type_id}', to_jsonb(UB)));
  -- s09 repeated opens
  PERFORM fx_ui('s09', PA, 'contact_intent_open',          T,                       fx_meta('open', 'panel', 'en', true));
  PERFORM fx_ui('s09', PA, 'contact_intent_open',          T + interval '40 seconds', fx_meta('open', 'panel', 'en', true));
  PERFORM fx_ui('s09', PA, 'contact_intent_open',          T + interval '2 minutes',  fx_meta('open', 'panel', 'en', true));
  PERFORM fx_ui('s09', PA, 'contact_intent_location',      T + interval '3 minutes',  fx_meta('location', 'panel', 'en', true));
  -- s10 NULL session
  PERFORM fx_ui(NULL, PA, 'contact_intent_open',           T, fx_meta('open', 'sheet', 'en', true));
  PERFORM fx_ui(NULL, PA, 'contact_intent_contact_agent',  T + interval '20 seconds', fx_meta('contact_agent', 'sheet', 'en', true, 'whatsapp'), 'cta');
  PERFORM fx_lead(NULL, PA, 'whatsapp_click',              T + interval '21 seconds');
  -- s11 listing hard-deleted afterwards (FK nulls ui_events.property_id; lead_events keeps the id)
  PERFORM fx_ui('s11', PD, 'contact_intent_open',          T, fx_meta('open', 'sheet', 'en', true));
  PERFORM fx_lead('s11', PD, 'whatsapp_click',             T + interval '20 seconds');
  -- s12a legacy WhatsApp row, no metadata, no lead
  PERFORM fx_ui('s12a', PA, 'contact_intent_open',         T, fx_meta('open', 'panel', 'en', true));
  PERFORM fx_ui('s12a', PA, 'mcta-whatsapp',               T + interval '20 seconds', NULL, 'cta');
  -- s12b new-vocabulary row WITHOUT metadata
  PERFORM fx_ui('s12b', PA, 'contact_intent_open',         T, fx_meta('open', 'panel', 'en', true));
  PERFORM fx_ui('s12b', PA, 'contact_intent_price',        T + interval '8 seconds', NULL);
  -- s13 outcome outside the 24 h window; availability OFF
  PERFORM fx_ui('s13', PA, 'contact_intent_open',          T, fx_meta('open', 'sheet', 'en', false));
  PERFORM fx_ui('s13', PA, 'contact_intent_location',      T + interval '25 hours', fx_meta('location', 'sheet', 'en', false));
  -- s14 open before the range, lead inside it
  PERFORM fx_ui('s14', PA, 'contact_intent_open',          '2026-10-07T16:00:00Z', fx_meta('open', 'sheet', 'en', true));
  PERFORM fx_lead('s14', PA, 'whatsapp_click',             '2026-10-07T18:00:00Z');
  -- s15 Ask + lead, no action row
  PERFORM fx_ui('s15', PA, 'contact_intent_open',          T, fx_meta('open', 'sheet', 'en', true));
  PERFORM fx_lead('s15', PA, 'whatsapp_click',             T + interval '30 seconds');
  -- s16 Ask -> WhatsApp action, no lead
  PERFORM fx_ui('s16', PA, 'contact_intent_open',          T, fx_meta('open', 'sheet', 'en', true));
  PERFORM fx_ui('s16', PA, 'contact_intent_contact_agent', T + interval '20 seconds', fx_meta('contact_agent', 'sheet', 'en', true, 'whatsapp'), 'cta');
  -- s17 junk metadata on the open; unit_card WhatsApp (no channel), no lead
  PERFORM fx_ui('s17', PA, 'contact_intent_open',          T, '"junk"'::jsonb);
  PERFORM fx_ui('s17', PA, 'contact_intent_contact_agent', T + interval '20 seconds', fx_meta('contact_agent', 'unit_card', 'en', true), 'cta');
  -- s18a / s18b Laos-day boundary
  PERFORM fx_ui('s18a', PA, 'contact_intent_open',         '2026-10-07T16:59:59Z', fx_meta('open', 'sheet', 'en', true));
  PERFORM fx_ui('s18b', PA, 'contact_intent_open',         '2026-10-07T17:00:00Z', NULL);
  -- s19 soft-deleted listing
  PERFORM fx_ui('s19', PS, 'contact_intent_open',          T, fx_meta('open', 'panel', 'en', true));
  PERFORM fx_ui('s19', PS, 'contact_intent_location',      T + interval '9 seconds', fx_meta('location', 'panel', 'en', true));
  -- s20 availability + photos
  PERFORM fx_ui('s20', PA, 'contact_intent_open',          T, fx_meta('open', 'panel', 'en', true));
  PERFORM fx_ui('s20', PA, 'contact_intent_availability',  T + interval '7 seconds', fx_meta('availability', 'panel', 'en', true));
  PERFORM fx_ui('s20', PA, 'contact_intent_gallery',       T + interval '12 seconds', fx_meta('gallery', 'panel', 'en', true));
  -- s21 a much older open
  PERFORM fx_ui('s21', PA, 'contact_intent_open',          '2026-10-01T03:00:00Z', fx_meta('open', 'panel', 'en', true));
END $$;

-- The hard delete: ui_events.property_id -> NULL by the FK, lead_events keeps the dangling id.
DELETE FROM properties WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000d';

-- Noise that must never be counted: unrelated ui_events and other lead types.
INSERT INTO ui_events (session_id, page, element_id, element_type, event_type, property_id, created_at)
  VALUES ('s01', 'listing.html', 'share-property', 'cta', 'click', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-10-08T03:00:03Z'),
         ('s01', 'listing.html', 'contact-whatsapp-status-cta', 'cta', 'click', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-10-08T03:00:04Z'),
         ('s01', 'listing.html', 'mcta-whatsapp-status', 'cta', 'click', 'aaaaaaaa-0000-0000-0000-00000000000a', '2026-10-08T03:00:04Z');
INSERT INTO lead_events (session_id, listing_id, event_type, created_at)
  VALUES ('s01', 'aaaaaaaa-0000-0000-0000-00000000000a', 'messenger_click', '2026-10-08T03:00:06Z');

-- ── Results table (the RPC runs as a signed-in STAFF user) ─────────────────
CREATE TABLE fx_result (k text PRIMARY KEY, j jsonb);
GRANT ALL ON fx_result TO authenticated;
CREATE OR REPLACE FUNCTION res(p_k text, VARIADIC p_path text[]) RETURNS text LANGUAGE sql AS $$
  SELECT j #>> p_path FROM fx_result WHERE k = p_k
$$;

CREATE TABLE fx_counts_before AS
  SELECT (SELECT count(*) FROM ui_events) AS ui, (SELECT count(*) FROM lead_events) AS ld, (SELECT count(*) FROM properties) AS pr;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000ad01', false);
INSERT INTO fx_result VALUES ('main',     analytics_contact_intent_funnel('2026-10-08', '2026-10-09'));
INSERT INTO fx_result VALUES ('prev_day', analytics_contact_intent_funnel('2026-10-07', '2026-10-08'));
INSERT INTO fx_result VALUES ('empty',    analytics_contact_intent_funnel('2026-01-01', '2026-01-02'));
INSERT INTO fx_result VALUES ('today',    analytics_contact_intent_funnel((now() AT TIME ZONE 'Asia/Vientiane')::date,
                                                                          (now() AT TIME ZONE 'Asia/Vientiane')::date + 1));
INSERT INTO fx_result VALUES ('wide',     analytics_contact_intent_funnel('2026-09-01', '2026-11-01'));
RESET ROLE;

\echo '=== A. Ask visits: distinct (session, listing); repeats collapse; NULLs and deleted listings are reported ==='
SELECT assert_eq(res('main','ask','visits'), '17', 'visits = distinct (session, listing) with an open in range (s01-04,07,08a,08b,09,12a,12b,13,15-17,18b,19,20)');
SELECT assert_eq(res('main','ask','open_events'), '21', 'open_events counts every open row in range (s09 has 3; s10 and s11 are unlinkable)');
SELECT assert_eq(res('main','ask','repeat_open_visits'), '1', 'only s09 opened more than once');
SELECT assert_eq(res('main','ask','excluded_null_session'), '1', 's10 (NULL session) is excluded and reported, not invented');
SELECT assert_eq(res('main','ask','excluded_null_property'), '1', 's11 (hard-deleted listing -> NULL property_id) is excluded and reported');

\echo ''
\echo '=== B. CONTACT INTENT: self-service intents, never a failed conversion ==='
SELECT assert_eq(res('main','contact_intent','self_service_visits'), '5', 'self-service = s01, s09, s12b, s19, s20 (s13 location is outside the 24 h window)');
SELECT assert_eq(res('main','contact_intent','where_visits'),        '3', 'Where: s01, s09, s19 (soft-deleted listing still counts)');
SELECT assert_eq(res('main','contact_intent','price_visits'),        '2', 'Price: s01 + s12b (a new-vocabulary row without metadata still counts)');
SELECT assert_eq(res('main','contact_intent','availability_visits'), '1', 'Availability: s20');
SELECT assert_eq(res('main','contact_intent','photos_visits'),       '1', 'Photos: s20');
SELECT assert_eq(res('main','contact_intent','unit_select_visits'),  '2', 'Unit selection: s08a, s08b');
SELECT assert_eq(res('main','contact_intent','intent_chosen_visits'), '15', 'intent chosen = self-service OR unit OR high-intent (all but s13 and s18b)');

\echo ''
\echo '=== C. HIGH-INTENT: Book viewing, Call, WhatsApp, Contact clicks ==='
SELECT assert_eq(res('main','high_intent','book_visits'), '1', 'Book viewing: s04');
SELECT assert_eq(res('main','high_intent','call_visits'), '2', 'Call: s03 (channel=call) + s07 (LEGACY contact-phone normalised into the Call bucket)');
SELECT assert_eq(res('main','high_intent','whatsapp_visits'), '6', 'WhatsApp: s02, s04, s08a, s12a (legacy mcta-whatsapp), s16, s17 (unit_card, no channel)');
SELECT assert_eq(res('main','high_intent','agent_contact_visits'), '8', 'agent contact = Call OR WhatsApp, counted once per visit');
SELECT assert_eq(res('main','high_intent','agent_contact_via_menu_visits'), '5', 'via the Ask sheet itself: s02, s03, s04, s08a, s16');
SELECT assert_eq(res('main','high_intent','contact_click_visits'), '6', 'visits with a lead: s02, s03, s04, s07, s08a, s15');
SELECT assert_eq(res('main','high_intent','contact_clicks'), '7', 'contact clicks inside Ask visits (s04 made two)');
SELECT assert_eq(res('main','high_intent','call_clicks'), '2', 'call clicks: s03, s07');
SELECT assert_eq(res('main','high_intent','whatsapp_clicks'), '5', 'WhatsApp clicks include Book a viewing: s02, s04 x2, s08a, s15');
SELECT assert_eq(res('main','high_intent','high_intent_visits'), '9', 'any high-intent action or click: s02,03,04,07,08a,12a,15,16,17');

\echo ''
\echo '=== D. Unit selection -> contact ==='
SELECT assert_eq(res('main','unit_flow','unit_select_visits'), '2', 'unit_flow counts both unit selectors');
SELECT assert_eq(res('main','unit_flow','unit_then_contact_visits'), '1', 'only s08a contacted AFTER choosing a unit');
SELECT assert_eq((SELECT x ->> 'then_contact_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_unit') x WHERE k = 'main' AND x ->> 'unit_name' = 'Room A'), '1', 'Room A led to a contact');
SELECT assert_eq((SELECT x ->> 'then_contact_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_unit') x WHERE k = 'main' AND x ->> 'unit_name' = 'Room B'), '0', 'Room B did not');

\echo ''
\echo '=== E. Contact-click reconciliation: via_ask / direct / unlinked ==='
SELECT assert_eq(res('main','clicks','total'), '12', 'every WhatsApp/call lead in the range (messenger_click is not one)');
SELECT assert_eq(res('main','clicks','call'), '3', 'call: s03, s06, s07');
SELECT assert_eq(res('main','clicks','whatsapp'), '9', 'whatsapp: 9');
SELECT assert_eq(res('main','clicks','via_ask','total'), '8', 'via Ask: s02, s03, s04 x2, s07, s08a, s15 and s14 (open 2 h earlier, before the range)');
SELECT assert_eq(res('main','clicks','via_ask','call'), '2', 'via Ask call');
SELECT assert_eq(res('main','clicks','via_ask','whatsapp'), '6', 'via Ask whatsapp');
SELECT assert_eq(res('main','clicks','direct','total'), '2', 'direct (no Ask): s05 WhatsApp and s06 Call');
SELECT assert_eq(res('main','clicks','direct','call'), '1', 'direct Call without Ask (legacy contact-phone)');
SELECT assert_eq(res('main','clicks','direct','whatsapp'), '1', 'direct WhatsApp without Ask');
SELECT assert_eq(res('main','clicks','unlinked','total'), '2', 'unlinked: s10 (NULL session) and s11 (listing hard-deleted)');
SELECT assert((res('main','clicks','via_ask','total')::int + res('main','clicks','direct','total')::int + res('main','clicks','unlinked','total')::int) = res('main','clicks','total')::int,
  'via_ask + direct + unlinked = total (nothing double counted or dropped)');

\echo ''
\echo '=== F. Diagnostics: derived attribution, data quality, breakdowns ==='
SELECT assert_eq(res('main','diagnostics','attribution','matched','book'), '1', 'derived: Book viewing action matched a lead');
SELECT assert_eq(res('main','diagnostics','attribution','matched','call'), '3', 'derived: Call actions matched (s03, s06, s07)');
SELECT assert_eq(res('main','diagnostics','attribution','matched','whatsapp'), '4', 'derived: WhatsApp actions matched (s02, s04, s05, s08a)');
SELECT assert_eq(res('main','diagnostics','attribution','unmatched','whatsapp'), '3', 'derived: WhatsApp actions with no lead (s12a, s16, s17)');
SELECT assert_eq(res('main','diagnostics','attribution','unmatched','book'), '0', 'no unmatched Book actions');
SELECT assert_eq(res('main','diagnostics','attribution','unlinkable_actions'), '1', 'the NULL-session action cannot be matched at all');
SELECT assert_eq(res('main','diagnostics','attribution','leads_without_action'), '3', 'leads with no action row: s11, s14, s15');
SELECT assert_eq(res('main','diagnostics','attribution','visits_with_click_but_no_action'), '1', 's15');
SELECT assert_eq(res('main','diagnostics','data_quality','new_rows_without_metadata'), '2', 'new-vocabulary rows with NULL metadata: s12b price and s18b open');
SELECT assert_eq(res('main','diagnostics','data_quality','legacy_rows'), '3', 'legacy rows: contact-phone x2, mcta-whatsapp');
SELECT assert_eq(res('main','diagnostics','data_quality','legacy_call_rows'), '2', 'legacy contact-phone rows');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_surface') x WHERE k = 'main' AND x ->> 'key' = 'panel'), '7', 'surface panel');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_surface') x WHERE k = 'main' AND x ->> 'key' = 'sheet'), '8', 'surface sheet');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_surface') x WHERE k = 'main' AND x ->> 'key' = 'unknown'), '2', 'junk / missing metadata -> unknown (s17, s18b)');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_lang') x WHERE k = 'main' AND x ->> 'key' = 'lo'), '1', 'lang lo');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_lang') x WHERE k = 'main' AND x ->> 'key' = 'zh'), '1', 'lang zh');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_lang') x WHERE k = 'main' AND x ->> 'key' = 'en'), '13', 'lang en');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_availability') x WHERE k = 'main' AND x ->> 'key' = 'off'), '1', 'availability OFF: s13');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_availability') x WHERE k = 'main' AND x ->> 'key' = 'on'), '14', 'availability ON');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'by_availability') x WHERE k = 'main' AND x ->> 'key' = 'unknown'), '2', 'availability unknown');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'listings') x WHERE k = 'main' AND x ->> 'slug' = 'villa-alpha'), '14', 'listing Villa Alpha');
SELECT assert_eq((SELECT x ->> 'ask_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'listings') x WHERE k = 'main' AND x ->> 'slug' = 'tower-beta'), '2', 'listing Tower Beta');
SELECT assert_eq((SELECT x ->> 'is_deleted' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'listings') x WHERE k = 'main' AND x ->> 'slug' = 'gamma-soft'), 'true', 'a soft-deleted listing is kept and flagged is_deleted');
SELECT assert_eq(jsonb_array_length((SELECT j -> 'diagnostics' -> 'listings' FROM fx_result WHERE k = 'main'))::text, '3', 'the hard-deleted listing has no Ask visit (its events lost the id)');
SELECT assert_eq((SELECT x ->> 'agent_contact_visits' FROM fx_result, jsonb_array_elements(j -> 'diagnostics' -> 'listings') x WHERE k = 'main' AND x ->> 'slug' = 'villa-alpha'), '7', 'Villa Alpha agent-contact visits');

\echo ''
\echo '=== G. Laos calendar days, the 24 h window and the epoch ==='
SELECT assert_eq(res('prev_day','ask','visits'), '2', 'Laos 2026-10-07 holds s14 and s18a (the 16:59:59Z open) - and NOT s18b (17:00:00Z)');
SELECT assert_eq(res('prev_day','high_intent','contact_click_visits'), '1', 's14''s lead lands the next Laos day but inside its 24 h window: counted for the visit');
SELECT assert_eq(res('prev_day','high_intent','contact_clicks'), '1', '...as one click');
SELECT assert_eq(res('prev_day','clicks','total'), '0', 'while the range-wide click total (by the lead''s own Laos day) is 0 for 2026-10-07');
SELECT assert_eq(res('main','range','first_open_day'), '2026-10-01', 'first_open_day = first day with any open (s21), independent of the range');
SELECT assert_eq(res('main','range','outcome_window_hours'), '24', 'outcome window is reported');
SELECT assert_eq(res('empty','range','includes_today'), 'false', 'a past range does not include today');
SELECT assert_eq(res('empty','range','outcomes_incomplete'), 'false', '...and its 24 h outcome windows are complete');
SELECT assert_eq(res('today','range','includes_today'), 'true', 'a range containing today is flagged includes_today');
SELECT assert_eq(res('today','range','outcomes_incomplete'), 'true', '...and its outcomes are flagged incomplete');
SELECT assert_eq(res('empty','ask','visits'), '0', 'an empty range returns zeros, not an error');
SELECT assert_eq(res('empty','clicks','total'), '0', 'empty range: no clicks');
SELECT assert_eq(jsonb_typeof((SELECT j -> 'diagnostics' -> 'listings' FROM fx_result WHERE k = 'empty')), 'array', 'empty range: listings is an empty array');
SELECT assert_eq(res('wide','ask','visits'), '20', 'wide range: the 17 above + s14, s18a, s21 = 20 linkable visits, each once (s10 and s11 stay excluded)');

\echo ''
\echo '=== H. Read-only, privacy, ACL, search_path ==='
SELECT assert((SELECT ui = (SELECT count(*) FROM ui_events) AND ld = (SELECT count(*) FROM lead_events) AND pr = (SELECT count(*) FROM properties) FROM fx_counts_before),
  'calling the function wrote nothing');
SELECT assert((SELECT provolatile = 's' FROM pg_proc WHERE oid = 'analytics_contact_intent_funnel(date,date)'::regprocedure), 'the function is STABLE');
SELECT assert(NOT EXISTS (SELECT 1 FROM fx_result WHERE j::text ~ $re$"s[0-9]{2}[ab]?"$re$) AND NOT EXISTS (SELECT 1 FROM fx_result WHERE j::text ~* $re$(phone|customer|whatsapp:)$re$), $re$the result carries no session ids and no buyer / phone data$re$);
DO $$
DECLARE f text := 'analytics_contact_intent_funnel(date,date)'; def text; cfg text[];
BEGIN
  PERFORM assert((SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure), f || ' is SECURITY DEFINER');
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid = f::regprocedure;
  PERFORM assert(cfg @> ARRAY['search_path=public, pg_temp'], f || ' pins search_path = public, pg_temp');
  PERFORM assert(NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE'), 'anon cannot EXECUTE');
  PERFORM assert(has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'), 'authenticated can EXECUTE');
  PERFORM assert(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                             WHERE p.oid = f::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), 'no PUBLIC EXECUTE grant');
  def := pg_get_functiondef(f::regprocedure);
  PERFORM assert(def LIKE '%is_pintag_staff(auth.uid())%', 'gated through is_pintag_staff(auth.uid())');
  PERFORM assert(def !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|drop\s+table|alter\s+table)\M', 'the body contains no write statement');
  PERFORM assert(def !~ 'created_at::date' AND def !~ '(?i)AT TIME ZONE ''UTC''', 'no UTC bucketing');
  PERFORM assert(def ~ 'Asia/Vientiane', 'buckets by Asia/Vientiane');
END $$;

SET ROLE anon;
DO $$
BEGIN
  BEGIN PERFORM analytics_contact_intent_funnel('2026-10-08', '2026-10-09'); PERFORM assert(false, 'anon must be denied');
  EXCEPTION WHEN insufficient_privilege THEN PERFORM assert(true, 'anon cannot call the funnel RPC (permission denied)'); END;
END $$;
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ff', false);   -- signed in, NOT staff
DO $$
BEGIN
  BEGIN PERFORM analytics_contact_intent_funnel('2026-10-08', '2026-10-09'); PERFORM assert(false, 'non-staff must be denied');
  EXCEPTION WHEN OTHERS THEN PERFORM assert(SQLERRM LIKE 'Access denied%', 'a signed-in NON-staff user is refused by the is_pintag_staff gate'); END;
END $$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000ad01', false);
DO $$
BEGIN
  BEGIN PERFORM analytics_contact_intent_funnel('2026-10-09', '2026-10-08'); PERFORM assert(false, 'inverted range must be rejected');
  EXCEPTION WHEN OTHERS THEN PERFORM assert(SQLSTATE = '22023', 'an inverted range is rejected (22023)'); END;
  BEGIN PERFORM analytics_contact_intent_funnel(NULL, '2026-10-09'); PERFORM assert(false, 'NULL range must be rejected');
  EXCEPTION WHEN OTHERS THEN PERFORM assert(SQLSTATE = '22023', 'a NULL bound is rejected (22023)'); END;
END $$;

-- search_path hijack: temp tables named like the real ones must NOT shadow them
CREATE TEMP TABLE ui_events (id uuid, session_id text, element_id text, element_type text, property_id uuid, metadata jsonb, created_at timestamptz);
INSERT INTO pg_temp.ui_events VALUES (gen_random_uuid(), 'evil', 'contact_intent_open', 'contact_intent', 'aaaaaaaa-0000-0000-0000-00000000000a', NULL, '2026-10-08T03:00:00Z');
CREATE TEMP TABLE lead_events (id uuid, session_id text, listing_id uuid, event_type text, created_at timestamptz);
DO $$
BEGIN
  PERFORM assert_eq(analytics_contact_intent_funnel('2026-10-08', '2026-10-09') #>> '{ask,visits}', '17',
    'a pg_temp.ui_events / pg_temp.lead_events cannot shadow the real tables inside the SECURITY DEFINER function');
END $$;
DROP TABLE pg_temp.ui_events;
DROP TABLE pg_temp.lead_events;
RESET ROLE;

\echo ''
\echo 'ALL CONTACT INTENT FUNNEL ASSERTIONS PASSED'
