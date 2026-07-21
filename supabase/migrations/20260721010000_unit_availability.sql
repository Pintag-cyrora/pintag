-- Unit Availability: "Next Available Date" enhancement. Additive only.
--
-- Deliberately separate from Rental Terms (see unit-availability.js) --
-- occupancy state, not policy. Flat nullable columns, not JSONB, per the
-- JSONB scope boundary documented in the Rental Terms migration: this is
-- operational state (and will connect to lease data in a future phase),
-- not configuration/policy data.
--
-- is_available/available_count already exist (Phase 1, NOT NULL, always
-- per-unit-type, never inherited from the building). This migration adds
-- the fields needed for "Fully Occupied -- Available from 15 Aug 2026"
-- instead of a bare "Fully Occupied". See resolveUnitAvailability() in
-- unit-availability.js for the resolver that is the sole reader of these
-- columns.

ALTER TABLE unit_types ADD COLUMN total_units integer;
ALTER TABLE unit_types ADD COLUMN next_available_date date;
ALTER TABLE unit_types ADD COLUMN availability_note text;

ALTER TABLE unit_types ADD CONSTRAINT unit_types_available_within_total
  CHECK (total_units IS NULL OR available_count <= total_units);

COMMENT ON COLUMN unit_types.total_units IS
  'Optional. Total physical units of this type in the building. NULL means not yet tracked -- consumers must not assume it exists. Enables "3 of 12 available" style display and future inventory features once populated; paired with available_count.';
COMMENT ON COLUMN unit_types.next_available_date IS
  'Phase 1: manually entered by staff, used directly. Future inventory phase: an automatically computed date (from lease/move-out data) is preferred by default -- this column then acts as an explicit override, taking precedence over the computed value only when staff has actually set it (NULL = defer to computed). NULL today means "unknown". Never read this column directly outside unit-availability.js -- call resolveUnitAvailability(unitType, computedNextAvailableDate).';
COMMENT ON COLUMN unit_types.availability_note IS
  'Optional free-text note surfaced alongside (never in place of) the resolved availability status, e.g. "3 more units expected Q3 2026". Independent of Rental Terms.';
