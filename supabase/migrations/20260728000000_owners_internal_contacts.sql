-- Owner Contact: the INTERNAL, staff-only record of who actually owns a
-- property. Deliberately and permanently separate from `contacts`.
--
-- ============================================================================
-- WHY THIS IS NOT `contacts`, AND MUST NEVER BE MERGED INTO IT
-- ============================================================================
-- `contacts` (20260705000100) is the PUBLIC Buyer Contact -- who a buyer
-- should call about a listing. It has an explicit `anon` SELECT policy
-- ("Public read contacts of active properties") because the public listing
-- page's WhatsApp/Call buttons depend on reading it un-authenticated.
--
-- `owners` is the opposite: an internal CRM record that must NEVER reach the
-- public site or the public API. It therefore has NO anon policy of any
-- kind -- not a restricted one, none at all. With RLS enabled and no anon
-- policy, PostgREST returns zero rows to the anon key by default-deny.
--
-- These two can look similar (both have a name and a phone) and an owner is
-- often ALSO the buyer contact -- but they answer different questions, have
-- opposite visibility, and change independently. Collapsing them would mean
-- either leaking internal owner data publicly or breaking the public
-- contact band. Keep them separate. See ARCHITECTURE.md's Platform Identity
-- / Buyer Contact separation for the same reasoning applied to `parties`.
--
-- ============================================================================
-- WHY NORMALIZED (a table + FK) RATHER THAN owner_* COLUMNS ON properties
-- ============================================================================
-- One owner routinely owns several listings. Denormalized owner_name/
-- owner_phone/... columns on `properties` would mean updating a phone number
-- in N places and having no way to ask "show me everything this owner owns."
-- This repo already learned that lesson once: the pre-`contacts` schema
-- denormalized agent_name/agent_phone/... onto properties and they rotted
-- into permanently-null columns within weeks (see
-- 20260705000300_backfill_contacts_from_properties.sql's own notes).
-- properties.owner_id is a plain nullable FK -- one row updated, every
-- listing follows.

CREATE TABLE IF NOT EXISTS owners (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  phone       text,
  whatsapp    text,
  email       text,
  -- Free-form internal notes: access arrangements, payment preferences,
  -- "prefers Lao only", "call after 5pm". Staff-facing, never rendered
  -- anywhere public.
  notes       text,
  -- Optional claim link, mirroring contacts.party_id: if this owner ever
  -- registers a Pintag account, point at it here. Nullable forever -- most
  -- owners in the manual-onboarding era never will.
  party_id    uuid REFERENCES parties(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE owners IS
  'INTERNAL owner contact records -- staff-only, never public. One owner may own many properties (properties.owner_id). Deliberately separate from `contacts`, which is the PUBLIC buyer-facing contact and has an anon read policy; `owners` has no anon policy at all.';

CREATE INDEX IF NOT EXISTS idx_owners_party_id ON owners(party_id);
-- Owner Phone is a first-class admin search key (staff routinely get a call
-- from a number and need to find that owner's listings), so it is indexed
-- rather than left to a sequential scan as the owner list grows.
CREATE INDEX IF NOT EXISTS idx_owners_phone ON owners(phone);
CREATE INDEX IF NOT EXISTS idx_owners_name ON owners(name);

DROP TRIGGER IF EXISTS trg_owners_updated_at ON owners;
CREATE TRIGGER trg_owners_updated_at
  BEFORE UPDATE ON owners
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── properties.owner_id ────────────────────────────────────────────────
-- Nullable: existing listings have no owner on file, and staff will fill
-- them in over time. Never NOT NULL -- unlike contact_id (which is required
-- because a buyer must always have someone to call), an internal owner
-- record is genuinely optional.
-- ON DELETE SET NULL: removing an owner record must never cascade into
-- deleting listings.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES owners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_properties_owner_id ON properties(owner_id);

COMMENT ON COLUMN properties.owner_id IS
  'Internal owner record (owners.id). Staff-only -- must never be selected by any public/anon query. Distinct from contact_id, which is the public buyer-facing contact.';

ALTER TABLE owners ENABLE ROW LEVEL SECURITY;

-- NOTE: there is intentionally NO policy for the `anon` role on this table.
-- RLS is enabled and anon has no policy, so PostgREST's default-deny makes
-- every anon SELECT return zero rows. Adding an anon policy here -- even a
-- narrow one -- would defeat the entire purpose of this table.

DROP POLICY IF EXISTS "Staff full access owners" ON owners;
CREATE POLICY "Staff full access owners"
  ON owners TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

-- A self-service agent sees only owner records they created themselves, or
-- that are linked to a party they own -- same shape as contacts' own
-- own-scope policy, so an agent can manage their own owners without seeing
-- the whole internal owner book.
DROP POLICY IF EXISTS "Authenticated read own-scope owners" ON owners;
CREATE POLICY "Authenticated read own-scope owners"
  ON owners FOR SELECT TO authenticated
  USING (
    NOT is_pintag_staff(auth.uid())
    AND (created_by = auth.uid() OR party_id IN (SELECT owned_party_ids(auth.uid())))
  );

DROP POLICY IF EXISTS "Party insert own owner" ON owners;
CREATE POLICY "Party insert own owner"
  ON owners FOR INSERT TO authenticated
  WITH CHECK (NOT is_pintag_staff(auth.uid()) AND created_by = auth.uid());

DROP POLICY IF EXISTS "Party update own owner" ON owners;
CREATE POLICY "Party update own owner"
  ON owners FOR UPDATE TO authenticated
  USING (
    NOT is_pintag_staff(auth.uid())
    AND (created_by = auth.uid() OR party_id IN (SELECT owned_party_ids(auth.uid())))
  )
  WITH CHECK (created_by = auth.uid() OR party_id IN (SELECT owned_party_ids(auth.uid())));

-- ── Owner portfolio view, for the admin "all listings by this owner" panel ──
-- SECURITY DEFINER so it can join properties/owners in one call, but gated
-- internally on staff -- the same guard pattern as analytics_* in
-- 20260727000000 and reset_weekly_views()'s admin-only check.
CREATE OR REPLACE FUNCTION owner_portfolio(p_owner_id uuid)
RETURNS TABLE(property_id uuid, slug text, title_en text, status text, price_display text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_pintag_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: staff only';
  END IF;
  RETURN QUERY
  SELECT p.id, p.slug, p.title_en, p.status, p.price_display
  FROM properties p
  WHERE p.owner_id = p_owner_id
  ORDER BY p.created_at DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION owner_portfolio(uuid) TO authenticated;
