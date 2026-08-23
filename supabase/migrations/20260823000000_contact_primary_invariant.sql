-- ============================================================================
-- properties.contact_id ALWAYS HAS A MATCHING PRIMARY property_contacts ROW
-- ============================================================================
-- THE BUG (traced against production, 2026-08-23):
--   Two active listings carried properties.contact_id with ZERO rows in
--   property_contacts. The public page still rendered a number only because
--   listing.html also requests the legacy contacts() embed and
--   resolveListingContacts() pushes it unconditionally -- language routing,
--   which reads property_contacts, silently degraded to "primary/any".
--
-- WHY THOSE ROWS EXIST:
--   properties.contact_id is NULLABLE (20260705000200 added it without NOT
--   NULL; its own header called that "eventually NOT NULL" and it never
--   happened). 20260820000000's backfill is therefore correctly scoped
--   `WHERE p.contact_id IS NOT NULL` -- it cannot link a row whose contact is
--   NULL at the moment it runs. Anything that sets contact_id AFTERWARDS must
--   create the link itself, and only ONE of the five live write paths did:
--
--     admin.html saveListing + saveExtraContacts   -- writes both (separate
--                                                     requests, not atomic)
--     add-property.html                            -- contact_id only
--     edit-listing.html                            -- contact_id only
--     agent-setup.html bulk assign (x2)            -- contact_id only
--     recover-listings-from-manifest.sql           -- omits contact_id, so it
--                                                     creates the NULL-contact
--                                                     rows the backfill skips
--
--   Nothing at the database level guaranteed the invariant, so the gap in the
--   application code became live, silently mis-routed contacts.
--
-- This is the SAME failure shape 20260809000000 fixed for slugs, and it gets
-- the same remedy for the same stated reason: make the invariant a database
-- guarantee instead of an application convention, so NO path -- an agent's
-- self-service edit, a bulk reassignment, a recovery script, or a hand-written
-- UPDATE in the SQL editor -- can set contact_id without the link appearing.
--
-- WHAT IT DOES
--   1. properties_sync_primary_contact() -- AFTER INSERT OR UPDATE OF
--      contact_id: demote any stale primary, then upsert the correct one.
--   2. trg_properties_sync_primary_contact -- the trigger.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It does NOT backfill. Repairing the two known drift rows is a separate,
--     explicitly authorized, scoped statement -- not a side effect of a schema
--     migration. Applying this file changes no existing row.
--   * It does NOT delete secondary contacts. A reassignment demotes the old
--     primary to a secondary and keeps it; losing a real phone number is worse
--     than carrying a stale one, and demotion is reversible.
--   * It does NOT touch contacts, properties, leads or lead_events.
--   * It does NOT make contact_id NOT NULL. A NULL contact stays NULL and gets
--     no link -- draft/recovered rows must remain linkless until reviewed.
-- ============================================================================

BEGIN;

-- ── The invariant ───────────────────────────────────────────────────────────
-- SECURITY DEFINER on purpose. property_contacts has RLS: staff have full
-- access and a managing party has access to its own listings, but an agent
-- editing a listing that is NOT managed by their party (edit-listing.html can
-- reach such a row) would have the INSERT refused -- turning a safety net into
-- a new way for a save to fail. A safety net must hold for EVERY writer, so
-- the function runs as owner with a pinned search_path.
--
-- This cannot be used to forge a link: both columns it writes are read from
-- the properties row the caller just wrote (NEW.id, NEW.contact_id). It grants
-- no ability the caller did not already exercise by setting contact_id.
CREATE OR REPLACE FUNCTION properties_sync_primary_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- A NULL contact gets no link. Drafts and manifest-recovered rows stay
  -- linkless until a human assigns someone.
  IF NEW.contact_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. DEMOTE FIRST. idx_property_contacts_one_primary is a partial UNIQUE on
  --    (property_id) WHERE is_primary, so two primaries must not coexist even
  --    momentarily. Doing the upsert first would raise a unique violation on
  --    every genuine A -> B reassignment.
  --
  --    Only the row for a DIFFERENT contact is demoted; the row we are about
  --    to promote is left alone, which is what makes a repeat run a no-op.
  --
  --    The demoted row also vacates slot 0. property_contacts' own table
  --    comment defines the contract as "sort_order 0 is the primary and
  --    mirrors properties.contact_id", and two readers depend on it
  --    DIFFERENTLY: resolveContactForLanguage() tier 2 keys on the is_primary
  --    FLAG, while resolvePrimaryContact() returns all[0] -- the first row
  --    after sorting by sort_order. Flipping the flag without moving the rank
  --    would make those two functions name different people as the primary.
  --    Only the ex-primary moves; every other secondary keeps its staff-chosen
  --    order.
  UPDATE property_contacts pc
     SET is_primary = false,
         sort_order = CASE WHEN pc.sort_order = 0
                           THEN (SELECT COALESCE(MAX(x.sort_order), 0) + 1
                                   FROM property_contacts x
                                  WHERE x.property_id = NEW.id)
                           ELSE pc.sort_order END
   WHERE pc.property_id = NEW.id
     AND pc.is_primary
     AND pc.contact_id <> NEW.contact_id;

  -- 2. Ensure the row for the current contact exists and is the primary.
  --    ON CONFLICT targets property_contacts_unique (property_id, contact_id),
  --    so a contact that was already a SECONDARY on this listing is PROMOTED
  --    in place rather than duplicated -- its languages and its row survive.
  --
  --    The DO UPDATE ... WHERE clause makes the whole thing genuinely
  --    idempotent: when the link is already correct, no row is written at all,
  --    so updated_at does not churn on every unrelated property save.
  INSERT INTO property_contacts (property_id, contact_id, sort_order, is_primary)
  VALUES (NEW.id, NEW.contact_id, 0, true)
  ON CONFLICT ON CONSTRAINT property_contacts_unique
  DO UPDATE SET is_primary = true, sort_order = 0
  WHERE property_contacts.is_primary IS DISTINCT FROM true
     OR property_contacts.sort_order IS DISTINCT FROM 0;

  RETURN NULL;   -- AFTER trigger: the return value is ignored.
END;
$$;

COMMENT ON FUNCTION properties_sync_primary_contact() IS
  'Guarantees that a listing with a non-NULL properties.contact_id always has exactly one matching primary property_contacts row (sort_order 0 on insert, is_primary true). Demotes a superseded primary to a secondary (moving it out of slot 0) rather than deleting it. No-op when contact_id is NULL or the link is already correct. Only ever writes property_contacts.';

-- UPDATE OF contact_id fires whenever contact_id appears in the SET list, even
-- if the value is unchanged -- harmless, because step 2 is a no-op then.
DROP TRIGGER IF EXISTS trg_properties_sync_primary_contact ON properties;
CREATE TRIGGER trg_properties_sync_primary_contact
  AFTER INSERT OR UPDATE OF contact_id ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_sync_primary_contact();

COMMIT;
