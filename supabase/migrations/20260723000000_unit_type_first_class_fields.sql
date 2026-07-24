-- Unit Types as first-class objects: adds the unit-level fields that have
-- no existing column anywhere (floor plan/virtual tour/video links,
-- furnishing, floor number, orientation). Additive only.
--
-- Everything else requested in this phase (Description, Features,
-- Amenities, Rental Terms incl. a new Lease Length/Pet Policy/Parking,
-- Deposit, Utilities, Availability, Images) already has a column/registry
-- entry from earlier phases -- see terminology.js/rental-terms.js for the
-- corresponding registry additions, which need no migration at all.
--
-- `furnished` deliberately has no CHECK constraint, matching
-- properties.furnished (validated client-side against FURNISHED_OPTIONS in
-- terminology.js, not at the DB layer) -- same convention, not a new one.
--
-- These columns describe a unit TYPE (a floor plan / product), never an
-- individual physical apartment -- see unit_types' own table comment and
-- the Phase 1 migration's note that a future `units` child table (Phase 3)
-- is what will track individual physical units (Room 203, Room 305, ...)
-- sharing one of these unit_types rows. Nothing added here should ever be
-- read as "this one specific apartment" -- e.g. floor_number is the floor
-- this unit type is typically found/listed on, not a single unit's address.

ALTER TABLE unit_types ADD COLUMN floor_plan_url   text;
ALTER TABLE unit_types ADD COLUMN virtual_tour_url text;
ALTER TABLE unit_types ADD COLUMN video_url        text;
ALTER TABLE unit_types ADD COLUMN furnished        text;
ALTER TABLE unit_types ADD COLUMN floor_number     integer;
ALTER TABLE unit_types ADD COLUMN orientation      text;

COMMENT ON COLUMN unit_types.floor_plan_url IS
  'Optional link to a floor plan image/PDF for this unit type. NULL = none provided. Never read directly outside resolveUnitType() (terminology.js).';
COMMENT ON COLUMN unit_types.virtual_tour_url IS
  'Optional link to a 3D/virtual tour for this unit type. NULL = none provided.';
COMMENT ON COLUMN unit_types.video_url IS
  'Optional link to a video walkthrough for this unit type. NULL = none provided.';
COMMENT ON COLUMN unit_types.furnished IS
  'Furnishing level for this unit type: fully | partially | unfurnished (see FURNISHED_OPTIONS, terminology.js). NULL inherits the building''s own properties.furnished value via resolveUnitType()''s pick() -- same inheritance convention as every other nullable unit_types column, not unit-only.';
COMMENT ON COLUMN unit_types.floor_number IS
  'The floor this unit type is typically found on (e.g. Studios are on floors 2-4). A unit-type-only concept -- properties has no equivalent column, so this never inherits from the building. Not the floor of any one physical apartment.';
COMMENT ON COLUMN unit_types.orientation IS
  'Facing/orientation for this unit type (see ORIENTATION_OPTIONS, terminology.js), e.g. river-facing, city-facing, courtyard-facing. Unit-type-only, no building-level equivalent.';
