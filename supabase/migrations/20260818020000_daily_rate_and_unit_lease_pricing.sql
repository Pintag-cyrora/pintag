-- Rental pricing, phase 3: a Daily rate tier, and lease-term pricing moved
-- down to the unit type.
--
-- Builds directly on 20260808000000_lease_duration_pricing.sql, which added
-- building-level rent_price_3mo/6mo/12mo + lease_price_basis and explicitly
-- deferred two things:
--
--   "Per-unit-type lease pricing is intentionally out of scope here
--    (building-level single price only)."
--
-- and had no Daily tier at all. Both are what this migration adds. Nothing is
-- dropped, no column type changes, and every new column is nullable, so an
-- existing listing (building-level or multi-unit) behaves exactly as it does
-- today until someone types a number into one of the new fields.
--
-- ── The lease-term model (unchanged in shape, extended in reach) ───────────
--
--   daily     rent_price_daily   a per-DAY rate
--   monthly   the BASE price     properties/unit_types.price_amount for a pure
--                                for_rent row, rent_price_amount for the rent
--                                leg of a sale_or_rent row -- no new column,
--                                exactly as 20260808000000 established
--   3 months  rent_price_3mo     |
--   6 months  rent_price_6mo     |  read per lease_price_basis
--   1 year    rent_price_12mo    |
--
-- lease_price_basis ('monthly' | 'total') governs ONLY the 3/6/12-month tiers.
-- 'monthly' (the default, and the basis the product asks for: "3-month =
-- $420/month, 6-month = $400/month, 1-year = $350/month") means each amount is
-- the per-month rate a tenant pays when committing to that term.
--
-- rent_price_daily is DELIBERATELY outside that basis. A daily rate is per-day
-- by definition -- there is no coherent reading of "a daily rate quoted as a
-- whole-lease total", and letting the basis flag reach it would make $45 mean
-- either $45/day or $45 for an unspecified stay. Every reader must render it
-- as a per-day rate unconditionally; see LEASE_TERMS in lease-pricing.js,
-- which is the single source of truth for that rule on the application side.
--
-- ── Why unit-level columns rather than a JSONB blob ───────────────────────
-- This is PRICING (operational/transactional data), so it stays flat and
-- relational like every other price in this schema -- the same rule
-- 20260808000000 followed, and the explicit scope boundary rental-terms.js
-- documents in its rule 9 for properties.rental_terms. The Trash Fee shipped
-- alongside this work is policy/config data and therefore correctly goes in
-- the rental_terms JSONB instead, needing no column here at all.
--
-- ── Currency ──────────────────────────────────────────────────────────────
-- Still not duplicated per tier: a row has one rent currency (price_currency
-- for for_rent, rent_price_currency for sale_or_rent) and every tier inherits
-- it, exactly as the building-level tiers already do.

-- ── properties: the missing Daily tier ────────────────────────────────────
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS rent_price_daily numeric;

COMMENT ON COLUMN properties.rent_price_daily IS
  'Optional per-DAY rental rate. Always a per-day figure -- lease_price_basis governs rent_price_3mo/6mo/12mo only and must never be applied to this column. NULL = no daily rate offered.';

-- ── unit_types: the same five-term model, per unit ────────────────────────
-- NOTE the ONE deliberate departure from the usual null-means-inherit-the-
-- building contract (resolveUnitType(), terminology.js): lease tiers do NOT
-- inherit per column. A tier is a discount quoted against a SPECIFIC base
-- rent, so pairing a building tier ("3 months: $420/month", quoted against
-- the building's $450 base) with a different unit type's own base ($700 for
-- the 2BR) would publish a price no landlord ever agreed to. A unit type
-- therefore shows its OWN tiers or none at all; the building's tiers belong
-- to the building-level price only. resolveLeasePricing() (lease-pricing.js)
-- is the single implementation of that rule -- never read these columns
-- directly.
ALTER TABLE unit_types
  ADD COLUMN IF NOT EXISTS lease_price_basis text,
  ADD COLUMN IF NOT EXISTS rent_price_daily  numeric,
  ADD COLUMN IF NOT EXISTS rent_price_3mo    numeric,
  ADD COLUMN IF NOT EXISTS rent_price_6mo    numeric,
  ADD COLUMN IF NOT EXISTS rent_price_12mo   numeric;

ALTER TABLE unit_types
  DROP CONSTRAINT IF EXISTS unit_types_lease_price_basis_check;
ALTER TABLE unit_types
  ADD CONSTRAINT unit_types_lease_price_basis_check
  CHECK (lease_price_basis IS NULL OR lease_price_basis IN ('monthly', 'total'));

COMMENT ON COLUMN unit_types.lease_price_basis IS
  'How this unit type''s rent_price_3mo/6mo/12mo are quoted: monthly (per-month rate at that term) or total (whole-lease total). NULL = this unit type has no lease-duration tiers of its own. Basis is a quoting CONVENTION rather than a price, so a unit with tiers but no basis of its own reads the building''s basis; the amounts themselves never inherit. Mirrors properties.lease_price_basis exactly.';
COMMENT ON COLUMN unit_types.rent_price_daily IS
  'Optional per-DAY rate for this unit type. Always per-day; never reinterpreted by lease_price_basis. NULL = this unit type quotes no daily rate (it does NOT fall back to the building''s -- see this migration''s header on why lease tiers do not inherit per column).';
COMMENT ON COLUMN unit_types.rent_price_3mo IS
  'Optional 3-month lease rate for this unit type (interpreted per this row''s lease_price_basis, else the building''s). NULL = not offered at this unit level.';
COMMENT ON COLUMN unit_types.rent_price_6mo IS
  'Optional 6-month lease rate for this unit type (interpreted per this row''s lease_price_basis, else the building''s). NULL = not offered at this unit level.';
COMMENT ON COLUMN unit_types.rent_price_12mo IS
  'Optional 12-month (1-year) lease rate for this unit type (interpreted per this row''s lease_price_basis, else the building''s). NULL = not offered at this unit level.';
