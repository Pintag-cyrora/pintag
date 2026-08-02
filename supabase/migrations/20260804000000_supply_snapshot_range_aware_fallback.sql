-- point_in_time_supply_snapshot()'s legacy price_display fallback (added by
-- 20260731010000_supply_snapshot_prefers_structured_price.sql, for any row
-- not yet backfilled by 20260731000000_structured_pricing.sql) strips
-- price_display down to digits/dot before validating it as a number. That
-- strip does not distinguish a genuine single price ("$550,000") from a
-- price RANGE ("$280-300"): stripping the range's separator along with
-- every other non-digit character concatenates the two numbers into one
-- bogus value ("280-300" -> "280300"), which still matches the
-- '^[0-9]+(\.[0-9]+)?$' numeric guard and gets folded into the median/avg
-- asking-price stats as if it were a real ~280K price.
--
-- Fix: detect a range in the RAW price_display text first (a digit, a
-- dash/en dash/"to", a digit) and exclude that row from price_text
-- entirely rather than guessing at one side of the range -- same
-- "exclude what can't be safely parsed" principle this function's own
-- comment already documents for genuinely non-numeric text, extended to
-- cover the ambiguous-range case the original guard missed. Everything
-- else (structured price_amount preference, grouping, percentile/avg
-- calculation, output shape) is unchanged.
CREATE OR REPLACE FUNCTION point_in_time_supply_snapshot()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH active AS (
    SELECT property_type, district_en, transaction_type, price_amount,
      CASE
        -- A dash-style range ("$280-300") or a "to"-style range ("$1,200 to
        -- $1,500") is detected against the RAW text, tolerating a currency
        -- symbol/whitespace between the separator and the second number
        -- (a naive '[0-9]\s*(-|to)\s*[0-9]' check misses "$1,200 to $1,500"
        -- because of the second '$' sitting between "to" and "1,500" --
        -- confirmed against a local Postgres replay before this migration
        -- was finalized).
        WHEN price_display ~ '[0-9][^0-9]{0,3}(-|–|—)[^0-9]{0,3}[0-9]'
          OR price_display ~ '[0-9][^0-9]{0,3}\sto\s[^0-9]{0,3}[0-9]'
        THEN NULL
        ELSE NULLIF(regexp_replace(coalesce(price_display, ''), '[^0-9.]', '', 'g'), '')
      END AS price_text
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
  'Current-state read (active inventory + asking price percentiles), not a time series. Prefers structured price_amount; falls back to a safe, range-aware regex-parse of legacy price_display for any row not yet backfilled -- a price range ("$280-300") is excluded from the fallback rather than guessed at, so it can never be concatenated into one bogus figure ("280300"). Only ever attached to the single most-recently-finalized daily_metrics_snapshot row -- see ensure_daily_metrics_snapshot().';
