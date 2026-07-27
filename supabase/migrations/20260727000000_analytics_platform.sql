-- Full-site analytics platform: adds the one genuinely missing signal this
-- schema didn't have -- a row for every PAGE LOAD (not just a tracked
-- click/impression/search) -- plus a handful of staff-only aggregate RPCs
-- for the new analytics.html dashboard. Everything else the dashboard
-- needs (listings, search, leads) already exists in search_events/
-- listing_events/lead_events/leads/properties/parties and is read directly
-- from there; this file only adds what's actually missing.
--
-- Deliberately NOT captured here, and not faked: visitor country/city (no
-- IP geolocation exists anywhere in this stack -- every public page's CSP
-- connect-src is locked to https://*.supabase.co, and there is no
-- server-side request path today that could read geo headers; doing this
-- honestly needs a fetch-through Worker in front of every page, the same
-- pattern already used for OG previews in cloudflare-worker/, not a client-
-- side add-on here). See analytics.html's Location section for how this
-- gap is disclosed to the user rather than silently guessed at.

-- ─────────────────────────────────────────────────────────────────────────
-- page_views: one row per page load. session_id shares the same spine as
-- search_events/listing_events/lead_events/ui_events (session.js's
-- getOrCreateSessionId()) so it's joinable into the same funnel; visitor_id
-- is new -- the first PERSISTENT (localStorage, not sessionStorage) id
-- this codebase has ever recorded, which is what makes "unique visitors"
-- and "returning visitors" real numbers instead of just "sessions" (see
-- 20260725000000_intelligence_bi_metrics.sql's own comment explaining why
-- returning-visitor metrics were deliberately left out until this existed).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS page_views (
  id               bigserial PRIMARY KEY,
  session_id       text,
  visitor_id       text,
  page             text NOT NULL,
  referrer         text,
  -- Classified client-side at write time (see analytics-tracking.js's
  -- classifyReferrer()) into one of: direct, google, facebook, instagram,
  -- tiktok, whatsapp, referral. Stored pre-classified (not re-derived from
  -- raw referrer at query time) so the classification logic only has to
  -- live in one place and stays stable even if a future visit's raw
  -- referrer format changes.
  referrer_source  text,
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  lang             text,
  device_type      text,   -- mobile | tablet | desktop
  browser          text,
  os                text,
  viewport_width   integer,
  is_returning     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_views_created     ON page_views(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_session_id  ON page_views(session_id);
CREATE INDEX IF NOT EXISTS idx_page_views_visitor_id  ON page_views(visitor_id);
CREATE INDEX IF NOT EXISTS idx_page_views_page        ON page_views(page);

COMMENT ON TABLE page_views IS
  'One row per page load across the public site, written by analytics-tracking.js''s trackPageView(). This is the foundation for the site-overview/traffic/behavior/location sections of analytics.html -- distinct from search_events/listing_events/lead_events/ui_events, which only ever fired on specific interactions, never on every page load.';

ALTER TABLE page_views ENABLE ROW LEVEL SECURITY;

-- Same shape as check_ui_event_rate_limit -- generous enough for real
-- browsing (a page load per navigation), tight enough to block a flood.
CREATE OR REPLACE FUNCTION check_page_view_rate_limit(p_session_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_session_id IS NULL THEN RETURN true; END IF;
  RETURN (
    SELECT COUNT(*) FROM page_views
    WHERE session_id = p_session_id
      AND created_at > NOW() - INTERVAL '1 minute'
  ) < 60;
END;
$$;
GRANT EXECUTE ON FUNCTION check_page_view_rate_limit(text) TO anon;

DROP POLICY IF EXISTS "Allow anon page view inserts" ON page_views;
CREATE POLICY "Allow anon page view inserts"
  ON page_views FOR INSERT TO anon
  WITH CHECK (check_page_view_rate_limit(session_id));

DROP POLICY IF EXISTS "Staff read page_views" ON page_views;
CREATE POLICY "Staff read page_views"
  ON page_views FOR SELECT TO authenticated
  USING (is_pintag_staff(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────
-- Scroll depth: same mechanism the codebase already documented for itself
-- as the extensibility path (one more event_type value, no new table) --
-- see the "Future event types" note in this repo's own architecture
-- history for listing_events' impression/click addition. element_id here
-- carries the milestone bucket ('25'|'50'|'75'|'100'), page carries which
-- page, matching ui_events' existing shape exactly.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE ui_events DROP CONSTRAINT IF EXISTS ui_events_event_type_check;
ALTER TABLE ui_events ADD CONSTRAINT ui_events_event_type_check
  CHECK (event_type IN ('click', 'scroll'));

-- ─────────────────────────────────────────────────────────────────────────
-- Staff-only aggregate RPCs for analytics.html. Each is SECURITY DEFINER
-- (so it can read across page_views/search_events/listing_events/
-- lead_events/leads regardless of the per-table RLS scoping) but gates
-- itself internally with is_pintag_staff(auth.uid()) -- same pattern as
-- reset_weekly_views()'s admin-only RAISE EXCEPTION guard -- so a
-- SECURITY DEFINER function can never be used to bypass RLS from a
-- non-staff caller. p_end is exclusive (pass the day AFTER the last day
-- you want included), matching how analytics.html's date range picker
-- already has to handle its own end-of-day boundary in JS.
-- ─────────────────────────────────────────────────────────────────────────

-- Traffic trend: page views / sessions / unique+returning visitors, one row
-- per calendar day in range. The one genuinely new day-by-day rollup this
-- migration needs -- everything else the dashboard wants (listings, leads,
-- search) is cheap enough to aggregate directly from raw rows in JS,
-- matching admin.html's own established pattern (see loadAnalytics()).
CREATE OR REPLACE FUNCTION analytics_traffic_by_day(p_start date, p_end date)
RETURNS TABLE(day date, page_views bigint, sessions bigint, unique_visitors bigint, returning_visitors bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  RETURN QUERY
  SELECT d::date,
         COUNT(pv.id),
         COUNT(DISTINCT pv.session_id),
         COUNT(DISTINCT pv.visitor_id),
         COUNT(DISTINCT pv.visitor_id) FILTER (WHERE pv.is_returning)
  FROM generate_series(p_start, p_end - INTERVAL '1 day', INTERVAL '1 day') d
  LEFT JOIN page_views pv
    ON pv.created_at >= d AND pv.created_at < d + INTERVAL '1 day'
  GROUP BY d
  ORDER BY d;
END;
$$;
GRANT EXECUTE ON FUNCTION analytics_traffic_by_day(date, date) TO authenticated;

-- Session-level funnel: how many DISTINCT SESSIONS reached each stage in
-- range, not raw event counts -- a real conversion funnel answers "how
-- many visitors got this far," not "how many events fired." "closed" joins
-- leads back to the originating lead_events row (leads itself carries no
-- session_id -- see lead_event_id) so it can still be counted as a session
-- reaching the final stage.
CREATE OR REPLACE FUNCTION analytics_funnel(p_start date, p_end date)
RETURNS TABLE(stage text, sessions bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  RETURN QUERY
  WITH landed AS (
    SELECT DISTINCT session_id FROM page_views
    WHERE session_id IS NOT NULL AND created_at >= p_start AND created_at < p_end
  ), searched AS (
    SELECT DISTINCT session_id FROM search_events
    WHERE session_id IS NOT NULL AND created_at >= p_start AND created_at < p_end
  ), viewed AS (
    SELECT DISTINCT session_id FROM listing_events
    WHERE event_type = 'view' AND session_id IS NOT NULL AND created_at >= p_start AND created_at < p_end
  ), contacted AS (
    SELECT DISTINCT session_id FROM lead_events
    WHERE session_id IS NOT NULL AND created_at >= p_start AND created_at < p_end
  ), closed AS (
    SELECT DISTINCT le.session_id
    FROM leads l JOIN lead_events le ON le.id = l.lead_event_id
    WHERE l.status = 'closed' AND le.session_id IS NOT NULL
      AND l.updated_at >= p_start AND l.updated_at < p_end
  )
  SELECT 'landed', (SELECT COUNT(*) FROM landed)
  UNION ALL SELECT 'searched', (SELECT COUNT(*) FROM searched)
  UNION ALL SELECT 'viewed_listing', (SELECT COUNT(*) FROM viewed)
  UNION ALL SELECT 'contacted', (SELECT COUNT(*) FROM contacted)
  UNION ALL SELECT 'closed', (SELECT COUNT(*) FROM closed);
END;
$$;
GRANT EXECUTE ON FUNCTION analytics_funnel(date, date) TO authenticated;

-- Real-time snapshot: everything in the trailing p_minutes window (default
-- 5). Poll-based, refreshed client-side every ~20s (analytics.html) --
-- genuinely live data, just not push/websocket-delivered; the same
-- trade-off most GA-style "realtime" panels make under the hood.
CREATE OR REPLACE FUNCTION analytics_realtime_snapshot(p_minutes integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  SELECT jsonb_build_object(
    'active_visitors', (
      SELECT COUNT(DISTINCT session_id) FROM page_views
      WHERE created_at > now() - (p_minutes || ' minutes')::interval
    ),
    'pages_now', (
      SELECT COALESCE(jsonb_object_agg(page, cnt), '{}'::jsonb)
      FROM (
        SELECT page, COUNT(*) cnt FROM page_views
        WHERE created_at > now() - (p_minutes || ' minutes')::interval
        GROUP BY page ORDER BY cnt DESC LIMIT 10
      ) t
    ),
    'live_searches', (
      SELECT COUNT(*) FROM search_events
      WHERE created_at > now() - (p_minutes || ' minutes')::interval
    ),
    'live_listing_views', (
      SELECT COUNT(*) FROM listing_events
      WHERE event_type = 'view' AND created_at > now() - (p_minutes || ' minutes')::interval
    )
  ) INTO result;
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION analytics_realtime_snapshot(integer) TO authenticated;

-- Session-level overview stats (avg session duration, bounce rate, pages
-- per session) -- these need GROUP BY session_id to compute honestly, which
-- is naturally a SQL aggregation rather than pulling every raw page_views
-- row into the browser just to derive three numbers. bounce_rate = share
-- of sessions with exactly one page_view. duration is approximated as
-- last-page_view minus first-page_view per session (the same convention
-- analytics-inspector.html already uses for a single session -- a true
-- "time on last page" is unknowable without a page-unload beacon, which
-- this pass doesn't add).
CREATE OR REPLACE FUNCTION analytics_session_stats(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  WITH per_session AS (
    SELECT session_id, COUNT(*) AS views,
           EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) AS duration_seconds
    FROM page_views
    WHERE session_id IS NOT NULL AND created_at >= p_start AND created_at < p_end
    GROUP BY session_id
  ), totals AS (
    SELECT COUNT(*) AS page_views,
           COUNT(DISTINCT visitor_id) AS unique_visitors,
           COUNT(DISTINCT visitor_id) FILTER (WHERE is_returning) AS returning_visitors
    FROM page_views
    WHERE created_at >= p_start AND created_at < p_end
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
GRANT EXECUTE ON FUNCTION analytics_session_stats(date, date) TO authenticated;
