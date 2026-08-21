-- MULTIPLE PHONE NUMBERS PER LISTING, EACH WITH THE LANGUAGES THAT PERSON SPEAKS
--
-- Goal: one listing -> many phone contacts -> each number advertises the
-- languages its owner answers in.
--
-- WHY THIS SHAPE
-- --------------
-- `contacts` is ALREADY the entity that owns a phone number (phone, whatsapp,
-- name, role, party_id, is_verified). Languages belong to the person who
-- answers, so they are a contacts column -- not a new JSON blob on properties,
-- and not phone_1/phone_2/phone_3.
--
-- The many-side is a JOIN TABLE, not a property_id column on contacts, because
-- a contacts row is SHARED BY MANY LISTINGS. 20260705000300 grouped properties
-- by (managed_by_party_id, agent_name, agent_whatsapp) and pointed a whole
-- group at ONE contacts row, and admin still surfaces that sharing (the
-- "shared by N other listings" warning and its fork checkbox). Adding
-- property_id to contacts would have forced every shared row to be split.
--
-- properties.contact_id IS UNCHANGED and still points at the PRIMARY contact.
-- leads.contact_id and lead_events.contact_id (20260722000000) keep working
-- untouched, and because each phone number is its own contacts row, a buyer
-- who picks the second number produces a lead attributed to THAT contact with
-- no change to the tracking model at all.
--
-- Purely additive: one nullable column, one new table, one backfill that only
-- INSERTs into the new table, and one widened SELECT policy. No column is
-- dropped, no type changes, no existing row is rewritten.

-- ── 1. Languages on the contact ──────────────────────────────────────────
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS languages text[];

COMMENT ON COLUMN contacts.languages IS
  'ISO 639-1 codes for the languages this contact ANSWERS THE PHONE in, e.g. {lo,en}. NULL or {} = not recorded, which the UI renders as no language line -- never as a guess. This is NOT the site UI language set (lo/en/zh); Thai is the obvious extra. The registry of permitted codes and their labels lives in contact-languages.js (CONTACT_LANGUAGES); read it only via resolveListingContacts()/normalizeContactLanguages().';

-- ── 2. The join table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  -- Staff-controlled display order. 0 is the PRIMARY: the number shown before
  -- a buyer chooses, and the one properties.contact_id mirrors.
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_contacts_unique UNIQUE (property_id, contact_id)
);

COMMENT ON TABLE property_contacts IS
  'Which phone contacts a listing advertises, ordered. sort_order 0 is the primary and mirrors properties.contact_id. A listing with exactly one row here behaves identically to the pre-2026-08-20 single-contact model. Read only via resolveListingContacts() (contact-languages.js).';

CREATE INDEX IF NOT EXISTS idx_property_contacts_property_id ON property_contacts(property_id);
CREATE INDEX IF NOT EXISTS idx_property_contacts_contact_id  ON property_contacts(contact_id);

DROP TRIGGER IF EXISTS trg_property_contacts_updated_at ON property_contacts;
CREATE TRIGGER trg_property_contacts_updated_at
  BEFORE UPDATE ON property_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 3. Backfill: every existing listing keeps its current number ─────────
-- Idempotent via the unique constraint. Only INSERTs; touches no existing row
-- in properties or contacts.
INSERT INTO property_contacts (property_id, contact_id, sort_order)
SELECT p.id, p.contact_id, 0
FROM properties p
WHERE p.contact_id IS NOT NULL
ON CONFLICT (property_id, contact_id) DO NOTHING;

-- ── 4. RLS ───────────────────────────────────────────────────────────────
-- Mirrors unit_types exactly (20260720000000): staff full access, a managing
-- party over its own listings, and public read for listings that are actually
-- public.
ALTER TABLE property_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff full access property_contacts" ON property_contacts;
CREATE POLICY "Staff full access property_contacts"
  ON property_contacts TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

DROP POLICY IF EXISTS "Party manage own property_contacts" ON property_contacts;
CREATE POLICY "Party manage own property_contacts"
  ON property_contacts TO authenticated
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

DROP POLICY IF EXISTS "Public read property_contacts of active properties" ON property_contacts;
CREATE POLICY "Public read property_contacts of active properties"
  ON property_contacts FOR SELECT TO anon
  USING (property_id IN (SELECT id FROM properties WHERE status IN ('active','available')));

-- ── 5. Widen the public contacts policy ──────────────────────────────────
-- WITHOUT THIS THE FEATURE IS INVISIBLE. The policy from 20260705000200 made a
-- contact publicly readable only when it was some property's contact_id -- so a
-- SECOND number, which by definition is not any listing's contact_id, would be
-- filtered out of the anon response and the picker would show one option.
-- Extended, not replaced: the contact_id arm is kept verbatim so a listing that
-- has not been backfilled yet is unaffected. Exposure does not widen beyond the
-- existing rule -- a contact is still readable only through a listing that is
-- already public.
DROP POLICY IF EXISTS "Public read contacts of active properties" ON contacts;
CREATE POLICY "Public read contacts of active properties"
  ON contacts FOR SELECT TO anon
  USING (
    id IN (SELECT contact_id FROM properties WHERE status IN ('active','available'))
    OR id IN (
      SELECT pc.contact_id FROM property_contacts pc
      JOIN properties p ON p.id = pc.property_id
      WHERE p.status IN ('active','available')
    )
  );
