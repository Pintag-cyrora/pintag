-- Owner-controlled price qualifier: exact / starting price ("From") / explicit price range.
--
-- ADDITIVE ONLY. Every new column is nullable with no default, nothing is dropped or retyped, no row is written, and no backfill runs. A NULL
-- qualifier means "no owner intent recorded": every reader keeps today's behaviour (the exact price, or the "From" price that
-- components.js derives from differing unit-type prices -- PR #167). Idempotent: safe to apply twice.
--
-- THE FOUR COLUMN PAIRS (properties AND unit_types)
--   price_qualifier       / price_max_amount        qualifies price_amount        (the base price: the SALE leg of a sale_or_rent row,
--                                                    the rent price of a pure for_rent row -- see 20260731000000 / 20260808000000)
--   rent_price_qualifier  / rent_price_max_amount   qualifies rent_price_amount   (the RENT leg of a sale_or_rent row)
--   qualifier:  'exact' | 'from' | 'range'
--   max amount: only meaningful for 'range'; the upper bound. Currency and frequency are the leg's own price_currency/price_frequency
--               (rent_price_currency/rent_price_frequency), so a range can never mix currencies or frequencies.
--
-- RULES THE DATABASE ENFORCES (CHECK constraints; the application formatter is still defensive about legacy rows)
--   1. price_max_amount may only be set together with qualifier 'range'.
--   2. qualifier 'range' REQUIRES the leg's own amount (> 0) and a max amount strictly greater than it.
--      A range is never inferred from incomplete data: an incomplete range cannot be saved at all.
--   3. max amount, when present, must be > 0.
--   'exact' and 'from' need nothing else (the leg's amount is the price / the starting price).
--
-- INHERITANCE (documented here because unit_types already means "NULL = inherit the building" for price_amount):
--   a unit type's qualifier belongs to the unit's OWN price. A unit that has its own price_amount uses its own qualifier (NULL = no intent);
--   a unit that inherits the building's price_amount inherits the building's qualifier and max amount together with it (amount, max and qualifier
--   travel as one). An explicit unit-level qualifier therefore always overrides the property-level one for that unit. This is application
--   logic (formatPropertyPrice); nothing here enforces it.
--
-- NOT CHANGED: price_display / sale_price / rent_price (legacy text), RLS, grants (new columns inherit each table's existing column/table
-- privileges and policies), triggers, indexes, views, functions. The supply-snapshot / market functions read price_amount (the lower bound) and
-- are unaffected.
--
-- ROLLBACK: the columns can stay (harmless) or be dropped; no data depends on them until the owner form writes them.
-- ORDERING: apply this migration to production BEFORE deploying any code that selects these columns (PostgREST rejects an unknown column in a
-- select list).

-- ── properties ────────────────────────────────────────────────────────────
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS price_qualifier           text,
  ADD COLUMN IF NOT EXISTS price_max_amount          numeric,
  ADD COLUMN IF NOT EXISTS rent_price_qualifier      text,
  ADD COLUMN IF NOT EXISTS rent_price_max_amount     numeric;

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_price_qualifier_check;
ALTER TABLE properties ADD CONSTRAINT properties_price_qualifier_check
  CHECK (price_qualifier IS NULL OR price_qualifier IN ('exact', 'from', 'range'));
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_rent_price_qualifier_check;
ALTER TABLE properties ADD CONSTRAINT properties_rent_price_qualifier_check
  CHECK (rent_price_qualifier IS NULL OR rent_price_qualifier IN ('exact', 'from', 'range'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_price_range_shape_check;
ALTER TABLE properties ADD CONSTRAINT properties_price_range_shape_check CHECK (
  (price_max_amount IS NULL OR (coalesce(price_qualifier = 'range', false) AND price_max_amount > 0))
  AND (price_qualifier IS DISTINCT FROM 'range'
       OR (price_amount IS NOT NULL AND price_amount > 0 AND price_max_amount IS NOT NULL AND price_max_amount > price_amount)));
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_rent_price_range_shape_check;
ALTER TABLE properties ADD CONSTRAINT properties_rent_price_range_shape_check CHECK (
  (rent_price_max_amount IS NULL OR (coalesce(rent_price_qualifier = 'range', false) AND rent_price_max_amount > 0))
  AND (rent_price_qualifier IS DISTINCT FROM 'range'
       OR (rent_price_amount IS NOT NULL AND rent_price_amount > 0 AND rent_price_max_amount IS NOT NULL AND rent_price_max_amount > rent_price_amount)));

COMMENT ON COLUMN properties.price_qualifier IS
  'Owner intent for price_amount: exact | from (starting price) | range. NULL = no intent recorded (derived behaviour, unchanged). See 20261103000000_price_qualifier.sql.';
COMMENT ON COLUMN properties.price_max_amount IS
  'Upper bound of an explicit price range for price_amount (same currency and frequency). Only allowed with price_qualifier = range, and must exceed price_amount.';
COMMENT ON COLUMN properties.rent_price_qualifier IS
  'Owner intent for rent_price_amount (the rent leg of a sale_or_rent listing): exact | from | range. NULL = no intent recorded.';
COMMENT ON COLUMN properties.rent_price_max_amount IS
  'Upper bound of an explicit price range for rent_price_amount. Only allowed with rent_price_qualifier = range, and must exceed rent_price_amount.';

-- ── unit_types ────────────────────────────────────────────────────────────
ALTER TABLE unit_types
  ADD COLUMN IF NOT EXISTS price_qualifier           text,
  ADD COLUMN IF NOT EXISTS price_max_amount          numeric,
  ADD COLUMN IF NOT EXISTS rent_price_qualifier      text,
  ADD COLUMN IF NOT EXISTS rent_price_max_amount     numeric;

ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_price_qualifier_check;
ALTER TABLE unit_types ADD CONSTRAINT unit_types_price_qualifier_check
  CHECK (price_qualifier IS NULL OR price_qualifier IN ('exact', 'from', 'range'));
ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_rent_price_qualifier_check;
ALTER TABLE unit_types ADD CONSTRAINT unit_types_rent_price_qualifier_check
  CHECK (rent_price_qualifier IS NULL OR rent_price_qualifier IN ('exact', 'from', 'range'));

ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_price_range_shape_check;
ALTER TABLE unit_types ADD CONSTRAINT unit_types_price_range_shape_check CHECK (
  (price_max_amount IS NULL OR (coalesce(price_qualifier = 'range', false) AND price_max_amount > 0))
  AND (price_qualifier IS DISTINCT FROM 'range'
       OR (price_amount IS NOT NULL AND price_amount > 0 AND price_max_amount IS NOT NULL AND price_max_amount > price_amount)));
ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_rent_price_range_shape_check;
ALTER TABLE unit_types ADD CONSTRAINT unit_types_rent_price_range_shape_check CHECK (
  (rent_price_max_amount IS NULL OR (coalesce(rent_price_qualifier = 'range', false) AND rent_price_max_amount > 0))
  AND (rent_price_qualifier IS DISTINCT FROM 'range'
       OR (rent_price_amount IS NOT NULL AND rent_price_amount > 0 AND rent_price_max_amount IS NOT NULL AND rent_price_max_amount > rent_price_amount)));

COMMENT ON COLUMN unit_types.price_qualifier IS
  'Owner intent for this unit''s OWN price_amount: exact | from | range. NULL = no intent recorded. A unit that inherits the building price inherits the building qualifier with it. See 20261103000000_price_qualifier.sql.';
COMMENT ON COLUMN unit_types.price_max_amount IS
  'Upper bound of an explicit price range for this unit''s own price_amount. Only allowed with price_qualifier = range, and must exceed price_amount.';
COMMENT ON COLUMN unit_types.rent_price_qualifier IS
  'Owner intent for this unit''s rent_price_amount (rent leg of a sale_or_rent unit): exact | from | range. NULL = no intent recorded.';
COMMENT ON COLUMN unit_types.rent_price_max_amount IS
  'Upper bound of an explicit price range for this unit''s rent_price_amount. Only allowed with rent_price_qualifier = range, and must exceed rent_price_amount.';
