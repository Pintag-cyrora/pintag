-- ============================================================================
-- Fixture for verify_production_security_checks_regression.sql
-- ============================================================================
-- Minimal, faithful fixture built to let scripts/verify-production-security.sql
-- itself (not a reimplementation of its checks) run to completion against a
-- throwaway database, satisfying every one of its 13 controls EXCEPT for a
-- small set of deliberately-included rows this fixture exists to exercise:
--
--   Control 4 (write-policy gate):
--     * POSITIVE — property_contacts carries the REAL "Staff full access"
--       (is_pintag_staff) and "Party manage own" (owned_party_ids-scoped)
--       policies, copied VERBATIM from
--       20260820000000_multi_phone_contacts.sql. Before the 2026-09-21 fix
--       these were false-positive "bypasses" (no literal is_pintag_admin
--       substring); this fixture proves they now PASS.
--     * NEGATIVE CONTROL — evil_table carries a write policy with NO gate
--       at all (USING (true)), proving the widened check still catches a
--       genuine open-write bypass.
--
--   Control 10 (SECURITY DEFINER anon-callable):
--     * POSITIVE — a trigger-type function (RETURNS trigger) with the
--       default PUBLIC execute grant, exactly like create_lead_from_event/
--       pintag_property_images_trg/etc. in production. Before the fix this
--       was flagged purely because PostgreSQL grants EXECUTE to PUBLIC on
--       every new function by default; this fixture proves it is now
--       structurally excluded (trigger-only functions cannot be invoked
--       directly as an RPC regardless of grants).
--     * NEGATIVE CONTROL — an ordinary (non-trigger) SECURITY DEFINER
--       function, ungated and anon-callable, proves the check still
--       flags a genuine unexpected ungated function.
--
-- Every other control (migration ledger, RLS coverage, view invoker mode,
-- storage write gating, the admin-primitive shape checks, the four named
-- F-04/F-05/F-06/F-09 function checks, the analytics-ceiling wiring, the
-- anon-grant floor, the admin-allowlist count, and the internal-table
-- SELECT-policy check) is satisfied here with the smallest object that
-- makes that control PASS cleanly, so the only FAIL rows the regression
-- SQL should see are the two negative controls above.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE);
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'email' $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

-- ── 1. Migration ledger ─────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY);
INSERT INTO supabase_migrations.schema_migrations (version) VALUES
  ('20260817000000'), ('20260817010000'), ('20260813000000');

-- ── core tables (control 11 needs these six to exist; kept minimal) ─────────
CREATE TABLE parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid,
  type text
);
ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON parties FROM anon;

CREATE TABLE contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON contacts FROM anon;

CREATE TABLE owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON owners FROM anon;

CREATE TABLE unit_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid);
ALTER TABLE unit_types ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON unit_types FROM anon;

CREATE TABLE properties (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status              text,
  deleted_at          timestamptz,
  view_count          integer DEFAULT 0,
  views_week          integer DEFAULT 0,
  district_en         text,
  managed_by_party_id uuid
);
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON properties FROM anon;
CREATE POLICY "public read active properties" ON properties FOR SELECT TO public
  USING (status IN ('active','available') AND deleted_at IS NULL);

CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid);
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON leads FROM anon;
-- control 13: internal tables must carry no anon/public SELECT policy —
-- simplest way to satisfy that is to create none here.

