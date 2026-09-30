-- ============================================================================
-- ANALYTICS: ASIA/VIENTIANE CALENDAR DAYS, FULL-HISTORY RANGES, HONEST BUCKETS
-- ============================================================================
-- Recreates the ten analytics_* range RPCs (same names, same argument lists,
-- same return types, so PostgREST callers keep working) with four changes:
--
--  1. CALENDAR. A "day" is the Asia/Vientiane (UTC+7, no DST) calendar day,
--     the same convention the Intelligence pipeline adopted in
--     20260918000000_intelligence_vientiane_calendar.sql. Buckets are
--     `(created_at AT TIME ZONE 'Asia/Vientiane')::date`. The database /
--     session TimeZone (UTC) is NOT changed.
--
--     Range filtering uses the equivalent, index-friendly instant form:
--         created_at >= (p_start::timestamp AT TIME ZONE 'Asia/Vientiane')
--         created_at <  (p_end::timestamp   AT TIME ZONE 'Asia/Vientiane')
--     which selects exactly the rows whose Laos calendar date is in
--     [p_start, p_end). Before this migration the date arguments were cast at
--     the session timezone (UTC), so a "day" started at 07:00 Laos time, and
--     the browser compounded that by sending toISOString() dates (see
--     laos-date.js). p_end stays EXCLUSIVE (the analytics contract);
--     intelligence_daily_metrics uses an inclusive end and is untouched.
--
--  2. NO WINDOW CAP. No function limits how far back a range may reach. Only
--     RANKED lists keep their LIMITs (top-10 etc.); every such list now also
--     reports how many rows exist in total, plus an "unattributed / deleted"
--     bucket, so a truncated list is always visibly a "Top 10 of N".
--
--  3. ZERO-FILLED DAILY SERIES. traffic_by_day, views_by_day and the leads
--     by_day series return one entry for every Laos day in the range.
--
--  4. LEGACY / UNATTRIBUTED LEAD EVENTS are reported SEPARATELY from official
--     CRM leads: `legacy_events` are lead_events rows that have a listing but
--     no leads row; `unattributed_events` have neither. `total` still counts
--     only real leads rows.
--
-- Also here:
--   * analytics_listing_labels(uuid[]) -- internal helper resolving a listing
--     id to a display title: current properties row -> latest
--     properties_row_snapshots row -> properties_removal_log -> unknown (the
--     id is always preserved). Only the SECURITY DEFINER analytics functions
--     call it; it is granted to no client role.
--   * idx_leads_lead_event_id -- the legacy anti-join, the funnel's `closed`
--     join and first-touch lookups all go leads.lead_event_id -> lead_events
--     and there was no index on it.
--
-- Every function: STABLE SECURITY DEFINER, SET search_path = public, pg_temp,
-- gated by is_pintag_staff(auth.uid()), EXECUTE revoked from PUBLIC/anon and
-- granted to authenticated only. An inverted or NULL range raises instead of
-- silently returning nothing.
--
-- analytics_realtime_snapshot(integer) is untouched (trailing-minutes window,
-- no calendar).
--
-- ROLLBACK: the previous definitions are, verbatim, in
-- 20260727000000_analytics_platform.sql, 20260730000000_analytics_rpc_aggregation.sql
-- and 20260803000000_share_attribution_metrics.sql; re-running those
-- CREATE OR REPLACE statements restores them. DROP INDEX idx_leads_lead_event_id
-- and DROP FUNCTION analytics_listing_labels(uuid[]) remove the additions.
-- Touches no data.
-- ============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_leads_lead_event_id ON leads(lead_event_id);

