-- ============================================================================
-- SECURITY AUDIT HARDENING (2026-08-17)
-- ============================================================================
-- Four data-layer findings from the full-surface audit. Each is an RLS or
-- authorization BYPASS: a path that reaches rows the caller's own policies
-- would refuse. None of them touch a single row of production data — this
-- migration only redefines one view's execution mode and three functions'
-- authorization gates.
--
-- Shared root cause for #1: in PostgreSQL a view executes with the privileges
-- of its OWNER unless `security_invoker` is set, so RLS on the underlying
-- table is evaluated as the owner (postgres) — not as anon/authenticated.
-- Shared root cause for #2-#4: SECURITY DEFINER bypasses RLS by construction,
-- so the authorization check MUST live in the function body. Every other
-- admin-facing definer function in this schema already does this
-- (analytics_*, owner_portfolio, listing_timeline, rebuild_gallery); the
-- three below were the ones that did not.
--
-- Idempotent (CREATE OR REPLACE / ALTER VIEW), atomic, and re-runnable.
-- Rollback for each item is noted inline.
-- ============================================================================

BEGIN;

-- ── 1. property_engagement: view bypassed RLS on `properties` ───────────────
-- FINDING (confirmed on PostgreSQL 16): `property_engagement`
-- (20260622000000_engagement_metrics.sql) selects from `properties` with no
-- status filter and no `security_invoker`, so it ran as its owner and RLS was
-- never applied to the caller. An anonymous caller reading the view received
-- every row — including DRAFT listings and SOFT-DELETED ones — leaking their
-- `id` and `slug`, while the same caller reading `properties` directly is
-- correctly limited to `status IN ('active','available') AND deleted_at IS NULL`
-- by the "public read active properties" policy (20260806020000).
--
-- The leaked ids/slugs are also the key that unlocks public_listing_stats()
-- (fixed in #4 below) for unpublished listings, so the two chained.
--
-- FIX: run the view as the INVOKER, so the caller's own RLS policies apply.
-- With this set, anon sees exactly the rows the public read policy allows and
-- the administrator still sees everything — identical behaviour to querying
-- `properties` directly, which is what a derived view should always have had.
-- No application code reads this view (verified by repo-wide grep), so this
-- cannot change any page's behaviour; it only removes the bypass.
--
-- Rollback: ALTER VIEW property_engagement SET (security_invoker = false);
ALTER VIEW IF EXISTS public.property_engagement SET (security_invoker = true);

-- ── 2. rebuild_images_from_registry(): missing admin gate ───────────────────
-- FINDING: the function is SECURITY DEFINER and GRANTed to `authenticated`
-- (20260813000000_property_images_registry.sql) but had NO check in its body,
-- while the table it reads — `property_images` — is admin-only under RLS
-- ("admin read property_images"). Any authenticated non-admin could therefore
-- POST /rest/v1/rpc/rebuild_images_from_registry with an arbitrary property
-- uuid and receive that listing's storage URLs, including for draft and
-- soft-deleted listings and for images already soft-removed from a gallery.
-- Because `property-images` is a public-read bucket, the URL IS the access.
--
-- FIX: gate the body on is_pintag_admin(auth.uid()) — the same single
-- authorization primitive (allowlist membership AND an aal2/MFA session) every
-- other admin definer function uses. Converted to plpgsql purely to host the
-- guard; the query, ordering, return type, and DR behaviour are unchanged, so
-- the administrator's own recovery workflow is untouched.
--
-- Rollback: re-run the CREATE OR REPLACE block from
-- 20260813000000_property_images_registry.sql.
CREATE OR REPLACE FUNCTION rebuild_images_from_registry(p_property uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_pintag_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: admin only';
  END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(storage_url ORDER BY display_order), '[]'::jsonb)
    FROM property_images
    WHERE property_id = p_property AND status = 'active'
  );
END;
$$;

