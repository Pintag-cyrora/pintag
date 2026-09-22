-- ============================================================================
-- PRODUCTION SECURITY DRIFT VERIFICATION — 100% READ-ONLY
-- ============================================================================
--   psql "$PINTAG_PROD_DB_URL" -v ON_ERROR_STOP=1 -f scripts/verify-production-security.sql
--
-- Answers ONE question: does the production database actually enforce the
-- security model this repository describes? "The migration is in Git" is not an
-- answer — the 2026-08-03 breach happened because production carried
-- dashboard-created policies no migration file described, and the first storage
-- lockdown was a silent no-op because it dropped policies BY NAME.
--
-- Every statement here is a SELECT against a catalog. It creates nothing, alters
-- nothing, writes nothing, and reads no customer data. It never prints an email
-- address, a token, a key, or any listing content — only counts and object
-- names — so its output is safe to paste into a report or a CI log.
--
-- Output is one row per control:  STATUS | CONTROL | EXPECTED | ACTUAL
-- Any row with STATUS='FAIL' means production diverges from the repository.
-- The final SELECT raises if anything failed, so psql exits non-zero and CI
-- turns red.
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off
\pset border 2

CREATE TEMP TABLE drift(
  ord serial, status text, control text, expected text, actual text
);

-- Helper: record one control.
CREATE OR REPLACE FUNCTION pg_temp.chk(p_control text, p_expected text, p_actual text, p_ok boolean)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO drift(status, control, expected, actual)
  VALUES (CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_control, p_expected, p_actual);
$$;

-- ── 1. Migration ledger ─────────────────────────────────────────────────────
-- Which migrations does production believe it has applied? The two security
-- migrations from the 2026-08-17 audit are the ones under test.
SELECT pg_temp.chk(
  'migration 20260817000000 (security audit hardening) applied',
  'present',
  coalesce((SELECT max(version) FROM supabase_migrations.schema_migrations
            WHERE version = '20260817000000'), 'MISSING'),
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260817000000')
);
SELECT pg_temp.chk(
  'migration 20260817010000 (authz identity + abuse bounds) applied',
  'present',
  coalesce((SELECT max(version) FROM supabase_migrations.schema_migrations
            WHERE version = '20260817010000'), 'MISSING'),
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260817010000')
);
SELECT pg_temp.chk(
  'migration 20260813000000 (property_images registry) applied',
  'present',
  coalesce((SELECT max(version) FROM supabase_migrations.schema_migrations
            WHERE version = '20260813000000'), 'MISSING'),
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260813000000')
);

-- ── 2. RLS enabled on every base table in public ────────────────────────────
SELECT pg_temp.chk(
  'RLS enabled on every public base table',
  '0 tables without RLS',
  (SELECT coalesce(string_agg(c.relname, ', '), '0 tables without RLS')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity),
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity)
);

-- ── 3. No view may bypass RLS (finding F-03) ────────────────────────────────
-- A view without security_invoker runs as its OWNER, so the underlying table's
-- RLS is evaluated as postgres and not as the caller. This is the class of bug
-- property_engagement had.
SELECT pg_temp.chk(
  'every public view runs as invoker (no RLS bypass)',
  'all views security_invoker=true',
  (SELECT coalesce(string_agg(c.relname, ', '), 'none')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind='v'
      AND NOT coalesce(c.reloptions::text LIKE '%security_invoker=true%', false)),
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relkind='v'
                 AND NOT coalesce(c.reloptions::text LIKE '%security_invoker=true%', false))
);

