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
\echo '=== G. is_pintag_admin() answers only about the CALLER (identity binding) ='

-- G1: an MFA-verified NON-admin must not be able to ask about the administrator.
-- Pre-fix this returned true and acted as an "is this uuid an admin?" oracle;
-- worse, any future policy forwarding a client-supplied id into this check
-- would have become a straight privilege escalation.
DO $$
DECLARE about_admin boolean; about_self boolean;
BEGIN
  PERFORM become_user('bbbbbbbb-0000-0000-0000-000000000002', 'signed-up-attacker@example.com', 'aal2');
  SELECT is_pintag_admin('aaaaaaaa-0000-0000-0000-000000000001') INTO about_admin;
  SELECT is_pintag_admin(auth.uid()) INTO about_self;
  RESET ROLE;
  PERFORM assert(about_admin IS FALSE,
    'a non-admin asking is_pintag_admin(<the administrator''s uuid>) gets false, not an oracle');
  PERFORM assert(about_self IS FALSE, 'a non-admin asking about themselves gets false');
END $$;

-- G2: the administrator still authorizes normally, both explicitly and via NULL.
DO $$
DECLARE self boolean; implicit boolean; other boolean;
BEGIN
  PERFORM become_user('aaaaaaaa-0000-0000-0000-000000000001', 'cyrora.trading@gmail.com', 'aal2');
  SELECT is_pintag_admin(auth.uid()) INTO self;
  SELECT is_pintag_admin(NULL)       INTO implicit;
  SELECT is_pintag_admin('bbbbbbbb-0000-0000-0000-000000000002') INTO other;
  RESET ROLE;
  PERFORM assert(self,     'the MFA-verified administrator still authorizes via is_pintag_admin(auth.uid())');
  PERFORM assert(implicit, 'a NULL argument means "me" and still authorizes the administrator');
  PERFORM assert(other IS FALSE,
    'even the administrator cannot use the function to ask about somebody else');
END $$;

-- G3: anonymous callers get false, never an error (policies must fail closed).
DO $$
DECLARE r boolean;
BEGIN
  PERFORM become_anon();
  SELECT is_pintag_admin('aaaaaaaa-0000-0000-0000-000000000001') INTO r;
  RESET ROLE;
  PERFORM assert(r IS FALSE, 'anon gets false from is_pintag_admin()');
END $$;

\echo ''
\echo '=== H. Analytics ceilings survive session-id rotation (F-08) ==========='

-- H1: THE headline case. Rotating session_id defeats every per-session limit,
-- so the ceiling must be keyed on the TARGET instead. 30/min per
-- (listing, event_type) for lead_events.
DO $$
DECLARE accepted int := 0; i int;
BEGIN
  PERFORM become_anon();
  FOR i IN 1..80 LOOP
    BEGIN
      -- A brand-new session id every single time: exactly what an attacker does.
      INSERT INTO lead_events (listing_id, event_type, session_id)
      VALUES ('11111111-0000-0000-0000-000000000001', 'whatsapp_click',
              'rotated-' || i::text);
      accepted := accepted + 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RESET ROLE;
  PERFORM assert(accepted <= 30,
    format('rotating session ids is bounded by the per-listing ceiling (accepted %s, cap 30)', accepted));
  PERFORM assert(accepted > 0, 'the ceiling did not block everything outright');
END $$;

-- H2: the ceiling is per TARGET — a different listing is unaffected, so one
-- attacker cannot deny analytics for the rest of the catalogue.
DO $$
DECLARE ok boolean := false;
BEGIN
  PERFORM become_anon();
  BEGIN
    INSERT INTO lead_events (listing_id, event_type, session_id)
    VALUES ('11111111-0000-0000-0000-000000000001', 'call_click', 'other-type-session');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false;
  END;
  RESET ROLE;
  PERFORM assert(ok,
    'a DIFFERENT event type on the same listing is still recorded (ceiling is per target+type)');
END $$;

-- H3: a normal visitor is never affected. One genuine contact click on a quiet
-- listing must always be recorded.
DO $$
DECLARE ok boolean := false;
BEGIN
  DELETE FROM lead_events WHERE listing_id = '11111111-0000-0000-0000-000000000001';
  PERFORM become_anon();
  BEGIN
    INSERT INTO lead_events (listing_id, event_type, session_id)
    VALUES ('11111111-0000-0000-0000-000000000001', 'whatsapp_click', 'a-real-visitor');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false;
  END;
  RESET ROLE;
  PERFORM assert(ok, 'a genuine single contact click from a real visitor is still recorded');
END $$;

-- H4: the active-listing requirement from 20260811000000 still holds — the
-- ceiling was added ALONGSIDE it, not instead of it.
DO $$
DECLARE ok boolean := true;
BEGIN
  PERFORM become_anon();
  BEGIN
    INSERT INTO lead_events (listing_id, event_type, session_id)
    VALUES ('22222222-0000-0000-0000-000000000002', 'whatsapp_click', 'draft-probe');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false;
  END;
  RESET ROLE;
  PERFORM assert(NOT ok, 'anon still cannot record an event against a DRAFT listing');
END $$;

\echo ''
\echo '=== I. View-count inflation is bounded (F-09) =========================='

