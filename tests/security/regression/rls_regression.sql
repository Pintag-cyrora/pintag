-- ============================================================================
-- SECURITY REGRESSION ASSERTIONS — data layer (2026-08-17 audit)
-- ============================================================================
-- Run against a throwaway PostgreSQL instance seeded by schema.sql and then
-- migrated by supabase/migrations/20260817000000_security_audit_hardening.sql:
--
--     bash tests/security/regression/run-local-pg.sh
--
-- Every assertion below corresponds to a CONFIRMED bypass found in the audit.
-- The whole point is that reverting any part of the hardening migration must
-- make this file fail loudly rather than silently reopen the hole. Each
-- assertion also checks the LEGITIMATE path still works, so a future "fix"
-- that simply denies everyone cannot pass either.
--
-- Any failed assertion raises an exception, which aborts psql under
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

-- Become a given caller: sets the JWT claims PostgREST would set, then the role.
CREATE OR REPLACE FUNCTION become_anon() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{}', true);
  EXECUTE 'SET LOCAL ROLE anon';
END $$;

CREATE OR REPLACE FUNCTION become_user(p_uid uuid, p_email text, p_aal text DEFAULT 'aal1')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'email', p_email, 'role', 'authenticated', 'aal', p_aal)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

\echo ''
\echo '=== A. property_engagement must NOT bypass RLS on properties ==========='

-- A1: anonymous read through the view must expose ONLY publicly-readable rows.
-- Pre-fix this returned all three seeded listings (draft + soft-deleted
-- included), which handed an attacker the ids/slugs of unpublished inventory.
DO $$
DECLARE n_view int; n_table int;
BEGIN
  PERFORM become_anon();
  SELECT count(*) INTO n_view  FROM property_engagement;
  SELECT count(*) INTO n_table FROM properties;
  RESET ROLE;
  PERFORM assert(n_view = n_table,
    'anon sees the same row count through property_engagement as through properties (view honours RLS)');
  PERFORM assert(n_view = 1,
    'anon sees exactly the 1 published listing through property_engagement');
END $$;

-- A2: the specific unpublished rows must be absent by slug, not merely counted.
DO $$
DECLARE leaked text;
BEGIN
  PERFORM become_anon();
  SELECT string_agg(slug, ',') INTO leaked
  FROM property_engagement WHERE slug IN ('secret-draft', 'removed-listing');
  RESET ROLE;
  PERFORM assert(leaked IS NULL,
    'anon cannot enumerate draft or soft-deleted listings through property_engagement');
END $$;

-- A3: the administrator must still see everything through the view.
DO $$
DECLARE n int;
BEGIN
  PERFORM become_user('aaaaaaaa-0000-0000-0000-000000000001', 'cyrora.trading@gmail.com', 'aal2');
  SELECT count(*) INTO n FROM property_engagement;
  RESET ROLE;
  PERFORM assert(n = 3, 'the administrator still sees every listing through property_engagement');
END $$;

-- A4: the option itself is set — guards against a future CREATE OR REPLACE
-- VIEW that silently drops it (replacing a view resets its options).
DO $$
DECLARE opts text[];
BEGIN
  SELECT reloptions INTO opts FROM pg_class WHERE relname = 'property_engagement';
  PERFORM assert(opts @> ARRAY['security_invoker=true'],
    'property_engagement carries security_invoker=true');
END $$;

\echo ''
\echo '=== B. rebuild_images_from_registry() must be admin-only =============='

-- B1: a signed-up non-admin must not read the admin-only image registry.
-- Pre-fix this returned the draft listing''s storage URL — and the bucket is
-- public-read, so the URL is the access.
DO $$
DECLARE got jsonb; denied boolean := false;
BEGIN
  PERFORM become_user('bbbbbbbb-0000-0000-0000-000000000002', 'signed-up-attacker@example.com', 'aal2');
  BEGIN
    SELECT rebuild_images_from_registry('22222222-0000-0000-0000-000000000002') INTO got;
  EXCEPTION WHEN OTHERS THEN denied := true;
  END;
  RESET ROLE;
  PERFORM assert(denied, 'authenticated non-admin is denied rebuild_images_from_registry()');
