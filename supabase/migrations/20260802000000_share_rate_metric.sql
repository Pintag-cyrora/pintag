-- Share UX Improvement: adds the "Share Rate = Shares / Listing Views"
-- metric requested alongside the redesigned Share button, so staff can
-- measure whether the more prominent Share affordance actually increases
-- organic distribution -- see analytics.js's Listing Engagement tab.
--
-- Pure function replace, no schema change: analytics_listing_engagement()
-- (20260730000000_analytics_rpc_aggregation.sql) already computes a
-- per-property `views`/`shares` pair in its per_property CTE and already
-- returns a site-wide shares_total; this adds the matching views_total and
-- the derived share_rate (a percentage, NULL -- not 0 or a divide-by-zero
-- error -- when there have been no views yet, so the UI never renders a
-- fabricated "0%" for a period with no traffic at all).
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
  ),
  totals AS (
    SELECT COALESCE(SUM(views), 0) AS views_total, COALESCE(SUM(shares), 0) AS shares_total
    FROM per_property
  )
  SELECT jsonb_build_object(
    'saves_total', COALESCE((SELECT SUM(saves) FROM per_property), 0),
    'shares_total', (SELECT shares_total FROM totals),
    'views_total', (SELECT views_total FROM totals),
    'share_rate', (
      SELECT CASE WHEN views_total > 0 THEN ROUND(100.0 * shares_total / views_total, 1) ELSE NULL END
      FROM totals
    ),
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
