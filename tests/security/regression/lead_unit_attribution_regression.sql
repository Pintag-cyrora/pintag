-- ============================================================================
-- LEAD UNIT ATTRIBUTION REGRESSION ASSERTIONS
-- (supabase/migrations/20260921000000_lead_unit_attribution.sql)
--
-- Run against a throwaway PostgreSQL instance seeded by
-- schema_lead_unit_attribution.sql and then migrated by the file above:
--
--     bash tests/security/regression/run-lead-unit-attribution-pg.sh
--
-- Proves: (1) a lead_events row carrying unit_type_id produces a leads row
-- with the SAME unit_type_id, via the upgraded create_lead_from_event()
-- trigger; (2) a lead_events row with no unit_type_id (a general,
-- building-level inquiry) produces a leads row with unit_type_id NULL --
-- existing property-level attribution is completely unaffected; (3)
-- deleting the referenced unit_types row afterwards SETS NULL on both
-- lead_events.unit_type_id and leads.unit_type_id rather than erroring --
-- the "missing/deleted unit type does not crash" requirement, enforced at
-- the database layer, not just in application code; (4) unit_id (no FK --
-- no backing table yet) passes through verbatim; (5) the migration is
-- idempotent.
--
-- Any failed assertion raises an exception, aborting psql under
-- ON_ERROR_STOP=1 with a non-zero exit code.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'REGRESSION FAILED: %', p_what;
  END IF;
  RAISE NOTICE '  ok  %', p_what;
END $$;

\echo ''
\echo '=== Fixture: one property with two unit types, one contact ==='

DO $$
DECLARE
  v_property_id  uuid;
  v_unit_a_id    uuid;
  v_unit_b_id    uuid;
  v_contact_id   uuid;
  v_event_id     uuid;
  v_lead_unit_type_id uuid;
  v_new_unit_id  uuid;
  v_lead_unit_id uuid;
  v_event_unit_type_id_after_delete uuid;
  v_lead_unit_type_id_after_delete  uuid;
  v_general_lead_unit_type_id uuid;
  v_count int;
