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

\echo '=== L. listing_events anonymous insert: success, dedup, ceiling, targets ====='
-- These are the assertions the LIVE suite (tests/security/suites/02_rls.sh, 07_rate_limiting.sh) used to make by
-- inserting real rows into the production listing_events table. They live here instead, against a throwaway database,
-- so production analytics are never written by a test.

-- L1: a first view of an active listing is recorded (the legitimate path still works).
DO $$
DECLARE ok boolean := false;
BEGIN
  PERFORM become_anon();
  BEGIN
    INSERT INTO listing_events (property_id, event_type, session_id)
    VALUES ('11111111-0000-0000-0000-000000000001', 'view', 'l-session-1');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false;
  END;
  RESET ROLE;
  PERFORM assert(ok, 'anon INSERT listing_events (active listing, first event of a session) is accepted');
END $$;

-- L2: the same session repeating the same event inside the window is refused (per-session dedup).
DO $$
DECLARE ok boolean := true;
BEGIN
  PERFORM become_anon();
  BEGIN
    INSERT INTO listing_events (property_id, event_type, session_id)
    VALUES ('11111111-0000-0000-0000-000000000001', 'view', 'l-session-1');
  EXCEPTION WHEN OTHERS THEN ok := false;
  END;
  RESET ROLE;
  PERFORM assert(NOT ok, 'anon INSERT listing_events (duplicate session+listing+event inside the window) is refused');
END $$;

-- L3: a different event type for the same session is not deduplicated.
DO $$
DECLARE ok boolean := false;
BEGIN
  PERFORM become_anon();
  BEGIN
    INSERT INTO listing_events (property_id, event_type, session_id)
    VALUES ('11111111-0000-0000-0000-000000000001', 'share', 'l-session-1');
    ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false;
  END;
  RESET ROLE;
  PERFORM assert(ok, 'anon INSERT listing_events (different event type, same session) is accepted');
END $$;

-- L4: events for an unpublished, an unknown, and a NULL listing are refused.
DO $$
DECLARE refused int := 0; pid uuid;
BEGIN
  PERFORM become_anon();
  FOREACH pid IN ARRAY ARRAY['22222222-0000-0000-0000-000000000002'::uuid,
                             '00000000-0000-0000-0000-000000000000'::uuid] LOOP
    BEGIN
      INSERT INTO listing_events (property_id, event_type, session_id) VALUES (pid, 'view', 'l-session-2');
    EXCEPTION WHEN OTHERS THEN refused := refused + 1;
    END;
  END LOOP;
  RESET ROLE;
  PERFORM assert(refused = 2, 'anon INSERT listing_events for a draft listing and for a non-existent listing are both refused');
END $$;

-- L5: rotating session ids is bounded by the per-listing ceiling (300/minute), and another listing is unaffected.
DO $$
DECLARE accepted int := 0; i int;
BEGIN
  PERFORM become_anon();
  FOR i IN 1..400 LOOP
    BEGIN
      INSERT INTO listing_events (property_id, event_type, session_id)
      VALUES ('11111111-0000-0000-0000-000000000001', 'impression', 'l-rotated-' || i::text);
      accepted := accepted + 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RESET ROLE;
  PERFORM assert(accepted <= 300, format('rotating session ids on listing_events is bounded by the ceiling (accepted %s, cap 300)', accepted));
  PERFORM assert(accepted > 0, 'the listing_events ceiling does not block everything outright');
END $$;

-- L6: anonymous callers cannot update or delete listing_events, and cannot widen what they may read beyond the table's policy.
DO $$
DECLARE upd int; del int; denied_upd boolean := false; denied_del boolean := false;
BEGIN
  PERFORM become_anon();
  BEGIN UPDATE listing_events SET event_type = 'hacked' WHERE session_id = 'l-session-1'; GET DIAGNOSTICS upd = ROW_COUNT; EXCEPTION WHEN OTHERS THEN denied_upd := true; END;
  BEGIN DELETE FROM listing_events WHERE session_id = 'l-session-1'; GET DIAGNOSTICS del = ROW_COUNT; EXCEPTION WHEN OTHERS THEN denied_del := true; END;
  RESET ROLE;
  PERFORM assert(denied_upd OR coalesce(upd, 0) = 0, 'anon UPDATE listing_events changes nothing');
  PERFORM assert(denied_del OR coalesce(del, 0) = 0, 'anon DELETE listing_events removes nothing');
