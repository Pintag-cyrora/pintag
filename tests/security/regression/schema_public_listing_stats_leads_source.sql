-- ============================================================================
-- Minimal fixture for the public_listing_stats() leads-source regression
-- (supabase/migrations/20260926000000_public_listing_stats_leads_source.sql).
--
-- Recreates properties/unit_types/contacts/parties/lead_events/leads AS THEY
-- EXIST TODAY (i.e. the state right before this migration runs): the current
-- create_lead_from_event() trigger body (verbatim from 20260921000000_lead_
-- unit_attribution.sql) and the CURRENT, pre-fix public_listing_stats()
-- (verbatim from 20260817000000_security_audit_hardening.sql, which still
-- aggregates from lead_events) -- same trimmed-fixture convention already
-- used by schema_lead_unit_attribution.sql in this same directory. Applying
-- the migration on top of this is a genuine upgrade test, not a fresh
-- install.
-- ============================================================================

CREATE TABLE properties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_en    text,
  district_en text,
  status      text NOT NULL DEFAULT 'active',
  deleted_at  timestamptz,
  view_count  integer DEFAULT 0,
  views_week  integer DEFAULT 0
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
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid,
  agent_id    uuid,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  unit_type_id uuid REFERENCES unit_types(id) ON DELETE SET NULL,
  unit_id     uuid,
  event_type  text NOT NULL CHECK (event_type IN (
                'whatsapp_click','call_click','messenger_click',
                'telegram_click','line_click','contact_click'
              )),
  session_id  text,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  party_id           uuid REFERENCES parties(id) ON DELETE SET NULL,
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,
  lead_event_id      uuid REFERENCES lead_events(id) ON DELETE SET NULL,
  unit_type_id       uuid REFERENCES unit_types(id) ON DELETE SET NULL,
  unit_id            uuid,
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

-- The CURRENT trigger function body (20260921000000_lead_unit_attribution.sql,
-- verbatim) -- unconditional for any non-null listing_id, regardless of
-- event_type. This is the fact the migration under test's header comment
-- leans on: every lead_events row with a listing_id creates exactly one
-- leads row, so switching the aggregate's source table is a rename of the
-- population, not a behavior change, UNLESS a lead_events row is later
-- deleted (leads survive that -- ON DELETE SET NULL below) or a leads row
-- is inserted directly (no matching lead_events row at all) -- both
-- exercised by the regression assertions.
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

CREATE TRIGGER trg_lead_events_create_lead
  AFTER INSERT ON lead_events
  FOR EACH ROW EXECUTE FUNCTION create_lead_from_event();

-- The CURRENT, PRE-FIX public_listing_stats() (verbatim from
-- 20260817000000_security_audit_hardening.sql) -- still aggregates
-- lead_count/lead_week/lead_month from lead_events. This is the "before"
-- state the migration under test replaces.
CREATE OR REPLACE FUNCTION public_listing_stats(p_listing_id UUID)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_count  INTEGER := 0;
  v_lead_week   INTEGER := 0;
  v_lead_month  INTEGER := 0;
  v_view_count  INTEGER := 0;
  v_views_week  INTEGER := 0;
  v_is_top      BOOLEAN := FALSE;
  v_district    TEXT;
  v_visible     BOOLEAN := FALSE;
BEGIN
  SELECT TRUE, COALESCE(view_count, 0), COALESCE(views_week, 0), district_en
    INTO v_visible, v_view_count, v_views_week, v_district
  FROM properties
  WHERE id = p_listing_id
    AND status IN ('active', 'available')
    AND deleted_at IS NULL;

  IF NOT COALESCE(v_visible, FALSE) THEN
    RETURN json_build_object(
      'lead_count', 0, 'lead_week', 0, 'lead_month', 0,
      'view_count', 0, 'views_week', 0,
      'is_top_district', FALSE, 'district', NULL
    );
  END IF;

  SELECT
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::INTEGER
  INTO v_lead_count, v_lead_week, v_lead_month
  FROM lead_events
  WHERE listing_id = p_listing_id;

  IF v_district IS NOT NULL AND v_view_count > 0 THEN
    SELECT (p_listing_id = (
      SELECT id FROM properties
      WHERE district_en = v_district
        AND status = 'active'
        AND deleted_at IS NULL
      ORDER BY COALESCE(view_count, 0) DESC
      LIMIT 1
    )) INTO v_is_top;
  END IF;

  RETURN json_build_object(
    'lead_count',      v_lead_count,
    'lead_week',       v_lead_week,
    'lead_month',      v_lead_month,
    'view_count',      v_view_count,
    'views_week',      v_views_week,
    'is_top_district', COALESCE(v_is_top, FALSE),
    'district',        v_district
  );
END;
$$;
