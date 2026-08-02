-- generate-legacy-price-range-repairs.sql — READ-ONLY. Prints candidate
-- UPDATE statements for a human to review and run themselves; does not
-- execute anything. Run scripts/diagnose-legacy-price-ranges.sql FIRST and
-- read its output before this one -- this script only ever surfaces the
-- HIGH confidence subset of that same report (see that file's header for
-- the full explanation of what HIGH/MEDIUM/LOW mean and why). MEDIUM and
-- LOW rows never get a statement here, on purpose -- they stay in the
-- diagnostic report for a human to resolve by hand.
--
-- Usage:
--   psql "<connection string>" -f scripts/generate-legacy-price-range-repairs.sql
--   # Read every line of the output. For each one you've individually
--   # confirmed against the listing (ideally by also glancing at the
--   # source in admin.html), copy it into your own psql session and run
--   # it yourself, inside its own transaction:
--   #   BEGIN;
--   #   <paste one UPDATE statement>
--   #   SELECT id, price_display, price_amount FROM properties WHERE id = '...'; -- eyeball it
--   #   COMMIT;   -- or ROLLBACK if anything looks off
--   # Nothing in this repo runs these statements for you.
--
-- NOTE ON KEEPING THIS IN SYNC: the CTE chain below (sources /
-- range_candidates / parsed / scored) is intentionally duplicated from
-- diagnose-legacy-price-ranges.sql rather than shared via a view or
-- function, so each script stays a single self-contained file a DBA can
-- read and run in isolation (matching this repo's existing scripts/
-- convention). If the classification logic ever changes, change it in
-- BOTH files identically.

WITH sources AS (
  SELECT
    p.id AS property_id, p.id AS row_id, 'properties' AS source_table, 'price_amount' AS source_column,
    coalesce(p.title_en, p.title_lo, '(untitled)') AS title,
    p.price_display AS legacy_text, p.price_amount AS current_amount,
    p.price_currency AS current_currency, p.price_frequency AS current_frequency
  FROM properties p
  WHERE p.price_amount IS NOT NULL AND p.price_display IS NOT NULL

  UNION ALL

  SELECT p.id, p.id, 'properties', 'price_amount (sale leg)',
    coalesce(p.title_en, p.title_lo, '(untitled)'),
    p.sale_price, p.price_amount, p.price_currency, p.price_frequency
  FROM properties p
  WHERE p.price_amount IS NOT NULL AND p.sale_price IS NOT NULL
    AND p.transaction_type = 'sale_or_rent'

  UNION ALL

  SELECT p.id, p.id, 'properties', 'rent_price_amount',
    coalesce(p.title_en, p.title_lo, '(untitled)'),
    p.rent_price, p.rent_price_amount, p.rent_price_currency, p.rent_price_frequency
  FROM properties p
  WHERE p.rent_price_amount IS NOT NULL AND p.rent_price IS NOT NULL

  UNION ALL

  SELECT ut.property_id, ut.id, 'unit_types', 'price_amount',
    coalesce(p.title_en, p.title_lo, '(untitled)') || ' — unit: ' || coalesce(ut.name_en, ut.id::text),
    ut.price_display, ut.price_amount, ut.price_currency, ut.price_frequency
  FROM unit_types ut JOIN properties p ON p.id = ut.property_id
  WHERE ut.price_amount IS NOT NULL AND ut.price_display IS NOT NULL

  UNION ALL

  SELECT ut.property_id, ut.id, 'unit_types', 'price_amount (sale leg)',
    coalesce(p.title_en, p.title_lo, '(untitled)') || ' — unit: ' || coalesce(ut.name_en, ut.id::text),
    ut.sale_price, ut.price_amount, ut.price_currency, ut.price_frequency
  FROM unit_types ut JOIN properties p ON p.id = ut.property_id
  WHERE ut.price_amount IS NOT NULL AND ut.sale_price IS NOT NULL

  UNION ALL

  SELECT ut.property_id, ut.id, 'unit_types', 'rent_price_amount',
    coalesce(p.title_en, p.title_lo, '(untitled)') || ' — unit: ' || coalesce(ut.name_en, ut.id::text),
    ut.rent_price, ut.rent_price_amount, ut.rent_price_currency, ut.rent_price_frequency
  FROM unit_types ut JOIN properties p ON p.id = ut.property_id
  WHERE ut.rent_price_amount IS NOT NULL AND ut.rent_price IS NOT NULL
),
range_candidates AS (
  SELECT s.*,
    coalesce(
      (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[1],
      (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}\sto\s[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[1]
    ) AS lower_text,
    coalesce(
      (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[3],
      (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}\sto\s[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[2]
    ) AS upper_text
  FROM sources s
  WHERE s.legacy_text ~ '[0-9][^0-9]{0,3}(-|–|—)[^0-9]{0,3}[0-9]'
     OR s.legacy_text ~ '[0-9][^0-9]{0,3}\sto\s[^0-9]{0,3}[0-9]'
),
parsed AS (
  SELECT rc.*,
    NULLIF(replace(rc.lower_text, ',', ''), '')::numeric AS lower_bound,
    NULLIF(replace(rc.upper_text, ',', ''), '')::numeric AS upper_bound
  FROM range_candidates rc
),
high_confidence AS (
  SELECT p.*, trunc(p.lower_bound) AS recommended_value
  FROM parsed p
  WHERE p.lower_bound IS NOT NULL AND p.upper_bound IS NOT NULL
    AND p.lower_bound > 0 AND p.lower_bound < p.upper_bound
    -- The one and only criterion for HIGH: current_amount is EXACTLY the
    -- glued-together digit reconstruction of the range's own two numbers.
    -- Not "suspiciously large," not "probably wrong" -- mathematically
    -- reproduced from this exact row's own legacy text.
    AND p.current_amount::bigint =
        (trunc(p.lower_bound)::bigint::text || trunc(p.upper_bound)::bigint::text)::bigint
)
SELECT
  '-- ' || source_table || '.' || row_id || ' ("' || title || '") -- legacy: "' || legacy_text ||
    '", current ' ||
    (CASE current_currency WHEN 'LAK' THEN '₭' WHEN 'THB' THEN '฿' ELSE '$' END) ||
    to_char(current_amount, 'FM999,999,999,999,999,990') ||
    ' -> recommended ' ||
    (CASE current_currency WHEN 'LAK' THEN '₭' WHEN 'THB' THEN '฿' ELSE '$' END) ||
    to_char(recommended_value, 'FM999,999,999,999,999,990') || E'\n' ||
  'UPDATE ' || source_table ||
  ' SET ' ||
    (CASE
       WHEN source_column IN ('price_amount', 'price_amount (sale leg)') THEN 'price_amount'
       WHEN source_column = 'rent_price_amount' THEN 'rent_price_amount'
     END) ||
    ' = ' || recommended_value ||
  ' WHERE id = ''' || row_id || ''';' AS review_then_run_this_statement
FROM high_confidence
ORDER BY source_table, row_id;
