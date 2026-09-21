-- ============================================================================
-- Minimal fixture for the Lead Unit Attribution regression
-- (supabase/migrations/20260921000000_lead_unit_attribution.sql).
--
-- Recreates lead_events/leads/unit_types/properties/contacts/parties AS THEY
-- EXIST TODAY (i.e. the state right before this migration runs, including
-- contact_id/session_id/recipient_type/recipient_verified from the earlier
-- 20260722000000_leads_recipient_model.sql migration, and the CURRENT
-- create_lead_from_event() trigger function body) -- not a full replica of
-- production's schema, same trimmed-fixture convention already used by
-- schema_intelligence_demand_supply_gap.sql in this same directory. Applying
-- the migration on top of this is a genuine upgrade test, not a fresh
-- install.
-- ============================================================================

CREATE TABLE properties (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_en text
);

CREATE TABLE unit_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name_en     text NOT NULL,
  bedrooms    integer
);

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role        text,
  is_verified boolean
);

CREATE TABLE parties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_verified boolean
);

CREATE TABLE lead_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid,
  agent_id   uuid,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
               'whatsapp_click','call_click','messenger_click',
               'telegram_click','line_click','contact_click'
             )),
  session_id text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  party_id           uuid,
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,
  lead_event_id      uuid REFERENCES lead_events(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'new',
  contact_method     text NOT NULL DEFAULT 'whatsapp' CHECK (contact_method IN
                       ('whatsapp','call','messenger','telegram','line','contact')),
  recipient_type     text,
  recipient_verified boolean,
  customer_name      text,
  customer_phone     text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- The pre-migration trigger function body (20260722000000_leads_recipient_
-- model.sql's version, verbatim) -- proves 20260921000000's CREATE OR
-- REPLACE is a real upgrade of existing logic, not a first definition.
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
    contact_method, recipient_type, recipient_verified
  )
  VALUES (
    NEW.listing_id, NEW.agent_id, NEW.contact_id, NEW.id,
    regexp_replace(NEW.event_type, '_click$', ''),
    v_recipient_type, v_recipient_verified
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lead_events_create_lead
  AFTER INSERT ON lead_events
  FOR EACH ROW EXECUTE FUNCTION create_lead_from_event();
