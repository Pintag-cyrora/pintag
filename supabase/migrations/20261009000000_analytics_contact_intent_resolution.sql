-- ============================================================================
-- ANALYTICS: CONTACT INTENT FUNNEL v2 — Terms & utilities, Price & deposit, resolution breakdown
-- ============================================================================
-- Requires 20261008000000_analytics_contact_intent_funnel.sql (this REPLACES the same function, same
-- signature, same ACL). Adds NO table, column, index, trigger or event type: everything new is read from
-- keys the client already writes into ui_events.metadata.
--
-- NEW EVENTS READ
--   contact_intent_terms            Terms & utilities (rentals). metadata: resolution, topic='terms'
--   contact_intent_price            now also carries resolution + topic ('deposit' | 'price')
--   contact_intent_contact_agent    an "Ask the agent" button inside an answer carries
--                                   resolution='escalate_to_agent' + topic (surface 'answer', channel 'whatsapp')
--
-- RESOLUTION (metadata.resolution, whitelisted; anything else is treated as absent)
--   answer_on_site     the page answered with the listing's own data
--   escalate_to_agent  the data is not on the listing, so the visitor was offered the agent
--   topic              price | deposit | terms
--
-- WHAT CHANGES IN THE EXISTING NUMBERS (the only behavioural change; everything else is additive)
--   * self_service no longer counts a Price or Terms tap whose resolution is escalate_to_agent: the
--     visitor's question was NOT answered on the site, so it is not a self-service success. Rows with no
--     resolution (every row written before this change) are unchanged: Price without a resolution is
--     still self-service.
--   * intent_chosen also includes terms taps and escalated taps.
--   * New keys: contact_intent.terms_visits / escalated_visits and a top-level `resolution` object
--     (Price and Terms visits by resolution, deposit-topic visits by resolution, visits that tapped an
--     "Ask the agent" button by topic, and escalated visits that went on to contact the agent).
--   Visits are distinct (session, listing) pairs, so a visit with several rows is counted once per bucket.
--
-- ROLLBACK: re-run 20261008000000_analytics_contact_intent_funnel.sql (CREATE OR REPLACE restores v1).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION analytics_contact_intent_funnel(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_from   timestamptz;
  v_to     timestamptz;
  v_win    constant interval := interval '24 hours';
  v_today  date := (now() AT TIME ZONE 'Asia/Vientiane')::date;
  result   jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';

  WITH
  -- Every tracked row that can matter, classified once. The 1-day lookback feeds the
  -- via_ask reconciliation; the 24 h lookahead feeds the outcome window.
  ui AS MATERIALIZED (
    SELECT e.id, e.session_id, e.property_id, e.created_at, e.element_id, e.metadata,
           CASE e.element_id
             WHEN 'contact_intent_open'         THEN 'open'
             WHEN 'contact_intent_location'     THEN 'location'
             WHEN 'contact_intent_price'        THEN 'price'
             WHEN 'contact_intent_terms'        THEN 'terms'
             WHEN 'contact_intent_availability' THEN 'availability'
             WHEN 'contact_intent_gallery'      THEN 'gallery'
             WHEN 'contact_intent_unit_select'  THEN 'unit_select'
             WHEN 'contact_intent_book_tour'    THEN 'book'
             WHEN 'contact_intent_contact_agent'
               THEN CASE WHEN e.metadata ->> 'channel' = 'call' THEN 'call' ELSE 'whatsapp' END
             WHEN 'contact-phone'               THEN 'call'
             ELSE 'whatsapp'                    -- contact-whatsapp / mcta-whatsapp / unit-inquire-whatsapp
           END AS kind,
           (e.element_id IN ('contact-phone', 'contact-whatsapp', 'mcta-whatsapp', 'unit-inquire-whatsapp')) AS is_legacy,
           CASE WHEN e.metadata ->> 'resolution' IN ('answer_on_site', 'escalate_to_agent') THEN e.metadata ->> 'resolution' END AS resolution,
           CASE WHEN e.metadata ->> 'topic' IN ('price', 'deposit', 'terms') THEN e.metadata ->> 'topic' END AS topic
    FROM ui_events e
    WHERE e.created_at >= v_from - interval '1 day'
      AND e.created_at <  v_to + v_win
      AND e.element_id IN (
        'contact_intent_open', 'contact_intent_location', 'contact_intent_price',
        'contact_intent_availability', 'contact_intent_gallery', 'contact_intent_unit_select',
        'contact_intent_book_tour', 'contact_intent_contact_agent', 'contact_intent_terms',
        'contact-phone', 'contact-whatsapp', 'mcta-whatsapp', 'unit-inquire-whatsapp')
  ),
  ld AS MATERIALIZED (
    SELECT l.id, l.session_id, l.listing_id, l.event_type, l.created_at
    FROM lead_events l
    WHERE l.event_type IN ('whatsapp_click', 'call_click')
      AND l.created_at >= v_from - interval '1 day'
      AND l.created_at <  v_to + v_win
  ),
  -- ── Ask visits ────────────────────────────────────────────────────────────
  opens AS MATERIALIZED (
    SELECT u.session_id, u.property_id,
           min(u.created_at) AS t0,
           count(*)          AS n_opens,
           (array_agg(u.metadata ORDER BY u.created_at, u.id))[1] AS m
    FROM ui u
    WHERE u.kind = 'open' AND u.created_at >= v_from AND u.created_at < v_to
      AND u.session_id IS NOT NULL AND u.property_id IS NOT NULL
    GROUP BY u.session_id, u.property_id
  ),
  acts AS MATERIALIZED (
    SELECT u.session_id, u.property_id, u.created_at, u.kind, u.metadata, u.resolution, u.topic
    FROM ui u
    WHERE u.kind <> 'open' AND u.session_id IS NOT NULL AND u.property_id IS NOT NULL
  ),
  vflags AS MATERIALIZED (
    SELECT o.session_id, o.property_id, o.t0, o.n_opens,
           CASE WHEN lower(o.m ->> 'lang') IN ('en', 'lo', 'zh') THEN lower(o.m ->> 'lang') ELSE 'unknown' END AS lang,
           CASE WHEN o.m ->> 'surface' IN ('panel', 'sheet') THEN o.m ->> 'surface' ELSE 'unknown' END       AS surface,
           CASE o.m -> 'availability' ->> 'available' WHEN 'true' THEN 'on' WHEN 'false' THEN 'off' ELSE 'unknown' END AS avail,
           coalesce(bool_or(a.kind = 'location'),     false) AS f_location,
           coalesce(bool_or(a.kind = 'price'),        false) AS f_price,
           coalesce(bool_or(a.kind = 'terms'),        false) AS f_terms,
           coalesce(bool_or(a.kind = 'price' AND a.resolution IS DISTINCT FROM 'escalate_to_agent'), false) AS f_price_self,
           coalesce(bool_or(a.kind = 'terms' AND a.resolution IS DISTINCT FROM 'escalate_to_agent'), false) AS f_terms_self,
           coalesce(bool_or(a.kind = 'price' AND a.resolution = 'answer_on_site'),    false) AS f_price_ans,
           coalesce(bool_or(a.kind = 'price' AND a.resolution = 'escalate_to_agent'), false) AS f_price_esc,
           coalesce(bool_or(a.kind = 'price' AND a.resolution IS NULL),               false) AS f_price_unk,
           coalesce(bool_or(a.kind = 'terms' AND a.resolution = 'answer_on_site'),    false) AS f_terms_ans,
           coalesce(bool_or(a.kind = 'terms' AND a.resolution = 'escalate_to_agent'), false) AS f_terms_esc,
           coalesce(bool_or(a.kind = 'terms' AND a.resolution IS NULL),               false) AS f_terms_unk,
           coalesce(bool_or(a.kind IN ('price', 'terms') AND a.topic = 'deposit' AND a.resolution = 'answer_on_site'),    false) AS f_dep_ans,
           coalesce(bool_or(a.kind IN ('price', 'terms') AND a.topic = 'deposit' AND a.resolution = 'escalate_to_agent'), false) AS f_dep_esc,
           coalesce(bool_or(a.kind IN ('price', 'terms') AND a.resolution = 'escalate_to_agent'), false) AS f_escalated,
           coalesce(bool_or(a.kind IN ('call', 'whatsapp') AND a.resolution = 'escalate_to_agent'), false)                AS f_esc_click,
           coalesce(bool_or(a.kind IN ('call', 'whatsapp') AND a.resolution = 'escalate_to_agent' AND a.topic = 'terms'),   false) AS f_esc_click_terms,
           coalesce(bool_or(a.kind IN ('call', 'whatsapp') AND a.resolution = 'escalate_to_agent' AND a.topic = 'deposit'), false) AS f_esc_click_deposit,
           min(a.created_at) FILTER (WHERE a.kind IN ('price', 'terms') AND a.resolution = 'escalate_to_agent') AS esc_at,
           coalesce(bool_or(a.kind = 'availability'), false) AS f_availability,
           coalesce(bool_or(a.kind = 'gallery'),      false) AS f_gallery,
           coalesce(bool_or(a.kind = 'unit_select'),  false) AS f_unit,
           coalesce(bool_or(a.kind = 'book'),         false) AS f_book,
           coalesce(bool_or(a.kind = 'call'),         false) AS f_call,
           coalesce(bool_or(a.kind = 'whatsapp'),     false) AS f_whatsapp,
           coalesce(bool_or(a.kind IN ('call', 'whatsapp') AND a.metadata ->> 'surface' = 'sheet'), false) AS f_agent_via_menu,
           min(a.created_at) FILTER (WHERE a.kind = 'unit_select') AS us_at,
           max(a.created_at) FILTER (WHERE a.kind IN ('book', 'call', 'whatsapp')) AS last_contact_at
    FROM opens o
    LEFT JOIN acts a
           ON a.session_id = o.session_id AND a.property_id = o.property_id
          AND a.created_at >= o.t0 AND a.created_at < o.t0 + v_win
    GROUP BY o.session_id, o.property_id, o.t0, o.n_opens, o.m
  ),
  vleads AS MATERIALIZED (
    SELECT o.session_id, o.property_id,
           count(*) FILTER (WHERE l.event_type = 'call_click')     AS lead_call,
           count(*) FILTER (WHERE l.event_type = 'whatsapp_click') AS lead_wa,
           max(l.created_at)                                       AS last_lead_at
    FROM opens o
    JOIN ld l ON l.session_id = o.session_id AND l.listing_id = o.property_id
             AND l.created_at >= o.t0 AND l.created_at < o.t0 + v_win
    GROUP BY o.session_id, o.property_id
  ),
  visits AS MATERIALIZED (
    SELECT f.*,
           coalesce(vl.lead_call, 0) AS lead_call,
           coalesce(vl.lead_wa, 0)   AS lead_wa,
           (f.f_location OR f.f_price_self OR f.f_terms_self OR f.f_availability OR f.f_gallery) AS self_service,
           (f.f_call OR f.f_whatsapp)                                               AS agent_contact,
           (coalesce(vl.lead_call, 0) + coalesce(vl.lead_wa, 0)) > 0                AS has_click,
           (f.f_book OR f.f_call OR f.f_whatsapp
              OR (coalesce(vl.lead_call, 0) + coalesce(vl.lead_wa, 0)) > 0)         AS high_intent,
           -- a unit was chosen AND a book / call / whatsapp / lead followed it
           (f.us_at IS NOT NULL AND (f.last_contact_at > f.us_at OR vl.last_lead_at > f.us_at)) AS unit_then_contact,
           -- a question was handed to the agent AND a book / call / whatsapp / lead followed it
           (f.esc_at IS NOT NULL AND (f.last_contact_at > f.esc_at OR vl.last_lead_at > f.esc_at)) AS escalated_then_contact
    FROM vflags f
    LEFT JOIN vleads vl ON vl.session_id = f.session_id AND vl.property_id = f.property_id
  ),
  -- ── Range-wide contact-click reconciliation (all lead_events in range) ─────
  -- Equality-keyed joins only (session + listing): a correlated EXISTS against a CTE would
  -- rescan it per lead and go quadratic at volume.
  clicks AS MATERIALIZED (
    SELECT CASE WHEN l.event_type = 'call_click' THEN 'call' ELSE 'whatsapp' END AS ch,
           CASE
             WHEN l.session_id IS NULL OR l.listing_id IS NULL THEN 'unlinked'
             WHEN p.id IS NULL THEN 'unlinked'
             WHEN bool_or(o.session_id IS NOT NULL) THEN 'via_ask'
             ELSE 'direct'
           END AS src
    FROM ld l
    LEFT JOIN properties p ON p.id = l.listing_id
    LEFT JOIN ui o ON o.kind = 'open' AND o.session_id = l.session_id AND o.property_id = l.listing_id
                  AND o.created_at <= l.created_at AND o.created_at > l.created_at - v_win
    WHERE l.created_at >= v_from AND l.created_at < v_to
    GROUP BY l.id, l.event_type, l.session_id, l.listing_id, p.id
  ),
  -- ── Derived action -> lead attribution (DIAGNOSTIC) ───────────────────────
  cta AS MATERIALIZED (
    SELECT u.kind,
           CASE WHEN u.session_id IS NULL OR u.property_id IS NULL THEN NULL
                ELSE coalesce(bool_or(l.id IS NOT NULL), false)
           END AS matched
    FROM ui u
    LEFT JOIN ld l ON l.session_id = u.session_id AND l.listing_id = u.property_id
                  AND l.event_type = CASE WHEN u.kind = 'call' THEN 'call_click' ELSE 'whatsapp_click' END
                  AND l.created_at >= u.created_at - interval '5 seconds'
                  AND l.created_at <= u.created_at + interval '10 seconds'
    WHERE u.kind IN ('book', 'call', 'whatsapp') AND u.created_at >= v_from AND u.created_at < v_to
    GROUP BY u.id, u.kind, u.session_id, u.property_id
  ),
  lead_no_cta AS MATERIALIZED (
    SELECT l.id
    FROM ld l
    LEFT JOIN ui u ON u.kind IN ('book', 'call', 'whatsapp')
                  AND u.session_id = l.session_id AND u.property_id = l.listing_id
                  AND (CASE WHEN u.kind = 'call' THEN 'call_click' ELSE 'whatsapp_click' END) = l.event_type
                  AND l.created_at >= u.created_at - interval '5 seconds'
                  AND l.created_at <= u.created_at + interval '10 seconds'
    WHERE l.created_at >= v_from AND l.created_at < v_to
      AND l.session_id IS NOT NULL AND l.listing_id IS NOT NULL
    GROUP BY l.id
    HAVING NOT bool_or(u.id IS NOT NULL)
  ),
  top_listings AS (
    SELECT v.property_id,
           count(*)                                      AS ask_visits,
           count(*) FILTER (WHERE v.self_service)        AS self_service_visits,
           count(*) FILTER (WHERE v.agent_contact)       AS agent_contact_visits,
           count(*) FILTER (WHERE v.f_book)              AS book_visits,
           count(*) FILTER (WHERE v.has_click)           AS contact_click_visits
    FROM visits v
    GROUP BY v.property_id
    ORDER BY count(*) DESC, v.property_id
    LIMIT 25
  ),
  listing_rows AS (
    SELECT t.*, lb.title, lb.slug, lb.resolution, coalesce(lb.is_deleted, false) AS is_deleted
    FROM top_listings t
    LEFT JOIN analytics_listing_labels(ARRAY(SELECT property_id FROM top_listings)) lb ON lb.property_id = t.property_id
  ),
  unit_rows AS (
    SELECT left(a.metadata ->> 'unit_type_id', 64) AS unit_key,
           count(DISTINCT (v.session_id, v.property_id)) AS visits,
           count(DISTINCT (v.session_id, v.property_id)) FILTER (WHERE v.unit_then_contact) AS then_contact
    FROM visits v
    JOIN acts a ON a.session_id = v.session_id AND a.property_id = v.property_id AND a.kind = 'unit_select'
               AND a.created_at >= v.t0 AND a.created_at < v.t0 + v_win
    GROUP BY 1
    ORDER BY 2 DESC, 1
    LIMIT 25
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object(
      'start', p_start, 'end_exclusive', p_end, 'tz', 'Asia/Vientiane',
      'today', v_today,
      'includes_today', (p_start <= v_today AND v_today < p_end),
      'outcome_window_hours', 24,
      'outcomes_incomplete', (now() < v_to + v_win),
      'first_open_day', (SELECT (MIN(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM ui_events WHERE element_id = 'contact_intent_open')
    ),
    'ask', jsonb_build_object(
      'visits',                  (SELECT count(*) FROM visits),
      'open_events',             (SELECT count(*) FROM ui WHERE kind = 'open' AND created_at >= v_from AND created_at < v_to),
      'repeat_open_visits',      (SELECT count(*) FROM visits WHERE n_opens > 1),
      'excluded_null_session',   (SELECT count(*) FROM ui WHERE kind = 'open' AND created_at >= v_from AND created_at < v_to AND session_id IS NULL),
      'excluded_null_property',  (SELECT count(*) FROM ui WHERE kind = 'open' AND created_at >= v_from AND created_at < v_to AND session_id IS NOT NULL AND property_id IS NULL)
    ),
    'contact_intent', jsonb_build_object(
      'intent_chosen_visits',  (SELECT count(*) FROM visits WHERE self_service OR f_unit OR high_intent OR f_terms OR f_escalated),
      'self_service_visits',   (SELECT count(*) FROM visits WHERE self_service),
      'where_visits',          (SELECT count(*) FROM visits WHERE f_location),
      'price_visits',          (SELECT count(*) FROM visits WHERE f_price),
      'availability_visits',   (SELECT count(*) FROM visits WHERE f_availability),
      'photos_visits',         (SELECT count(*) FROM visits WHERE f_gallery),
      'unit_select_visits',    (SELECT count(*) FROM visits WHERE f_unit),
      'terms_visits',          (SELECT count(*) FROM visits WHERE f_terms),
      'escalated_visits',      (SELECT count(*) FROM visits WHERE f_escalated)
    ),
    'resolution', jsonb_build_object(
      'price', jsonb_build_object('answer_on_site', (SELECT count(*) FROM visits WHERE f_price_ans),
                                  'escalate_to_agent', (SELECT count(*) FROM visits WHERE f_price_esc),
                                  'unspecified', (SELECT count(*) FROM visits WHERE f_price_unk)),
      'terms', jsonb_build_object('answer_on_site', (SELECT count(*) FROM visits WHERE f_terms_ans),
                                  'escalate_to_agent', (SELECT count(*) FROM visits WHERE f_terms_esc),
                                  'unspecified', (SELECT count(*) FROM visits WHERE f_terms_unk)),
      'deposit_topic', jsonb_build_object('answer_on_site', (SELECT count(*) FROM visits WHERE f_dep_ans),
                                          'escalate_to_agent', (SELECT count(*) FROM visits WHERE f_dep_esc)),
      'escalated_visits', (SELECT count(*) FROM visits WHERE f_escalated),
      'escalated_then_contact_visits', (SELECT count(*) FROM visits WHERE escalated_then_contact),
      'ask_agent_clicks', jsonb_build_object('visits', (SELECT count(*) FROM visits WHERE f_esc_click),
                                             'terms', (SELECT count(*) FROM visits WHERE f_esc_click_terms),
                                             'deposit', (SELECT count(*) FROM visits WHERE f_esc_click_deposit))
    ),
    'high_intent', jsonb_build_object(
      'high_intent_visits',            (SELECT count(*) FROM visits WHERE high_intent),
      'book_visits',                   (SELECT count(*) FROM visits WHERE f_book),
      'call_visits',                   (SELECT count(*) FROM visits WHERE f_call),
      'whatsapp_visits',               (SELECT count(*) FROM visits WHERE f_whatsapp),
      'agent_contact_visits',          (SELECT count(*) FROM visits WHERE agent_contact),
      'agent_contact_via_menu_visits', (SELECT count(*) FROM visits WHERE f_agent_via_menu),
      'contact_click_visits',          (SELECT count(*) FROM visits WHERE has_click),
      'contact_clicks',                (SELECT coalesce(sum(lead_call + lead_wa), 0) FROM visits),
      'call_clicks',                   (SELECT coalesce(sum(lead_call), 0) FROM visits),
      'whatsapp_clicks',               (SELECT coalesce(sum(lead_wa), 0) FROM visits)
    ),
    'unit_flow', jsonb_build_object(
      'unit_select_visits',       (SELECT count(*) FROM visits WHERE f_unit),
      'unit_then_contact_visits', (SELECT count(*) FROM visits WHERE unit_then_contact)
    ),
    'clicks', jsonb_build_object(
      'total',     (SELECT count(*) FROM clicks),
      'call',      (SELECT count(*) FROM clicks WHERE ch = 'call'),
      'whatsapp',  (SELECT count(*) FROM clicks WHERE ch = 'whatsapp'),
      'via_ask',   jsonb_build_object('total', (SELECT count(*) FROM clicks WHERE src = 'via_ask'),
                                      'call', (SELECT count(*) FROM clicks WHERE src = 'via_ask' AND ch = 'call'),
                                      'whatsapp', (SELECT count(*) FROM clicks WHERE src = 'via_ask' AND ch = 'whatsapp')),
      'direct',    jsonb_build_object('total', (SELECT count(*) FROM clicks WHERE src = 'direct'),
                                      'call', (SELECT count(*) FROM clicks WHERE src = 'direct' AND ch = 'call'),
                                      'whatsapp', (SELECT count(*) FROM clicks WHERE src = 'direct' AND ch = 'whatsapp')),
      'unlinked',  jsonb_build_object('total', (SELECT count(*) FROM clicks WHERE src = 'unlinked'),
                                      'call', (SELECT count(*) FROM clicks WHERE src = 'unlinked' AND ch = 'call'),
                                      'whatsapp', (SELECT count(*) FROM clicks WHERE src = 'unlinked' AND ch = 'whatsapp'))
    ),
    'diagnostics', jsonb_build_object(
      'by_surface', (SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'ask_visits')::int DESC, x ->> 'key'), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('key', surface, 'ask_visits', count(*),
                   'self_service_visits', count(*) FILTER (WHERE self_service), 'agent_contact_visits', count(*) FILTER (WHERE agent_contact),
                   'book_visits', count(*) FILTER (WHERE f_book), 'contact_click_visits', count(*) FILTER (WHERE has_click)) AS x
          FROM visits GROUP BY surface) s),
      'by_lang', (SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'ask_visits')::int DESC, x ->> 'key'), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('key', lang, 'ask_visits', count(*),
                   'self_service_visits', count(*) FILTER (WHERE self_service), 'agent_contact_visits', count(*) FILTER (WHERE agent_contact),
                   'book_visits', count(*) FILTER (WHERE f_book), 'contact_click_visits', count(*) FILTER (WHERE has_click)) AS x
          FROM visits GROUP BY lang) s),
      'by_availability', (SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'ask_visits')::int DESC, x ->> 'key'), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('key', avail, 'ask_visits', count(*),
                   'self_service_visits', count(*) FILTER (WHERE self_service), 'agent_contact_visits', count(*) FILTER (WHERE agent_contact),
                   'book_visits', count(*) FILTER (WHERE f_book), 'contact_click_visits', count(*) FILTER (WHERE has_click)) AS x
          FROM visits GROUP BY avail) s),
      'by_unit', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'unit_type_id', r.unit_key, 'unit_name', ut.name_en,
                    'visits', r.visits, 'then_contact_visits', r.then_contact) ORDER BY r.visits DESC, r.unit_key), '[]'::jsonb)
                  FROM unit_rows r LEFT JOIN unit_types ut ON ut.id::text = r.unit_key),
      'listings', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'property_id', property_id, 'title', title, 'slug', slug, 'resolution', resolution, 'is_deleted', is_deleted,
                    'ask_visits', ask_visits, 'self_service_visits', self_service_visits, 'agent_contact_visits', agent_contact_visits,
                    'book_visits', book_visits, 'contact_click_visits', contact_click_visits) ORDER BY ask_visits DESC, property_id), '[]'::jsonb)
                  FROM listing_rows),
      'attribution', jsonb_build_object(
        'matched',   jsonb_build_object('book', (SELECT count(*) FROM cta WHERE kind = 'book' AND matched),
                                        'call', (SELECT count(*) FROM cta WHERE kind = 'call' AND matched),
                                        'whatsapp', (SELECT count(*) FROM cta WHERE kind = 'whatsapp' AND matched)),
        'unmatched', jsonb_build_object('book', (SELECT count(*) FROM cta WHERE kind = 'book' AND matched IS FALSE),
                                        'call', (SELECT count(*) FROM cta WHERE kind = 'call' AND matched IS FALSE),
                                        'whatsapp', (SELECT count(*) FROM cta WHERE kind = 'whatsapp' AND matched IS FALSE)),
        'unlinkable_actions', (SELECT count(*) FROM cta WHERE matched IS NULL),
        'leads_without_action', (SELECT count(*) FROM lead_no_cta),
        'visits_with_click_but_no_action', (SELECT count(*) FROM visits WHERE has_click AND NOT (f_book OR f_call OR f_whatsapp))
      ),
      'data_quality', jsonb_build_object(
        'new_rows_without_metadata', (SELECT count(*) FROM ui WHERE NOT is_legacy AND metadata IS NULL
                                       AND created_at >= v_from AND created_at < v_to),
        'legacy_rows', (SELECT count(*) FROM ui WHERE is_legacy AND created_at >= v_from AND created_at < v_to),
        'legacy_call_rows', (SELECT count(*) FROM ui WHERE element_id = 'contact-phone' AND created_at >= v_from AND created_at < v_to)
      )
    )
  ) INTO result;

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_contact_intent_funnel(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_contact_intent_funnel(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_contact_intent_funnel(date, date) TO authenticated;

COMMENT ON FUNCTION analytics_contact_intent_funnel(date, date) IS
  'Staff-only, read-only Contact Intent funnel v2 (adds Terms & utilities, Price & deposit resolution) over [p_start, p_end) Asia/Vientiane days. Ask visit = distinct (session, listing) with a contact_intent_open; outcomes within 24 h in the same session+listing. Per-intent lead attribution is derived (diagnostics only). See the file header.';

COMMIT;
