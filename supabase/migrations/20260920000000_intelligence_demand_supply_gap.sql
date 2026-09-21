-- Intelligence: Demand -> Supply -> Gap. Adds the one piece
-- INTELLIGENCE_ARCHITECTURE.md's "BI Metrics: flow vs. stock" section and
-- demand-supply-detector.js's own header both name as still missing: a
-- SUPPLY read that actually answers "is this listing genuinely bookable
-- right now" and that is segmented by bedroom count, so the report can
-- compare bedroom-level DEMAND (customer_intent_segments' top_bedroom_count/
-- bedroom_sample_size, already computed) against real matching supply.
--
-- Extends point_in_time_supply_snapshot() ONLY, purely additively -- two new
-- keys inside the existing `active_inventory` object it returns. Every
-- existing key (`total`, `by_property_type`, `by_district`, `by_segment`,
-- `asking_price`) is untouched, byte-for-byte, so no already-tracked z-score
-- baseline (TRACKED_SCALAR_METRICS in insight-engine.js) or already-open
-- supply_shortage insight (demand-supply-detector.js, keyed off `by_segment`)
-- is perturbed by this migration. ensure_daily_metrics_snapshot() merges the
-- WHOLE `active_inventory` object wholesale (`v_supply -> 'active_inventory'`
-- -- see 20260918000000_intelligence_vientiane_calendar.sql), so adding a key
-- inside that object needs no change there at all, exactly as
-- 20260905000000_intelligence_customer_intent.sql's own header already
-- documents for this same reason.
--
-- WHY A NEW FILTER, NOT THE EXISTING `status IN ('active','available')` ONE.
-- Every existing supply read in this pipeline (`by_segment` above,
-- `by_type`/`by_district`, and index.ts's fetchCurrentSupply()) filters on
-- the legacy `status` column. Since 20260729000000_listing_status_model.sql,
-- that column is synced from workflow_status alone: ANY listing with
-- workflow_status='active' reads status='active', REGARDLESS of
-- market_status -- so a sold/rented/reserved/fully_occupied/off_market
-- listing is currently counted as "active supply" everywhere in this
-- pipeline. That is fine for the EXISTING fields (they answer "how much
-- inventory exists on the site", which is what they were built to answer),
-- but it is the wrong filter for a new field meant to answer "how much can
-- a customer actually book right now" -- exactly the question a demand/
-- supply GAP claim needs answered correctly, or it will systematically
-- undercount every gap. These two new keys therefore filter on
-- market_status = 'available' AND workflow_status = 'active' instead --
-- deliberately a different, narrower population than every other supply
-- field in this pipeline, which is why they get their own name
-- (`available_by_*`, not `active_*`) rather than reusing `by_segment`'s.
--
-- BEDROOM BUCKETING. properties.bedrooms is a plain integer column filled in
-- at the single-listing level; a multi-unit building's own bedrooms is
-- frequently null (its real per-unit-type bed counts live on unit_types,
-- which this function -- like every other supply read in this pipeline --
-- does not join against). A null-bedrooms property is simply excluded from
-- `available_by_bedroom_segment`, the same "undercount rather than guess"
-- discipline `by_segment` already applies to a null transaction_type/
-- property_type/district. This is a disclosed, accepted scope limit, not a
-- bug: it means bedroom-segmented supply is a floor, never an overcount.
-- Bucketed 0/1/2/3/'4+' (never a bare integer) so report-composer.js can
-- match it directly against a demand segment's top_bedroom_count (itself an
-- integer 0-N) by formatting the same way, and so a 5-bedroom villa and a
-- 9-bedroom mansion don't fragment an already-thin sample into noise.

CREATE OR REPLACE FUNCTION point_in_time_supply_snapshot()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH active AS (
    SELECT property_type, district_en, transaction_type,
      NULLIF(regexp_replace(coalesce(price_display, ''), '[^0-9.]', '', 'g'), '') AS price_text
    FROM properties
    WHERE status IN ('active', 'available')
  ),
  by_type AS (
    SELECT jsonb_object_agg(property_type, cnt) AS obj FROM (
      SELECT property_type, count(*) AS cnt FROM active WHERE property_type IS NOT NULL GROUP BY property_type
    ) x
  ),
  by_district AS (
    SELECT jsonb_object_agg(district_en, cnt) AS obj FROM (
      SELECT district_en, count(*) AS cnt FROM active WHERE district_en IS NOT NULL GROUP BY district_en
    ) x
  ),
  by_segment AS (
    SELECT jsonb_object_agg(seg_key, cnt) AS obj FROM (
      SELECT transaction_type || '|' || property_type || '|' || district_en AS seg_key, count(*) AS cnt
      FROM active
      WHERE transaction_type IS NOT NULL AND property_type IS NOT NULL AND district_en IS NOT NULL
      GROUP BY 1
    ) x
  ),
  priced AS (
    SELECT transaction_type, price_text::numeric AS price
    FROM active
    WHERE price_text IS NOT NULL
      AND price_text ~ '^[0-9]+(\.[0-9]+)?$'
      AND transaction_type IN ('for_sale', 'for_rent')
  ),
  price_stats AS (
    SELECT transaction_type,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median,
      avg(price) AS avg,
      count(*) AS n
    FROM priced GROUP BY transaction_type
  ),
  -- Genuinely bookable inventory: market_status='available' (never
  -- reserved/rented/sold/fully_occupied/off_market/coming_soon) AND
  -- workflow_status='active' (never draft/archived) -- see this file's
  -- header for why this differs from `active` above.
  available AS (
    SELECT property_type, district_en, transaction_type, bedrooms
    FROM properties
    WHERE market_status = 'available' AND workflow_status = 'active'
  ),
  available_by_segment AS (
    SELECT jsonb_object_agg(seg_key, cnt) AS obj FROM (
      SELECT transaction_type || '|' || property_type || '|' || district_en AS seg_key, count(*) AS cnt
      FROM available
      WHERE transaction_type IS NOT NULL AND property_type IS NOT NULL AND district_en IS NOT NULL
      GROUP BY 1
    ) x
  ),
  bedroom_bucketed AS (
    SELECT transaction_type, district_en,
      CASE WHEN bedrooms >= 4 THEN '4+' ELSE bedrooms::text END AS bedroom_bucket
    FROM available
    WHERE bedrooms IS NOT NULL AND bedrooms >= 0
      AND transaction_type IS NOT NULL AND district_en IS NOT NULL
  ),
  available_by_bedroom_segment AS (
    SELECT jsonb_object_agg(seg_key, cnt) AS obj FROM (
      SELECT transaction_type || '|' || district_en || '|' || bedroom_bucket AS seg_key, count(*) AS cnt
      FROM bedroom_bucketed
      GROUP BY 1
    ) x
  )
  SELECT jsonb_build_object(
    'active_inventory', jsonb_build_object(
      'total', (SELECT count(*) FROM active),
      'by_property_type', coalesce((SELECT obj FROM by_type), '{}'::jsonb),
      'by_district', coalesce((SELECT obj FROM by_district), '{}'::jsonb),
      'by_segment', coalesce((SELECT obj FROM by_segment), '{}'::jsonb),
      'available_by_segment', coalesce((SELECT obj FROM available_by_segment), '{}'::jsonb),
      'available_by_bedroom_segment', coalesce((SELECT obj FROM available_by_bedroom_segment), '{}'::jsonb)
    ),
    'asking_price', coalesce((
      SELECT jsonb_object_agg(transaction_type, jsonb_build_object(
        'median', round(median::numeric, 0), 'avg', round(avg::numeric, 0), 'count', n
      ))
      FROM price_stats
    ), '{}'::jsonb)
  );
$$;

COMMENT ON FUNCTION point_in_time_supply_snapshot IS
  'Current-state read (active inventory + asking price percentiles + per-segment inventory), not a time series. Only ever attached to the single most-recently-finalized daily_metrics_snapshot row -- see ensure_daily_metrics_snapshot(). available_by_segment/available_by_bedroom_segment additionally filter on market_status=''available'' AND workflow_status=''active'' (genuinely bookable right now), a narrower and different population than by_segment/by_type/by_district (which follow legacy status IN (''active'',''available'') and so include sold/rented/reserved/fully_occupied/off_market listings) -- see this migration''s header for why.';