-- ── Internal helper: listing id -> display info (never callable by clients) ──
CREATE OR REPLACE FUNCTION analytics_listing_labels(p_ids uuid[])
RETURNS TABLE(
  property_id    uuid,
  title          text,
  slug           text,
  listing_status text,
  resolution     text,
  is_deleted     boolean
)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT i.id,
         COALESCE(p.title_en, p.title_lo,
                  s.row_data ->> 'title_en', s.row_data ->> 'title_lo',
                  r.title_en, r.title_lo),
         COALESCE(p.slug, s.row_data ->> 'slug'),
         COALESCE(p.workflow_status, p.status,
                  s.row_data ->> 'workflow_status', s.row_data ->> 'status',
                  r.status_at_removal),
         CASE
           WHEN p.id IS NOT NULL AND p.deleted_at IS NULL THEN 'current'
           WHEN p.id IS NOT NULL THEN 'soft_deleted'
           WHEN s.row_data IS NOT NULL THEN 'snapshot'
           WHEN r.property_id IS NOT NULL THEN 'removal_log'
           ELSE 'unknown'
         END,
         (p.id IS NULL OR p.deleted_at IS NOT NULL)
  FROM (SELECT DISTINCT x AS id FROM unnest(p_ids) AS x WHERE x IS NOT NULL) i
  LEFT JOIN properties p ON p.id = i.id
  LEFT JOIN LATERAL (
    SELECT ps.row_data FROM properties_row_snapshots ps
    WHERE ps.property_id = i.id ORDER BY ps.created_at DESC LIMIT 1
  ) s ON p.id IS NULL
  LEFT JOIN LATERAL (
    SELECT rl.property_id, rl.title_en, rl.title_lo, rl.status_at_removal FROM properties_removal_log rl
    WHERE rl.property_id = i.id ORDER BY rl.removed_at DESC LIMIT 1
  ) r ON p.id IS NULL AND s.row_data IS NULL