-- ── 4. Write policies must all flow through a legitimate identity-bound gate ─
-- The repository establishes THREE legitimate, identity-bound authorization
-- patterns for a write policy (none of them "open"):
--   * is_pintag_admin(...)  — the single-admin allowlist + AAL2 gate
--     (20260817010000_authz_identity_and_abuse_bounds.sql)
--   * is_pintag_staff(...)  — the broader staff gate
--     (20260705000000_agents_becomes_parties.sql /
--      20260804130000_single_admin_cyrora_lockdown.sql)
--   * owned_party_ids(...)  — self-service ownership scoping, always called
--     as owned_party_ids(auth.uid()) so it can only ever resolve to the
--     CALLER's own party ids, never an arbitrary one
--     (20260705000000_agents_becomes_parties.sql, and reused verbatim by
--      every self-service policy since — see 20260705000400, 20260715000000,
--      20260720000000, 20260728000000, 20260820000000)
-- A policy naming ANY of these is identity-bound, not an open write — e.g.
-- property_contacts' "Staff full access property_contacts" (is_pintag_staff)
-- and "Party manage own property_contacts" (owned_party_ids, ownership-
-- checked) from 20260820000000_multi_phone_contacts.sql are both legitimate
-- and are the reason this check was widened past is_pintag_admin() alone —
-- they were previously flagged as false-positive "bypasses" for having no
-- literal is_pintag_admin substring, despite being real, auth.uid()-bound
-- authorization. This is a STRUCTURAL widening (recognizing three named,
-- documented functions), not a general loosening — a policy naming none of
-- them, or the 2026-08-03 breach's "no gate at all" pattern, still fails.
-- The five append-only anon analytics INSERT policies remain the only named
-- exception (they are correctly anon-writable by design, gated instead by
-- check_event_target_ceiling — see control 9 below).
WITH offenders AS (
  SELECT schemaname||'.'||tablename||' ['||policyname||']' AS p
  FROM pg_policies
  WHERE schemaname IN ('public','storage')
    AND cmd <> 'SELECT'
    AND coalesce(qual,'')       !~ '(is_pintag_admin|is_pintag_staff|owned_party_ids)\s*\('
    AND coalesce(with_check,'') !~ '(is_pintag_admin|is_pintag_staff|owned_party_ids)\s*\('
    AND policyname NOT IN (
      'anon insert lead_events','anon insert listing_events',
      'anon insert search_events','anon insert ui_events','anon insert page_views')
)
SELECT pg_temp.chk(
  'no write policy bypasses a legitimate identity-bound gate',
  'is_pintag_admin(...), is_pintag_staff(...), owned_party_ids(...)-scoped, or the 5 anon analytics INSERT policies',
  (SELECT coalesce(string_agg(p, ', '), 'none')  FROM offenders),
  (SELECT count(*) = 0 FROM offenders)
);

-- ── 5. Storage buckets locked to the administrator ──────────────────────────
WITH w AS (
  SELECT policyname, coalesce(qual,'')||coalesce(with_check,'') AS body
  FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND cmd <> 'SELECT'
)
SELECT pg_temp.chk(
  'every storage WRITE policy requires is_pintag_admin()',
  'all write policies gated',
  (SELECT coalesce(string_agg(policyname, ', '), 'none ungated')
     FROM w WHERE body NOT LIKE '%is_pintag_admin%'),
  (SELECT count(*) = 0 FROM w WHERE body NOT LIKE '%is_pintag_admin%')
);
SELECT pg_temp.chk(
  'no storage policy still keyed on the retired admin@pintag.io address',
  'none',
  (SELECT coalesce(string_agg(policyname, ', '), 'none')
     FROM pg_policies WHERE schemaname='storage'
       AND coalesce(qual,'')||coalesce(with_check,'') LIKE '%admin@pintag.io%'),
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage'
               AND coalesce(qual,'')||coalesce(with_check,'') LIKE '%admin@pintag.io%')
);

-- ── 6. The authorization primitive itself ───────────────────────────────────
SELECT pg_temp.chk(
  'is_pintag_admin() requires an MFA-verified session (aal2)',
  'definition references aal2',
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%aal2%' THEN 'yes' ELSE 'NO — MFA NOT ENFORCED' END,
  pg_get_functiondef(p.oid) LIKE '%aal2%'
) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='is_pintag_admin';

SELECT pg_temp.chk(
  'is_pintag_admin() answers only about the caller (identity binding)',
  'definition binds p_uid to auth.uid()',
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%p_uid = auth.uid()%' THEN 'yes' ELSE 'no' END,
  pg_get_functiondef(p.oid) LIKE '%p_uid = auth.uid()%'
) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='is_pintag_admin';

