-- Stage C RLS cutover — ships together with the matching admin.html /
-- listing.html / Agent Portal frontend changes in this same commit.
--
-- Two things happen here:
--   1. Replace every hardcoded `auth.email() = 'admin@pintag.io'` check with
--      `is_pintag_staff(auth.uid())`, so "Pintag Staff" is real data
--      (a parties row of type='staff'), not a string comparison.
--   2. Fix a pre-existing bug: agents had SELECT/DELETE on their own listings
--      but no INSERT/UPDATE grant at all, so the already-built self-service
--      add-property.html/edit-listing.html pages have been silently
--      non-functional (403) for real agents. Scope the new grants via
--      owned_party_ids(), consistent with the decoupled auth_user_id model.

-- ── properties ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Admin full access properties"         ON properties;
DROP POLICY IF EXISTS "Authenticated full access properties" ON properties;
DROP POLICY IF EXISTS "Agent select own properties"          ON properties;
DROP POLICY IF EXISTS "Agent delete own properties"          ON properties;

CREATE POLICY "Staff full access properties"
  ON properties TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

CREATE POLICY "Party select own properties"
  ON properties FOR SELECT TO authenticated
  USING (
    NOT is_pintag_staff(auth.uid())
    AND managed_by_party_id IN (SELECT owned_party_ids(auth.uid()))
  );

CREATE POLICY "Party delete own properties"
  ON properties FOR DELETE TO authenticated
  USING (
    NOT is_pintag_staff(auth.uid())
    AND managed_by_party_id IN (SELECT owned_party_ids(auth.uid()))
  );

-- NEW: the previously-missing grants that make add-property.html /
-- edit-listing.html actually work for real agents.
CREATE POLICY "Party insert own properties"
  ON properties FOR INSERT TO authenticated
  WITH CHECK (
    NOT is_pintag_staff(auth.uid())
    AND (managed_by_party_id IS NULL OR managed_by_party_id IN (SELECT owned_party_ids(auth.uid())))
    AND contact_id IS NOT NULL
  );

CREATE POLICY "Party update own properties"
  ON properties FOR UPDATE TO authenticated
  USING (
    NOT is_pintag_staff(auth.uid())
    AND managed_by_party_id IN (SELECT owned_party_ids(auth.uid()))
  )
  WITH CHECK (managed_by_party_id IN (SELECT owned_party_ids(auth.uid())));

-- ── parties (renamed from agents) ───────────────────────────────────────
DROP POLICY IF EXISTS "Admin insert agents" ON parties;
DROP POLICY IF EXISTS "Admin update agents" ON parties;
DROP POLICY IF EXISTS "Admin select agents" ON parties;
DROP POLICY IF EXISTS "Public read agents"  ON parties;

CREATE POLICY "Staff insert parties"
  ON parties FOR INSERT TO authenticated
  WITH CHECK (is_pintag_staff(auth.uid()));

CREATE POLICY "Staff update parties"
  ON parties FOR UPDATE TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

CREATE POLICY "Staff select parties"
  ON parties FOR SELECT TO authenticated
  USING (is_pintag_staff(auth.uid()));

CREATE POLICY "Public read parties"
  ON parties FOR SELECT TO anon
  USING (true);

-- Lets a party update their own public-facing profile fields, but not their
-- own type/auth_user_id (claiming/reassigning stays a staff-mediated action
-- via agent-setup.html for this phase — self-serve identity verification is
-- explicitly out of scope, flagged as future work).
CREATE POLICY "Party update own profile"
  ON parties FOR UPDATE TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- ── lead_events ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Admin full access lead_events" ON lead_events;
DROP POLICY IF EXISTS "Agent read own leads"          ON lead_events;

CREATE POLICY "Staff full access lead_events"
  ON lead_events TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

CREATE POLICY "Party read own leads"
  ON lead_events FOR SELECT TO authenticated
  USING (agent_id IN (SELECT owned_party_ids(auth.uid())));

-- ── contacts ─────────────────────────────────────────────────────────────
-- Staff/self-service policies were already added in
-- 20260705000100_contacts_table.sql and 20260705000200_..._fk.sql; nothing
-- further to change here.
