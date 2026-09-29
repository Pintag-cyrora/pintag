-- ============================================================================
-- HARDEN public.is_admin() AND public.rls_auto_enable()  (privileges + search_path only)
-- ============================================================================
-- Closes the two functions the "no UNEXPECTED ungated SECURITY DEFINER function
-- is callable by anon" control (scripts/verify-production-security.sql, check
-- 10) has flagged on every run, and which 20260921010000 deliberately left
-- alone. Neither has a CREATE FUNCTION anywhere in this repository (they were
-- created directly on the production database); their live definitions,
-- dependencies, owner and ACL were inspected read-only on 2026-09-29 before
-- this migration was written (diagnostic workflow runs 36540763273,
-- 36542469259, 36542787964 on branch claude/diagnose-is-admin-rls-auto-enable).
--
-- public.is_admin()  -- legacy pre-breach authorization primitive
--   * boolean, SECURITY DEFINER, owner postgres, reads public.profiles.role.
--   * Superseded by is_pintag_admin(): the 2026-08-04 lockdown (a4fc669) removed
--     the is_admin() policies. Live scan: zero references from any policy,
--     view, trigger, default, constraint, index, rule, or function body.
--     Zero callers in any branch/tag/history of this repository.
--   * Supabase API Gateway logs (Logs Explorer, the maximum 7-day window on
--     this plan) show zero requests to /rest/v1/rpc/is_admin, while
--     /rest/v1/rpc/is_pintag_admin shows successful calls in the same window
--     (control: gateway logging is working). Older usage is not observable.
--   * For anon, auth.uid() is NULL so it can only ever return false: anon needs
--     no access. authenticated keeps EXECUTE (a caller can only ever learn its
--     OWN status); service_role, postgres and backup_ro are untouched.
--   * search_path was UNPINNED. Reproduced on a scratch PostgreSQL 16 with a
--     non-superuser definer: a session that can run arbitrary SQL can create a
--     TEMP table named profiles, GRANT SELECT on it to PUBLIC, insert an admin
--     row for itself, and is_admin() then returns true. 'public' alone does NOT
--     fix that (the temp schema is searched first for relations unless pg_temp
--     is named), so pg_temp is named last. PostgREST cannot run such SQL, so
--     this is latent, not currently exploitable through the API.
--     public.profiles is the only relation named profiles in any schema, and no
--     untrusted role holds CREATE on schema public.
--
-- public.rls_auto_enable()  -- event-trigger function behind ensure_rls
--   * RETURNS event_trigger, SECURITY DEFINER, owner postgres, search_path
--     already pinned to pg_catalog (NOT changed here). Bound (same OID) to the
--     enabled event trigger ensure_rls: ddl_command_end, tags CREATE TABLE /
--     CREATE TABLE AS / SELECT INTO. It enables RLS on new public tables.
--   * It cannot be called as a function ("trigger functions can only be called
--     as triggers"), so the broad EXECUTE grants are inert; and event-trigger
--     firing performs no EXECUTE-ACL check (PostgreSQL 17 event_trigger.c:
--     EventTriggerInvoke = fmgr_info + FunctionCallInvoke; the only ACL checks
--     in that file are ownership checks on ALTER/OWNER). Removing PUBLIC / anon
--     / authenticated therefore cannot disable ensure_rls. service_role and
--     backup_ro are deliberately left as they are.
--   * check 10 flags it because it excludes only prorettype 'trigger', and
--     event_trigger is a different type. That control is NOT modified here: the
--     REVOKE below is what makes the check pass.
--
-- Every ACL entry on both functions was granted by postgres (the owner), so a
-- REVOKE run as the owner removes them.
--
-- Idempotent: ALTER ... SET, REVOKE of an already-revoked privilege and GRANT
-- of an already-held one are all no-ops. Each block is wrapped in
-- DO ... EXCEPTION WHEN undefined_function, exactly like 20260915000000 and
-- 20260921010000, so a database that never had these two functions (dev / CI
-- replay) skips them with a NOTICE instead of aborting.
--
-- Touches no data, no RLS policy, no function body, no default privilege, no
-- event trigger. Privileges and one function setting only.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER FUNCTION public.is_admin() SET search_path = public, pg_temp';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'skipping is_admin() (not present)';
  END;

  BEGIN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'skipping rls_auto_enable() (not present)';
  END;
END $$;

COMMIT;

-- ── Verify (read-only) ─────────────────────────────────────────────────────
--   SELECT p.proname,
--          has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_can,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can,
--          p.proconfig, p.proacl
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname IN ('is_admin','rls_auto_enable');
-- EXPECT: is_admin        anon_can=f auth_can=t proconfig={"search_path=public, pg_temp"}
--         rls_auto_enable anon_can=f auth_can=f proconfig={search_path=pg_catalog}
--   SELECT evtname, evtenabled FROM pg_event_trigger WHERE evtname = 'ensure_rls';
-- EXPECT: ensure_rls | O

-- ── ROLLBACK (manual; run as the function owner) ───────────────────────────
-- Restores the exact pre-migration state (unpinned search_path; EXECUTE for
-- PUBLIC and anon on is_admin; PUBLIC, anon and authenticated on
-- rls_auto_enable). authenticated / service_role / backup_ro / postgres on
-- is_admin, and service_role / backup_ro / postgres on rls_auto_enable, were
-- never removed, so nothing else needs re-granting.
--
--   BEGIN;
--   ALTER FUNCTION public.is_admin() RESET search_path;
--   GRANT EXECUTE ON FUNCTION public.is_admin() TO PUBLIC, anon;
--   GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO PUBLIC, anon, authenticated;
--   COMMIT;
