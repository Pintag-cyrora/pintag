-- Lead Unit Attribution: threads unit_type_id (and a forward-compatible
-- unit_id) through the exact same chain contact_id was threaded through in
-- 20260722000000_leads_recipient_model.sql (lead_events -> leads via
-- create_lead_from_event()) -- same additive pattern, same trigger, no
-- parallel tracking system.
--
-- Root cause this fixes: a multi-unit building (unit_types.sql,
-- 20260720000000) lets a buyer inquire about a SPECIFIC unit type from its
-- own Inquire button, or from the page's main WhatsApp button after
-- selecting a unit card (listing.html's selectUnitType()/buildUnitWhats
-- AppMessage()). The prefilled WhatsApp TEXT already named that unit, but
-- ptContactClick()'s lead_events POST (components.js) only ever carried
-- listing_id/agent_id/contact_id -- the unit context was dropped the moment
-- the click was tracked, so the resulting lead/conversation could not be
-- traced back to which unit type the buyer meant once they edited or
-- deleted the prefilled text in WhatsApp.
--
-- unit_type_id is the canonical identifier (a real FK), never the
-- unit-type's display name -- resolveUnitType()/admin.html can rename a
-- unit type freely without invalidating any existing attribution.
--
-- unit_id has no backing table yet: Phase 1 of Multi-Unit Buildings
-- (20260720000000_unit_types.sql) models availability as a computed count
-- on unit_types (available_count), not as individual physical-unit rows.
-- The column is added now, nullable and with no FK, purely so the whole
-- attribution chain (event -> lead -> admin display) needs no further
-- migration when a future Phase 3 introduces a real `units` table --
-- exactly the same "reserved for later, real today" reasoning
-- unit_types.sql's own header comment already used for available_count.
-- Every caller in this codebase sends unit_id as null today; that is
-- correct, not a bug, until an individual-unit entity exists to reference.

-- ── lead_events: thread the unit context through ────────────────────────
ALTER TABLE lead_events
  ADD COLUMN IF NOT EXISTS unit_type_id uuid REFERENCES unit_types(id) ON DELETE SET NULL;
ALTER TABLE lead_events
  ADD COLUMN IF NOT EXISTS unit_id uuid;

COMMENT ON COLUMN lead_events.unit_type_id IS
  'The unit_types row the buyer actually inquired about (via a unit card''s own Inquire button, or the main CTA after selecting a unit) -- NULL for a general, building-level inquiry. Never the unit-type''s display name: renaming a unit type in admin.html never invalidates this attribution.';
COMMENT ON COLUMN lead_events.unit_id IS
  'Reserved for a future individual physical unit (Phase 3 of Multi-Unit Buildings -- see unit_types.sql). No backing table exists yet, so every caller sends NULL today; not an FK for the same reason.';

CREATE INDEX IF NOT EXISTS idx_lead_events_unit_type_id ON lead_events(unit_type_id);

-- ── leads: same columns, same snapshot-independent FK, for the CRM row ──
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS unit_type_id uuid REFERENCES unit_types(id) ON DELETE SET NULL;
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS unit_id uuid;

COMMENT ON COLUMN leads.unit_type_id IS
  'Copied from lead_events.unit_type_id at creation time by create_lead_from_event() -- see that column''s comment on lead_events.';
COMMENT ON COLUMN leads.unit_id IS
  'Copied from lead_events.unit_id at creation time -- see that column''s comment on lead_events. Always NULL today (no backing table yet).';

CREATE INDEX IF NOT EXISTS idx_leads_unit_type_id ON leads(unit_type_id);

-- ── Trigger: copy both columns through, exactly like contact_id ─────────
-- No historical backfill: unlike contact_id (which had party_id/agent as a
-- derivable fallback), there is no reliable signal in any pre-existing row
-- to infer which unit type a past inquiry meant -- leaving history NULL is
-- honest; guessing would fabricate attribution that was never actually
-- captured.
CREATE OR REPLACE FUNCTION create_lead_from_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_contact_role       text;
  v_contact_verified   boolean;
  v_party_verified     boolean;
  v_recipient_type     text;
  v_recipient_verified boolean;
BEGIN
  IF NEW.listing_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.contact_id IS NOT NULL THEN
    SELECT role, is_verified INTO v_contact_role, v_contact_verified
    FROM contacts WHERE id = NEW.contact_id;
  END IF;

  IF NEW.agent_id IS NOT NULL THEN
    SELECT is_verified INTO v_party_verified FROM parties WHERE id = NEW.agent_id;
  END IF;

  v_recipient_type := COALESCE(v_contact_role,
    CASE WHEN NEW.agent_id IS NOT NULL THEN 'agent' ELSE 'unknown' END);
  v_recipient_verified := COALESCE(v_contact_verified, v_party_verified);

  INSERT INTO leads (
    property_id, party_id, contact_id, lead_event_id,
    contact_method, recipient_type, recipient_verified,
    unit_type_id, unit_id
  )
  VALUES (
    NEW.listing_id, NEW.agent_id, NEW.contact_id, NEW.id,
    regexp_replace(NEW.event_type, '_click$', ''),
    v_recipient_type, v_recipient_verified,
    NEW.unit_type_id, NEW.unit_id
  );

  RETURN NEW;
END;
$$;

-- trg_lead_events_create_lead itself is untouched -- only the function body
-- changed, so no DROP/CREATE TRIGGER needed here (same note as
-- 20260722000000_leads_recipient_model.sql).
