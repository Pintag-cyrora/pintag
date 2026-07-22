-- Multi-Unit Buildings, Phase 1: the schema foundation for buildings with
-- multiple unit variants (Studio / 1BR / 2BR / ...) managed under one
-- listing, instead of one duplicate `properties` row per variant. See the
-- Phase 1 design (unit_types section) for the full architecture; this
-- migration implements exactly that section.
--
-- Backward compatibility is by PRESENCE, not a flag: a `properties` row is
-- a multi-unit building purely because it has 1+ unit_types rows
-- (EXISTS (SELECT 1 FROM unit_types WHERE property_id = ...)). No column on
-- `properties` changes. Every existing consumer (search, the property
-- editor, the public API) that doesn't know unit_types exists keeps
-- working unchanged -- there is nothing for old code to trip over.
--
-- Column types for price_display/sale_price/rent_price below match the
-- CONFIRMED live types on `properties`, not an assumption: admin.html's
-- price inputs are plain type="text" fields (placeholder "$550,000") saved
-- via .value.trim() with zero numeric parsing (admin.html:1832-1839) -- a
-- numeric column would reject that payload outright, so these are `text`,
-- exactly like properties.price_display.

CREATE TABLE unit_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  sort_order    integer NOT NULL DEFAULT 0,  -- staff-controlled display order, drag-reordered in admin.html

  -- Identity: free text, not an enum -- "Studio"/"1 Bedroom" today,
  -- "Deluxe Corner Unit"/"Garden View" tomorrow, no schema change either way.
  name_en       text NOT NULL,
  name_lo       text,
  name_zh       text,

  -- Every field below is nullable. Null means "inherit the building's own
  -- value" -- see resolveUnitType() in terminology.js, the single resolver
  -- every consumer (admin preview, the Phase 2 listing-page variant
  -- switcher, Phase 2 search, future APIs, a future mobile app) must call
  -- rather than re-deriving this fallback logic itself.
  price_display text,
  sale_price    text,
  rent_price    text,
  rent_period   text CHECK (rent_period IN ('month','year','day')),
  bedrooms      integer,
  bathrooms     integer,
  sqm           numeric,
  floors        integer,
  description_en text, description_lo text, description_zh text,
  property_highlight_en text, property_highlight_lo text, property_highlight_zh text,
  features      jsonb,  -- same registry-key convention as properties.features
  amenities     jsonb,  -- same registry-key convention as properties.amenities
  images        text[], -- same plain-array convention as properties.images

  -- Availability -- Phase 1's complete model of "how many are open" (see
  -- the design's hierarchy section). Phase 3 adds a real `units` child
  -- table and makes this a computed value instead of a stored one, without
  -- changing what any Phase 1/2 consumer relies on.
  is_available    boolean NOT NULL DEFAULT true,
  available_count integer NOT NULL DEFAULT 1 CHECK (available_count >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE unit_types IS
  'One row per unit variant (Studio/1BR/2BR/...) within a multi-unit building. A properties row is a multi-unit building purely by having 1+ rows here -- no flag on properties. Every nullable column means "inherit the building''s own value"; see resolveUnitType() in terminology.js.';

CREATE INDEX idx_unit_types_property_id ON unit_types(property_id);

-- Defined here with CREATE OR REPLACE (same convention as
-- 20260705000100_contacts_table.sql) since this function's application
-- history is inconsistent across environments -- this migration doesn't
-- assume it already exists.
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_unit_types_updated_at
  BEFORE UPDATE ON unit_types
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE unit_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access unit_types"
  ON unit_types TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

-- Mirrors properties' own agent-scoped self-service grants exactly (same
-- owned_party_ids() join, through properties.managed_by_party_id) -- so a
-- future self-service Unit Types UI (add-property.html/edit-listing.html)
-- needs no RLS changes to work, even though Phase 1's UI is admin.html-only.
CREATE POLICY "Party manage own unit_types"
  ON unit_types TO authenticated
  USING (
    NOT is_pintag_staff(auth.uid())
    AND property_id IN (
      SELECT id FROM properties WHERE managed_by_party_id IN (SELECT owned_party_ids(auth.uid()))
    )
  )
  WITH CHECK (
    NOT is_pintag_staff(auth.uid())
    AND property_id IN (
      SELECT id FROM properties WHERE managed_by_party_id IN (SELECT owned_party_ids(auth.uid()))
    )
  );

-- Public read, gated the same way properties/contacts already are: only
-- unit types belonging to a currently-visible listing.
CREATE POLICY "Public read unit_types of active properties"
  ON unit_types FOR SELECT TO anon
  USING (property_id IN (SELECT id FROM properties WHERE status IN ('active','available')));
