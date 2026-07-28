-- Analytics performance fix: move every remaining client-side aggregation
-- in analytics.html into SQL, so the browser stops downloading raw event
-- rows (up to 20,000 per query, across 5 of the 8 tabs) just to compute a
-- handful of totals/breakdowns.
--
-- ============================================================================
-- WHY THIS WAS THE REAL BOTTLENECK, NOT THE 4 SEQUENTIAL admin.html QUERIES
-- ============================================================================
-- A prior pass parallelized 4 independent lookup queries in admin.html's
-- Analytics tab (Promise.all instead of sequential awaits) -- a real fix,
-- but a small one: 4 round trips became 1, saving maybe half a second. It
-- did nothing for analytics.html's Listings/Search/Behavior/Location/Admin
-- tabs, which each fetch up to 20,000 raw event rows (sometimes 2-3 such
-- fetches per tab, e.g. Behavior pulls up to 60,000 rows across three
-- queries) and aggregate them in JavaScript after the fact. That payload
-- size scales with TOTAL EVENTS EVER RECORDED IN THE RANGE, not with what
-- the page actually displays (a handful of stat cards and top-10 lists) --
-- so as the site accumulates real traffic, these tabs get slower and
-- eventually silently truncate at the 20,000-row cap, which is a
-- correctness bug on top of the performance one. Every function below
-- returns only the aggregated result the UI renders -- kilobytes, not
-- megabytes -- computed once, server-side, using indexes that already
-- exist on these tables.
--
-- Same conventions as 20260727000000_analytics_platform.sql's existing
-- RPCs: STABLE SECURITY DEFINER (so one function can join across
-- page_views/search_events/listing_events/lead_events/leads/properties/
-- parties regardless of per-table RLS scoping), gated internally with
-- is_pintag_staff(auth.uid()), p_end exclusive.

-- ── Traffic: source/referrer/UTM breakdown (was: page_views, limit 10000) ──
CREATE OR REPLACE FUNCTION analytics_traffic_sources(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  SELECT jsonb_build_object(
    'by_source', (
      SELECT COALESCE(jsonb_object_agg(COALESCE(referrer_source, 'direct'), cnt), '{}'::jsonb)
      FROM (
        SELECT referrer_source, COUNT(*) cnt FROM page_views
        WHERE created_at >= p_start AND created_at < p_end
        GROUP BY referrer_source
      ) t
    ),
    'top_referrers', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', host, 'value', cnt)), '[]'::jsonb)
      FROM (
        SELECT regexp_replace(regexp_replace(referrer, '^https?://(www\.)?', ''), '/.*$', '') AS host,
               COUNT(*) cnt
        FROM page_views
        WHERE created_at >= p_start AND created_at < p_end
          AND referrer IS NOT NULL AND referrer_source != 'direct'
        GROUP BY host ORDER BY cnt DESC LIMIT 10
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
        WHERE created_at >= p_start AND created_at < p_end AND utm_campaign IS NOT NULL
        GROUP BY utm_campaign, utm_source, utm_medium ORDER BY sessions DESC LIMIT 20
      ) t
    )
  ) INTO result;
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION analytics_traffic_sources(date, date) TO authenticated;