COMMENT ON FUNCTION rebuild_images_from_registry(uuid) IS
  'DR: reconstruct a listing''s ordered image URL array (cover first) purely from the registry, independent of properties.images. Admin-only: SECURITY DEFINER bypasses the admin-only RLS on property_images, so the is_pintag_admin() gate lives in the body.';

-- ── 3. reset_weekly_views(): guard keyed on a DELETED account ───────────────
-- FINDING: the guard was `IF auth.email() != 'admin@pintag.io' THEN RAISE`
-- (20260625000005). That account was deliberately removed from auth.users by
-- scripts/migrate-admin-to-cyrora-and-remove-legacy-accounts.sql when
-- administration moved to cyrora, so the email is now UNCLAIMED. If public
-- sign-up is ever enabled on the project (tracked as an open operator toggle
-- in docs/L1_SECURITY_BASELINE_2026-08-06.md), an attacker who registers
-- admin@pintag.io satisfies this guard and the function — SECURITY DEFINER,
-- therefore bypassing RLS — executes `UPDATE properties SET views_week = 0`
-- across every listing. A self-service signup would become an unauthenticated
-- write to the most protected table in the schema.
--
-- A string comparison against an email address is not an authorization
-- boundary: emails are re-registerable, RLS is not keyed on them anywhere
-- else, and this was the last function in the schema still doing it.
--
-- FIX: use is_pintag_admin(auth.uid()) — allowlist membership by immutable
-- auth uid plus a verified MFA session. Re-registering an email grants a new
-- uid that is not in admin_accounts, so the attack path closes completely.
-- This also RESTORES the function for the real administrator, who could not
-- call it at all while the guard named a nonexistent account.
--
-- Rollback: re-run the CREATE OR REPLACE block from
-- 20260625000005_reset_weekly_views_admin_only.sql.
CREATE OR REPLACE FUNCTION reset_weekly_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_pintag_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: admin only';
  END IF;
  UPDATE properties SET views_week = 0;
END;
$$;

COMMENT ON FUNCTION reset_weekly_views() IS
  'Zero the weekly view counters. Admin-only via is_pintag_admin(auth.uid()) — never an email comparison: the previously-named admin@pintag.io account was deleted and its address is re-registerable.';

-- ── 4. public_listing_stats(): reported on NON-PUBLIC listings ──────────────
-- FINDING: SECURITY DEFINER and GRANTed to anon, but it looked up the property
-- by id alone with no status/deleted_at filter. Anyone holding a listing uuid
-- — including one harvested through the property_engagement bypass in #1, or
-- retained after a listing was unpublished — could read that listing's lead
-- counts, view counts and district even though RLS makes the listing itself
-- invisible to them. Aggregates about an unpublished listing are still a
-- disclosure: they confirm the listing exists and expose commercial demand
-- signals for properties the operator has deliberately taken off the site.
--
-- FIX: resolve the property through the SAME predicate as the public read
-- policy, and return the neutral empty-stats object when it does not match.
-- Every listing a visitor can actually open on listing.html satisfies that
-- predicate (an unavailable/sold/rented listing still has status='active' —
-- only workflow drafts and soft-deletes do not), so the public page's social
-- proof, FOMO lines and badges are unaffected; only stats for listings the
-- caller was never allowed to see stop being served.
--
-- The is_top_district comparison additionally now excludes soft-deleted rows,
-- which could previously win "Most Viewed in District" while being invisible.
--
-- Rollback: re-run the CREATE OR REPLACE block from
-- 20260623000004_engagement_badges.sql.
CREATE OR REPLACE FUNCTION public_listing_stats(p_listing_id UUID)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_count  INTEGER := 0;
  v_lead_week   INTEGER := 0;
  v_lead_month  INTEGER := 0;
  v_view_count  INTEGER := 0;
  v_views_week  INTEGER := 0;
  v_is_top      BOOLEAN := FALSE;
  v_district    TEXT;
  v_visible     BOOLEAN := FALSE;
