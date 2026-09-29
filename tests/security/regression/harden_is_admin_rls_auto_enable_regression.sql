-- ============================================================================
-- SECURITY REGRESSION ASSERTIONS — is_admin() / rls_auto_enable() hardening
-- (supabase/migrations/20260921020000_harden_is_admin_and_rls_auto_enable.sql)
-- ============================================================================
-- Run by run-harden-is-admin-rls-auto-enable-pg.sh, twice or more:
--
--   psql -v phase=pre  -f this   -- baseline: proves the fixture reproduces the
--                                   production state the migration fixes, so the
--                                   post-migration assertions cannot pass
--                                   vacuously (also re-run after the rollback)
--   psql -v phase=post -f this   -- after the migration: the required end state
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
    RAISE EXCEPTION 'SECURITY REGRESSION FAILED: %', p_what;
  END IF;
  RAISE NOTICE '  ok  %', p_what;
END $$;

-- Roles holding an explicit EXECUTE entry ('PUBLIC' for the pseudo-role).
CREATE OR REPLACE FUNCTION exec_grantees(p_sig regprocedure) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(g ORDER BY g), '{}')
  FROM (
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = p_sig AND a.privilege_type = 'EXECUTE'
  ) s
$$;

CREATE OR REPLACE FUNCTION can_exec(p_role text, p_sig regprocedure) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT has_function_privilege(p_role, p_sig, 'EXECUTE') $$;

\if :{?phase}
\else
  \echo 'FATAL: run with -v phase=pre or -v phase=post'
  \quit
\endif
\set is_post `test :phase = post && echo true || echo false`

-- ── The temp-table shadow attack on is_admin() ──────────────────────────────
-- A session that can run arbitrary SQL as authenticated creates a TEMP table
-- named profiles, makes itself an admin in it, and calls is_admin(). Returns
-- what is_admin() answered. (Not reachable through PostgREST; latent.)
CREATE OR REPLACE FUNCTION attack_is_admin(p_grant_to_public boolean) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE r boolean; attacker constant text := '33333333-3333-3333-3333-333333333333';
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', attacker)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  CREATE TEMP TABLE profiles (id uuid, role text) ON COMMIT DROP;
  INSERT INTO profiles VALUES (attacker::uuid, 'admin');
  IF p_grant_to_public THEN EXECUTE 'GRANT SELECT ON profiles TO PUBLIC'; END IF;
  SELECT public.is_admin() INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION is_admin_as(p_role text, p_sub text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE r boolean;
BEGIN
  IF p_sub IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub)::text, true);
  END IF;
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  SELECT public.is_admin() INTO r;
  RETURN r;
END $$;

\echo ''
\if :is_post
\echo '=== POST-MIGRATION: required end state ================================='

\echo '--- public.is_admin() ---'
DO $$
DECLARE f constant regprocedure := 'public.is_admin()'::regprocedure; p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = f;
  PERFORM assert(p.prosecdef, 'is_admin() is still SECURITY DEFINER');
  PERFORM assert(p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp'],
    'is_admin() search_path is exactly "public, pg_temp" (was unpinned)');
  PERFORM assert(NOT can_exec('public', f) AND NOT ('PUBLIC' = ANY (exec_grantees(f))),
    'PUBLIC cannot EXECUTE is_admin()');
  PERFORM assert(NOT can_exec('anon', f),          'anon cannot EXECUTE is_admin()');
  PERFORM assert(can_exec('authenticated', f),     'authenticated can EXECUTE is_admin()');
  PERFORM assert(can_exec('service_role', f),      'service_role can EXECUTE is_admin()');
  PERFORM assert(exec_grantees(f) = ARRAY['authenticated','backup_ro','postgres','service_role'],
    'is_admin() EXECUTE is held by exactly authenticated, backup_ro, service_role and the owner (got '
    || exec_grantees(f)::text || ')');
END $$;

\echo '--- public.rls_auto_enable() ---'
DO $$
DECLARE f constant regprocedure := 'public.rls_auto_enable()'::regprocedure; p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = f;
  PERFORM assert(p.prosecdef, 'rls_auto_enable() is still SECURITY DEFINER');
  PERFORM assert(p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog'],
    'rls_auto_enable() search_path is still exactly pg_catalog');
  PERFORM assert(p.prorettype = 'event_trigger'::regtype, 'rls_auto_enable() still RETURNS event_trigger');
  PERFORM assert(NOT can_exec('public', f) AND NOT ('PUBLIC' = ANY (exec_grantees(f))),
    'PUBLIC cannot EXECUTE rls_auto_enable()');
  PERFORM assert(NOT can_exec('anon', f),          'anon cannot EXECUTE rls_auto_enable()');
  PERFORM assert(NOT can_exec('authenticated', f), 'authenticated cannot EXECUTE rls_auto_enable()');
  PERFORM assert(can_exec('service_role', f),      'service_role can still EXECUTE rls_auto_enable() (unchanged)');
  PERFORM assert(can_exec('backup_ro', f),         'backup_ro can still EXECUTE rls_auto_enable() (unchanged)');
  PERFORM assert(exec_grantees(f) = ARRAY['backup_ro','postgres','service_role'],
    'rls_auto_enable() EXECUTE is held by exactly backup_ro, service_role and the owner (got '
    || exec_grantees(f)::text || ')');
