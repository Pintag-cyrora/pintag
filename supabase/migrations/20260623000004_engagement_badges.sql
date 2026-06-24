-- Weekly view tracking for engagement badges (Hot Property, Popular)
ALTER TABLE properties ADD COLUMN IF NOT EXISTS views_week INTEGER DEFAULT 0;

-- Previous price column to enable Price Reduced badge in admin
ALTER TABLE properties ADD COLUMN IF NOT EXISTS price_previous TEXT;

-- Update increment_listing_view to also track weekly views
CREATE OR REPLACE FUNCTION increment_listing_view(p_listing_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE properties
  SET view_count = COALESCE(view_count, 0) + 1,
      views_week = COALESCE(views_week, 0) + 1
  WHERE id = p_listing_id
    AND status = 'active';
END;
$$;

-- Update public_listing_stats to expose views_week for FOMO signals
CREATE OR REPLACE FUNCTION public_listing_stats(p_listing_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_count  INTEGER := 0;
  v_lead_week   INTEGER := 0;
  v_lead_month  INTEGER := 0;
  v_view_count  INTEGER := 0;
  v_views_week  INTEGER := 0;
  v_is_top      BOOLEAN := FALSE;
  v_district    TEXT;
BEGIN
  SELECT
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::INTEGER
  INTO v_lead_count, v_lead_week, v_lead_month
  FROM lead_events
  WHERE listing_id = p_listing_id;

  SELECT COALESCE(view_count, 0), COALESCE(views_week, 0), district_en
  INTO v_view_count, v_views_week, v_district
  FROM properties
  WHERE id = p_listing_id;

  IF v_district IS NOT NULL AND v_view_count > 0 THEN
    SELECT (p_listing_id = (
      SELECT id FROM properties
      WHERE district_en = v_district
        AND status = 'active'
      ORDER BY COALESCE(view_count, 0) DESC
      LIMIT 1
    )) INTO v_is_top;
  END IF;

  RETURN json_build_object(
    'lead_count',      v_lead_count,
    'lead_week',       v_lead_week,
    'lead_month',      v_lead_month,
    'view_count',      v_view_count,
    'views_week',      v_views_week,
    'is_top_district', COALESCE(v_is_top, FALSE),
    'district',        v_district
  );
END;
$$;

-- Admin helper: reset weekly counters at start of each week
-- Run manually in Supabase SQL Editor: SELECT reset_weekly_views();
CREATE OR REPLACE FUNCTION reset_weekly_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE properties SET views_week = 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public_listing_stats(UUID)   TO anon;
GRANT EXECUTE ON FUNCTION public_listing_stats(UUID)   TO authenticated;
GRANT EXECUTE ON FUNCTION increment_listing_view(UUID) TO anon;
GRANT EXECUTE ON FUNCTION increment_listing_view(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION reset_weekly_views()         TO authenticated;
