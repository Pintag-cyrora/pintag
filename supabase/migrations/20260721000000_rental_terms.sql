-- Rental Terms v2: building-level defaults + per-unit-type overrides for
-- deposit, utilities, service frequency, policies, and fees. Additive only.
--
-- Architecture (see rental-terms.js for the full contract):
--   properties.rental_terms              -- building defaults
--   unit_types.rental_terms_overrides    -- only the keys that differ
-- resolveRentalTerms(property, unitType) in rental-terms.js is the ONLY
-- public read API for these two columns. No other file may read them
-- directly -- see rental-terms.js's header comment for the full rule.
--
-- "version" inside each blob is a SERIALIZATION/SCHEMA version only -- it
-- describes the shape of the JSON, never a business concept (not a pricing
-- revision, not a policy revision, not a lease-term version). Do not repurpose it.
--
-- JSONB is used here deliberately for configuration/policy data (small,
-- human-edited, evolves by adding optional keys). This is not a precedent
-- for operational/transactional data (bookings, pricing history, calendars,
-- analytics) -- those stay flat and relational, matching every other table
-- in this schema.

ALTER TABLE properties ADD COLUMN rental_terms jsonb NOT NULL DEFAULT '{"version":1}'::jsonb;
ALTER TABLE unit_types ADD COLUMN rental_terms_overrides jsonb NOT NULL DEFAULT '{"version":1}'::jsonb;

COMMENT ON COLUMN properties.rental_terms IS
  'Building-level rental terms (deposit, utilities, services, fees). Keys are defined by RENTAL_TERMS_FIELDS in rental-terms.js -- that registry is the single source of truth for valid keys/types, not this column. "version" is a serialization/schema-version marker only, never a business concept. Never read this column directly -- call resolveRentalTerms(property, unitType).';
COMMENT ON COLUMN unit_types.rental_terms_overrides IS
  'Per-unit-type overrides. Only keys that differ from the building default are present -- absence of a key means inherit. "version" is a serialization/schema-version marker only. Never read this column directly -- call resolveRentalTerms(property, unitType).';
