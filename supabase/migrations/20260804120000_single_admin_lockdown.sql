-- ============================================================================
-- SINGLE-ADMIN LOCKDOWN — least-privilege RLS redesign
-- ============================================================================
-- Written in response to the 2026-08-03 production breach, in which an
-- attacker logged into a weak-password account (testadmin@pintag.io) and used
-- three permissive `USING (true)` / `WITH CHECK (true)` write policies to
-- deface and delete 93 listings plus agent and contact records, via the REST
-- API, from an Azure IP, in ~30 seconds.
--
-- ROOT CAUSE: those permissive write policies granted **every authenticated
-- user** INSERT/UPDATE/DELETE on core tables. Any single compromised login
-- (of any account) therefore had full write access to all production data.
--
-- POLICY MODEL AFTER THIS MIGRATION — default-deny, single writer:
--   * WRITE (INSERT/UPDATE/DELETE) on every data table is granted ONLY to
--     is_pintag_staff(auth.uid()). Today exactly one party has type='staff'
--     (admin@pintag.io), so this is literally single-admin mode. Granting a
--     future admin/agent write access is a controlled data change (add a
--     staff party row, or add a narrowly-scoped policy) — never a return to
--     broad `authenticated` access.
--   * READ stays public where the website needs it (active listings, agent
--     profiles, contacts/units of active listings) via `TO public`, so both
--     anonymous visitors and any logged-in user can browse.
--   * Analytics event tables keep anon INSERT-only (append-only tracking);
--     everything else on them is staff-read-only.
--   * Internal/intelligence tables are staff-read-only; their writes happen
--     exclusively through SECURITY DEFINER triggers/functions and the
--     service-role edge function, both of which bypass RLS by design.
--
-- REGRESSION-SAFE: every public write path (view counter, lead creation from
-- a WhatsApp click, the removal-log audit trigger, rate-limit checks) runs
-- through a SECURITY DEFINER function/trigger and so is unaffected by locking
-- the anon/authenticated roles out of direct writes. Verified in the repo
-- before writing this file.
--
-- Idempotent and safe to re-run. Drops EVERY existing policy on each target
-- table first (via the helper below) so it fully reconciles production even
-- though the live database accumulated dashboard-created policies whose names
-- were never tracked here — the exact drift that hid the vulnerability.
-- ============================================================================

BEGIN;

-- Drop every policy on a public table, whatever it is named. This is what
-- makes the migration authoritative against a drifted production database:
-- we do not need to know the (possibly dashboard-created) policy names.
CREATE OR REPLACE FUNCTION _lockdown_drop_all_policies(p_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = p_table
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, p_table);
  END LOOP;
END $fn$;

-- ── DATA TABLES: public READ where the site needs it, staff-only WRITE ──────

-- properties: anyone may read ACTIVE listings; only staff may write.
SELECT _lockdown_drop_all_policies('properties');
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read active properties" ON properties
  FOR SELECT TO public
  USING (status IN ('active','available'));
CREATE POLICY "staff write properties" ON properties
  FOR ALL TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

-- parties (agents/staff/owners-as-parties): profiles are publicly readable;
-- only staff may write.
SELECT _lockdown_drop_all_policies('parties');
ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read parties" ON parties
  FOR SELECT TO public
  USING (true);
CREATE POLICY "staff write parties" ON parties
  FOR ALL TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

-- contacts (buyer contact info): readable only for contacts attached to an
-- active listing (the public buyer-contact band); only staff may write.
SELECT _lockdown_drop_all_policies('contacts');
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read contacts of active properties" ON contacts
  FOR SELECT TO public
  USING (id IN (
    SELECT contact_id FROM properties
    WHERE contact_id IS NOT NULL AND status IN ('active','available')
  ));
CREATE POLICY "staff write contacts" ON contacts
  FOR ALL TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

-- unit_types: readable for units of an active listing; only staff may write.
SELECT _lockdown_drop_all_policies('unit_types');
ALTER TABLE unit_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read unit_types of active properties" ON unit_types
  FOR SELECT TO public
  USING (property_id IN (
    SELECT id FROM properties WHERE status IN ('active','available')
  ));