-- ── Listings: views/CTR/most-viewed (was: listing_events, limit 20000 + properties, limit 5000) ──
CREATE OR REPLACE FUNCTION analytics_listing_engagement(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  WITH per_property AS (
    SELECT property_id,
           COUNT(*) FILTER (WHERE event_type = 'view') AS views,
           COUNT(*) FILTER (WHERE event_type = 'impression') AS impressions,
           COUNT(*) FILTER (WHERE event_type = 'click') AS clicks,
           COUNT(*) FILTER (WHERE event_type = 'save') AS saves,
           COUNT(*) FILTER (WHERE event_type = 'share') AS shares
    FROM listing_events
    WHERE created_at >= p_start AND created_at < p_end AND property_id IS NOT NULL
    GROUP BY property_id
  )
  SELECT jsonb_build_object(
    'saves_total', COALESCE((SELECT SUM(saves) FROM per_property), 0),
    'shares_total', COALESCE((SELECT SUM(shares) FROM per_property), 0),
    'views_by_day', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d, 'views', cnt) ORDER BY d), '[]'::jsonb)
      FROM (
        SELECT created_at::date AS d, COUNT(*) cnt FROM listing_events
        WHERE event_type = 'view' AND created_at >= p_start AND created_at < p_end
        GROUP BY d
      ) t
    ),
    'most_viewed', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(p.title_en, p.title_lo, pp.property_id::text), 'value', pp.views) ORDER BY pp.views DESC), '[]'::jsonb)
      FROM (SELECT * FROM per_property WHERE views > 0 ORDER BY views DESC LIMIT 10) pp
      LEFT JOIN properties p ON p.id = pp.property_id
    ),
    'top_ctr', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(p.title_en, p.title_lo, pp.property_id::text), 'value', ROUND(100.0 * pp.clicks / NULLIF(pp.impressions,0), 1)) ORDER BY pp.clicks::float / NULLIF(pp.impressions,0) DESC), '[]'::jsonb)
      FROM (SELECT * FROM per_property WHERE impressions >= 5 ORDER BY clicks::float / NULLIF(impressions,0) DESC LIMIT 10) pp
      LEFT JOIN properties p ON p.id = pp.property_id
    )
  ) INTO result;
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION analytics_listing_engagement(date, date) TO authenticated;

-- ── Search: type/transaction/district breakdown (was: search_events, limit 20000) ──
CREATE OR REPLACE FUNCTION analytics_search_breakdown(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*) FROM search_events WHERE created_at >= p_start AND created_at < p_end),
    'zero_result', (SELECT COUNT(*) FROM search_events WHERE created_at >= p_start AND created_at < p_end AND result_count = 0),
    'by_type', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', property_type, 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (SELECT property_type, COUNT(*) cnt FROM search_events WHERE created_at >= p_start AND created_at < p_end AND property_type IS NOT NULL GROUP BY property_type) t
    ),
    'by_tx', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', transaction_type, 'value', cnt)), '[]'::jsonb)
      FROM (SELECT transaction_type, COUNT(*) cnt FROM search_events WHERE created_at >= p_start AND created_at < p_end AND transaction_type IS NOT NULL GROUP BY transaction_type) t
    ),
    'by_district', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', district, 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (SELECT district, COUNT(*) cnt FROM search_events WHERE created_at >= p_start AND created_at < p_end AND district IS NOT NULL GROUP BY district) t
    )
  ) INTO result;
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION analytics_search_breakdown(date, date) TO authenticated;

-- ── Behavior: entry/exit pages, time-on-page, scroll depth, top clicks
--    (was: page_views + ui_events(click) + ui_events(scroll), limit 20000 each = up to 60,000 rows) ──
CREATE OR REPLACE FUNCTION analytics_behavior(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  WITH ordered AS (
    SELECT session_id, page, created_at,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at) AS rn,
           COUNT(*) OVER (PARTITION BY session_id) AS session_len,
           LEAD(created_at) OVER (PARTITION BY session_id ORDER BY created_at) AS next_at
    FROM page_views
    WHERE session_id IS NOT NULL AND created_at >= p_start AND created_at < p_end
  )
  SELECT jsonb_build_object(
    'entry', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', page, 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (SELECT page, COUNT(*) cnt FROM ordered WHERE rn = 1 GROUP BY page ORDER BY cnt DESC LIMIT 8) t
    ),
    'exit', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', page, 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (SELECT page, COUNT(*) cnt FROM ordered WHERE rn = session_len GROUP BY page ORDER BY cnt DESC LIMIT 8) t
    ),
    'avg_duration', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', page, 'value', avg_secs) ORDER BY avg_secs DESC), '[]'::jsonb)
      FROM (
        SELECT page, ROUND(AVG(EXTRACT(EPOCH FROM (next_at - created_at)))) AS avg_secs
        FROM ordered
        WHERE next_at IS NOT NULL AND next_at >= created_at AND next_at < created_at + INTERVAL '1 hour'
        GROUP BY page ORDER BY avg_secs DESC LIMIT 8
      ) t
    ),
    'scroll', (
      SELECT COALESCE(jsonb_object_agg(element_id, cnt), '{}'::jsonb)
      FROM (
        SELECT element_id, COUNT(*) cnt FROM ui_events
        WHERE event_type = 'scroll' AND element_id IN ('25','50','75','100')
          AND created_at >= p_start AND created_at < p_end
        GROUP BY element_id
      ) t
    ),
    'top_clicks', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', k, 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (
        SELECT COALESCE(NULLIF(label,''), element_id) AS k, COUNT(*) cnt FROM ui_events
        WHERE event_type = 'click' AND created_at >= p_start AND created_at < p_end
        GROUP BY k ORDER BY cnt DESC LIMIT 10
      ) t
    )
  ) INTO result;
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION analytics_behavior(date, date) TO authenticated;