END $$;

-- B2: an admin whose session is only AAL1 (password, no TOTP yet) is denied too.
DO $$
DECLARE got jsonb; denied boolean := false;
BEGIN
  PERFORM become_user('aaaaaaaa-0000-0000-0000-000000000001', 'cyrora.trading@gmail.com', 'aal1');
  BEGIN
    SELECT rebuild_images_from_registry('22222222-0000-0000-0000-000000000002') INTO got;
  EXCEPTION WHEN OTHERS THEN denied := true;
  END;
  RESET ROLE;
  PERFORM assert(denied, 'admin WITHOUT MFA (aal1) is denied rebuild_images_from_registry()');
END $$;

-- B3: the real administrator (aal2) still gets a working DR rebuild.
DO $$
DECLARE got jsonb;
BEGIN
  PERFORM become_user('aaaaaaaa-0000-0000-0000-000000000001', 'cyrora.trading@gmail.com', 'aal2');
  SELECT rebuild_images_from_registry('22222222-0000-0000-0000-000000000002') INTO got;
  RESET ROLE;
  PERFORM assert(jsonb_array_length(got) = 1,
    'the MFA-verified administrator still gets the gallery back from the registry');
END $$;

\echo ''
\echo '=== C. reset_weekly_views() must not trust an email address ============'

-- C1: THE headline case. An attacker re-registers admin@pintag.io — the legacy
-- address deleted during the migration to cyrora — and calls the function.
-- Pre-fix the email comparison passed and every listing''s weekly counter was
-- zeroed through a SECURITY DEFINER that bypasses RLS.
DO $$
DECLARE denied boolean := false; before_sum bigint; after_sum bigint;
BEGIN
  UPDATE properties SET views_week = 7;
  SELECT sum(views_week) INTO before_sum FROM properties;

  PERFORM become_user('cccccccc-0000-0000-0000-000000000003', 'admin@pintag.io', 'aal2');
  BEGIN
    PERFORM reset_weekly_views();
  EXCEPTION WHEN OTHERS THEN denied := true;
  END;
  RESET ROLE;

  SELECT sum(views_week) INTO after_sum FROM properties;
  PERFORM assert(denied,
    'an attacker holding the re-registered admin@pintag.io address is denied reset_weekly_views()');
  PERFORM assert(before_sum = after_sum,
    'no weekly counter was modified by the impostor call');
END $$;

-- C2: an ordinary signed-up account is denied.
DO $$
DECLARE denied boolean := false;
BEGIN
  PERFORM become_user('bbbbbbbb-0000-0000-0000-000000000002', 'signed-up-attacker@example.com', 'aal2');
  BEGIN PERFORM reset_weekly_views(); EXCEPTION WHEN OTHERS THEN denied := true; END;
  RESET ROLE;
  PERFORM assert(denied, 'authenticated non-admin is denied reset_weekly_views()');
END $$;

-- C3: the real administrator can run it again (it was broken for everyone
-- while the guard named a deleted account — the fix restores it).
DO $$
DECLARE after_sum bigint;
BEGIN
  UPDATE properties SET views_week = 7;
  PERFORM become_user('aaaaaaaa-0000-0000-0000-000000000001', 'cyrora.trading@gmail.com', 'aal2');
  PERFORM reset_weekly_views();
  RESET ROLE;
  SELECT sum(views_week) INTO after_sum FROM properties;
  PERFORM assert(after_sum = 0, 'the MFA-verified administrator can still reset weekly views');
END $$;

\echo ''
\echo '=== D. public_listing_stats() must only report on visible listings ====='

-- D1: a draft listing''s uuid must yield no intelligence. Pre-fix this returned
-- lead_count=2 and the district for an unpublished listing.
DO $$
DECLARE r json;
BEGIN
  PERFORM become_anon();
  SELECT public_listing_stats('22222222-0000-0000-0000-000000000002') INTO r;
  RESET ROLE;
  PERFORM assert((r->>'lead_count')::int = 0,  'anon gets no lead count for a DRAFT listing');
  PERFORM assert((r->>'view_count')::int = 0,  'anon gets no view count for a DRAFT listing');
  PERFORM assert(r->>'district' IS NULL,       'anon gets no district for a DRAFT listing');