END $$;

\echo '=== M. Write paths: anonymous and non-admin callers cannot write; the administrator can only with AAL2 =========='
-- These are the assertions the live suite used to make by SENDING write requests to production (anonymous POST/PATCH/DELETE on properties, parties,
-- contacts, intelligence_* and report_insights). The live suite now sends only GET to production; the policies are asserted here, on a throwaway database.

-- Seed one row per table as the superuser (RLS does not apply to it).
INSERT INTO parties (id, name_en, type) VALUES ('d0000000-0000-0000-0000-000000000001', 'Seed party', 'agent');
INSERT INTO contacts (id, role, phone) VALUES ('d0000000-0000-0000-0000-000000000002', 'owner', '00000000');
INSERT INTO intelligence_reports (id, report_type, period_start, period_end, title) VALUES ('d0000000-0000-0000-0000-000000000003', 'daily', '2026-01-01', '2026-01-01', 'Seed report');
INSERT INTO intelligence_insights (id, type, metric_key, title) VALUES ('d0000000-0000-0000-0000-000000000004', 'demand_spike', 'seed', 'Seed insight');
INSERT INTO report_insights (report_id, insight_id, role) VALUES ('d0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000004', 'mentioned');

-- M1: anonymous INSERT is refused on every table the live suite used to probe, and nothing is written.
DO $$
DECLARE
  stmts text[] := ARRAY[
    $q$INSERT INTO properties (title_en, status, slug) VALUES ('PENTEST_INSERT', 'active', 'pentest-rls-insert')$q$,
    $q$INSERT INTO parties (name_en) VALUES ('PENTEST_AGENT')$q$,
    $q$INSERT INTO contacts (role, phone) VALUES ('owner', '02099999999')$q$,
    $q$INSERT INTO intelligence_reports (report_type, period_start, period_end) VALUES ('daily', '2026-01-01', '2026-01-01')$q$,
    $q$INSERT INTO intelligence_insights (type, metric_key, title) VALUES ('demand_spike', 'test', 'PENTEST')$q$,
    $q$INSERT INTO report_insights (report_id, insight_id, role) VALUES (gen_random_uuid(), gen_random_uuid(), 'mentioned')$q$ ];
  q text; refused int := 0;
BEGIN
  PERFORM become_anon();
  FOREACH q IN ARRAY stmts LOOP
    BEGIN EXECUTE q; EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;   -- any OTHER error propagates and fails the run
  END LOOP;
  RESET ROLE;
  PERFORM assert(refused = array_length(stmts, 1), format('anon INSERT refused on all %s tables (permission denied / RLS), not merely rejected later', array_length(stmts, 1)));
  PERFORM assert((SELECT count(*) FROM properties WHERE slug = 'pentest-rls-insert') = 0
             AND (SELECT count(*) FROM parties) = 1 AND (SELECT count(*) FROM contacts) = 1
             AND (SELECT count(*) FROM intelligence_reports) = 1 AND (SELECT count(*) FROM intelligence_insights) = 1 AND (SELECT count(*) FROM report_insights) = 1,
             'nothing was written by the anonymous attempts');
END $$;