-- ── Location: device/browser/OS/language breakdown (was: page_views, limit 20000) ──
CREATE OR REPLACE FUNCTION analytics_location_breakdown(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  SELECT jsonb_build_object(
    'device', (SELECT COALESCE(jsonb_object_agg(device_type, cnt), '{}'::jsonb) FROM (SELECT device_type, COUNT(*) cnt FROM page_views WHERE created_at >= p_start AND created_at < p_end AND device_type IS NOT NULL GROUP BY device_type) t),
    'browser', (SELECT COALESCE(jsonb_object_agg(browser, cnt), '{}'::jsonb) FROM (SELECT browser, COUNT(*) cnt FROM page_views WHERE created_at >= p_start AND created_at < p_end AND browser IS NOT NULL GROUP BY browser) t),
    'os', (SELECT COALESCE(jsonb_object_agg(os, cnt), '{}'::jsonb) FROM (SELECT os, COUNT(*) cnt FROM page_views WHERE created_at >= p_start AND created_at < p_end AND os IS NOT NULL GROUP BY os) t),
    'lang', (SELECT COALESCE(jsonb_object_agg(lang, cnt), '{}'::jsonb) FROM (SELECT lang, COUNT(*) cnt FROM page_views WHERE created_at >= p_start AND created_at < p_end AND lang IS NOT NULL GROUP BY lang) t)
  ) INTO result;
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION analytics_location_breakdown(date, date) TO authenticated;

-- ── Leads: totals/by-listing/by-agent/by-day/by-source (was: leads limit
--    10000 + properties limit 5000 + parties limit 1000 + lead_events limit
--    10000, then a SECOND sequential fetch of up to 20000 more page_views
--    rows for first-touch attribution) ──
CREATE OR REPLACE FUNCTION analytics_leads_breakdown(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  WITH in_range AS (
    SELECT * FROM leads WHERE created_at >= p_start AND created_at < p_end
  ),
  -- First-touch attribution: each lead's originating session's earliest
  -- page_view.referrer_source, resolved via lead_event_id -> lead_events.
  -- session_id -> MIN(created_at) page_view in that session. A LATERAL
  -- join computes this per-lead server-side instead of pulling every
  -- candidate page_views row into the browser to do the same lookup in JS.
  first_touch AS (
    SELECT ir.id AS lead_id, pv.referrer_source
    FROM in_range ir
    LEFT JOIN lead_events le ON le.id = ir.lead_event_id
    LEFT JOIN LATERAL (
      SELECT referrer_source FROM page_views
      WHERE session_id = le.session_id
      ORDER BY created_at ASC LIMIT 1
    ) pv ON le.session_id IS NOT NULL
  )
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*) FROM in_range),
    'closed', (SELECT COUNT(*) FROM in_range WHERE status = 'closed'),
    'by_day', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d, 'value', cnt) ORDER BY d), '[]'::jsonb)
      FROM (SELECT created_at::date AS d, COUNT(*) cnt FROM in_range GROUP BY d) t
    ),
    'by_listing', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(p.title_en, p.title_lo, ir.property_id::text), 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (SELECT property_id, COUNT(*) cnt FROM in_range WHERE property_id IS NOT NULL GROUP BY property_id ORDER BY cnt DESC LIMIT 10) ir
      LEFT JOIN properties p ON p.id = ir.property_id
    ),
    'by_agent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(pt.name_en, 'Unassigned'), 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (SELECT party_id, COUNT(*) cnt FROM in_range WHERE party_id IS NOT NULL GROUP BY party_id ORDER BY cnt DESC LIMIT 10) ir
      LEFT JOIN parties pt ON pt.id = ir.party_id
    ),
    'by_source', (
      SELECT COALESCE(jsonb_object_agg(COALESCE(referrer_source, 'unknown'), cnt), '{}'::jsonb)
      FROM (SELECT referrer_source, COUNT(*) cnt FROM first_touch GROUP BY referrer_source) t
    ),
    -- Most-recent 50 leads for the browsable table -- a real page of rows,
    -- not the full range, matching what the UI actually renders.
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
GRANT EXECUTE ON FUNCTION analytics_leads_breakdown(date, date) TO authenticated;