-- I1: an unbounded loop must not produce an unbounded counter.
DO $$
DECLARE before_v int; after_v int; gained int; i int;
BEGIN
  SELECT view_count INTO before_v FROM properties WHERE slug = 'published-villa';
  PERFORM become_anon();
  FOR i IN 1..400 LOOP
    PERFORM increment_listing_view('11111111-0000-0000-0000-000000000001');
  END LOOP;
  RESET ROLE;
  SELECT view_count INTO after_v FROM properties WHERE slug = 'published-villa';
  gained := after_v - before_v;
  PERFORM assert(gained <= 120,
    format('400 anonymous calls yielded at most the 120/minute ceiling (gained %s)', gained));
  PERFORM assert(gained > 0, 'genuine views are still counted');
END $$;

-- I2: a normal visitor on a quiet listing is counted immediately — the ceiling
-- must be invisible to real traffic.
DO $$
DECLARE before_v int; after_v int;
BEGIN
  DELETE FROM listing_view_throttle;
  UPDATE properties SET status='active', deleted_at=NULL WHERE slug='published-villa';
  SELECT view_count INTO before_v FROM properties WHERE slug = 'published-villa';
  PERFORM become_anon();
  PERFORM increment_listing_view('11111111-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT view_count INTO after_v FROM properties WHERE slug = 'published-villa';
  PERFORM assert(after_v = before_v + 1, 'a single genuine view still increments by exactly one');
END $$;

-- I3: the throttle bookkeeping is not readable by anyone but the administrator.
DO $$
DECLARE n int;
BEGIN
  PERFORM become_user('bbbbbbbb-0000-0000-0000-000000000002', 'signed-up-attacker@example.com', 'aal2');
  SELECT count(*) INTO n FROM listing_view_throttle;
  RESET ROLE;
  PERFORM assert(n = 0, 'a non-admin reads zero rows from listing_view_throttle');
END $$;

\echo ''
\echo '=== J. anon cannot even REACH privileged functions (PUBLIC grant) ======'

-- J1: PostgreSQL grants EXECUTE to PUBLIC by default, and
-- 20260625000005 never revoked it — so `GRANT ... TO authenticated` did NOT
-- mean "only authenticated". Confirmed in production on 2026-08-18:
-- has_function_privilege('anon','reset_weekly_views()','EXECUTE') was true.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('reset_weekly_views','rebuild_images_from_registry',
                      'pintag_client_network_probe')
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  PERFORM assert(bad IS NULL,
    format('anon holds no EXECUTE on admin-only functions (offenders: %s)', coalesce(bad,'none')));
END $$;

-- J2: the administrator must still be able to call them.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
  WHERE n2.nspname = 'public'
    AND p.proname IN ('reset_weekly_views','rebuild_images_from_registry')
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  PERFORM assert(n = 2, 'authenticated retains EXECUTE on the admin functions (the gate does the rest)');
END $$;

-- J3: THE REGRESSION THAT MATTERS. The old guard was
--     IF auth.email() != 'admin@pintag.io' THEN RAISE
-- For an anonymous caller auth.email() is NULL and `NULL != 'x'` is NULL, not
-- TRUE — so the IF never fired and the UPDATE ran. Reproduced on PG16 and
-- observed for real in production. Assert the *behaviour*, not the text: an
-- anonymous caller must be refused and must change nothing.
DO $$
DECLARE denied boolean := false; before_sum bigint; after_sum bigint;
BEGIN
  UPDATE properties SET views_week = 9;
  SELECT sum(views_week) INTO before_sum FROM properties;
  PERFORM become_anon();
  BEGIN
    PERFORM reset_weekly_views();
  EXCEPTION WHEN OTHERS THEN denied := true;
  END;
  RESET ROLE;
  SELECT sum(views_week) INTO after_sum FROM properties;
  PERFORM assert(denied,
    'an ANONYMOUS caller is refused by reset_weekly_views() (NULL-comparison bypass closed)');
  PERFORM assert(before_sum = after_sum,
    'an anonymous call to reset_weekly_views() modified no weekly counter');
END $$;

\echo ''
\echo '=== K. schema the security functions depend on actually exists ========='

-- Production verification (2026-08-18) found properties.views_week MISSING,
-- even though 20260623000004 declares it and two shipped pages consume it. The
-- effect was a silent one: increment_listing_view() raised 42703 on every
-- anonymous call, so the view counter had simply stopped working, and nothing
-- alerted because listing.html ignores the result.
--
-- A security function that cannot run is not a security control. Assert the
-- column exists AND that the functions depending on it actually execute.
DO $$
DECLARE has_col boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='properties' AND column_name='views_week'
  ) INTO has_col;
  PERFORM assert(has_col, 'properties.views_week exists (increment_listing_view and the FOMO lines need it)');
END $$;

-- K2: the anonymous view counter runs without raising.
DO $$
DECLARE errored boolean := false;
BEGIN
  DELETE FROM listing_view_throttle;
  PERFORM become_anon();
  BEGIN
    PERFORM increment_listing_view('11111111-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN errored := true;
  END;
  RESET ROLE;
  PERFORM assert(NOT errored, 'increment_listing_view() runs for an anonymous visitor without a schema error');
END $$;

-- K3: public_listing_stats returns the full shape, views_week included.
DO $$
DECLARE r json;
BEGIN
  PERFORM become_anon();
  SELECT public_listing_stats('11111111-0000-0000-0000-000000000001') INTO r;
  RESET ROLE;
  PERFORM assert((r::jsonb) ? 'views_week', 'public_listing_stats() returns a views_week key (the shape listing.html expects)');
END $$;

\echo ''
\echo 'ALL DATA-LAYER SECURITY REGRESSION ASSERTIONS PASSED'