-- ── 7. No privileged function may authorize on an email address (F-05) ──────
-- An email is re-registerable; a deleted account's address can be claimed by
-- anyone if sign-up is ever enabled. auth.uid() + the allowlist is the only
-- acceptable check.
WITH bad AS (
  SELECT p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND pg_get_functiondef(p.oid) LIKE '%auth.email()%'
)
SELECT pg_temp.chk(
  'no SECURITY DEFINER function authorizes on auth.email()',
  'none',
  (SELECT coalesce(string_agg(proname, ', '), 'none') FROM bad),
  (SELECT count(*) = 0 FROM bad)
);

-- ── 8. Specific functions the audit fixed ───────────────────────────────────
SELECT pg_temp.chk(
  'rebuild_images_from_registry() is admin-gated (F-04)',
  'body calls is_pintag_admin',
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%is_pintag_admin%' THEN 'gated' ELSE 'UNGATED' END,
  pg_get_functiondef(p.oid) LIKE '%is_pintag_admin%'
) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='rebuild_images_from_registry';

SELECT pg_temp.chk(
  'reset_weekly_views() is admin-gated (F-05)',
  'body calls is_pintag_admin',
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%is_pintag_admin%' THEN 'gated' ELSE 'UNGATED' END,
  pg_get_functiondef(p.oid) LIKE '%is_pintag_admin%'
) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='reset_weekly_views';

SELECT pg_temp.chk(
  'public_listing_stats() filters to publicly-visible listings (F-06)',
  'body checks status + deleted_at',
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%deleted_at IS NULL%' THEN 'filtered' ELSE 'UNFILTERED' END,
  pg_get_functiondef(p.oid) LIKE '%deleted_at IS NULL%'
) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='public_listing_stats';

SELECT pg_temp.chk(
  'increment_listing_view() has an abuse ceiling (F-09)',
  'body references listing_view_throttle',
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%listing_view_throttle%' THEN 'bounded' ELSE 'UNBOUNDED' END,
  pg_get_functiondef(p.oid) LIKE '%listing_view_throttle%'
) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='increment_listing_view';

-- ── 9. Analytics ceilings are wired into the anon INSERT policies (F-08) ────
SELECT pg_temp.chk(
  'anon analytics INSERT policies enforce a target ceiling',
  'lead_events + listing_events reference check_event_target_ceiling',
  (SELECT coalesce(string_agg(tablename, ', '), 'neither'))||' wired',
  (SELECT count(*) = 2 FROM pg_policies
    WHERE policyname IN ('anon insert lead_events','anon insert listing_events')
      AND coalesce(with_check,'') LIKE '%check_event_target_ceiling%')
) FROM pg_policies
WHERE policyname IN ('anon insert lead_events','anon insert listing_events')
  AND coalesce(with_check,'') LIKE '%check_event_target_ceiling%'
LIMIT 1;