-- ── Admin Insights: new listings, leads by agent/district/type, no-view
--    listings, high-view-low-convert (was: properties limit 5000 with NO
--    date filter at all -- the entire catalog, every column, on every load
--    -- plus leads limit 10000 + parties limit 1000 + listing_events limit
--    20000) ──
CREATE OR REPLACE FUNCTION analytics_admin_insights(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  WITH leads_in_range AS (
    SELECT * FROM leads WHERE created_at >= p_start AND created_at < p_end
  )
  SELECT jsonb_build_object(
    'new_listings', (SELECT COUNT(*) FROM properties WHERE created_at >= p_start AND created_at < p_end),
    'by_agent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(pt.name_en, 'Unassigned'), 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (SELECT party_id, COUNT(*) cnt FROM leads_in_range WHERE party_id IS NOT NULL GROUP BY party_id ORDER BY cnt DESC LIMIT 10) l
      LEFT JOIN parties pt ON pt.id = l.party_id
    ),
    'by_district', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', d, 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (
        SELECT p.district_en AS d, COUNT(*) cnt FROM leads_in_range l
        JOIN properties p ON p.id = l.property_id
        WHERE p.district_en IS NOT NULL GROUP BY p.district_en ORDER BY cnt DESC LIMIT 10
      ) t
    ),
    'by_type', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', d, 'value', cnt) ORDER BY cnt DESC), '[]'::jsonb)
      FROM (
        SELECT p.property_type AS d, COUNT(*) cnt FROM leads_in_range l
        JOIN properties p ON p.id = l.property_id
        WHERE p.property_type IS NOT NULL GROUP BY p.property_type ORDER BY cnt DESC
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
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', COALESCE(p.title_en, p.title_lo), 'value', p.view_count) ORDER BY p.view_count DESC), '[]'::jsonb)
      FROM (
        SELECT * FROM properties p
        WHERE p.workflow_status = 'active' AND COALESCE(p.view_count, 0) >= 20
          AND NOT EXISTS (SELECT 1 FROM leads_in_range l WHERE l.property_id = p.id)
        ORDER BY p.view_count DESC LIMIT 10
      ) p
    )
  ) INTO result;
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION analytics_admin_insights(date, date) TO authenticated;

-- Composite index supporting the Behavior tab's session-ordered window
-- functions (PARTITION BY session_id ORDER BY created_at) -- the existing
-- idx_page_views_session_id and idx_page_views_created indexes each help
-- half of that access pattern; this one lets Postgres satisfy the window
-- function's own ordering directly instead of a separate sort step.
CREATE INDEX IF NOT EXISTS idx_page_views_session_created ON page_views(session_id, created_at);
