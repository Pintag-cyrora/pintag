-- ============================================================================
-- SECURITY REGRESSION ASSERTIONS — anon EXECUTE revocation
-- (supabase/migrations/20260915000000_revoke_anon_execute_ops_alert_and_image
-- _sync.sql)
-- ============================================================================
-- Run against a throwaway PostgreSQL instance seeded by
-- schema_ops_alert_and_image_sync.sql (pre-fix function/trigger bodies, no
-- REVOKE of their own) and then migrated by the file above:
--
--     bash tests/security/regression/run-ops-alert-and-image-sync-pg.sh
--
-- Proves two things together, because a fix that only satisfies one is not
-- done: (1) anon can no longer call either function directly, and (2) every
-- real, legitimate way these functions get invoked -- the three triggers --
-- still works exactly as before, fired by an ordinary non-owner role.
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

CREATE OR REPLACE FUNCTION become_anon() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE anon';
END $$;

CREATE OR REPLACE FUNCTION become_authenticated() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.uid', '99999999-0000-0000-0000-000000000099', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

\echo ''
\echo '=== A. anon can no longer call either function directly ================'

-- A1: _ops_raise_alert — direct anonymous RPC call must be denied.
DO $$
DECLARE denied boolean := false; before_count int; after_count int;
BEGIN
  SELECT count(*) INTO before_count FROM ops_alerts;
  PERFORM become_anon();
  BEGIN
    PERFORM _ops_raise_alert('fake_incident','critical','forged by anon', '{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  RESET ROLE;
  SELECT count(*) INTO after_count FROM ops_alerts;
  PERFORM assert(denied, 'anon is denied direct EXECUTE on _ops_raise_alert()');
  PERFORM assert(before_count = after_count, 'no forged alert was written by the denied anon call');
END $$;

-- A2: pintag_sync_property_images — direct anonymous RPC call must be denied.
DO $$
DECLARE denied boolean := false; before_count int; after_count int;
BEGIN
  SELECT count(*) INTO before_count FROM property_images;
  PERFORM become_anon();
  BEGIN
    PERFORM pintag_sync_property_images(
      '11111111-0000-0000-0000-000000000001',
      '["https://evil.example/x.jpg"]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  RESET ROLE;
  SELECT count(*) INTO after_count FROM property_images;
  PERFORM assert(denied, 'anon is denied direct EXECUTE on pintag_sync_property_images()');
  PERFORM assert(before_count = after_count, 'no forged registry row was written by the denied anon call');
END $$;

-- A3: catalog-level confirmation, belt-and-braces with A1/A2's behavioural proof.
DO $$
DECLARE anon_ops boolean; anon_sync boolean;
BEGIN
  SELECT has_function_privilege('anon', '_ops_raise_alert(text,text,text,jsonb)', 'EXECUTE') INTO anon_ops;
  SELECT has_function_privilege('anon', 'pintag_sync_property_images(uuid,jsonb)', 'EXECUTE') INTO anon_sync;
  PERFORM assert(anon_ops IS FALSE, 'has_function_privilege(anon, _ops_raise_alert, EXECUTE) = false');
  PERFORM assert(anon_sync IS FALSE, 'has_function_privilege(anon, pintag_sync_property_images, EXECUTE) = false');
END $$;

\echo ''
\echo '=== B. authenticated keeps EXECUTE on both, unmodified by this fix ======'

DO $$
DECLARE auth_ops boolean; auth_sync boolean;
BEGIN
  SELECT has_function_privilege('authenticated', '_ops_raise_alert(text,text,text,jsonb)', 'EXECUTE') INTO auth_ops;
  SELECT has_function_privilege('authenticated', 'pintag_sync_property_images(uuid,jsonb)', 'EXECUTE') INTO auth_sync;
  PERFORM assert(auth_ops IS TRUE, 'has_function_privilege(authenticated, _ops_raise_alert, EXECUTE) = true (preserved)');
  PERFORM assert(auth_sync IS TRUE, 'has_function_privilege(authenticated, pintag_sync_property_images, EXECUTE) = true (preserved)');
END $$;

DO $$
DECLARE ok boolean := true;
BEGIN
  PERFORM become_authenticated();
  BEGIN
    PERFORM _ops_raise_alert('test_direct_call','info','authenticated direct call still works', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN ok := false;
  END;
  RESET ROLE;
  PERFORM assert(ok, 'authenticated can still directly EXECUTE _ops_raise_alert() (not what this fix removes)');
END $$;

\echo ''
\echo '=== C. the real trigger chains still fire, under a non-owner role ======='

-- C1: a single hard delete (below the mass-delete threshold) — the trigger
-- must fire, call _ops_raise_alert() internally, and record it, exactly as
-- before this fix. This is the crux of the whole migration: it proves that
-- revoking a NAMED role's (anon's) EXECUTE does not affect an internal call
-- made from within a SECURITY DEFINER function, because that internal call
-- runs with the OWNER's privileges, not the invoking session's.
DO $$
DECLARE pid uuid; n_alerts_before int; n_alerts_after int; recorded_kind text;
BEGIN
  INSERT INTO properties (images) VALUES ('[]'::jsonb) RETURNING id INTO pid;
  SELECT count(*) INTO n_alerts_before FROM ops_alerts;

  PERFORM become_authenticated();
  DELETE FROM properties WHERE id = pid;
  RESET ROLE;

  SELECT count(*) INTO n_alerts_after FROM ops_alerts;
  SELECT kind INTO recorded_kind FROM ops_alerts ORDER BY created_at DESC LIMIT 1;
  PERFORM assert(n_alerts_after = n_alerts_before + 1,
    'a single hard delete still triggers exactly one ops_alerts row via the internal _ops_raise_alert() call');
  PERFORM assert(recorded_kind = 'hard_delete', 'the recorded alert is kind=hard_delete');
END $$;

-- C2: the mass-delete guard (>= 10 rows in one statement) still BLOCKS the
-- statement — unrelated to the EXECUTE fix, but proves the trigger's own
-- logic (which also calls _ops_raise_alert internally, on the <10 path) is
-- otherwise completely undisturbed.
DO $$
DECLARE blocked boolean := false; n_before int; n_after int;
BEGIN
  INSERT INTO properties (images)
  SELECT '[]'::jsonb FROM generate_series(1, 10);
  SELECT count(*) INTO n_before FROM properties;

  PERFORM become_authenticated();
  BEGIN
    DELETE FROM properties;
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  RESET ROLE;

  SELECT count(*) INTO n_after FROM properties;
  PERFORM assert(blocked, 'a 10+ row hard-delete statement is still blocked by the mass-delete guard');
  PERFORM assert(n_after = n_before, 'no row was actually deleted by the blocked mass-delete attempt');
  -- No cleanup needed: these 10 rows are harmless leftovers (later assertions
  -- use fresh, distinct ids and never assume the table starts empty). A bare
  -- DELETE here would itself be an 11th-row-or-more mass delete and trip the
  -- very guard this assertion just proved works.
END $$;

-- C3: mass soft-delete (>= 5 rows in one statement) — the alert-only path.
DO $$
DECLARE n_alerts_before int; n_alerts_after int; recorded_kind text; ids uuid[];
BEGIN
  ids := ARRAY(SELECT gen_random_uuid() FROM generate_series(1,5));
  INSERT INTO properties (id, images) SELECT unnest(ids), '[]'::jsonb;
  SELECT count(*) INTO n_alerts_before FROM ops_alerts;

  PERFORM become_authenticated();
  UPDATE properties SET deleted_at = now() WHERE id = ANY(ids);
  RESET ROLE;

  SELECT count(*) INTO n_alerts_after FROM ops_alerts;
  SELECT kind INTO recorded_kind FROM ops_alerts ORDER BY created_at DESC LIMIT 1;
  PERFORM assert(n_alerts_after = n_alerts_before + 1,
    'a 5+ row soft-delete still triggers exactly one ops_alerts row via the internal _ops_raise_alert() call');
  PERFORM assert(recorded_kind = 'mass_soft_delete', 'the recorded alert is kind=mass_soft_delete');
END $$;

-- C4: the image-registry sync trigger — insert a listing with images, confirm
-- pintag_property_images_trg() -> pintag_sync_property_images() still runs.
DO $$
DECLARE pid uuid; n_images int; recorded_cover boolean;
BEGIN
  PERFORM become_authenticated();
  INSERT INTO properties (images) VALUES (
    '["https://x.supabase.co/storage/v1/object/public/property-images/a.jpg",
      "https://x.supabase.co/storage/v1/object/public/property-images/b.jpg"]'::jsonb
  ) RETURNING id INTO pid;
  RESET ROLE;

  SELECT count(*) INTO n_images FROM property_images WHERE property_id = pid AND status = 'active';
  SELECT is_cover INTO recorded_cover FROM property_images WHERE property_id = pid AND storage_path = 'a.jpg';
  PERFORM assert(n_images = 2, 'inserting a listing with 2 images still creates 2 property_images rows via the trigger');
  PERFORM assert(recorded_cover IS TRUE, 'the first image is still marked the cover, exactly as before this fix');
END $$;

-- C5: removing an image from the array still soft-removes its registry row
-- (never deletes it) — the trigger's UPDATE OF images path.
DO $$
DECLARE pid uuid; removed_status text;
BEGIN
  PERFORM become_authenticated();
  INSERT INTO properties (images) VALUES (
    '["https://x.supabase.co/storage/v1/object/public/property-images/c.jpg"]'::jsonb
  ) RETURNING id INTO pid;
  UPDATE properties SET images = '[]'::jsonb WHERE id = pid;
  RESET ROLE;

  SELECT status INTO removed_status FROM property_images WHERE property_id = pid AND storage_path = 'c.jpg';
  PERFORM assert(removed_status = 'removed',
    'removing an image from the array still soft-removes (never deletes) its property_images row via the trigger');
END $$;