-- ── 10. SECURITY DEFINER functions reachable by anon/authenticated ──────────
-- Not a pass/fail: an inventory for human review. Anything appearing here
-- WITHOUT a gate must be a deliberately-public function. The known-public set
-- is listed as expected; a new name showing up is the signal to investigate.
--
-- STRUCTURAL EXCLUSION: p.prorettype <> 'trigger'::regtype. PostgreSQL grants
-- EXECUTE on every newly created function to PUBLIC by default (the same
-- default that made this control necessary in the first place), including
-- trigger functions — but a trigger-type function errors if invoked directly
-- outside trigger context ("trigger functions can only be called as
-- triggers"), so has_function_privilege('anon', ..., 'EXECUTE')=true on one
-- is a privilege-grant technicality, never a working RPC entry point for
-- anon. Excluding by ACTUAL return type (checked against the live catalog,
-- not a name list) correctly handles every trigger function regardless of
-- name or which migration created it — e.g. create_lead_from_event,
-- log_properties_removal, pintag_property_images_trg, snapshot_property_row,
-- _properties_delete_guard, _properties_softdelete_alert,
-- properties_sync_primary_contact all previously showed up here purely
-- because of this default grant, not because any of them are callable as an
-- ordinary RPC. This does NOT change any function's actual grants — see the
-- accompanying migration for the separate, audited set of real (non-trigger)
-- functions whose PUBLIC grant is revoked outright.
SELECT pg_temp.chk(
  'no UNEXPECTED ungated SECURITY DEFINER function is callable by anon',
  'only the deliberately-public ones (trigger-only functions excluded)',
  (SELECT coalesce(string_agg(p.proname, ', '), 'none')
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef
      AND p.prorettype <> 'trigger'::regtype
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND pg_get_functiondef(p.oid) NOT LIKE '%is_pintag_admin%'
      AND p.proname NOT IN (
        'public_listing_stats','increment_listing_view','market_transition_stats',
        'is_pintag_admin','is_pintag_staff',
        'check_lead_rate_limit','check_listing_event_dedup','check_event_target_ceiling',
        'check_search_event_rate_limit','check_ui_event_rate_limit',
        'check_page_view_rate_limit','check_listing_event_burst_limit')),
  NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND p.prorettype <> 'trigger'::regtype
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
       AND pg_get_functiondef(p.oid) NOT LIKE '%is_pintag_admin%'
       AND p.proname NOT IN (
        'public_listing_stats','increment_listing_view','market_transition_stats',
        'is_pintag_admin','is_pintag_staff',
        'check_lead_rate_limit','check_listing_event_dedup','check_event_target_ceiling',
        'check_search_event_rate_limit','check_ui_event_rate_limit',
        'check_page_view_rate_limit','check_listing_event_burst_limit'))
);

-- ── 11. anon must hold no write privilege on core tables ────────────────────
WITH g AS (
  SELECT table_name, privilege_type
  FROM information_schema.role_table_grants
  WHERE grantee = 'anon' AND privilege_type IN ('INSERT','UPDATE','DELETE')
    AND table_name IN ('properties','parties','contacts','owners','unit_types','leads')
)
SELECT pg_temp.chk(
  'anon holds no INSERT/UPDATE/DELETE on core tables',
  'none',
  (SELECT coalesce(string_agg(table_name||':'||privilege_type, ', '), 'none') FROM g),
  (SELECT count(*) = 0 FROM g)
);

-- ── 12. The admin allowlist is small (count only — never print identities) ──
SELECT pg_temp.chk(
  'admin allowlist size',
  'exactly 1 administrator',
  (SELECT count(*)::text FROM admin_accounts),
  (SELECT count(*) = 1 FROM admin_accounts)
);

-- ── 13. Internal tables have no anon-readable policy ────────────────────────
WITH leaky AS (
  SELECT tablename, policyname FROM pg_policies
  WHERE schemaname='public' AND cmd='SELECT'
    AND tablename IN ('owners','leads','admin_accounts','property_images',
                      'intelligence_reports','properties_row_snapshots','listing_view_throttle')
    AND ('anon' = ANY(roles) OR 'public' = ANY(roles))
)
SELECT pg_temp.chk(
  'internal tables expose no anon SELECT policy',
  'none',
  (SELECT coalesce(string_agg(tablename||' ['||policyname||']', ', '), 'none') FROM leaky),
  (SELECT count(*) = 0 FROM leaky)
);

-- ── Report ──────────────────────────────────────────────────────────────────
\echo ''
\echo '================ PRODUCTION SECURITY DRIFT REPORT ================'
SELECT status, control, expected, actual FROM drift ORDER BY ord;

\echo ''
SELECT count(*) FILTER (WHERE status='PASS') AS passed,
       count(*) FILTER (WHERE status='FAIL') AS failed
FROM drift;

-- Exit non-zero when anything drifted, so CI fails loudly instead of printing
-- a report nobody reads.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM drift WHERE status='FAIL';
  IF n > 0 THEN
    RAISE EXCEPTION 'PRODUCTION SECURITY DRIFT: % control(s) do not match the repository security model', n;
  END IF;
  RAISE NOTICE 'No drift: production matches the repository security model.';
END $$;
