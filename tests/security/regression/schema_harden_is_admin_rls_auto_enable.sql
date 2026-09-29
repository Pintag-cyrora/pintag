-- ============================================================================
-- Fixture for harden_is_admin_rls_auto_enable_regression.sql
-- (supabase/migrations/20260921020000_harden_is_admin_and_rls_auto_enable.sql)
-- ============================================================================
-- LAYERED ON TOP OF schema_verify_production_security_checks.sql (loaded first
-- by run-harden-is-admin-rls-auto-enable-pg.sh, which is left untouched) so the
-- REAL scripts/verify-production-security.sql can run against the result.
--
-- Reproduces the PRE-migration production state of the two functions exactly as
-- read from the live catalog on 2026-09-29 (read-only diagnostic):
--
--   public.is_admin()          boolean, SECURITY DEFINER, search_path UNPINNED,
--                              EXECUTE: PUBLIC, anon, authenticated,
--                              service_role, backup_ro, owner
--   public.rls_auto_enable()   event_trigger, SECURITY DEFINER,
--                              search_path=pg_catalog, same EXECUTE set
--   event trigger ensure_rls   ddl_command_end, tags CREATE TABLE /
--                              CREATE TABLE AS / SELECT INTO, enabled, bound to
--                              rls_auto_enable()
--
-- The EXECUTE grants come the way production got them: PostgreSQL's implicit
-- PUBLIC grant plus this project's default privileges for functions in
-- schema public (anon / authenticated / service_role), plus an explicit grant to
-- backup_ro.
--
-- The owner here is the (superuser) test role. Production's owner is a
-- non-superuser, which is a STRONGER position for the definer than this one, so
-- this is the worst case for the search_path assertions.
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_ro')    THEN CREATE ROLE backup_ro NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ddl_author')   THEN CREATE ROLE ddl_author NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO service_role, backup_ro, ddl_author;
GRANT CREATE ON SCHEMA public TO ddl_author;

-- Production's default privileges for functions created in schema public.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- The table is_admin() reads. Production: RLS enabled, no policies.
CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- is_admin(): body as read from production (whitespace normalised).
CREATE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER
AS $function$
  select exists (
    select 1
    from profiles
    where id = auth.uid()
    and role = 'admin'
  );
$function$;

-- rls_auto_enable(): body as read from production.
CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- Explicit grant production has to the read-only backup role.
GRANT EXECUTE ON FUNCTION public.is_admin(), public.rls_auto_enable() TO backup_ro;

CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();

-- Test data for is_admin(): one admin, one ordinary user, one attacker.
INSERT INTO public.profiles (id, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'admin'),
  ('22222222-2222-2222-2222-222222222222', 'user'),
  ('33333333-3333-3333-3333-333333333333', 'user');