-- ── admin allowlist + the single authorization primitives ───────────────────
-- Copied VERBATIM (current/latest bodies) from
-- 20260817010000_authz_identity_and_abuse_bounds.sql (is_pintag_admin),
-- 20260804130000_single_admin_cyrora_lockdown.sql (is_pintag_staff), and
-- 20260705000000_agents_becomes_parties.sql (owned_party_ids) — the exact
-- three functions control 4's widened check now recognizes.
CREATE TABLE admin_accounts (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note         text,
  added_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE admin_accounts ENABLE ROW LEVEL SECURITY;
-- control 13 also names admin_accounts: no anon SELECT policy created, so it
-- naturally satisfies that control too.

CREATE OR REPLACE FUNCTION is_pintag_admin(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL
     AND (p_uid IS NULL OR p_uid = auth.uid())
     AND EXISTS (SELECT 1 FROM admin_accounts WHERE auth_user_id = auth.uid())
     AND coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
$$;
GRANT EXECUTE ON FUNCTION is_pintag_admin(uuid) TO authenticated, anon;

CREATE OR REPLACE FUNCTION is_pintag_staff(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_pintag_admin(p_uid)
$$;
GRANT EXECUTE ON FUNCTION is_pintag_staff(uuid) TO authenticated, anon;

CREATE OR REPLACE FUNCTION owned_party_ids(p_uid uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM parties WHERE auth_user_id = p_uid
$$;
GRANT EXECUTE ON FUNCTION owned_party_ids(uuid) TO authenticated;

CREATE POLICY "admin write properties" ON properties
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

INSERT INTO auth.users (id, email) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@example.test');
INSERT INTO admin_accounts (auth_user_id, note) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'fixture admin');

-- ── property_contacts — control 4's POSITIVE fixture ────────────────────────
-- Policy bodies copied VERBATIM from 20260820000000_multi_phone_contacts.sql.
CREATE TABLE property_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid,
  contact_id  uuid
);
ALTER TABLE property_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access property_contacts"
  ON property_contacts TO authenticated
  USING (is_pintag_staff(auth.uid()))
  WITH CHECK (is_pintag_staff(auth.uid()));

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

CREATE POLICY "Public read property_contacts of active properties"
  ON property_contacts FOR SELECT TO anon
  USING (property_id IN (SELECT id FROM properties WHERE status IN ('active','available')));

-- ── evil_table — control 4's NEGATIVE CONTROL (a genuine open write) ────────
CREATE TABLE evil_table (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payload text);
ALTER TABLE evil_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wide open evil_table write" ON evil_table
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ── analytics tables + the F-08 ceiling wiring (control 9) ──────────────────
CREATE TABLE lead_events (id bigserial PRIMARY KEY, listing_id uuid, event_type text, session_id text, created_at timestamptz DEFAULT now());
ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;
CREATE TABLE listing_events (id bigserial PRIMARY KEY, property_id uuid, event_type text, session_id text, created_at timestamptz DEFAULT now());
ALTER TABLE listing_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION check_event_target_ceiling(p_target uuid, p_event_type text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT true -- fixture stub; only the WITH CHECK wiring is under test here.
$$;
GRANT EXECUTE ON FUNCTION check_event_target_ceiling(uuid, text) TO anon;

CREATE POLICY "anon insert lead_events" ON lead_events FOR INSERT TO anon
  WITH CHECK (check_event_target_ceiling(listing_id, event_type));
CREATE POLICY "anon insert listing_events" ON listing_events FOR INSERT TO anon
  WITH CHECK (check_event_target_ceiling(property_id, event_type));

-- ── the four F-04/F-05/F-06/F-09 functions (control 8) ──────────────────────
CREATE TABLE listing_view_throttle (id bigserial PRIMARY KEY);
ALTER TABLE listing_view_throttle ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION rebuild_images_from_registry(p_property uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT '[]'::jsonb WHERE is_pintag_admin(auth.uid()); -- gated, per F-04
$$;
REVOKE ALL ON FUNCTION rebuild_images_from_registry(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rebuild_images_from_registry(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION reset_weekly_views()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_pintag_admin(auth.uid()) THEN RAISE EXCEPTION 'Access denied: admin only'; END IF;
  UPDATE properties SET views_week = 0;
END;
$$;
REVOKE ALL ON FUNCTION reset_weekly_views() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_weekly_views() TO authenticated;

CREATE OR REPLACE FUNCTION public_listing_stats(p_listing_id uuid)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object('view_count', view_count)
  FROM properties WHERE id = p_listing_id AND deleted_at IS NULL; -- gated, per F-06
$$;
GRANT EXECUTE ON FUNCTION public_listing_stats(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION increment_listing_view(p_listing_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (SELECT count(*) FROM listing_view_throttle) IS NOT NULL THEN -- gated, per F-09
    UPDATE properties SET view_count = coalesce(view_count,0)+1 WHERE id = p_listing_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION increment_listing_view(uuid) TO anon, authenticated;

-- ── storage (control 5) ──────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin write storage" ON storage.objects
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

-- ── control 10 — trigger-function POSITIVE + plain-function NEGATIVE ───────
-- A real trigger function, exactly like create_lead_from_event/
-- pintag_property_images_trg/etc. in production: default PUBLIC execute
-- (never revoked), RETURNS trigger. Before the fix this was flagged purely
-- because of the default grant; the structural prorettype exclusion now
-- correctly excludes it regardless of name.
CREATE OR REPLACE FUNCTION fixture_trigger_fn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN NEW;
END;
$$;
-- No REVOKE here, deliberately — this fixture proves the check does not
-- need one for a genuine trigger function.

-- A genuine, ordinary (non-trigger) SECURITY DEFINER function with no
-- is_pintag_admin gate and the default PUBLIC execute grant, never revoked —
-- the NEGATIVE CONTROL proving control 10 still flags a real unexpected
-- ungated function after the fix.
CREATE OR REPLACE FUNCTION fixture_ungated_rpc()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'this should still be flagged'::text
$$;