BEGIN
  -- Visibility gate FIRST: mirrors the "public read active properties" policy
  -- (20260806020000) exactly. A definer function granted to anon must never
  -- answer questions about a row anon cannot read.
  SELECT TRUE, COALESCE(view_count, 0), COALESCE(views_week, 0), district_en
    INTO v_visible, v_view_count, v_views_week, v_district
  FROM properties
  WHERE id = p_listing_id
    AND status IN ('active', 'available')
    AND deleted_at IS NULL;

  IF NOT COALESCE(v_visible, FALSE) THEN
    -- Same shape as a real response, all zeroes: a not-visible listing is
    -- indistinguishable from one with no activity, so this cannot be used
    -- as an existence oracle either.
    RETURN json_build_object(
      'lead_count', 0, 'lead_week', 0, 'lead_month', 0,
      'view_count', 0, 'views_week', 0,
      'is_top_district', FALSE, 'district', NULL
    );
  END IF;

  SELECT
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::INTEGER,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::INTEGER
  INTO v_lead_count, v_lead_week, v_lead_month
  FROM lead_events
  WHERE listing_id = p_listing_id;

  IF v_district IS NOT NULL AND v_view_count > 0 THEN
    SELECT (p_listing_id = (
      SELECT id FROM properties
      WHERE district_en = v_district
        AND status = 'active'
        AND deleted_at IS NULL
      ORDER BY COALESCE(view_count, 0) DESC
      LIMIT 1
    )) INTO v_is_top;
  END IF;

  RETURN json_build_object(
    'lead_count',      v_lead_count,
    'lead_week',       v_lead_week,
    'lead_month',      v_lead_month,
    'view_count',      v_view_count,
    'views_week',      v_views_week,
    'is_top_district', COALESCE(v_is_top, FALSE),
    'district',        v_district
  );
END;
$$;

COMMENT ON FUNCTION public_listing_stats(UUID) IS
  'Public social-proof aggregates for ONE listing. SECURITY DEFINER (it reads lead_events, which anon cannot select), so it re-implements the public read predicate itself and returns zeroed stats for any listing anon could not read directly.';

-- ── 5. increment_listing_view(): could bump a soft-deleted listing ──────────
-- Minor correctness/consistency fix in the same family: the counter's own
-- guard predated soft delete and checked only `status = 'active'`, so a
-- soft-deleted listing (status stays 'active', deleted_at is set) could still
-- have its counters incremented by anonymous callers. Align it with the public
-- visibility predicate. NOTE: this does NOT address unauthenticated view-count
-- inflation in general — see the audit report; that needs an edge rate limit,
-- not a database change.
--
-- Rollback: re-run the CREATE OR REPLACE block from
-- 20260623000004_engagement_badges.sql.
CREATE OR REPLACE FUNCTION increment_listing_view(p_listing_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE properties
  SET view_count = COALESCE(view_count, 0) + 1,
      views_week = COALESCE(views_week, 0) + 1
  WHERE id = p_listing_id
    AND status = 'active'
    AND deleted_at IS NULL;
END;
$$;

COMMIT;

-- ── Verify (Supabase SQL editor / psql) ─────────────────────────────────────
-- 1. View now runs as invoker:
--      SELECT relname, reloptions FROM pg_class WHERE relname = 'property_engagement';
--      EXPECT reloptions to contain security_invoker=true
-- 2. Anon can no longer enumerate unpublished listings through it:
--      SET ROLE anon; SELECT count(*) FROM property_engagement;
--      EXPECT: equals the count of active, non-deleted listings only.
-- 3. Non-admin authenticated session:
--      SELECT rebuild_images_from_registry('<any uuid>');  -- EXPECT: admin only
--      SELECT reset_weekly_views();                        -- EXPECT: admin only
-- 4. Anon: SELECT public_listing_stats('<a draft listing uuid>');
--      EXPECT: all-zero object, district null.
--    Anon: SELECT public_listing_stats('<a live listing uuid>');
--      EXPECT: real counts, unchanged from before this migration.
-- 5. Regression suite: bash tests/security/regression/run-local-pg.sh