-- M2: anonymous UPDATE and DELETE change nothing (refused by privilege, or matching no visible row), and the seed rows are intact.
DO $$
DECLARE
  stmts text[] := ARRAY[
    $q$UPDATE properties SET title_en = 'HACKED' WHERE status = 'active'$q$,
    $q$DELETE FROM properties WHERE status = 'active'$q$,
    $q$UPDATE parties SET name_en = 'HACKED'$q$, $q$DELETE FROM parties$q$,
    $q$UPDATE contacts SET phone = 'HACKED'$q$, $q$DELETE FROM contacts$q$,
    $q$UPDATE intelligence_reports SET title = 'HACKED'$q$, $q$DELETE FROM intelligence_reports$q$,
    $q$UPDATE intelligence_insights SET title = 'HACKED'$q$, $q$DELETE FROM intelligence_insights$q$,
    $q$DELETE FROM report_insights$q$ ];
  q text; n bigint; affected bigint := 0;
BEGIN
  PERFORM become_anon();
  FOREACH q IN ARRAY stmts LOOP
    BEGIN EXECUTE q; GET DIAGNOSTICS n = ROW_COUNT; affected := affected + n; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  RESET ROLE;
  PERFORM assert(affected = 0, 'anon UPDATE / DELETE affected no row on any table');
  PERFORM assert((SELECT name_en FROM parties) = 'Seed party' AND (SELECT phone FROM contacts) = '00000000' AND (SELECT title FROM intelligence_reports) = 'Seed report'
             AND (SELECT count(*) FROM properties WHERE title_en = 'HACKED') = 0, 'the seed rows are unchanged');
END $$;