CREATE POLICY "staff write unit_types" ON unit_types
  FOR ALL TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

-- owners (internal owner directory): staff-only, no public read at all.
SELECT _lockdown_drop_all_policies('owners');
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff all owners" ON owners
  FOR ALL TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

-- leads (CRM pipeline): staff-only. Rows are created by a SECURITY DEFINER
-- trigger on lead_events, which bypasses RLS, so no anon/agent write is needed.
SELECT _lockdown_drop_all_policies('leads');
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff all leads" ON leads
  FOR ALL TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

-- ── ANALYTICS EVENT TABLES: anon INSERT-only (tracking), staff READ ─────────
-- These MUST keep anon INSERT or click/impression/search/page tracking stops.
-- They are strictly append-only for anon: no SELECT (except the one dedup
-- self-check listing_events needs), no UPDATE, no DELETE.

SELECT _lockdown_drop_all_policies('lead_events');
ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert lead_events" ON lead_events
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "staff read lead_events" ON lead_events
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));

SELECT _lockdown_drop_all_policies('listing_events');
ALTER TABLE listing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert listing_events" ON listing_events
  FOR INSERT TO anon WITH CHECK (true);
-- the dedup window self-check trackListingEvent() performs before inserting
CREATE POLICY "anon dedup read listing_events" ON listing_events
  FOR SELECT TO anon USING (true);
CREATE POLICY "staff read listing_events" ON listing_events
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));

SELECT _lockdown_drop_all_policies('search_events');
ALTER TABLE search_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert search_events" ON search_events
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "staff read search_events" ON search_events
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));

SELECT _lockdown_drop_all_policies('ui_events');
ALTER TABLE ui_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert ui_events" ON ui_events
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "staff read ui_events" ON ui_events
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));

SELECT _lockdown_drop_all_policies('page_views');
ALTER TABLE page_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert page_views" ON page_views
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "staff read page_views" ON page_views
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));

-- ── INTERNAL / INTELLIGENCE TABLES: staff READ only; writes via service role ─
-- The generate-intelligence-report edge function writes these with the
-- service-role key (bypasses RLS). daily_metrics_snapshot is written by a
-- SECURITY DEFINER function; properties_removal_log by a SECURITY DEFINER
-- trigger. No client role needs write access.

SELECT _lockdown_drop_all_policies('intelligence_reports');
ALTER TABLE intelligence_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read intelligence_reports" ON intelligence_reports
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));
CREATE POLICY "staff delete intelligence_reports" ON intelligence_reports
  FOR DELETE TO authenticated USING (is_pintag_staff(auth.uid()));

SELECT _lockdown_drop_all_policies('intelligence_insights');
ALTER TABLE intelligence_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read intelligence_insights" ON intelligence_insights
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));

SELECT _lockdown_drop_all_policies('report_insights');
ALTER TABLE report_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read report_insights" ON report_insights
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));

SELECT _lockdown_drop_all_policies('daily_metrics_snapshot');
ALTER TABLE daily_metrics_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read daily_metrics_snapshot" ON daily_metrics_snapshot
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));

SELECT _lockdown_drop_all_policies('properties_removal_log');
ALTER TABLE properties_removal_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read properties_removal_log" ON properties_removal_log
  FOR SELECT TO authenticated USING (is_pintag_staff(auth.uid()));

-- ── PRIVILEGE-LAYER FLOOR (defense in depth beneath RLS) ────────────────────
-- Even if a permissive policy is ever re-introduced by accident, the anon
-- role has no table-level privilege to write core data. RLS is the primary
-- boundary; this is the backstop.
REVOKE INSERT, UPDATE, DELETE
  ON properties, parties, contacts, owners, unit_types, leads
  FROM anon;

-- anon must retain INSERT on the append-only analytics tables (tracking).
GRANT INSERT ON lead_events, listing_events, search_events, ui_events, page_views TO anon;

DROP FUNCTION _lockdown_drop_all_policies(text);

COMMIT;

-- ============================================================================
-- POST-MIGRATION VERIFICATION — run scripts/verify-single-admin-lockdown.sql
-- ============================================================================
