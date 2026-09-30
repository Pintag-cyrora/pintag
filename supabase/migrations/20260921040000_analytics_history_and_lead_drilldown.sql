-- ============================================================================
-- ANALYTICS: HISTORY BOUNDS + PAGINATED LEAD ACTIVITY (DAY / LISTING DRILL-DOWN)
-- ============================================================================
-- Two new staff-only RPCs. Requires 20260921030000 (analytics_listing_labels,
-- idx_leads_lead_event_id, the Asia/Vientiane day convention).
--
-- analytics_history_bounds()
--   Cheap min/max(created_at) per analytics table, as Asia/Vientiane dates,
--   plus today's Laos date. Lets the "All time" preset start at the real
--   first day of data instead of an invented epoch, and lets each chart say
--   "tracking since <date>" for sources that started later.
--
-- analytics_lead_activity(p_start, p_end, p_property_id, p_limit, cursor)
--   One row per lead-type record in [p_start, p_end) Laos days, newest first,
--   keyset-paginated. It answers "which listing generated this lead?".
--   Row kinds (never merged, never fabricated):
--     lead                official CRM leads row (drives the "Total leads"
--                         number; carries CRM status)
--     legacy_event        lead_events row WITH a listing_id but NO leads row
--                         (pre-CRM, or the CRM row no longer exists). Shown
--                         with its own listing/unit/agent from the event; no
--                         leads row is created or implied; NOT counted as a
--                         lead.
--     unattributed_event  lead_events row with neither a listing nor a leads
--                         row. Shown so nothing silently disappears; cannot
--                         be attributed to a listing.
--   A lead whose listing was hard-deleted has leads.property_id = NULL (ON DELETE
--   SET NULL) but its lead_event still carries the listing id, so the row keeps
--   its listing attribution (resolved through the snapshot / removal-log chain).
--   `totals` always describe the WHOLE requested range (not the page), so the
--   UI can say "12 leads · 3 legacy events" while paging. p_property_id
--   filters to one listing (unattributed events never match it).
--   Result is one jsonb value, so PostgREST's max-rows cap can never truncate
--   it; the page size is clamped to 1..500 and there is an explicit
--   has_more / next_cursor.
--
-- PRIVACY. Buyer data (leads.customer_name / customer_phone / notes) and
-- contact phone numbers are NOT selected anywhere in this function. The
-- recipient CONTACT's display name and role and the operational agent name
-- are returned (operational identity, no phone numbers).
--
-- Both functions: STABLE SECURITY DEFINER, SET search_path = public, pg_temp,
-- gated by is_pintag_staff(auth.uid()), EXECUTE revoked from PUBLIC/anon,
-- granted to authenticated only. Read-only; touches no data.
--
-- ROLLBACK: DROP FUNCTION analytics_history_bounds();
--           DROP FUNCTION analytics_lead_activity(date, date, uuid, integer, timestamptz, uuid);
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION analytics_history_bounds()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  WITH b AS (
    SELECT 'page_views' AS src,
           (SELECT (MIN(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM page_views) AS first_day,
           (SELECT (MAX(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM page_views) AS last_day
    UNION ALL SELECT 'listing_events',
           (SELECT (MIN(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM listing_events),
           (SELECT (MAX(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM listing_events)
    UNION ALL SELECT 'lead_events',
           (SELECT (MIN(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM lead_events),
           (SELECT (MAX(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM lead_events)
    UNION ALL SELECT 'leads',
           (SELECT (MIN(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM leads),
           (SELECT (MAX(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM leads)
    UNION ALL SELECT 'search_events',
           (SELECT (MIN(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM search_events),
           (SELECT (MAX(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM search_events)
    UNION ALL SELECT 'ui_events',
           (SELECT (MIN(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM ui_events),
           (SELECT (MAX(created_at) AT TIME ZONE 'Asia/Vientiane')::date FROM ui_events)
  )
  SELECT jsonb_build_object(
    'tz', 'Asia/Vientiane',
    'today', (now() AT TIME ZONE 'Asia/Vientiane')::date,
    'earliest_day', (SELECT MIN(first_day) FROM b),
    'latest_day', (SELECT MAX(last_day) FROM b),
    'sources', (SELECT jsonb_object_agg(src, jsonb_build_object('first_day', first_day, 'last_day', last_day)) FROM b)
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_history_bounds() FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_history_bounds() FROM anon;
GRANT EXECUTE ON FUNCTION analytics_history_bounds() TO authenticated;

CREATE OR REPLACE FUNCTION analytics_lead_activity(
  p_start       date,
  p_end         date,
  p_property_id uuid        DEFAULT NULL,
  p_limit       integer     DEFAULT 200,
  p_cursor_at   timestamptz DEFAULT NULL,
  p_cursor_id   uuid        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result  jsonb;
  v_from  timestamptz;
  v_to    timestamptz;
  v_limit integer;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  IF (p_cursor_at IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'p_cursor_at and p_cursor_id must be given together' USING ERRCODE = '22023';
  END IF;
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_from  := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to    := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';

  WITH act AS MATERIALIZED (
    SELECT 'lead'::text          AS kind,
           l.id                  AS row_id,
           l.created_at          AS event_at,
           l.id                  AS lead_id,
           l.lead_event_id       AS lead_event_id,
           COALESCE(l.property_id, lev.listing_id) AS property_id,  -- detached lead (listing hard-deleted): keep the id the event recorded
           l.party_id            AS agent_party_id,
           l.contact_id          AS contact_id,
           l.status              AS lead_status,
           l.contact_method      AS channel,
           l.recipient_type      AS recipient_type,
           l.recipient_verified  AS recipient_verified,
           l.unit_type_id        AS unit_type_id
    FROM leads l
    LEFT JOIN lead_events lev ON lev.id = l.lead_event_id
    WHERE l.created_at >= v_from AND l.created_at < v_to
      AND (p_property_id IS NULL OR COALESCE(l.property_id, lev.listing_id) = p_property_id)
    UNION ALL
    SELECT CASE WHEN le.listing_id IS NULL THEN 'unattributed_event' ELSE 'legacy_event' END,
           le.id, le.created_at, NULL::uuid, le.id, le.listing_id, le.agent_id, le.contact_id,
           NULL::text, regexp_replace(le.event_type, '_click$', ''), NULL::text, NULL::boolean,
           le.unit_type_id
    FROM lead_events le
    WHERE le.created_at >= v_from AND le.created_at < v_to
      AND (p_property_id IS NULL OR le.listing_id = p_property_id)
      AND NOT EXISTS (SELECT 1 FROM leads l2 WHERE l2.lead_event_id = le.id)
  ),
  totals AS (
    SELECT COUNT(*) FILTER (WHERE kind = 'lead')               AS leads,
           COUNT(*) FILTER (WHERE kind = 'legacy_event')       AS legacy_events,
           COUNT(*) FILTER (WHERE kind = 'unattributed_event') AS unattributed_events,
           COUNT(DISTINCT property_id)                         AS distinct_listings,
           COUNT(*) FILTER (
             WHERE property_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.id = act.property_id AND p.deleted_at IS NULL)
           )                                                   AS deleted_listing_rows
    FROM act
  ),
  page AS MATERIALIZED (
    SELECT * FROM act
    WHERE p_cursor_at IS NULL OR (act.event_at, act.row_id) < (p_cursor_at, p_cursor_id)
    ORDER BY act.event_at DESC, act.row_id DESC
    LIMIT v_limit + 1
  ),
  page_lim AS MATERIALIZED (
    SELECT * FROM page ORDER BY event_at DESC, row_id DESC LIMIT v_limit
  ),
  labels AS (
    SELECT * FROM analytics_listing_labels(ARRAY(SELECT DISTINCT property_id FROM page_lim WHERE property_id IS NOT NULL))
  ),
  enriched AS (
    SELECT pl.event_at, pl.row_id,
           jsonb_build_object(
             'event_at', pl.event_at,
             'laos_day', (pl.event_at AT TIME ZONE 'Asia/Vientiane')::date,
             'kind', pl.kind,
             'lead_id', pl.lead_id,
             'lead_event_id', pl.lead_event_id,
             'contact_action', COALESCE(le.event_type, pl.channel || '_click'),
             'channel', pl.channel,
             'lead_status', pl.lead_status,
             'property_id', pl.property_id,
             'listing_title', CASE WHEN pl.property_id IS NULL THEN NULL
                                   ELSE COALESCE(lb.title, lb.slug, 'Unknown listing ' || left(pl.property_id::text, 8)) END,
             'listing_slug', lb.slug,
             'listing_status', lb.listing_status,
             'listing_resolution', CASE WHEN pl.property_id IS NULL THEN NULL ELSE COALESCE(lb.resolution, 'unknown') END,
             'is_deleted', COALESCE(lb.is_deleted, false),
             'unit_type_id', pl.unit_type_id,
             'unit_type_name', ut.name_en,
             'agent_party_id', pl.agent_party_id,
             'agent_name', pt.name_en,
             'contact_id', pl.contact_id,
             'contact_name', c.name,
             'contact_role', c.role,
             'recipient_type', pl.recipient_type,
             'recipient_verified', pl.recipient_verified,
             'first_touch_source', ft.referrer_source,
             'session_id', le.session_id
           ) AS j
    FROM page_lim pl
    LEFT JOIN lead_events le ON le.id = pl.lead_event_id
    LEFT JOIN labels lb ON lb.property_id = pl.property_id
    LEFT JOIN unit_types ut ON ut.id = pl.unit_type_id
    LEFT JOIN parties pt ON pt.id = pl.agent_party_id
    LEFT JOIN contacts c ON c.id = pl.contact_id
    LEFT JOIN LATERAL (
      SELECT pv.referrer_source FROM page_views pv
      WHERE pv.session_id = le.session_id
      ORDER BY pv.created_at ASC LIMIT 1
    ) ft ON le.session_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end, 'tz', 'Asia/Vientiane'),
    'property_id', p_property_id,
    'totals', (SELECT jsonb_build_object(
                 'leads', leads, 'legacy_events', legacy_events,
                 'unattributed_events', unattributed_events,
                 'distinct_listings', distinct_listings,
                 'deleted_listing_rows', deleted_listing_rows) FROM totals),
    'rows', (SELECT COALESCE(jsonb_agg(j ORDER BY event_at DESC, row_id DESC), '[]'::jsonb) FROM enriched),
    'has_more', ((SELECT COUNT(*) FROM page) > v_limit),
    'next_cursor', (
      SELECT CASE WHEN (SELECT COUNT(*) FROM page) > v_limit
                  THEN jsonb_build_object('at', event_at, 'id', row_id) END
      FROM page_lim ORDER BY event_at ASC, row_id ASC LIMIT 1
    )
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_lead_activity(date, date, uuid, integer, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_lead_activity(date, date, uuid, integer, timestamptz, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_lead_activity(date, date, uuid, integer, timestamptz, uuid) TO authenticated;

COMMIT;