END $$;

\echo '--- ensure_rls event trigger ---'
DO $$
DECLARE e pg_event_trigger%ROWTYPE;
BEGIN
  SELECT * INTO e FROM pg_event_trigger WHERE evtname = 'ensure_rls';
  PERFORM assert(FOUND, 'the ensure_rls event trigger still exists');
  PERFORM assert(e.evtenabled = 'O', 'ensure_rls is still enabled (evtenabled = O)');
  PERFORM assert(e.evtevent = 'ddl_command_end', 'ensure_rls still fires on ddl_command_end');
  PERFORM assert(e.evttags = ARRAY['CREATE TABLE','CREATE TABLE AS','SELECT INTO'],
    'ensure_rls still filters on CREATE TABLE / CREATE TABLE AS / SELECT INTO');
  PERFORM assert(e.evtfoid = 'public.rls_auto_enable()'::regprocedure,
    'ensure_rls is still bound to public.rls_auto_enable() (same OID)');
END $$;

\echo '--- ensure_rls still FIRES for a non-owner role with no EXECUTE on the function ---'
DROP TABLE IF EXISTS public.rls_probe_create, public.rls_probe_ctas, public.rls_probe_into;
SET ROLE ddl_author;
CREATE TABLE public.rls_probe_create (x int);
CREATE TABLE public.rls_probe_ctas AS SELECT 1 AS x;
SELECT 1 AS x INTO public.rls_probe_into;
RESET ROLE;
DO $$
DECLARE n int;
BEGIN
  PERFORM assert(NOT can_exec('ddl_author', 'public.rls_auto_enable()'::regprocedure),
    'the DDL author holds no EXECUTE on rls_auto_enable() (the trigger must not depend on it)');
  SELECT count(*) INTO n FROM pg_class
   WHERE relname IN ('rls_probe_create','rls_probe_ctas','rls_probe_into') AND relrowsecurity;
  PERFORM assert(n = 3, 'RLS was auto-enabled on tables made by CREATE TABLE, CREATE TABLE AS and SELECT INTO (got '
    || n || ' of 3)');
END $$;

\echo '--- is_admin() behaviour: unchanged for legitimate callers, temp-table shadow closed ---'
DO $$
BEGIN
  PERFORM assert(is_admin_as('authenticated', '11111111-1111-1111-1111-111111111111') IS TRUE,
    'an authenticated admin still gets true from is_admin()');
END $$;
DO $$
BEGIN
  PERFORM assert(is_admin_as('authenticated', '22222222-2222-2222-2222-222222222222') IS FALSE,
    'an authenticated non-admin still gets false from is_admin()');
END $$;
DO $$
BEGIN
  PERFORM assert(is_admin_as('service_role', NULL) IS FALSE,
    'service_role can still call is_admin() (no user identity, so false)');
END $$;
DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM is_admin_as('anon', NULL);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  PERFORM assert(denied, 'anon is denied direct EXECUTE on is_admin()');
END $$;
DO $$
BEGIN
  PERFORM assert(attack_is_admin(false) IS NOT TRUE, 'temp-table shadow attack (plain) does not make is_admin() true');
END $$;
DO $$
BEGIN
  PERFORM assert(attack_is_admin(true) IS NOT TRUE,
    'temp-table shadow attack (with GRANT SELECT to PUBLIC) does not make is_admin() true');
END $$;

\else
\echo '=== BASELINE (pre-migration, or after rollback): the state being fixed ==='

DO $$
DECLARE fa constant regprocedure := 'public.is_admin()'::regprocedure;
        fr constant regprocedure := 'public.rls_auto_enable()'::regprocedure;
BEGIN
  PERFORM assert((SELECT proconfig FROM pg_proc WHERE oid = fa) IS NULL, 'baseline: is_admin() search_path is unpinned');
  PERFORM assert(can_exec('public', fa) AND can_exec('anon', fa), 'baseline: PUBLIC and anon can EXECUTE is_admin()');
  PERFORM assert(can_exec('public', fr) AND can_exec('anon', fr) AND can_exec('authenticated', fr),
    'baseline: PUBLIC, anon and authenticated can EXECUTE rls_auto_enable()');
  PERFORM assert(exec_grantees(fa) = ARRAY['PUBLIC','anon','authenticated','backup_ro','postgres','service_role'],
    'baseline: is_admin() ACL matches the production pre-migration ACL');
  PERFORM assert(exec_grantees(fr) = ARRAY['PUBLIC','anon','authenticated','backup_ro','postgres','service_role'],
    'baseline: rls_auto_enable() ACL matches the production pre-migration ACL');
END $$;
DO $$
BEGIN
  PERFORM assert(attack_is_admin(true) IS TRUE,
    'baseline: the temp-table shadow attack works against the unpinned is_admin() (so the post-migration check is meaningful)');
END $$;
\endif

\echo ''
\echo 'all assertions for this phase passed'
