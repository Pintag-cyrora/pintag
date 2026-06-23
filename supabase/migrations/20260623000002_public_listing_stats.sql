-- Public listing stats functions for social proof
-- Run in Supabase SQL Editor → Database → SQL Editor

-- Ensure view_count column exists on properties
ALTER TABLE properties ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0;

-- ── public_listing_stats ─────────────────────────────────────────────
-- Returns aggregated, anonymised stats safe to expose publicly.
-- SECURITY DEFINER: runs as the function owner (bypasses RLS on
-- lead_events/properties), but only returns aggregates — no raw rows.
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
  v_is_top      BOOLEAN := FALSE;
  v_district    TEXT;
BEGIN
  -- Aggregate lead counts (total / last 7 days / last 30 days)
  SELECT
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::INTEGER
  INTO v_lead_count, v_lead_week, v_lead_month
  FROM lead_events
  WHERE listing_id = p_listing_id;

  -- Get view count and district from properties
  SELECT COALESCE(view_count, 0), district_en
  INTO v_view_count, v_district
  FROM properties
  WHERE id = p_listing_id;

  -- Check if this is the most-viewed active listing in its district
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
    'is_top_district', COALESCE(v_is_top, FALSE),
    'district',        v_district
  );
END;
$$;

-- ── increment_listing_view ────────────────────────────────────────────
-- Safely increments view_count for active listings only.
CREATE OR REPLACE FUNCTION increment_listing_view(p_listing_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE properties
  SET view_count = COALESCE(view_count, 0) + 1
  WHERE id = p_listing_id
    AND status = 'active';
END;
$$;

-- Allow anon (public listing page visitors) to call both functions
GRANT EXECUTE ON FUNCTION public_listing_stats(UUID)    TO anon;
GRANT EXECUTE ON FUNCTION public_listing_stats(UUID)    TO authenticated;
GRANT EXECUTE ON FUNCTION increment_listing_view(UUID)  TO anon;
GRANT EXECUTE ON FUNCTION increment_listing_view(UUID)  TO authenticated;
