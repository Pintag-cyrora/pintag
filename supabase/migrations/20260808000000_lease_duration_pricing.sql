-- Lease-duration pricing: optional tiered rental rates for longer commitments.
-- Some rentals quote a lower rate the longer the tenant commits, e.g.
--   1 month  $400/month   (the existing base rent — price_amount/price_frequency)
--   3 months $380/month
--   6 months $350/month
--   1 year   $320/month
--
-- Design (deliberately flat columns, mirroring 20260731000000_structured_pricing):
--   * The BASE 1-month/monthly price stays exactly where it is today
--     (properties.price_amount + price_frequency for a pure for_rent listing,
--     properties.rent_price_amount for a sale_or_rent listing). No new column
--     for it — single-price listings are 100% unchanged.
--   * Three OPTIONAL tier columns hold the 3-/6-/12-month rate. NULL = that
--     duration is not offered. All three NULL on an existing row = today's
--     single-price behavior, unchanged.
--   * ONE listing-level basis flag says how to read the tier amounts:
--       'monthly' (default) → each amount is a per-month rate at that term
--       'total'             → each amount is the total for the whole lease
--     A single flag per listing (not per tier) matches how landlords actually
--     quote — they don't mix "monthly for 6mo, total for 12mo".
--   * Currency is intentionally NOT duplicated per tier: a listing has one
--     rent currency (price_currency for for_rent, rent_price_currency for
--     sale_or_rent), and the tiers inherit it.
--
-- This is PRICING data, so it lives in flat relational columns like every
-- other price in the schema — NOT in the rental_terms JSONB (that blob is for
-- policy/config only; see rental-terms.js rule 9). Per-unit-type lease pricing
-- is intentionally out of scope here (building-level single price only).

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS lease_price_basis text,
  ADD COLUMN IF NOT EXISTS rent_price_3mo    numeric,
  ADD COLUMN IF NOT EXISTS rent_price_6mo    numeric,
  ADD COLUMN IF NOT EXISTS rent_price_12mo   numeric;

-- Allow only the two known bases (or NULL, meaning "no tiers / treat as
-- monthly"). NOT VALID would be fine too, but the table has no pre-existing
-- values for this column so a plain CHECK is safe.
ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_lease_price_basis_check;
ALTER TABLE properties
  ADD CONSTRAINT properties_lease_price_basis_check
  CHECK (lease_price_basis IS NULL OR lease_price_basis IN ('monthly', 'total'));

COMMENT ON COLUMN properties.lease_price_basis IS
  'How rent_price_3mo/6mo/12mo are quoted: monthly (per-month rate at that term) or total (whole-lease total). NULL = no lease-duration tiers.';
COMMENT ON COLUMN properties.rent_price_3mo IS
  'Optional 3-month lease rate (interpreted per lease_price_basis). NULL = not offered.';
COMMENT ON COLUMN properties.rent_price_6mo IS
  'Optional 6-month lease rate (interpreted per lease_price_basis). NULL = not offered.';
COMMENT ON COLUMN properties.rent_price_12mo IS
  'Optional 12-month (1-year) lease rate (interpreted per lease_price_basis). NULL = not offered.';
