-- ============================================================================
-- SINGLE-ADMINISTRATOR LOCKDOWN — cyrora.trading@gmail.com
-- ============================================================================
-- Supersedes 20260804120000_single_admin_lockdown.sql (which was staff-based).
-- Per the post-breach decision: there is exactly ONE production administrator,
-- cyrora.trading@gmail.com. The legacy staff model (parties.type='staff' +
-- is_pintag_staff consulting it) is retired. Authorization is now a small,
-- explicit admin allowlist — not "any authenticated user", not "staff parties".
--
-- Self-contained and idempotent. Drops EVERY policy on each table (iterating
-- pg_policies) so it reconciles the drifted production database, then recreates
-- a minimal default-deny set: only is_pintag_admin() may write; reads stay
-- public where the site needs them; anon keeps append-only analytics inserts.
--
-- SAFETY: this does NOT touch a single row of production data (properties,
-- parties, contacts, owners, unit_types, listings). It only creates the
-- allowlist table, seeds cyrora, and rewrites policies/grants. Wrapped in
-- BEGIN/COMMIT — any error rolls the whole thing back.
-- ============================================================================

BEGIN;

-- ── 1. The single authorization primitive: an explicit admin allowlist ──────
-- One row today (cyrora). Granting another admin later is one INSERT; it never
-- requires a USING(true) policy or a migration. This is the "expand later,
-- safely" hook.
CREATE TABLE IF NOT EXISTS admin_accounts (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note         text,
  added_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE admin_accounts ENABLE ROW LEVEL SECURITY;
-- An admin may see their own allowlist row; nobody writes this table through
-- the API (it is managed in the SQL editor / by the service role only).
DROP POLICY IF EXISTS "admin read own allowlist row" ON admin_accounts;
CREATE POLICY "admin read own allowlist row" ON admin_accounts
  FOR SELECT TO authenticated USING (auth_user_id = auth.uid());

-- Seed cyrora.trading@gmail.com as the sole administrator (no-op if already there).
INSERT INTO admin_accounts (auth_user_id, note)
SELECT id, 'Sole production administrator'
FROM auth.users WHERE email = 'cyrora.trading@gmail.com'
ON CONFLICT (auth_user_id) DO NOTHING;

-- is_pintag_admin(): the ONLY write-authorization check from here on.
-- SECURITY DEFINER so it can read the allowlist regardless of caller RLS.
CREATE OR REPLACE FUNCTION is_pintag_admin(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM admin_accounts WHERE auth_user_id = p_uid)
$$;
GRANT EXECUTE ON FUNCTION is_pintag_admin(uuid) TO authenticated, anon;

-- Retire the legacy staff model without risking a hidden dependency: redefine
-- is_pintag_staff() to defer to the admin allowlist. It no longer consults
-- parties.type='staff', so the staff model is dead; any lingering caller now
-- enforces single-admin. Drop it entirely once a grep confirms nothing calls it.
CREATE OR REPLACE FUNCTION is_pintag_staff(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_pintag_admin(p_uid)
$$;

-- ── 2. Policy reset helper (authoritative against drifted policy names) ──────
CREATE OR REPLACE FUNCTION _lockdown_drop_all_policies(p_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE r record;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies
           WHERE schemaname='public' AND tablename=p_table
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, p_table);
  END LOOP;
END $fn$;

-- ── 3. DATA TABLES: public READ where the site needs it, admin-only WRITE ────
SELECT _lockdown_drop_all_policies('properties');
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read active properties" ON properties
  FOR SELECT TO public USING (status IN ('active','available'));
CREATE POLICY "admin write properties" ON properties
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('parties');
ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read parties" ON parties
  FOR SELECT TO public USING (true);
CREATE POLICY "admin write parties" ON parties
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('contacts');
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read contacts of active properties" ON contacts
  FOR SELECT TO public USING (id IN (
    SELECT contact_id FROM properties
    WHERE contact_id IS NOT NULL AND status IN ('active','available')));
CREATE POLICY "admin write contacts" ON contacts
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('unit_types');
ALTER TABLE unit_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read unit_types of active properties" ON unit_types
  FOR SELECT TO public USING (property_id IN (
    SELECT id FROM properties WHERE status IN ('active','available')));
CREATE POLICY "admin write unit_types" ON unit_types
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('owners');
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin all owners" ON owners
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('leads');
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin all leads" ON leads
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

-- ── 4. ANALYTICS EVENT TABLES: anon INSERT-only, admin READ ─────────────────
SELECT _lockdown_drop_all_policies('lead_events');
ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert lead_events" ON lead_events FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin read lead_events" ON lead_events FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('listing_events');
ALTER TABLE listing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert listing_events" ON listing_events FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon dedup read listing_events" ON listing_events FOR SELECT TO anon USING (true);
CREATE POLICY "admin read listing_events" ON listing_events FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('search_events');
ALTER TABLE search_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert search_events" ON search_events FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin read search_events" ON search_events FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('ui_events');
ALTER TABLE ui_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert ui_events" ON ui_events FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin read ui_events" ON ui_events FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('page_views');
ALTER TABLE page_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert page_views" ON page_views FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "admin read page_views" ON page_views FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

-- ── 5. INTERNAL / INTELLIGENCE TABLES: admin READ only (writes via svc role) ─
SELECT _lockdown_drop_all_policies('intelligence_reports');
ALTER TABLE intelligence_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read intelligence_reports" ON intelligence_reports FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));
CREATE POLICY "admin delete intelligence_reports" ON intelligence_reports FOR DELETE TO authenticated USING (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('intelligence_insights');
ALTER TABLE intelligence_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read intelligence_insights" ON intelligence_insights FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('report_insights');
ALTER TABLE report_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read report_insights" ON report_insights FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('daily_metrics_snapshot');
ALTER TABLE daily_metrics_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read daily_metrics_snapshot" ON daily_metrics_snapshot FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

SELECT _lockdown_drop_all_policies('properties_removal_log');
ALTER TABLE properties_removal_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read properties_removal_log" ON properties_removal_log FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

-- ── 6. PRIVILEGE-LAYER FLOOR (defense in depth beneath RLS) ─────────────────
REVOKE INSERT, UPDATE, DELETE
  ON properties, parties, contacts, owners, unit_types, leads FROM anon;
GRANT INSERT ON lead_events, listing_events, search_events, ui_events, page_views TO anon;

DROP FUNCTION _lockdown_drop_all_policies(text);

COMMIT;

-- Verify with scripts/verify-single-admin-lockdown.sql (uses is_pintag_admin
-- and cyrora's uid). EXPECT: the audit returns only the anon analytics inserts;
-- is_pintag_admin(cyrora) = true; every other account = false.
