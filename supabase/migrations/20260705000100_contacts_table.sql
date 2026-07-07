-- Buyer Contact: who the buyer should actually call about a listing, decoupled
-- from `parties` (Platform Identity — who manages the listing inside Pintag).
--
-- A contacts row is reusable across many listings (e.g. one apartment
-- building's reception number attached to dozens of units), and remains the
-- stable anchor for future CRM history (conversations, viewing appointments,
-- notes, lead ownership) even before anyone has signed up for a Pintag
-- account — most contacts never will, in the manual-onboarding era.

CREATE TABLE contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role       text NOT NULL CHECK (role IN (
               'owner','agent','property_manager','reception',
               'sales_office','developer','family_representative','other')),
  name       text,
  phone      text NOT NULL,
  whatsapp   text,
  party_id   uuid REFERENCES parties(id) ON DELETE SET NULL,
  is_verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE contacts IS
  'Who the buyer should contact about a listing — always present, independent of whether a linked Pintag party (agent/owner/etc.) exists. party_id is the claim link once this contact signs up.';

CREATE INDEX idx_contacts_party_id ON contacts(party_id);

-- Defined here with CREATE OR REPLACE (not just assumed present from
-- 20260622000000_engagement_metrics.sql) — that migration's application
-- history turned out to be inconsistent between environments, so this one
-- no longer depends on it having run first.
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- NOTE: the public "read contacts of active properties" policy is added in
-- 20260705000200_properties_contact_and_managed_by_fk.sql, since it depends
-- on properties.contact_id, which doesn't exist until that migration runs.

CREATE POLICY "Staff full access contacts"
  ON contacts TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

CREATE POLICY "Authenticated read own-scope contacts"
  ON contacts FOR SELECT TO authenticated
  USING (
    NOT is_pintag_staff(auth.uid())
    AND (created_by = auth.uid() OR party_id IN (SELECT owned_party_ids(auth.uid())))
  );

CREATE POLICY "Party insert own contact"
  ON contacts FOR INSERT TO authenticated
  WITH CHECK (
    NOT is_pintag_staff(auth.uid())
    AND created_by = auth.uid()
    AND (party_id IS NULL OR party_id IN (SELECT owned_party_ids(auth.uid())))
  );

CREATE POLICY "Party update own contact"
  ON contacts FOR UPDATE TO authenticated
  USING (
    NOT is_pintag_staff(auth.uid())
    AND (created_by = auth.uid() OR party_id IN (SELECT owned_party_ids(auth.uid())))
  )
  WITH CHECK (created_by = auth.uid() OR party_id IN (SELECT owned_party_ids(auth.uid())));
