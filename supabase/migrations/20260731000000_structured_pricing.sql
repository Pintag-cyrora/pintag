-- Structured pricing model: properties.price_display/sale_price/rent_price/
-- rent_period have always been plain TEXT with zero validation (staff types
-- "$550,000" directly; nothing stops "Price on request" or a typo). This
-- adds real numeric/currency/frequency columns as the new source of truth
-- while keeping the legacy text columns as derived/display-only values,
-- backfilled from a best-effort parse of the existing data.
--
-- Design (see currency.js / budget-bands.js for the shared frontend
-- registries this schema is built to feed):
--   price_amount     numeric  -- the primary price. For for_sale/for_rent
--                                 listings this IS the listing's price. For
--                                 sale_or_rent listings this holds the SALE
--                                 leg specifically -- mirrors exactly how
--                                 price_display already worked before this
--                                 migration (admin.html's saveListing() has
--                                 always written the sale price into
--                                 price_display for sale_or_rent listings,
--                                 confirmed by reading that code directly).
--   price_currency   text     -- 'USD' | 'LAK' | 'THB', matches currency.js
--   price_frequency  text     -- 'one_time' for any sale; 'monthly' |
--                                 'yearly' | 'weekly' | 'daily' for a
--                                 rental cadence; 'negotiable' when neither
--                                 party has fixed one yet. Deliberately NOT
--                                 named rent_period/rent_frequency -- this
--                                 column applies to sale listings too
--                                 ('one_time'), matching the reality that
--                                 Pintag lists both sales and rentals under
--                                 one schema, not a rental-only concept.
--   rent_price_amount / rent_price_currency / rent_price_frequency
--                              -- the RENT leg, populated only for
--                                 sale_or_rent listings (mirrors the
--                                 existing rent_price/rent_period pair
--                                 exactly). A pure for_rent listing uses
--                                 price_amount/price_frequency directly and
--                                 leaves these null, same as today's
--                                 rent_price/rent_period being null for a
--                                 non-dual rental.
--
-- unit_types gets the identical six columns, preserving the existing
-- null-means-inherit-from-building resolution contract already implemented
-- by resolveUnitType() in terminology.js (a null unit_types.price_amount
-- must keep meaning "use the building's own price_amount" exactly as null
-- unit_types.price_display already does today).
--
-- Fully additive: no column is dropped, no existing column's type changes.
-- price_display/sale_price/rent_price/rent_period/price_previous remain
-- exactly as they are -- application code stops treating them as the
-- source of truth (that's a frontend change, tracked separately), but
-- nothing here breaks a reader that still uses them during rollout.

-- ── properties ───────────────────────────────────────────────────────────
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS price_amount     numeric,
  ADD COLUMN IF NOT EXISTS price_currency   text,
  ADD COLUMN IF NOT EXISTS price_frequency  text,
  ADD COLUMN IF NOT EXISTS rent_price_amount    numeric,
  ADD COLUMN IF NOT EXISTS rent_price_currency  text,
  ADD COLUMN IF NOT EXISTS rent_price_frequency text;

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_price_currency_check;
ALTER TABLE properties ADD CONSTRAINT properties_price_currency_check
  CHECK (price_currency IS NULL OR price_currency IN ('USD','LAK','THB'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_price_frequency_check;
ALTER TABLE properties ADD CONSTRAINT properties_price_frequency_check
  CHECK (price_frequency IS NULL OR price_frequency IN ('one_time','monthly','yearly','weekly','daily','negotiable'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_rent_price_currency_check;
ALTER TABLE properties ADD CONSTRAINT properties_rent_price_currency_check
  CHECK (rent_price_currency IS NULL OR rent_price_currency IN ('USD','LAK','THB'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_rent_price_frequency_check;
ALTER TABLE properties ADD CONSTRAINT properties_rent_price_frequency_check
  CHECK (rent_price_frequency IS NULL OR rent_price_frequency IN ('one_time','monthly','yearly','weekly','daily','negotiable'));

COMMENT ON COLUMN properties.price_amount IS
  'Structured price -- the source of truth for sorting/filtering/budget bands. For sale_or_rent listings this is the SALE leg (see rent_price_amount for the rent leg). Superseded price_display; that column is now derived/legacy display only. Never read price_display for anything except a fallback while old rows are unbackfilled.';
COMMENT ON COLUMN properties.price_currency IS 'USD | LAK | THB -- see currency.js, the single shared currency registry.';
COMMENT ON COLUMN properties.price_frequency IS
  'one_time (any sale) | monthly | yearly | weekly | daily (a rental cadence) | negotiable. Applies to both sale and rent listings -- not a rent-only concept, hence not named rent_period/rent_frequency.';
COMMENT ON COLUMN properties.rent_price_amount IS
  'The RENT leg for a sale_or_rent listing only. A pure for_rent listing uses price_amount/price_frequency directly and leaves this null -- mirrors how legacy rent_price was already null for non-dual rentals.';

-- ── unit_types: identical structured pair, same inheritance contract ───────
ALTER TABLE unit_types
  ADD COLUMN IF NOT EXISTS price_amount     numeric,
  ADD COLUMN IF NOT EXISTS price_currency   text,
  ADD COLUMN IF NOT EXISTS price_frequency  text,
  ADD COLUMN IF NOT EXISTS rent_price_amount    numeric,
  ADD COLUMN IF NOT EXISTS rent_price_currency  text,
  ADD COLUMN IF NOT EXISTS rent_price_frequency text;

ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_price_currency_check;
ALTER TABLE unit_types ADD CONSTRAINT unit_types_price_currency_check
  CHECK (price_currency IS NULL OR price_currency IN ('USD','LAK','THB'));

ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_price_frequency_check;
ALTER TABLE unit_types ADD CONSTRAINT unit_types_price_frequency_check
  CHECK (price_frequency IS NULL OR price_frequency IN ('one_time','monthly','yearly','weekly','daily','negotiable'));

ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_rent_price_currency_check;
ALTER TABLE unit_types ADD CONSTRAINT unit_types_rent_price_currency_check
  CHECK (rent_price_currency IS NULL OR rent_price_currency IN ('USD','LAK','THB'));

ALTER TABLE unit_types DROP CONSTRAINT IF EXISTS unit_types_rent_price_frequency_check;
ALTER TABLE unit_types ADD CONSTRAINT unit_types_rent_price_frequency_check
  CHECK (rent_price_frequency IS NULL OR rent_price_frequency IN ('one_time','monthly','yearly','weekly','daily','negotiable'));

COMMENT ON COLUMN unit_types.price_amount IS
  'Structured price override for this unit type. NULL means "inherit the building''s own price_amount" -- same null-means-inherit contract as every other unit_types column, implemented by resolveUnitType() in terminology.js. Never read directly; call resolveUnitType().';

-- ── Backfill (additive only; never touches a row with no parseable price) ──
-- Same regexp-strip-then-cast approach already proven in production by
-- point_in_time_supply_snapshot() (20260725000000_intelligence_bi_metrics.sql)
-- for exactly this data. Currency is sniffed from the raw text (₭/LAK -> LAK,
-- ฿/THB -> THB, otherwise USD -- matches listings.html's formatPriceBubble()
-- sniffing logic, the one existing place currency detection already happens
-- client-side). rent_period's existing 'month'/'year'/'day' vocabulary maps
-- directly onto the new frequency vocabulary; a rental with no rent_period
-- set defaults to 'monthly', the overwhelmingly common case in this market.

-- properties: for_sale / for_rent (single price_display, no dual pricing)
UPDATE properties SET
  price_amount = NULLIF(regexp_replace(price_display, '[^0-9.]', '', 'g'), '')::numeric,
  price_currency = CASE
    WHEN price_display ~* '₭|LAK' THEN 'LAK'
    WHEN price_display ~* '฿|THB' THEN 'THB'
    ELSE 'USD'
  END,
  price_frequency = CASE
    WHEN transaction_type = 'for_sale' THEN 'one_time'
    WHEN transaction_type = 'for_rent' THEN COALESCE(
      CASE rent_period WHEN 'month' THEN 'monthly' WHEN 'year' THEN 'yearly' WHEN 'day' THEN 'daily' END,
      'monthly'
    )
    ELSE NULL
  END
WHERE price_amount IS NULL
  AND price_display IS NOT NULL
  AND price_display ~ '[0-9]'
  AND transaction_type IN ('for_sale', 'for_rent');

-- properties: sale_or_rent (sale leg from sale_price, rent leg from rent_price)
UPDATE properties SET
  price_amount = NULLIF(regexp_replace(sale_price, '[^0-9.]', '', 'g'), '')::numeric,
  price_currency = CASE
    WHEN sale_price ~* '₭|LAK' THEN 'LAK'
    WHEN sale_price ~* '฿|THB' THEN 'THB'
    ELSE 'USD'
  END,
  price_frequency = 'one_time'
WHERE price_amount IS NULL
  AND transaction_type = 'sale_or_rent'
  AND sale_price IS NOT NULL
  AND sale_price ~ '[0-9]';

UPDATE properties SET
  rent_price_amount = NULLIF(regexp_replace(rent_price, '[^0-9.]', '', 'g'), '')::numeric,
  rent_price_currency = CASE
    WHEN rent_price ~* '₭|LAK' THEN 'LAK'
    WHEN rent_price ~* '฿|THB' THEN 'THB'
    ELSE 'USD'
  END,
  rent_price_frequency = COALESCE(
    CASE rent_period WHEN 'month' THEN 'monthly' WHEN 'year' THEN 'yearly' WHEN 'day' THEN 'daily' END,
    'monthly'
  )
WHERE rent_price_amount IS NULL
  AND transaction_type = 'sale_or_rent'
  AND rent_price IS NOT NULL
  AND rent_price ~ '[0-9]';

-- unit_types: same three passes, scoped through the parent property's
-- transaction_type (unit_types has no transaction_type of its own -- it
-- always belongs to one property and follows that property's transaction
-- type, same assumption resolveUnitType() already makes).
UPDATE unit_types ut SET
  price_amount = NULLIF(regexp_replace(ut.price_display, '[^0-9.]', '', 'g'), '')::numeric,
  price_currency = CASE
    WHEN ut.price_display ~* '₭|LAK' THEN 'LAK'
    WHEN ut.price_display ~* '฿|THB' THEN 'THB'
    ELSE 'USD'
  END,
  price_frequency = CASE
    WHEN p.transaction_type = 'for_sale' THEN 'one_time'
    WHEN p.transaction_type = 'for_rent' THEN COALESCE(
      CASE ut.rent_period WHEN 'month' THEN 'monthly' WHEN 'year' THEN 'yearly' WHEN 'day' THEN 'daily' END,
      'monthly'
    )
    ELSE NULL
  END
FROM properties p
WHERE ut.property_id = p.id
  AND ut.price_amount IS NULL
  AND ut.price_display IS NOT NULL
  AND ut.price_display ~ '[0-9]'
  AND p.transaction_type IN ('for_sale', 'for_rent');

UPDATE unit_types ut SET
  price_amount = NULLIF(regexp_replace(ut.sale_price, '[^0-9.]', '', 'g'), '')::numeric,
  price_currency = CASE
    WHEN ut.sale_price ~* '₭|LAK' THEN 'LAK'
    WHEN ut.sale_price ~* '฿|THB' THEN 'THB'
    ELSE 'USD'
  END,
  price_frequency = 'one_time'
FROM properties p
WHERE ut.property_id = p.id
  AND ut.price_amount IS NULL
  AND p.transaction_type = 'sale_or_rent'
  AND ut.sale_price IS NOT NULL
  AND ut.sale_price ~ '[0-9]';

UPDATE unit_types ut SET
  rent_price_amount = NULLIF(regexp_replace(ut.rent_price, '[^0-9.]', '', 'g'), '')::numeric,
  rent_price_currency = CASE
    WHEN ut.rent_price ~* '₭|LAK' THEN 'LAK'
    WHEN ut.rent_price ~* '฿|THB' THEN 'THB'
    ELSE 'USD'
  END,
  rent_price_frequency = COALESCE(
    CASE ut.rent_period WHEN 'month' THEN 'monthly' WHEN 'year' THEN 'yearly' WHEN 'day' THEN 'daily' END,
    'monthly'
  )
FROM properties p
WHERE ut.property_id = p.id
  AND ut.rent_price_amount IS NULL
  AND p.transaction_type = 'sale_or_rent'
  AND ut.rent_price IS NOT NULL
  AND ut.rent_price ~ '[0-9]';

CREATE INDEX IF NOT EXISTS idx_properties_price_amount ON properties(price_amount);
CREATE INDEX IF NOT EXISTS idx_properties_price_currency ON properties(price_currency);