$$;
REVOKE ALL ON FUNCTION analytics_listing_labels(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_listing_labels(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION analytics_listing_labels(uuid[]) FROM authenticated;

-- ── Traffic trend: one row per Laos day, zero-filled ────────────────────────
CREATE OR REPLACE FUNCTION analytics_traffic_by_day(p_start date, p_end date)
RETURNS TABLE(day date, page_views bigint, sessions bigint, unique_visitors bigint, returning_visitors bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  RETURN QUERY
  WITH agg AS (
    SELECT (pv.created_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
           COUNT(*)                                            AS pvs,
           COUNT(DISTINCT pv.session_id)                       AS sess,
           COUNT(DISTINCT pv.visitor_id)                       AS uv,
           COUNT(DISTINCT pv.visitor_id) FILTER (WHERE pv.is_returning) AS rv
    FROM page_views pv
    WHERE pv.created_at >= v_from AND pv.created_at < v_to
    GROUP BY 1
  )
  SELECT g.d::date,
         COALESCE(a.pvs, 0), COALESCE(a.sess, 0), COALESCE(a.uv, 0), COALESCE(a.rv, 0)
  FROM generate_series(p_start::timestamp, (p_end - 1)::timestamp, interval '1 day') AS g(d)
  LEFT JOIN agg a ON a.d = g.d::date
  ORDER BY 1;
END;
$$;
REVOKE ALL ON FUNCTION analytics_traffic_by_day(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_traffic_by_day(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_traffic_by_day(date, date) TO authenticated;

-- ── Session-level funnel ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION analytics_funnel(p_start date, p_end date)
RETURNS TABLE(stage text, sessions bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  RETURN QUERY
  WITH landed AS (
    SELECT DISTINCT session_id FROM page_views
    WHERE session_id IS NOT NULL AND created_at >= v_from AND created_at < v_to
  ), searched AS (
    SELECT DISTINCT session_id FROM search_events
    WHERE session_id IS NOT NULL AND created_at >= v_from AND created_at < v_to
  ), viewed AS (
    SELECT DISTINCT session_id FROM listing_events
    WHERE event_type = 'view' AND session_id IS NOT NULL AND created_at >= v_from AND created_at < v_to
  ), contacted AS (
    SELECT DISTINCT session_id FROM lead_events
    WHERE session_id IS NOT NULL AND created_at >= v_from AND created_at < v_to
  ), closed AS (
    SELECT DISTINCT le.session_id
    FROM leads l JOIN lead_events le ON le.id = l.lead_event_id
    WHERE l.status = 'closed' AND le.session_id IS NOT NULL
      AND l.updated_at >= v_from AND l.updated_at < v_to
  )
  SELECT 'landed', (SELECT COUNT(*) FROM landed)
  UNION ALL SELECT 'searched', (SELECT COUNT(*) FROM searched)
  UNION ALL SELECT 'viewed_listing', (SELECT COUNT(*) FROM viewed)
  UNION ALL SELECT 'contacted', (SELECT COUNT(*) FROM contacted)
  UNION ALL SELECT 'closed', (SELECT COUNT(*) FROM closed);
END;
$$;
REVOKE ALL ON FUNCTION analytics_funnel(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_funnel(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_funnel(date, date) TO authenticated;

-- ── Session stats ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION analytics_session_stats(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result jsonb;
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  WITH per_session AS (
    SELECT session_id, COUNT(*) AS views,
           EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) AS duration_seconds
    FROM page_views
    WHERE session_id IS NOT NULL AND created_at >= v_from AND created_at < v_to
    GROUP BY session_id
  ), totals AS (
    SELECT COUNT(*) AS page_views,
           COUNT(DISTINCT visitor_id) AS unique_visitors,
           COUNT(DISTINCT visitor_id) FILTER (WHERE is_returning) AS returning_visitors
    FROM page_views
    WHERE created_at >= v_from AND created_at < v_to
  )
  SELECT jsonb_build_object(
    'sessions', (SELECT COUNT(*) FROM per_session),
    'avg_pages_per_session', COALESCE((SELECT ROUND(AVG(views), 2) FROM per_session), 0),
    'avg_session_duration_seconds', COALESCE((SELECT ROUND(AVG(duration_seconds)) FROM per_session), 0),
    'bounce_rate', COALESCE((SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE views = 1) / NULLIF(COUNT(*), 0), 1) FROM per_session), 0),
    'page_views', (SELECT page_views FROM totals),
    'unique_visitors', (SELECT unique_visitors FROM totals),
    'returning_visitors', (SELECT returning_visitors FROM totals)
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_session_stats(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_session_stats(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_session_stats(date, date) TO authenticated;

-- ── Traffic sources ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION analytics_traffic_sources(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result jsonb;
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  SELECT jsonb_build_object(
    'by_source', (
      SELECT COALESCE(jsonb_object_agg(COALESCE(referrer_source, 'direct'), cnt), '{}'::jsonb)
      FROM (
        SELECT referrer_source, COUNT(*) cnt FROM page_views
        WHERE created_at >= v_from AND created_at < v_to
        GROUP BY referrer_source
      ) t
    ),
    'top_referrers', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', host, 'value', cnt)), '[]'::jsonb)
      FROM (
        SELECT regexp_replace(regexp_replace(referrer, '^https?://(www\.)?', ''), '/.*$', '') AS host,
               COUNT(*) cnt
        FROM page_views
        WHERE created_at >= v_from AND created_at < v_to
          AND referrer IS NOT NULL AND referrer_source != 'direct'
        GROUP BY host ORDER BY cnt DESC, host LIMIT 10
      ) t
    ),
    'campaigns', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'campaign', utm_campaign, 'source', COALESCE(utm_source, '—'),
        'medium', COALESCE(utm_medium, '—'), 'sessions', sessions
      )), '[]'::jsonb)
      FROM (
        SELECT utm_campaign, utm_source, utm_medium, COUNT(DISTINCT session_id) sessions
        FROM page_views
        WHERE created_at >= v_from AND created_at < v_to AND utm_campaign IS NOT NULL
        GROUP BY utm_campaign, utm_source, utm_medium ORDER BY sessions DESC, utm_campaign LIMIT 20
      ) t
    )
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_traffic_sources(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_traffic_sources(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_traffic_sources(date, date) TO authenticated;

-- ── Listing engagement (was 20260803000000's definition) ────────────────────
-- Adds wa_clicks / call_clicks / agent_profile_clicks (previously three
-- client-side counts built from browser-local instants, which disagreed with
-- these day boundaries), zero-filled views_by_day, most_viewed_total.
CREATE OR REPLACE FUNCTION analytics_listing_engagement(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result jsonb;
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  WITH per_property AS (
    SELECT property_id,
           COUNT(*) FILTER (WHERE event_type = 'view') AS views,
           COUNT(*) FILTER (WHERE event_type = 'impression') AS impressions,
           COUNT(*) FILTER (WHERE event_type = 'click') AS clicks,
           COUNT(*) FILTER (WHERE event_type = 'save') AS saves,
           COUNT(*) FILTER (WHERE event_type = 'share') AS shares
    FROM listing_events
    WHERE created_at >= v_from AND created_at < v_to AND property_id IS NOT NULL
    GROUP BY property_id
  ),
  totals AS (
    SELECT COALESCE(SUM(views), 0) AS views_total, COALESCE(SUM(shares), 0) AS shares_total
    FROM per_property
  ),
  shared_sessions AS (
    SELECT DISTINCT session_id FROM page_views
    WHERE page = 'listing.html' AND utm_source = 'pintag_share'
      AND session_id IS NOT NULL
      AND created_at >= v_from AND created_at < v_to
  ),
  shared_link_stats AS (
    SELECT
      (SELECT COUNT(*) FROM page_views
         WHERE page = 'listing.html' AND utm_source = 'pintag_share'
           AND created_at >= v_from AND created_at < v_to) AS shared_link_views,
      (SELECT COUNT(*) FROM lead_events
         WHERE session_id IN (SELECT session_id FROM shared_sessions)
           AND created_at >= v_from AND created_at < v_to) AS shared_link_leads,
      (SELECT COUNT(*) FROM listing_events
         WHERE event_type = 'share'
           AND session_id IN (SELECT session_id FROM shared_sessions)
           AND created_at >= v_from AND created_at < v_to) AS secondary_shares
  ),
  views_daily AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, COUNT(*) AS cnt
    FROM listing_events
    WHERE event_type = 'view' AND created_at >= v_from AND created_at < v_to
    GROUP BY 1
  )
  SELECT jsonb_build_object(
    'saves_total', COALESCE((SELECT SUM(saves) FROM per_property), 0),
    'shares_total', (SELECT shares_total FROM totals),
    'views_total', (SELECT views_total FROM totals),
    'share_rate', (
      SELECT CASE WHEN views_total > 0 THEN ROUND(100.0 * shares_total / views_total, 1) ELSE NULL END
      FROM totals
    ),
    'shared_link_views', (SELECT shared_link_views FROM shared_link_stats),
    'views_per_share', (
      SELECT CASE WHEN shares_total > 0 THEN ROUND(shared_link_stats.shared_link_views::numeric / shares_total, 2) ELSE NULL END
      FROM totals, shared_link_stats
    ),
    'shared_link_leads', (SELECT shared_link_leads FROM shared_link_stats),
    'secondary_shares', (SELECT secondary_shares FROM shared_link_stats),
    'wa_clicks', (SELECT COUNT(*) FROM lead_events
                  WHERE event_type = 'whatsapp_click' AND created_at >= v_from AND created_at < v_to),
    'call_clicks', (SELECT COUNT(*) FROM lead_events
                    WHERE event_type = 'call_click' AND created_at >= v_from AND created_at < v_to),
    'agent_profile_clicks', (SELECT COUNT(*) FROM ui_events
                             WHERE element_id = 'agent-profile-link' AND created_at >= v_from AND created_at < v_to),
    'views_by_day', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('day', g.d::date, 'views', COALESCE(v.cnt, 0)) ORDER BY g.d), '[]'::jsonb)
      FROM generate_series(p_start::timestamp, (p_end - 1)::timestamp, interval '1 day') AS g(d)
      LEFT JOIN views_daily v ON v.d = g.d::date
    ),
    'most_viewed_total', (SELECT COUNT(*) FROM per_property WHERE views > 0),
    'most_viewed', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(p.title_en, p.title_lo, pp.property_id::text), 'value', pp.views) ORDER BY pp.views DESC, pp.property_id), '[]'::jsonb)
      FROM (SELECT * FROM per_property WHERE views > 0 ORDER BY views DESC, property_id LIMIT 10) pp
      LEFT JOIN properties p ON p.id = pp.property_id
    ),
    'top_ctr', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(p.title_en, p.title_lo, pp.property_id::text), 'value', ROUND(100.0 * pp.clicks / NULLIF(pp.impressions,0), 1)) ORDER BY pp.clicks::float / NULLIF(pp.impressions,0) DESC, pp.property_id), '[]'::jsonb)
      FROM (SELECT * FROM per_property WHERE impressions >= 5 ORDER BY clicks::float / NULLIF(impressions,0) DESC, property_id LIMIT 10) pp
      LEFT JOIN properties p ON p.id = pp.property_id
    )
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_listing_engagement(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_listing_engagement(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_listing_engagement(date, date) TO authenticated;

-- ── Search breakdown ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION analytics_search_breakdown(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result jsonb;
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*) FROM search_events WHERE created_at >= v_from AND created_at < v_to),
    'zero_result', (SELECT COUNT(*) FROM search_events WHERE created_at >= v_from AND created_at < v_to AND result_count = 0),
    'by_type', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', property_type, 'value', cnt) ORDER BY cnt DESC, property_type), '[]'::jsonb)
      FROM (SELECT property_type, COUNT(*) cnt FROM search_events WHERE created_at >= v_from AND created_at < v_to AND property_type IS NOT NULL GROUP BY property_type) t
    ),
    'by_tx', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', transaction_type, 'value', cnt)), '[]'::jsonb)
      FROM (SELECT transaction_type, COUNT(*) cnt FROM search_events WHERE created_at >= v_from AND created_at < v_to AND transaction_type IS NOT NULL GROUP BY transaction_type) t
    ),
    'by_district', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', district, 'value', cnt) ORDER BY cnt DESC, district), '[]'::jsonb)
      FROM (SELECT district, COUNT(*) cnt FROM search_events WHERE created_at >= v_from AND created_at < v_to AND district IS NOT NULL GROUP BY district) t
    )
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_search_breakdown(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_search_breakdown(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_search_breakdown(date, date) TO authenticated;

-- ── Behavior ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION analytics_behavior(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result jsonb;
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  WITH ordered AS (
    SELECT session_id, page, created_at,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at) AS rn,
           COUNT(*) OVER (PARTITION BY session_id) AS session_len,
           LEAD(created_at) OVER (PARTITION BY session_id ORDER BY created_at) AS next_at
    FROM page_views
    WHERE session_id IS NOT NULL AND created_at >= v_from AND created_at < v_to
  )
  SELECT jsonb_build_object(
    'entry', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', page, 'value', cnt) ORDER BY cnt DESC, page), '[]'::jsonb)
      FROM (SELECT page, COUNT(*) cnt FROM ordered WHERE rn = 1 GROUP BY page ORDER BY cnt DESC, page LIMIT 8) t
    ),
    'exit', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', page, 'value', cnt) ORDER BY cnt DESC, page), '[]'::jsonb)
      FROM (SELECT page, COUNT(*) cnt FROM ordered WHERE rn = session_len GROUP BY page ORDER BY cnt DESC, page LIMIT 8) t
    ),
    'avg_duration', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', page, 'value', avg_secs) ORDER BY avg_secs DESC, page), '[]'::jsonb)
      FROM (
        SELECT page, ROUND(AVG(EXTRACT(EPOCH FROM (next_at - created_at)))) AS avg_secs
        FROM ordered
        WHERE next_at IS NOT NULL AND next_at >= created_at AND next_at < created_at + INTERVAL '1 hour'
        GROUP BY page ORDER BY avg_secs DESC, page LIMIT 8
      ) t
    ),
    'scroll', (
      SELECT COALESCE(jsonb_object_agg(element_id, cnt), '{}'::jsonb)
      FROM (
        SELECT element_id, COUNT(*) cnt FROM ui_events
        WHERE event_type = 'scroll' AND element_id IN ('25','50','75','100')
          AND created_at >= v_from AND created_at < v_to
        GROUP BY element_id
      ) t
    ),
    'top_clicks', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', k, 'value', cnt) ORDER BY cnt DESC, k), '[]'::jsonb)
      FROM (
        SELECT COALESCE(NULLIF(label,''), element_id) AS k, COUNT(*) cnt FROM ui_events
        WHERE event_type = 'click' AND created_at >= v_from AND created_at < v_to
        GROUP BY k ORDER BY cnt DESC, k LIMIT 10
      ) t
    )
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_behavior(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_behavior(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_behavior(date, date) TO authenticated;

-- ── Location / device breakdown ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION analytics_location_breakdown(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result jsonb;
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  SELECT jsonb_build_object(
    'device', (SELECT COALESCE(jsonb_object_agg(device_type, cnt), '{}'::jsonb) FROM (SELECT device_type, COUNT(*) cnt FROM page_views WHERE created_at >= v_from AND created_at < v_to AND device_type IS NOT NULL GROUP BY device_type) t),
    'browser', (SELECT COALESCE(jsonb_object_agg(browser, cnt), '{}'::jsonb) FROM (SELECT browser, COUNT(*) cnt FROM page_views WHERE created_at >= v_from AND created_at < v_to AND browser IS NOT NULL GROUP BY browser) t),
    'os', (SELECT COALESCE(jsonb_object_agg(os, cnt), '{}'::jsonb) FROM (SELECT os, COUNT(*) cnt FROM page_views WHERE created_at >= v_from AND created_at < v_to AND os IS NOT NULL GROUP BY os) t),
    'lang', (SELECT COALESCE(jsonb_object_agg(lang, cnt), '{}'::jsonb) FROM (SELECT lang, COUNT(*) cnt FROM page_views WHERE created_at >= v_from AND created_at < v_to AND lang IS NOT NULL GROUP BY lang) t)
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_location_breakdown(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_location_breakdown(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_location_breakdown(date, date) TO authenticated;

-- ── Leads: official CRM leads, plus legacy / unattributed events separately ──
-- `total`, `closed`, `by_listing`, `by_agent`, `by_source` and `recent` keep
-- counting ONLY leads rows. Legacy (listing but no leads row) and
-- unattributed (neither) lead_events are reported in their own keys.
-- Ranked lists stay top-10 but carry *_total, an "other" remainder and the
-- unattributed / deleted buckets so the parts always add up to `total`.
CREATE OR REPLACE FUNCTION analytics_leads_breakdown(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result jsonb;
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  WITH in_range AS (
    SELECT * FROM leads WHERE created_at >= v_from AND created_at < v_to
  ),
  orphan_events AS (
    SELECT le.id, le.created_at, le.listing_id
    FROM lead_events le
    WHERE le.created_at >= v_from AND le.created_at < v_to
      AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.lead_event_id = le.id)
  ),
  first_touch AS (
    SELECT ir.id AS lead_id, pv.referrer_source
    FROM in_range ir
    LEFT JOIN lead_events le ON le.id = ir.lead_event_id
    LEFT JOIN LATERAL (
      SELECT referrer_source FROM page_views
      WHERE session_id = le.session_id
      ORDER BY created_at ASC LIMIT 1
    ) pv ON le.session_id IS NOT NULL
  ),
  by_listing_all AS (
    SELECT property_id, COUNT(*) AS cnt FROM in_range WHERE property_id IS NOT NULL GROUP BY property_id
  ),
  by_listing_top AS (
    SELECT property_id, cnt FROM by_listing_all ORDER BY cnt DESC, property_id LIMIT 10
  ),
  listing_labels AS (
    SELECT * FROM analytics_listing_labels(ARRAY(SELECT property_id FROM by_listing_top))
  ),
  by_agent_all AS (
    SELECT party_id, COUNT(*) AS cnt FROM in_range WHERE party_id IS NOT NULL GROUP BY party_id
  ),
  by_agent_top AS (
    SELECT party_id, cnt FROM by_agent_all ORDER BY cnt DESC, party_id LIMIT 10
  ),
  daily_leads AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d, COUNT(*) AS cnt FROM in_range GROUP BY 1
  ),
  daily_orphans AS (
    SELECT (created_at AT TIME ZONE 'Asia/Vientiane')::date AS d,
           COUNT(*) FILTER (WHERE listing_id IS NOT NULL) AS legacy,
           COUNT(*) FILTER (WHERE listing_id IS NULL)     AS unattributed
    FROM orphan_events GROUP BY 1
  )
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*) FROM in_range),
    'closed', (SELECT COUNT(*) FROM in_range WHERE status = 'closed'),
    'legacy_events', (SELECT COUNT(*) FROM orphan_events WHERE listing_id IS NOT NULL),
    'unattributed_events', (SELECT COUNT(*) FROM orphan_events WHERE listing_id IS NULL),
    'by_day', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'day', g.d::date,
               'value', COALESCE(dl.cnt, 0),
               'legacy', COALESCE(dorph.legacy, 0),
               'unattributed', COALESCE(dorph.unattributed, 0)) ORDER BY g.d), '[]'::jsonb)
      FROM generate_series(p_start::timestamp, (p_end - 1)::timestamp, interval '1 day') AS g(d)
      LEFT JOIN daily_leads dl ON dl.d = g.d::date
      LEFT JOIN daily_orphans dorph ON dorph.d = g.d::date
    ),
    'by_listing', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'property_id', t.property_id,
               'label', COALESCE(lb.title, lb.slug, 'Unknown listing ' || left(t.property_id::text, 8)),
               'value', t.cnt,
               'resolution', lb.resolution,
               'is_deleted', lb.is_deleted) ORDER BY t.cnt DESC, t.property_id), '[]'::jsonb)
      FROM by_listing_top t
      LEFT JOIN listing_labels lb ON lb.property_id = t.property_id
    ),
    'by_listing_total', (SELECT COUNT(*) FROM by_listing_all),
    'by_listing_other', (SELECT COALESCE(SUM(cnt), 0) FROM by_listing_all) - (SELECT COALESCE(SUM(cnt), 0) FROM by_listing_top),
    'by_listing_unattributed', (SELECT COUNT(*) FROM in_range WHERE property_id IS NULL),
    'by_listing_deleted', (
      SELECT COUNT(*) FROM in_range ir
      WHERE ir.property_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.id = ir.property_id AND p.deleted_at IS NULL)
    ),
    'by_agent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'party_id', t.party_id,
               'label', COALESCE(pt.name_en, 'Unknown agent'),
               'value', t.cnt) ORDER BY t.cnt DESC, t.party_id), '[]'::jsonb)
      FROM by_agent_top t
      LEFT JOIN parties pt ON pt.id = t.party_id
    ),
    'by_agent_total', (SELECT COUNT(*) FROM by_agent_all),
    'by_agent_other', (SELECT COALESCE(SUM(cnt), 0) FROM by_agent_all) - (SELECT COALESCE(SUM(cnt), 0) FROM by_agent_top),
    'by_agent_unassigned', (SELECT COUNT(*) FROM in_range WHERE party_id IS NULL),
    'by_source', (
      SELECT COALESCE(jsonb_object_agg(COALESCE(referrer_source, 'unknown'), cnt), '{}'::jsonb)
      FROM (SELECT referrer_source, COUNT(*) cnt FROM first_touch GROUP BY referrer_source) t
    ),
    -- Kept for backward compatibility with older cached analytics.js builds;
    -- the UI now pages analytics_lead_activity() instead.
    'recent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', ir.id, 'listing', COALESCE(p.title_en, p.title_lo, '—'),
        'agent', COALESCE(pt.name_en, '—'), 'status', ir.status, 'created_at', ir.created_at
      ) ORDER BY ir.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM in_range ORDER BY created_at DESC LIMIT 50) ir
      LEFT JOIN properties p ON p.id = ir.property_id
      LEFT JOIN parties pt ON pt.id = ir.party_id
    )
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_leads_breakdown(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_leads_breakdown(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_leads_breakdown(date, date) TO authenticated;

-- ── Admin insights ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION analytics_admin_insights(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result jsonb;
  v_from timestamptz;
  v_to   timestamptz;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Invalid date range' USING ERRCODE = '22023';
  END IF;
  v_from := p_start::timestamp AT TIME ZONE 'Asia/Vientiane';
  v_to   := p_end::timestamp   AT TIME ZONE 'Asia/Vientiane';
  WITH leads_in_range AS (
    SELECT * FROM leads WHERE created_at >= v_from AND created_at < v_to
  )
  SELECT jsonb_build_object(
    'new_listings', (SELECT COUNT(*) FROM properties WHERE created_at >= v_from AND created_at < v_to),
    'by_agent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(pt.name_en, 'Unassigned'), 'value', cnt) ORDER BY cnt DESC, l.party_id), '[]'::jsonb)
      FROM (SELECT party_id, COUNT(*) cnt FROM leads_in_range WHERE party_id IS NOT NULL GROUP BY party_id ORDER BY cnt DESC, party_id LIMIT 10) l
      LEFT JOIN parties pt ON pt.id = l.party_id
    ),
    'by_district', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', d, 'value', cnt) ORDER BY cnt DESC, d), '[]'::jsonb)
      FROM (
        SELECT p.district_en AS d, COUNT(*) cnt FROM leads_in_range l
        JOIN properties p ON p.id = l.property_id
        WHERE p.district_en IS NOT NULL GROUP BY p.district_en ORDER BY cnt DESC, d LIMIT 10
      ) t
    ),
    'by_type', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', d, 'value', cnt) ORDER BY cnt DESC, d), '[]'::jsonb)
      FROM (
        SELECT p.property_type AS d, COUNT(*) cnt FROM leads_in_range l
        JOIN properties p ON p.id = l.property_id
        WHERE p.property_type IS NOT NULL GROUP BY p.property_type ORDER BY cnt DESC, d
      ) t
    ),
    'no_views', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('title', COALESCE(p.title_en, p.title_lo), 'district', p.district_en, 'type', p.property_type)), '[]'::jsonb)
      FROM (
        SELECT * FROM properties
        WHERE workflow_status = 'active' AND (view_count IS NULL OR view_count = 0)
        ORDER BY created_at DESC LIMIT 15
      ) p
    ),
    'high_view_low_convert', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(p.title_en, p.title_lo), 'value', p.view_count) ORDER BY p.view_count DESC, p.id), '[]'::jsonb)
      FROM (
        SELECT * FROM properties p
        WHERE p.workflow_status = 'active' AND COALESCE(p.view_count, 0) >= 20
          AND NOT EXISTS (SELECT 1 FROM leads_in_range l WHERE l.property_id = p.id)
        ORDER BY p.view_count DESC, p.id LIMIT 10
      ) p
    )
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION analytics_admin_insights(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics_admin_insights(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION analytics_admin_insights(date, date) TO authenticated;

COMMIT;
