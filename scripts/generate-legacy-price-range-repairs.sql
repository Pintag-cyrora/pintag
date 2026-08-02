-- generate-legacy-price-range-repairs.sql — READ-ONLY. Prints candidate
-- UPDATE statements for a human to review and run themselves; does not
-- execute anything. Run scripts/diagnose-legacy-price-ranges.sql FIRST and
-- read its output before this one -- this script only ever surfaces the
-- HIGH confidence subset of that same report (see that file's header for
-- the full explanation of what HIGH/MEDIUM/LOW mean and why). MEDIUM and
-- LOW rows never get a statement here, on purpose -- they stay in the
-- diagnostic report for a human to resolve by hand.
--
-- Every generated block is idempotent and concurrency-safe: the UPDATE is
-- guarded with "AND <column> = <value the diagnostic observed>", the same
-- compare-and-swap pattern any concurrent-safe write uses. If the record
-- was already fixed (by an earlier run of this same block) or legitimately
-- re-priced by staff between diagnosis and repair, the guard fails, the
-- UPDATE affects 0 rows, and nothing is overwritten -- running the exact
-- same block twice in a row is always safe, and running it days after the
-- diagnostic (when other data may have changed) never clobbers a value
-- that no longer matches what was diagnosed. A verification SELECT
-- immediately follows every UPDATE so the result is checkable without
-- trusting the UPDATE's own row-count message.
--
-- Usage:
--   psql "<connection string>" -f scripts/generate-legacy-price-range-repairs.sql
--   # Read every block. For each one you've individually confirmed against
--   # the listing (ideally by also glancing at the source in admin.html),
--   # copy the whole block -- UPDATE then its paired verification SELECT --
--   # into your own psql session and run it yourself, inside its own
--   # transaction:
--   #   BEGIN;
--   #   <paste one UPDATE ... AND <column> = <old value> statement>
--   #   -- "UPDATE 1" means it applied; "UPDATE 0" means the guard blocked
--   #   -- it because the row already changed -- re-run the diagnostic
--   #   -- instead of retrying, do not loosen the guard to force it through.
--   #   <paste its paired verification SELECT>  -- eyeball the result
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
),
-- Column names differ per leg (price_amount / rent_price_amount) and per
-- legacy source (price_display / sale_price / rent_price), but are
-- identical between the properties and unit_types tables -- one mapping
-- covers both.
column_mapped AS (
  SELECT h.*,
    (CASE
       WHEN source_column IN ('price_amount', 'price_amount (sale leg)') THEN 'price_amount'
       WHEN source_column = 'rent_price_amount' THEN 'rent_price_amount'
     END) AS numeric_column,
    (CASE
       WHEN source_column = 'price_amount' THEN 'price_display'
       WHEN source_column = 'price_amount (sale leg)' THEN 'sale_price'
       WHEN source_column = 'rent_price_amount' THEN 'rent_price'
     END) AS legacy_column,
    (CASE
       WHEN source_column IN ('price_amount', 'price_amount (sale leg)') THEN 'price_currency'
       WHEN source_column = 'rent_price_amount' THEN 'rent_price_currency'
     END) AS currency_column
  FROM high_confidence h
)
SELECT
  '-- ============================================================' || E'\n' ||
  '-- ' || source_table || '.' || row_id || ' ("' || title || '")' || E'\n' ||
  '-- legacy: "' || legacy_text || '", current ' ||
    (CASE current_currency WHEN 'LAK' THEN '₭' WHEN 'THB' THEN '฿' ELSE '$' END) ||
    to_char(current_amount, 'FM999,999,999,999,999,990') ||
    ' -> recommended ' ||
    (CASE current_currency WHEN 'LAK' THEN '₭' WHEN 'THB' THEN '฿' ELSE '$' END) ||
    to_char(recommended_value, 'FM999,999,999,999,999,990') || E'\n' ||
  -- Guard: the UPDATE only ever applies if numeric_column is STILL exactly
  -- the value the diagnostic observed. A row that already changed (already
  -- fixed, or legitimately re-priced by staff) fails the guard and this
  -- affects 0 rows -- idempotent and concurrency-safe by construction, not
  -- by convention.
  'UPDATE ' || source_table ||
  ' SET ' || numeric_column || ' = ' || recommended_value ||
  ' WHERE id = ''' || row_id || '''' ||
  '  AND ' || numeric_column || ' = ' || current_amount || ';' || E'\n' ||
  -- Verification: run right after the UPDATE, in the same transaction,
  -- before deciding to COMMIT. numeric_column = recommended_value means it
  -- applied; numeric_column still = current_amount means the guard blocked
  -- it (the record changed since the diagnostic ran -- re-diagnose, don't
  -- just retry).
  'SELECT id, ' || legacy_column || ' AS legacy_text, ' ||
    numeric_column || ', ' || currency_column ||
  ' FROM ' || source_table || ' WHERE id = ''' || row_id || ''';'
  AS review_then_run_this_block
FROM column_mapped
ORDER BY source_table, row_id;
