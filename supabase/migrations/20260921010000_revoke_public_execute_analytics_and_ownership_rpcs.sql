-- ============================================================================
-- REVOKE THE DEFAULT PUBLIC EXECUTE GRANT ON FOUR MORE PRIVILEGED FUNCTIONS
-- ============================================================================
-- Found by the 2026-09-21 Verify Production Security investigation (into a
-- run that failed on PR #104's merge commit — established NOT to be caused
-- by that PR; the same "no UNEXPECTED ungated SECURITY DEFINER function"
-- control has flagged this exact set on every run of the workflow, including
-- runs from before PR #104 existed). SAME ROOT CAUSE as
-- 20260818000000_revoke_public_execute.sql and
-- 20260915000000_revoke_anon_execute_ops_alert_and_image_sync.sql: PostgreSQL
-- grants EXECUTE on every new function to PUBLIC by default, and none of the
-- four functions below ever had that default revoked.
--
-- A full repository-wide audit (every `.rpc(...)` call site in every client
-- HTML/JS file and every edge function) was completed BEFORE writing this
-- migration, per each function below:
--
--   Function                        | Direct client caller | Internal caller                                  | Reads data | Writes data | auth.uid() required | PUBLIC EXECUTE needed
--   ---------------------------------|-----------------------|---------------------------------------------------|------------|-------------|----------------------|------------------------
--   owned_party_ids(uuid)            | none found            | RLS policies, always as owned_party_ids(auth.uid())| yes (own party ids only) | no | no (caller passes p_uid; only ever called with auth.uid() in every real call site) | no — `authenticated` already has an explicit grant (20260705000000) covering every real caller; anon's auth.uid() is always NULL, and no anon-scoped policy references this function at all
--   intelligence_daily_metrics(date,date) | none found      | generate-intelligence-report/index.ts, via the Supabase SERVICE ROLE key (bypasses grants entirely) | yes — aggregated search/lead/conversion metrics | no | no | no
--   point_in_time_supply_snapshot()  | none found            | same as above                                      | yes — aggregated inventory/pricing | no | no | no
--   ensure_daily_metrics_snapshot(date,date) | none found    | same as above                                      | yes (via intelligence_daily_metrics) | yes — idempotent INSERT ... ON CONFLICT DO NOTHING into daily_metrics_snapshot | no | no
--
-- None of the four is identity-scoped internally (no auth.uid() check in the
-- body), so PUBLIC execute meant anon could call intelligence_daily_metrics/
-- point_in_time_supply_snapshot/ensure_daily_metrics_snapshot directly and
-- read the full aggregate business data (or, for the last one, force a
-- snapshot write) with no authentication at all — and could call
-- owned_party_ids(<any uuid>) although, with auth.uid() always NULL for
-- anon, that specific call always returns an empty set today. The one real
-- caller of the three intelligence functions (generate-intelligence-report)
-- already authenticates with the service-role key, which bypasses grants
-- entirely — revoking PUBLIC changes nothing for it.
--
-- WHY REVOKING FROM PUBLIC DOES NOT BREAK ANY REAL CALLER:
-- owned_party_ids(uuid) keeps its existing, unmodified `GRANT ... TO
-- authenticated` (20260705000000_agents_becomes_parties.sql) — this
-- migration only removes PUBLIC's redundant, unused reach to anon. The three
-- intelligence functions get no authenticated/anon grant at all: no caller
-- other than the service-role edge function was found anywhere in this
-- repository, so the least-privilege choice is to leave them reachable only
-- by the role that already has full access regardless of grants.
--
-- WHAT IS DELIBERATELY *NOT* TOUCHED HERE: is_admin and rls_auto_enable, also
-- flagged by the same control. Neither has a CREATE FUNCTION statement
-- anywhere in this repository's migration history — their current
-- production definition and real caller(s), if any, are unknown from static
-- inspection. Revoking blind risks breaking an undocumented real caller;
-- leaving them ungated could be a real hole. Per the investigation's own
-- instruction not to allowlist or revoke ambiguous cases blindly, both are
-- left exactly as they are, so the verifier keeps failing on them until a
-- human inspects their actual production definition (pg_get_functiondef) and
-- decides. See the 2026-09-21 verification report.
--
-- Idempotent and safe to run anywhere: wrapped in DO blocks with
-- EXCEPTION WHEN undefined_function, exactly like the two prior fixes of
-- this shape, so a database missing one of these functions (e.g. a dev DB
-- that has not applied the relevant earlier migration) is skipped rather
-- than aborted, and re-running this file after it has already applied is a
-- no-op (REVOKE of an already-revoked privilege, and GRANT of an
-- already-held one, are both no-ops in PostgreSQL).
--
-- Touches no data, no RLS policy, no function definition. Privileges only.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION owned_party_ids(uuid) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION owned_party_ids(uuid) FROM anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION owned_party_ids(uuid) TO authenticated';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'skipping owned_party_ids(uuid) (not present)';
  END;

  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION intelligence_daily_metrics(date, date) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION intelligence_daily_metrics(date, date) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION intelligence_daily_metrics(date, date) FROM authenticated';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'skipping intelligence_daily_metrics(date, date) (not present)';
  END;

  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION point_in_time_supply_snapshot() FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION point_in_time_supply_snapshot() FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION point_in_time_supply_snapshot() FROM authenticated';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'skipping point_in_time_supply_snapshot() (not present)';
  END;

  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION ensure_daily_metrics_snapshot(date, date) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION ensure_daily_metrics_snapshot(date, date) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION ensure_daily_metrics_snapshot(date, date) FROM authenticated';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'skipping ensure_daily_metrics_snapshot(date, date) (not present)';
  END;
END $$;

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   SELECT p.proname,
--          has_function_privilege('anon',   p.oid, 'EXECUTE') AS anon_can,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public'
--     AND p.proname IN ('owned_party_ids','intelligence_daily_metrics',
--                        'point_in_time_supply_snapshot','ensure_daily_metrics_snapshot')
--   ORDER BY p.proname;
-- EXPECT: anon_can = false for all four rows; auth_can = true only for
-- owned_party_ids, false for the other three.
