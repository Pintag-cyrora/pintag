-- Share Strategy: "Keep Sharing About the Listing, Not the Contact" --
-- measures whether a shared link actually brings people INTO Pintag (a
-- landing view), whether they go on to enquire, and whether they share
-- again -- the "self-propagating discovery mechanism" success metrics.
--
-- No new table or column: every signal already exists.
--   - A shared link is tagged utm_source=pintag_share&utm_medium=share
--     (listing.html's getShareableListingUrl()) -- picked up for free by
--     analytics-tracking.js's captureUtm(), already stamped on every
--     page_views row with no code change needed here.
--   - page_views/listing_events/lead_events already share one join key,
--     session_id (session.js's getOrCreateSessionId()) -- the same spine
--     the Intelligence pivot's "one event stream" design established.
-- This migration only extends analytics_listing_engagement() (already
-- additively extended once for Share Rate, 20260802000000) with four more
-- keys computed from that existing chain.
--
-- Deliberately NOT called "click-through rate": Pintag never learns how
-- many people a share reached (WhatsApp/Messenger fan-out is invisible to
-- us), only how many share actions were taken (shares_total, already in
-- this RPC) and how many landing views carried the share tag
-- (shared_link_views). views_per_share is an honest amplification ratio of
-- two real counts, not a fabricated per-recipient CTR.
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
  ),
  shared_sessions AS (
    -- Distinct sessions whose FIRST landing on a listing page carried the
    -- share tag -- the "arrived via a shared link" cohort for this period.
    SELECT DISTINCT session_id FROM page_views
    WHERE page = 'listing.html' AND utm_source = 'pintag_share'
      AND session_id IS NOT NULL
      AND created_at >= p_start AND created_at < p_end
  ),
  shared_link_stats AS (
    SELECT
      (SELECT COUNT(*) FROM page_views
         WHERE page = 'listing.html' AND utm_source = 'pintag_share'
           AND created_at >= p_start AND created_at < p_end) AS shared_link_views,
      (SELECT COUNT(*) FROM lead_events
         WHERE session_id IN (SELECT session_id FROM shared_sessions)
           AND created_at >= p_start AND created_at < p_end) AS shared_link_leads,
      (SELECT COUNT(*) FROM listing_events
         WHERE event_type = 'share'
           AND session_id IN (SELECT session_id FROM shared_sessions)
           AND created_at >= p_start AND created_at < p_end) AS secondary_shares
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