END $$;

-- D2: same for a soft-deleted listing.
DO $$
DECLARE r json;
BEGIN
  PERFORM become_anon();
  SELECT public_listing_stats('33333333-0000-0000-0000-000000000003') INTO r;
  RESET ROLE;
  PERFORM assert((r->>'view_count')::int = 0, 'anon gets no stats for a SOFT-DELETED listing');
  PERFORM assert(r->>'district' IS NULL,      'anon gets no district for a SOFT-DELETED listing');
END $$;

-- D3: the published listing''s real social proof is UNCHANGED — the fix must
-- not have broken the public listing page it exists to serve.
DO $$
DECLARE r json;
BEGIN
  PERFORM become_anon();
  SELECT public_listing_stats('11111111-0000-0000-0000-000000000001') INTO r;
  RESET ROLE;
  PERFORM assert((r->>'lead_count')::int = 1,      'a published listing still reports its real lead count');
  PERFORM assert((r->>'view_count')::int = 500,    'a published listing still reports its real view count');
  PERFORM assert(r->>'district' = 'Sisattanak',    'a published listing still reports its district');
  PERFORM assert((r->>'is_top_district')::boolean, 'a published listing still earns its district badge');
END $$;

\echo ''
\echo '=== E. increment_listing_view() must not touch invisible listings ======'

DO $$
DECLARE v_draft int; v_deleted int; v_live int;
BEGIN
  PERFORM become_anon();
  PERFORM increment_listing_view('22222222-0000-0000-0000-000000000002');
  PERFORM increment_listing_view('33333333-0000-0000-0000-000000000003');
  PERFORM increment_listing_view('11111111-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT view_count INTO v_draft   FROM properties WHERE slug = 'secret-draft';
  SELECT view_count INTO v_deleted FROM properties WHERE slug = 'removed-listing';
  SELECT view_count INTO v_live    FROM properties WHERE slug = 'published-villa';
  PERFORM assert(v_draft = 90,    'anon cannot inflate a DRAFT listing''s view counter');
  PERFORM assert(v_deleted = 40,  'anon cannot inflate a SOFT-DELETED listing''s view counter');
  PERFORM assert(v_live = 501,    'anon can still record a genuine view on a published listing');
END $$;

\echo ''
\echo '=== F. baseline: core tables stay closed to non-admins ================='

-- Not part of the audit fixes — a tripwire so a future migration that
-- accidentally re-introduces a permissive policy (the 2026-08-03 breach
-- pattern) fails here rather than in production.
DO $$
DECLARE n int; wrote boolean := false;
BEGIN
  PERFORM become_user('bbbbbbbb-0000-0000-0000-000000000002', 'signed-up-attacker@example.com', 'aal2');
  SELECT count(*) INTO n FROM properties;
  BEGIN
    UPDATE properties SET title_en = 'DEFACED' WHERE slug = 'published-villa';
    GET DIAGNOSTICS n = ROW_COUNT;
    wrote := n > 0;
  EXCEPTION WHEN OTHERS THEN wrote := false;
  END;
  RESET ROLE;
  PERFORM assert(NOT wrote, 'authenticated non-admin cannot UPDATE properties');
  PERFORM assert((SELECT title_en FROM properties WHERE slug = 'published-villa') <> 'DEFACED',
    'no listing was defaced');
END $$;

DO $$
DECLARE n int;
BEGIN
  PERFORM become_user('bbbbbbbb-0000-0000-0000-000000000002', 'signed-up-attacker@example.com', 'aal2');
  SELECT count(*) INTO n FROM property_images;
  RESET ROLE;
  PERFORM assert(n = 0, 'authenticated non-admin reads zero rows from property_images');
END $$;

\echo ''
\echo 'ALL DATA-LAYER SECURITY REGRESSION ASSERTIONS PASSED'
