-- point_in_time_supply_snapshot() (20260725000000_intelligence_bi_metrics.sql)
-- computed its asking-price percentiles entirely from a live regex-parse of
-- properties.price_display. Now that price_amount/price_currency exist and
-- are the structured source of truth (20260731000000_structured_pricing.sql),
-- this redefines the function to prefer price_amount when present, falling
-- back to the original safe regex-parse of price_display only for a row
-- that hasn't been backfilled yet (should be rare after that migration
-- runs, but this keeps the function correct regardless of backfill timing).
--
-- The fallback branch keeps the exact same guard-before-cast pattern the
-- original function already used (validate the stripped text against
-- '^[0-9]+(\.[0-9]+)?$' before ever casting to numeric) -- this is the
-- proven-safe approach that structured_pricing.sql's own backfill was
-- missing and has now adopted too. Everything else (grouping, percentile/
-- avg calculation, output shape) is unchanged from the original.
CREATE OR REPLACE FUNCTION point_in_time_supply_snapshot()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH active AS (
    SELECT property_type, district_en, transaction_type, price_amount,
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
  priced AS (
    SELECT transaction_type,
      COALESCE(
        price_amount,
        CASE WHEN price_text ~ '^[0-9]+(\.[0-9]+)?$' THEN price_text::numeric END
      ) AS price
    FROM active
    WHERE transaction_type IN ('for_sale', 'for_rent')
      AND (price_amount IS NOT NULL OR price_text ~ '^[0-9]+(\.[0-9]+)?$')
  ),
  price_stats AS (
    SELECT transaction_type,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median,
      avg(price) AS avg,
      count(*) AS n
    FROM priced GROUP BY transaction_type
  )
  SELECT jsonb_build_object(
    'active_inventory', jsonb_build_object(
      'total', (SELECT count(*) FROM active),
      'by_property_type', coalesce((SELECT obj FROM by_type), '{}'::jsonb),
      'by_district', coalesce((SELECT obj FROM by_district), '{}'::jsonb)
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
  'Current-state read (active inventory + asking price percentiles), not a time series. Prefers structured price_amount; falls back to a safe regex-parse of legacy price_display for any row not yet backfilled. Only ever attached to the single most-recently-finalized daily_metrics_snapshot row -- see ensure_daily_metrics_snapshot().';
