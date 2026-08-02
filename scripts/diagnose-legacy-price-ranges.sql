-- diagnose-legacy-price-ranges.sql — READ-ONLY diagnostic. Does not modify
-- any data. Run this first; review the output; only then consider
-- generate-legacy-price-range-repairs.sql (a separate, also read-only,
-- file that prints candidate UPDATE statements for a human to review and
-- run themselves -- nothing in this pair of scripts ever writes to the
-- database on its own).
--
-- Background: 20260731000000_structured_pricing.sql's one-time backfill
-- populated price_amount/rent_price_amount from legacy free-text columns
-- (price_display/sale_price/rent_price, and the unit_types equivalents) by
-- stripping every non-digit character and casting the remainder to
-- numeric. That strip does not distinguish a genuine single price
-- ("$550,000") from a price RANGE ("$280-300"): the separator gets
-- stripped along with everything else, concatenating the two numbers into
-- one bogus value ("280-300" -> "280300"). Every reader now trusts
-- price_amount as the structured source of truth, so a corrupted row
-- silently displays as a confident, wrong number everywhere (the "$280,300"
-- bug fixed in components.js/currency.js this session). This script finds
-- every row where that's likely to have happened, across every column the
-- same backfill touched.
--
-- Usage:
--   psql "<connection string>" -f scripts/diagnose-legacy-price-ranges.sql
--
-- ============================================================================
-- How a row is classified
-- ============================================================================
-- A row only enters this report at all if its legacy free-text column
-- contains a genuine range pattern (two numbers joined by a dash/en dash/em
-- dash, or by the word "to") -- a real single price like "$280,300" (no
-- separator between two numbers) never matches this pattern and is never
-- touched or even listed. This is the structural protection against ever
-- flagging a genuine high-value listing: the diagnostic has no opinion
-- about whether a number is "too big," only about whether the ORIGINAL
-- TEXT actually described a range.
--
--   HIGH   -- current_amount is EXACTLY what you get from gluing the
--             range's two extracted numbers together as digit strings
--             ("280" + "300" = 280300). This is a reconstruction, not a
--             guess: it mathematically proves this specific row went
--             through the buggy parser and produced this specific number.
--             Only HIGH rows get a candidate UPDATE statement (in the
--             companion script).
--   MEDIUM -- the legacy text is a genuine range, and current_amount is
--             larger than the range's own upper bound (inconsistent with
--             a real price for something advertised at $X-$Y), but it does
--             NOT exactly match the glued reconstruction -- something else
--             is going on (extra digits elsewhere in the text, a decimal
--             edge case, etc.) that this script won't guess at.
--   (rows where current_amount already equals the recommended value, or
--   already sits inside/below the stated range, are excluded entirely --
--   nothing to review, most likely already correct.)
--
-- Every remaining ambiguous range-shaped row that isn't HIGH or excluded is
-- reported as LOW confidence for manual review -- never silently dropped,
-- never silently "fixed."
--
-- Recommended corrected value is always the range's LOWER bound, matching
-- the "starting from" convention this codebase already uses everywhere
-- else a price range collapses to one structured number (admin.html's
-- _utComputeRange(), currency.js's parseLegacyPriceAmount()).
-- ============================================================================

WITH sources AS (
  -- properties.price_amount <- properties.price_display (for_sale / for_rent, single price)
  SELECT
    p.id                                   AS property_id,
    p.id                                   AS row_id,
    'properties'                           AS source_table,
    'price_amount'                         AS source_column,
    coalesce(p.title_en, p.title_lo, '(untitled)') AS title,
    p.price_display                        AS legacy_text,
    p.price_amount                         AS current_amount,
    p.price_currency                       AS current_currency,
    p.price_frequency                      AS current_frequency
  FROM properties p
  WHERE p.price_amount IS NOT NULL AND p.price_display IS NOT NULL

  UNION ALL

  -- properties.price_amount <- properties.sale_price (sale_or_rent, sale leg)
  SELECT
    p.id, p.id, 'properties', 'price_amount (sale leg)',
    coalesce(p.title_en, p.title_lo, '(untitled)'),
    p.sale_price, p.price_amount, p.price_currency, p.price_frequency
  FROM properties p
  WHERE p.price_amount IS NOT NULL AND p.sale_price IS NOT NULL
    AND p.transaction_type = 'sale_or_rent'

  UNION ALL

  -- properties.rent_price_amount <- properties.rent_price (sale_or_rent, rent leg)
  SELECT
    p.id, p.id, 'properties', 'rent_price_amount',
    coalesce(p.title_en, p.title_lo, '(untitled)'),
    p.rent_price, p.rent_price_amount, p.rent_price_currency, p.rent_price_frequency
  FROM properties p
  WHERE p.rent_price_amount IS NOT NULL AND p.rent_price IS NOT NULL

  UNION ALL

  -- unit_types.price_amount <- unit_types.price_display
  SELECT
    ut.property_id, ut.id, 'unit_types', 'price_amount',
    coalesce(p.title_en, p.title_lo, '(untitled)') || ' — unit: ' || coalesce(ut.name_en, ut.id::text),
    ut.price_display, ut.price_amount, ut.price_currency, ut.price_frequency
  FROM unit_types ut JOIN properties p ON p.id = ut.property_id
  WHERE ut.price_amount IS NOT NULL AND ut.price_display IS NOT NULL

  UNION ALL

  -- unit_types.price_amount <- unit_types.sale_price
  SELECT
    ut.property_id, ut.id, 'unit_types', 'price_amount (sale leg)',
    coalesce(p.title_en, p.title_lo, '(untitled)') || ' — unit: ' || coalesce(ut.name_en, ut.id::text),
    ut.sale_price, ut.price_amount, ut.price_currency, ut.price_frequency
  FROM unit_types ut JOIN properties p ON p.id = ut.property_id
  WHERE ut.price_amount IS NOT NULL AND ut.sale_price IS NOT NULL

  UNION ALL

  -- unit_types.rent_price_amount <- unit_types.rent_price
  SELECT
    ut.property_id, ut.id, 'unit_types', 'rent_price_amount',
    coalesce(p.title_en, p.title_lo, '(untitled)') || ' — unit: ' || coalesce(ut.name_en, ut.id::text),
    ut.rent_price, ut.rent_price_amount, ut.rent_price_currency, ut.rent_price_frequency
  FROM unit_types ut JOIN properties p ON p.id = ut.property_id
  WHERE ut.rent_price_amount IS NOT NULL AND ut.rent_price IS NOT NULL
),
-- Only rows whose ORIGINAL TEXT genuinely looks like a range ever proceed
-- past this point -- this is the structural guard against ever flagging a
-- real single high-value price.
range_candidates AS (
  -- Two separate patterns (dash-style and word-"to"-style), not one
  -- combined with lookaround -- combining them behind a single alternation
  -- with a lookaround for the "to" branch was tried and confirmed (via a
  -- local Postgres replay) to sometimes shift where the FIRST capture
  -- group starts matching, silently truncating the lower bound ("280-300"
  -- read back as "80,300"). Two independent, simple patterns is what
  -- actually reproduces the same numbers verified by hand.
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
scored AS (
  SELECT p.*,
    trunc(p.lower_bound) AS recommended_value,
    CASE
      WHEN p.lower_bound IS NULL OR p.upper_bound IS NULL
        OR p.lower_bound <= 0 OR p.lower_bound >= p.upper_bound
      THEN 'LOW'   -- pattern matched but the two numbers don't form a sane range -- don't guess
      WHEN p.current_amount::bigint =
           (trunc(p.lower_bound)::bigint::text || trunc(p.upper_bound)::bigint::text)::bigint
      THEN 'HIGH'  -- exact reconstruction of the known bug -- proven, not guessed
      WHEN p.current_amount > p.upper_bound
      THEN 'MEDIUM' -- bigger than the whole stated range, but not an exact reconstruction
      ELSE 'LOW'    -- already inside/below the stated range or otherwise unclear
    END AS confidence
  FROM parsed p
)
SELECT
  row_id                                                      AS record_id,
  property_id,
  source_table,
  source_column,
  title,
  legacy_text                                                 AS legacy_price_string,
  (CASE current_currency WHEN 'LAK' THEN '₭' WHEN 'THB' THEN '฿' ELSE '$' END)
    || to_char(current_amount, 'FM999,999,999,999,999,990')
    || coalesce(' / ' || current_frequency, '')                AS current_structured_price,
  current_amount                                               AS current_price_amount,
  recommended_value                                            AS recommended_corrected_value,
  confidence
FROM scored
-- Nothing to review when the current value is already the recommendation,
-- or already sits at/below the stated upper bound (plausibly fine, maybe
-- already hand-corrected) -- keep the report focused on rows that actually
-- need a human decision.
WHERE current_amount IS DISTINCT FROM recommended_value
  AND (upper_bound IS NULL OR current_amount > upper_bound OR confidence = 'HIGH')
ORDER BY
  CASE confidence WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
  source_table, record_id;
