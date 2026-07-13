-- Phase 2 of the property-type-specific dynamic forms feature (see
-- terminology.js). Additive only — no existing column is renamed, altered,
-- or dropped; every new column is nullable, so every existing row and every
-- non-Land listing is completely unaffected.
--
-- Two deliberately separate concepts, per product review:
--   land_category  — the land's current legal/primary categorization
--                     (residential, commercial, agricultural, industrial,
--                     mixed_use). What it legally/primarily IS today.
--   land_best_use  — buyer-facing development potential, multi-select
--                     (apartment_development, villa, warehouse, retail,
--                     resort, investment). What a buyer COULD do with it.
-- A lot categorized "residential" today can still be an excellent
-- Apartment Development opportunity — these answer different questions
-- and neither one substitutes for the other.
--
-- Do NOT wire these columns into terminology.js's PROPERTY_TYPE_FIELDS.land
-- until this migration has actually been applied to whichever database the
-- running code talks to. PostgREST rejects insert/update payloads that
-- reference unknown columns, so shipping code that references e.g.
-- land_category before the column exists would break saving every Land
-- listing.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS land_width_m       numeric,
  ADD COLUMN IF NOT EXISTS land_length_m      numeric,
  ADD COLUMN IF NOT EXISTS road_frontage_m    numeric,
  ADD COLUMN IF NOT EXISTS road_width_m       numeric,
  ADD COLUMN IF NOT EXISTS road_surface       text,
  ADD COLUMN IF NOT EXISTS land_category      text,
  ADD COLUMN IF NOT EXISTS land_shape         text,
  ADD COLUMN IF NOT EXISTS land_terrain       text,
  ADD COLUMN IF NOT EXISTS existing_structure text,
  ADD COLUMN IF NOT EXISTS land_best_use      jsonb;

-- Enum-style guardrails, matching the CHECK-constraint convention already
-- used for parties.type. A plain `CHECK (col IN (...))` already permits
-- NULL (Postgres treats a NULL comparison as satisfying the constraint),
-- so these don't block the "field not applicable to this listing" case.
-- DROP-then-ADD makes this safe to re-run against a database that already
-- has an older version of these constraints.
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_road_surface_check;
ALTER TABLE properties ADD CONSTRAINT properties_road_surface_check
  CHECK (road_surface IN ('asphalt','concrete','gravel','dirt'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_land_category_check;
ALTER TABLE properties ADD CONSTRAINT properties_land_category_check
  CHECK (land_category IN ('residential','commercial','agricultural','industrial','mixed_use'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_land_shape_check;
ALTER TABLE properties ADD CONSTRAINT properties_land_shape_check
  CHECK (land_shape IN ('rectangle','square','corner_lot','triangle','irregular'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_land_terrain_check;
ALTER TABLE properties ADD CONSTRAINT properties_land_terrain_check
  CHECK (land_terrain IN ('flat','slight_slope','hillside','filled','needs_filling'));

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_existing_structure_check;
ALTER TABLE properties ADD CONSTRAINT properties_existing_structure_check
  CHECK (existing_structure IN ('vacant_land','old_house','warehouse','commercial_building','farm_building'));

COMMENT ON COLUMN properties.land_width_m       IS 'Land width in meters (Land listings only).';
COMMENT ON COLUMN properties.land_length_m      IS 'Land length in meters (Land listings only).';
COMMENT ON COLUMN properties.road_frontage_m    IS 'Road frontage in meters (Land listings only).';
COMMENT ON COLUMN properties.road_width_m       IS 'Width of the adjoining road/access, in meters (Land listings only).';
COMMENT ON COLUMN properties.road_surface       IS 'asphalt | concrete | gravel | dirt (Land listings only).';
COMMENT ON COLUMN properties.land_category      IS 'The land''s current legal/primary categorization: residential | commercial | agricultural | industrial | mixed_use. Distinct from land_best_use, which is buyer-facing development potential.';
COMMENT ON COLUMN properties.land_shape         IS 'rectangle | square | corner_lot | triangle | irregular (Land listings only).';
COMMENT ON COLUMN properties.land_terrain       IS 'flat | slight_slope | hillside | filled | needs_filling (Land listings only).';
COMMENT ON COLUMN properties.existing_structure IS 'vacant_land | old_house | warehouse | commercial_building | farm_building (Land listings only).';
COMMENT ON COLUMN properties.land_best_use      IS 'Multi-select JSON array of buyer-facing development-potential keys (apartment_development, villa, warehouse, retail, resort, investment). Distinct from land_category, which is the land''s current legal/primary categorization.';