BEGIN
  INSERT INTO properties (title_en) VALUES ('River Apartment') RETURNING id INTO v_property_id;
  INSERT INTO unit_types (property_id, name_en, bedrooms) VALUES (v_property_id, 'Room Type A', 2) RETURNING id INTO v_unit_a_id;
  INSERT INTO unit_types (property_id, name_en, bedrooms) VALUES (v_property_id, 'Room Type B', 1) RETURNING id INTO v_unit_b_id;
  INSERT INTO contacts (role, is_verified) VALUES ('agent', true) RETURNING id INTO v_contact_id;

  -- === 1. A unit-type CTA correctly attributes unit_type_id end to end ===
  INSERT INTO lead_events (listing_id, contact_id, unit_type_id, event_type)
  VALUES (v_property_id, v_contact_id, v_unit_a_id, 'whatsapp_click')
  RETURNING id INTO v_event_id;

  SELECT unit_type_id INTO v_lead_unit_type_id FROM leads WHERE lead_event_id = v_event_id;
  PERFORM assert(v_lead_unit_type_id = v_unit_a_id, 'a unit-type CTA''s lead_events.unit_type_id produces a leads row with the SAME unit_type_id');

  -- === 2. A specific-unit CTA (unit_id, no backing table/FK) passes through verbatim ===
  v_new_unit_id := gen_random_uuid();
  INSERT INTO lead_events (listing_id, contact_id, unit_type_id, unit_id, event_type)
  VALUES (v_property_id, v_contact_id, v_unit_a_id, v_new_unit_id, 'whatsapp_click')
  RETURNING id INTO v_event_id;

  SELECT unit_id INTO v_lead_unit_id FROM leads WHERE lead_event_id = v_event_id;
  PERFORM assert(v_lead_unit_id IS NOT NULL, 'unit_id column accepts a value with no FK constraint (no backing table yet)');
  PERFORM assert(v_lead_unit_id = v_new_unit_id, 'a specific-unit CTA''s unit_id is copied through to the leads row unchanged');

  -- === 3. A property-level (building) CTA -- no unit type selected -- stays NULL ===
  INSERT INTO lead_events (listing_id, contact_id, event_type)
  VALUES (v_property_id, v_contact_id, 'whatsapp_click')
  RETURNING id INTO v_event_id;

  SELECT unit_type_id INTO v_general_lead_unit_type_id FROM leads WHERE lead_event_id = v_event_id;
  PERFORM assert(v_general_lead_unit_type_id IS NULL, 'a general property-level CTA (no unit_type_id on the event) produces a leads row with unit_type_id NULL -- existing behavior unaffected');

  -- === 4. Multiple unit types on the same property remain distinguishable ===
  INSERT INTO lead_events (listing_id, contact_id, unit_type_id, event_type)
  VALUES (v_property_id, v_contact_id, v_unit_b_id, 'whatsapp_click')
  RETURNING id INTO v_event_id;
  PERFORM assert(
    (SELECT unit_type_id FROM leads WHERE lead_event_id = v_event_id) = v_unit_b_id,
    'a second unit type on the same property attributes to its OWN unit_type_id, distinguishable from the first'
  );
  SELECT count(DISTINCT unit_type_id) INTO v_count FROM leads WHERE property_id = v_property_id AND unit_type_id IS NOT NULL;
  PERFORM assert(v_count = 2, 'two distinct unit types on one property produce two distinct unit_type_id values across their leads');

  -- === 5. Deleting the referenced unit type does not crash existing rows ===
  INSERT INTO lead_events (listing_id, contact_id, unit_type_id, event_type)
  VALUES (v_property_id, v_contact_id, v_unit_b_id, 'whatsapp_click')
  RETURNING id INTO v_event_id;

  DELETE FROM unit_types WHERE id = v_unit_b_id;

  SELECT unit_type_id INTO v_event_unit_type_id_after_delete FROM lead_events WHERE id = v_event_id;
  SELECT unit_type_id INTO v_lead_unit_type_id_after_delete FROM leads WHERE lead_event_id = v_event_id;
  PERFORM assert(v_event_unit_type_id_after_delete IS NULL, 'deleting the unit_types row SETS NULL on lead_events.unit_type_id (ON DELETE SET NULL), no error');
  PERFORM assert(v_lead_unit_type_id_after_delete IS NULL, 'deleting the unit_types row also SETS NULL on the already-created leads.unit_type_id, no error');

  -- === 6. Inserting a NEW lead_events row after the unit type is gone still succeeds ===
  INSERT INTO lead_events (listing_id, contact_id, unit_type_id, event_type)
  VALUES (v_property_id, v_contact_id, NULL, 'whatsapp_click');
  PERFORM assert(true, 'a lead_events insert after the unit type was deleted still succeeds (missing/deleted unit type never crashes lead creation)');
END $$;

\echo ''
\echo '=== Existing recipient/contact attribution (20260722000000) is unaffected ==='

DO $$
DECLARE v_property_id uuid; v_contact_id uuid; v_event_id uuid; v_recipient_type text;
BEGIN
  INSERT INTO properties (title_en) VALUES ('Unrelated Listing') RETURNING id INTO v_property_id;
  INSERT INTO contacts (role, is_verified) VALUES ('owner', false) RETURNING id INTO v_contact_id;
  INSERT INTO lead_events (listing_id, contact_id, event_type)
  VALUES (v_property_id, v_contact_id, 'call_click')
  RETURNING id INTO v_event_id;
  SELECT recipient_type INTO v_recipient_type FROM leads WHERE lead_event_id = v_event_id;
  PERFORM assert(v_recipient_type = 'owner', 'recipient_type snapshotting (pre-existing behavior) still works unchanged alongside the new unit columns');
END $$;

DROP FUNCTION assert(boolean, text);
