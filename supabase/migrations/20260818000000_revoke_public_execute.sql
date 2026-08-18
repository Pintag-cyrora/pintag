-- ============================================================================
-- REVOKE THE DEFAULT PUBLIC EXECUTE GRANT ON PRIVILEGED FUNCTIONS
-- ============================================================================
-- Found by the 2026-08-18 production verification run, which is the first time
-- anything actually called these functions as an anonymous caller.
--
-- ROOT CAUSE — two independent defects that only combine into a vulnerability:
--
--   1. PostgreSQL grants EXECUTE on every new function to PUBLIC by default.
--      20260625000005 wrote `GRANT EXECUTE ON FUNCTION reset_weekly_views() TO
--      authenticated` and reasonably read that as "only authenticated may call
--      it". It is not: the implicit PUBLIC grant was never revoked, so `anon`
--      could call it too. Confirmed in production:
--        has_function_privilege('anon','reset_weekly_views()','EXECUTE') = true
--
--   2. The guard was `IF auth.email() != 'admin@pintag.io' THEN RAISE`. For an
--      anonymous caller auth.email() is NULL, and `NULL != 'x'` is NULL — not
--      TRUE. The IF therefore does not fire, execution falls through, and
--      `UPDATE properties SET views_week = 0` runs. A guard written to deny
--      everyone except one address in fact denied nobody who had no address.
--
-- Reproduced on PostgreSQL 16 (21 -> 0 with the old guard, "Access denied"
-- with the new one), and observed for real in production during verification.
--
-- Defect 2 is already fixed by 20260817000000, which replaces the comparison
-- with `NOT is_pintag_admin(auth.uid())` — that returns FALSE for anon, so NOT
-- FALSE is TRUE and the exception fires. This migration closes defect 1 as
-- well, so that the next function written with an implicit PUBLIC grant and a
-- subtly wrong guard is not reachable by anonymous callers in the first place.
--
-- Belt and braces on purpose: either fix alone is sufficient. Neither is
-- sufficient to rely on alone.
--
-- Idempotent. Touches no data. Only privileges change.
-- ============================================================================

BEGIN;

-- ── Admin-only functions: nobody but `authenticated` may even attempt them ──
-- The is_pintag_admin() gate inside each one still does the real work; this
-- removes the ability of an unauthenticated caller to reach that gate at all.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'reset_weekly_views()',
    'rebuild_images_from_registry(uuid)',
    'pintag_client_network_probe()',
    'listing_timeline(uuid)',
    'owner_portfolio(uuid)'
  ] LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    EXCEPTION WHEN undefined_function THEN
      -- Not every function exists in every environment (e.g. a database that
      -- has not yet applied the image-registry migration). Skip rather than
      -- abort: this migration must be safe to run anywhere.
      RAISE NOTICE 'skipping % (not present)', fn;
    END;
  END LOOP;
END $$;

-- ── The analytics aggregate RPCs: admin-facing, never public ────────────────
-- Each already raises 'Access denied: staff only' internally. Same reasoning:
-- an anonymous caller should not be able to reach the gate.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'analytics\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
  END LOOP;
END $$;

-- ── Deliberately PUBLIC, and left alone ─────────────────────────────────────
-- public_listing_stats(uuid), increment_listing_view(uuid),
-- market_transition_stats(text,text,text), is_pintag_admin(uuid),
-- and the check_*_rate_limit / dedup / ceiling helpers are called by the
-- anonymous public site and MUST stay executable by anon. Each is safe by
-- construction: they either return only publicly-visible aggregates, or they
-- are policy helpers whose effect is bounded by the policy that calls them.

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   SELECT p.proname,
--          has_function_privilege('anon',   p.oid, 'EXECUTE') AS anon_can,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public'
--     AND p.proname IN ('reset_weekly_views','rebuild_images_from_registry',
--                       'pintag_client_network_probe','listing_timeline',
--                       'owner_portfolio')
--   ORDER BY p.proname;
-- EXPECT: anon_can = false for every row; auth_can = true.
