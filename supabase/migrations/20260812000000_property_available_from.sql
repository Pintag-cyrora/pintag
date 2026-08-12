-- Per-listing "Available From" date.
--
-- Additive and backward-compatible: one nullable column. Complements — never
-- replaces — the unit-type-level unit_types.next_available_date (added in
-- 20260721010000_unit_availability.sql), which stays the source of truth for
-- listings modeled with unit types. This column gives PLAIN listings (a single
-- apartment/house/villa/townhouse with no unit_types rows) a place to record
-- when an unavailable rental frees up, so the listing page can show
-- "Available from {date}" for every rental property type, not just multi-unit
-- buildings.
--
-- NULL means "no date on file" — never fabricated or estimated (same rule as
-- market_status_changed_at). When NULL, the listing simply shows its price with
-- no availability date, which is a valid, expected state.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS available_from date;

COMMENT ON COLUMN properties.available_from IS
  'Optional per-listing date an unavailable rental becomes available again. Complements unit_types.next_available_date (which is per-unit-type); this covers plain listings with no unit_types. NULL = not set (never estimated). Surfaced on the listing page as "Available from {date}" only while the listing is not publicly available.';
