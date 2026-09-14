-- ============================================================================
-- REVOKE THE DEFAULT PUBLIC EXECUTE GRANT ON TWO MORE PRIVILEGED FUNCTIONS
-- ============================================================================
-- Found by the 2026-09-14 Verify Production Security run, once the read-only
-- monitoring role (backup_ro) finally had the schema grants it needed to let
-- scripts/verify-production-security.sql's catalog checks run to completion
-- (control #10) instead of erroring out on a permission-denied before ever
-- reaching them. Confirmed live in production before this migration was
-- written: anon EXECUTE = true and authenticated EXECUTE = true for both
-- functions below; ops_alert_config.webhook_url is currently NULL (no
-- webhook configured), so the live exposure today is the ops_alerts/
-- property_images writes themselves, not an external POST -- but the
-- capability to reach a configured webhook exists in the function body
-- regardless, so it is closed here too.
--
-- SAME ROOT CAUSE as 20260818000000_revoke_public_execute.sql: PostgreSQL
-- grants EXECUTE on every new function to PUBLIC by default. Both functions
-- below were created (20260806030000, 20260813000000) with no GRANT/REVOKE
-- statement of their own, so they inherited that default PUBLIC grant and
-- were never subsequently closed -- 20260818000000 closed five OTHER
-- functions, but these two were not on that list.
--
-- Neither function's own logic is an authorization boundary -- unlike
-- reset_weekly_views()/rebuild_images_from_registry() (which each contain
-- their own is_pintag_admin() gate that the 20260818000000 fix made
-- reachable-or-not), _ops_raise_alert() and pintag_sync_property_images()
-- have NO internal identity check at all, by design: they are meant to be
-- called only from inside other SECURITY DEFINER trigger functions
-- (_properties_delete_guard, _properties_softdelete_alert,
-- pintag_property_images_trg), never directly by a client. Repository-wide
-- search (every .rpc() call site in every client/edge-function file) found
-- zero direct callers of either function -- confirmed in the accompanying
-- investigation, not merely assumed here.
--
-- WHY REVOKING FROM PUBLIC DOES NOT BREAK THE TRIGGER CALLERS:
-- A SECURITY DEFINER function executes its body with the privileges of its
-- OWNER, not its invoker, for every statement inside that body -- including
-- a nested call to another function. _properties_delete_guard(),
-- _properties_softdelete_alert() and pintag_property_images_trg() are all
-- owned by the same role that runs this migration (the same role that
-- created _ops_raise_alert()/pintag_sync_property_images() in the first
-- place), and an object's OWNER always retains full rights on that object
-- regardless of what is granted to or revoked from PUBLIC/anon/authenticated
-- -- ownership is not conferred by a GRANT and is not removed by a REVOKE
-- naming a different role. So an anonymous DELETE/UPDATE on properties still
-- fires these triggers exactly as before; only a DIRECT, external RPC call
-- to _ops_raise_alert()/pintag_sync_property_images() as anon or
-- authenticated is what this migration closes. This is proven empirically,
-- not just asserted, by tests/security/regression/run-ops-alert-and-image-
-- sync-pg.sh, which fires the real triggers under a non-owner role after
-- applying this exact migration file.
--
-- authenticated keeps EXECUTE, deliberately, unmodified: no legitimate
-- caller was found requiring it either, but nothing in the repository shows
-- retaining it is unsafe (severity is the same "should not be directly
-- callable at all" as anon's case, not "retaining it is actively dangerous"),
-- and the request that produced this migration was scoped to the confirmed
-- ANONYMOUS exposure specifically. Tightening authenticated further, if
-- wanted, is a separate, later decision.
--
-- Idempotent and safe to run anywhere: wrapped in DO blocks with
-- EXCEPTION WHEN undefined_function, exactly like 20260818000000, so a
-- database missing one of these functions (e.g. a dev DB that has not
-- applied 20260806030000/20260813000000) is skipped rather than aborted,
-- and re-running this file after it has already applied is a no-op (REVOKE
-- of an already-revoked privilege, and GRANT of an already-held one, are
-- both no-ops in PostgreSQL).
--
-- Touches no data, no RLS policy, no function definition. Privileges only.
-- ============================================================================

BEGIN;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    '_ops_raise_alert(text,text,text,jsonb)',
    'pintag_sync_property_images(uuid,jsonb)'
  ] LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'skipping % (not present)', fn;
    END;
  END LOOP;
END $$;

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   SELECT p.proname,
--          has_function_privilege('anon',   p.oid, 'EXECUTE') AS anon_can,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public'
--     AND p.proname IN ('_ops_raise_alert','pintag_sync_property_images')
--   ORDER BY p.proname;
-- EXPECT: anon_can = false for both rows; auth_can = true for both rows.