-- M3: the legitimate path still works, so "deny everyone" cannot pass: only the allowlisted administrator at AAL2 writes parties / contacts / properties;
--     a signed-up non-admin and the administrator at AAL1 are refused; nobody writes the Intelligence tables through a client role.
DO $$
DECLARE who text; uid uuid; aal text; ok boolean; refused boolean; k int := 0;
BEGIN
  FOR who, uid, aal IN VALUES ('signed-up non-admin', 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'aal2'), ('administrator at AAL1', 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aal1') LOOP
    PERFORM become_user(uid, 'someone@example.test', aal);
    refused := false;
    BEGIN INSERT INTO parties (name_en) VALUES ('X'); EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
    PERFORM assert(refused, format('%s cannot INSERT into parties', who));
    refused := false;
    BEGIN INSERT INTO contacts (role) VALUES ('other'); EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
    PERFORM assert(refused, format('%s cannot INSERT into contacts', who));
    refused := false;
    BEGIN INSERT INTO properties (title_en, status, slug) VALUES ('X', 'draft', 'x-' || k); EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
    PERFORM assert(refused, format('%s cannot INSERT into properties', who));
    RESET ROLE; k := k + 1;
  END LOOP;

  PERFORM become_user('aaaaaaaa-0000-0000-0000-000000000001', 'someone@example.test', 'aal2');
  ok := false; BEGIN INSERT INTO parties (name_en) VALUES ('Admin party'); ok := true; EXCEPTION WHEN insufficient_privilege THEN ok := false; END;
  PERFORM assert(ok, 'the administrator at AAL2 CAN INSERT into parties (the legitimate path works)');
  ok := false; BEGIN INSERT INTO contacts (role) VALUES ('other'); ok := true; EXCEPTION WHEN insufficient_privilege THEN ok := false; END;
  PERFORM assert(ok, 'the administrator at AAL2 CAN INSERT into contacts');
  ok := false; BEGIN INSERT INTO properties (title_en, status, slug) VALUES ('Admin draft', 'draft', 'admin-draft'); ok := true; EXCEPTION WHEN insufficient_privilege THEN ok := false; END;
  PERFORM assert(ok, 'the administrator at AAL2 CAN INSERT into properties');
  refused := false; BEGIN INSERT INTO intelligence_reports (report_type, period_start, period_end) VALUES ('daily', '2026-01-02', '2026-01-02'); EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
  PERFORM assert(refused, 'even the administrator at AAL2 cannot INSERT into intelligence_reports (written only by the service role)');
  refused := false; BEGIN INSERT INTO intelligence_insights (type, metric_key, title) VALUES ('x', 'y', 'z'); EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
  PERFORM assert(refused, 'even the administrator at AAL2 cannot INSERT into intelligence_insights');
  PERFORM assert((SELECT count(*) FROM intelligence_reports) = 1, 'the administrator at AAL2 can READ intelligence_reports');
  RESET ROLE;
END $$;

-- M4: the Intelligence tables expose nothing to anonymous or non-admin readers.
DO $$
DECLARE a bigint; b bigint;
BEGIN
  PERFORM become_anon();
  SELECT (SELECT count(*) FROM intelligence_reports) + (SELECT count(*) FROM intelligence_insights) + (SELECT count(*) FROM report_insights) INTO a;
  RESET ROLE;
  PERFORM become_user('bbbbbbbb-0000-0000-0000-000000000002', 'someone@example.test', 'aal2');
  SELECT (SELECT count(*) FROM intelligence_reports) + (SELECT count(*) FROM intelligence_insights) + (SELECT count(*) FROM report_insights) INTO b;
  RESET ROLE;
  PERFORM assert(a = 0 AND b = 0, 'anon and a signed-up non-admin read no row from the Intelligence tables');
END $$;

\echo ''
\echo '=== N. Storage policies (the REAL migration 20260804150000 applied to a storage.objects stub) =================='
-- The live suite used to upload pentest-*.php/.js/.sh/.html/.exe/.jpg files to the production buckets. Uploads are asserted here instead.
DO $$
DECLARE refused int; ok boolean; fn text; bkt text;
BEGIN
  FOREACH bkt IN ARRAY ARRAY['property-images', 'agent-photos'] LOOP
    PERFORM become_anon(); refused := 0;
    FOREACH fn IN ARRAY ARRAY['a.jpg', 'a.php', 'a.js', 'a.sh', 'a.html', 'a.exe', 'a.svg'] LOOP
      BEGIN INSERT INTO storage.objects (bucket_id, name) VALUES (bkt, 'pentest-' || fn); EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
    END LOOP;
    RESET ROLE;
    PERFORM assert(refused = 7, format('anon cannot upload any file type to %s', bkt));
    PERFORM become_user('bbbbbbbb-0000-0000-0000-000000000002', 'someone@example.test', 'aal2'); ok := true;
    BEGIN INSERT INTO storage.objects (bucket_id, name) VALUES (bkt, 'u.jpg'); EXCEPTION WHEN insufficient_privilege THEN ok := false; END; RESET ROLE;
    PERFORM assert(NOT ok, format('a signed-up non-admin cannot upload to %s', bkt));
    PERFORM become_user('aaaaaaaa-0000-0000-0000-000000000001', 'someone@example.test', 'aal1'); ok := true;
    BEGIN INSERT INTO storage.objects (bucket_id, name) VALUES (bkt, 'u1.jpg'); EXCEPTION WHEN insufficient_privilege THEN ok := false; END; RESET ROLE;
    PERFORM assert(NOT ok, format('the administrator at AAL1 cannot upload to %s', bkt));
    PERFORM become_user('aaaaaaaa-0000-0000-0000-000000000001', 'someone@example.test', 'aal2');
    ok := false; BEGIN INSERT INTO storage.objects (bucket_id, name) VALUES (bkt, 'ok.jpg'); ok := true; EXCEPTION WHEN insufficient_privilege THEN ok := false; END;
    PERFORM assert(ok, format('the administrator at AAL2 CAN upload a .jpg to %s (the legitimate path works)', bkt));
    refused := 0;
    FOREACH fn IN ARRAY ARRAY['bad.php', 'bad.js', 'bad.sh', 'bad.html', 'bad.exe', 'bad.svg', 'bad.jpg.php', '.htaccess'] LOOP
      BEGIN INSERT INTO storage.objects (bucket_id, name) VALUES (bkt, fn); EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
    END LOOP;
    PERFORM assert(refused = 8, format('the administrator at AAL2 cannot upload scripts, svg or extension-less names to %s', bkt));
    RESET ROLE;
  END LOOP;
  PERFORM become_user('aaaaaaaa-0000-0000-0000-000000000001', 'someone@example.test', 'aal2'); ok := true;
  BEGIN INSERT INTO storage.objects (bucket_id, name) VALUES ('other-bucket', 'x.jpg'); EXCEPTION WHEN insufficient_privilege THEN ok := false; END; RESET ROLE;
  PERFORM assert(NOT ok, 'no write policy exists for an unlisted bucket');
  PERFORM become_anon();
  DELETE FROM storage.objects; UPDATE storage.objects SET name = 'hacked.jpg';
  PERFORM assert((SELECT count(*) FROM storage.objects WHERE name = 'ok.jpg') = 2, 'anon DELETE / UPDATE on storage.objects changed nothing and the public read works');
  RESET ROLE;
END $$;

\echo ''
\echo '=== O. increment_listing_view: invalid input is rejected before the function body; a nil UUID is NOT inert ==========='
-- Why production is never sent this RPC: even a nil UUID reaches the body and writes a bookkeeping row. Invalid input is rejected at the argument cast, so the
-- body (and its throttle write) is never entered. The old production probe sent {"property_id": ...} to a function whose parameter is p_listing_id, so it never
-- reached the function at all; nothing on production tests this function (documented coverage gap).
DO $$
DECLARE before_t bigint; before_v bigint; after_t bigint; after_v bigint; sqlstate_seen text; bad text; n int := 0; nil_rows bigint;
BEGIN
  PERFORM assert((SELECT count(*) FROM pg_proc WHERE proname = 'increment_listing_view') = 1
             AND (SELECT pronargs FROM pg_proc WHERE proname = 'increment_listing_view') = 1
             AND (SELECT proargtypes::text FROM pg_proc WHERE proname = 'increment_listing_view') = (SELECT oid::text FROM pg_type WHERE typname = 'uuid'),
             'increment_listing_view has exactly one signature, (uuid): a non-UUID value cannot be passed to a text overload');
  SELECT count(*) INTO before_t FROM listing_view_throttle;
  SELECT coalesce(sum(view_count), 0) INTO before_v FROM properties;
  PERFORM become_anon();
  FOREACH bad IN ARRAY ARRAY['not-a-uuid', '''', '''; DROP TABLE properties--', '1 UNION SELECT NULL--', '', '00000000-0000-0000-0000-00000000000g'] LOOP
    sqlstate_seen := NULL;
    BEGIN EXECUTE format('SELECT increment_listing_view(%L::uuid)', bad);
    EXCEPTION WHEN OTHERS THEN sqlstate_seen := SQLSTATE; END;
    IF sqlstate_seen = '22P02' THEN n := n + 1; END IF;
  END LOOP;
  RESET ROLE;
  SELECT count(*) INTO after_t FROM listing_view_throttle;
  SELECT coalesce(sum(view_count), 0) INTO after_v FROM properties;
  PERFORM assert(n = 6, 'every invalid UUID input is rejected with 22P02 (invalid_text_representation) at the cast');
  PERFORM assert(after_t = before_t AND after_v = before_v, 'rejected input wrote nothing: no throttle row, no view count change (the function body was never entered)');
  PERFORM become_anon();
  PERFORM increment_listing_view('00000000-0000-0000-0000-000000000000');
  RESET ROLE;
  SELECT count(*) INTO nil_rows FROM listing_view_throttle WHERE property_id = '00000000-0000-0000-0000-000000000000';
  PERFORM assert(nil_rows = 1, 'a NIL-UUID call DOES write a row to listing_view_throttle: a nil UUID is not inert');
  DELETE FROM listing_view_throttle WHERE property_id = '00000000-0000-0000-0000-000000000000';
END $$;

\echo ''
\echo 'ALL DATA-LAYER SECURITY REGRESSION ASSERTIONS PASSED'
