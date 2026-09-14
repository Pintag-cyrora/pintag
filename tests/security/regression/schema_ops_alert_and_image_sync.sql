-- ============================================================================
-- Minimal fixture for the ops-alert / image-sync EXECUTE-revocation regression
-- (supabase/migrations/20260915000000_revoke_anon_execute_ops_alert_and_image
-- _sync.sql). Separate from schema.sql/rls_regression.sql (which are scoped to
-- the 2026-08-17 audit) so this fix's fixture cannot accidentally regress that
-- already-passing suite, and vice versa.
--
-- Scope is deliberately narrow: this proves EXECUTE-privilege behavior and
-- that the real trigger chains still fire and still call these functions
-- successfully after the revoke -- NOT the RLS/visibility model, which the
-- other regression suite already covers. So RLS is intentionally left OFF on
-- every table here; anon/authenticated get plain table-level DML grants
-- instead, purely so a non-owner role can fire the triggers under test.
--
-- Every function/trigger body below is VERBATIM from the migration it comes
-- from (named on each block) in its CURRENT (pre-this-fix) form -- i.e. with
-- no REVOKE/GRANT of its own, exactly as it exists in production today. The
-- new migration is what the runner applies on top of this fixture.
-- ============================================================================

-- Supabase's auth.uid() surface -- only auth.uid() is needed here (the
-- trigger bodies call `coalesce(auth.uid()::text, current_user)`).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.uid', true), '')::uuid
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
-- The exact default this whole class of bug depends on: PostgreSQL grants
-- EXECUTE on every new function to PUBLIC unless revoked. Nothing here
-- revokes it up front -- that is the migration under test's job.

-- ── properties (minimal columns; RLS intentionally not modelled here) ──────
CREATE TABLE properties (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  images     jsonb,
  deleted_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON properties TO authenticated;

-- ── property_images — VERBATIM columns from 20260813000000 ──────────────────
CREATE TABLE property_images (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid,
  storage_bucket text,
  storage_path   text,
  storage_url    text,
  display_order  integer,
  is_cover       boolean,
  status         text,
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (property_id, storage_path)
);

-- ── ops_alerts / ops_alert_config — VERBATIM from 20260806030000 ────────────
CREATE TABLE ops_alerts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text        NOT NULL,
  severity   text        NOT NULL CHECK (severity IN ('info','high','critical')),
  message    text        NOT NULL,
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops_alert_config (
  id          int  PRIMARY KEY CHECK (id = 1),
  webhook_url text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ops_alert_config (id, webhook_url) VALUES (1, NULL);

-- ── _ops_raise_alert — VERBATIM from 20260806030000_mass_delete_alerting.sql ─
CREATE OR REPLACE FUNCTION _ops_raise_alert(
  p_kind text, p_severity text, p_message text, p_details jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_url text;
BEGIN
  INSERT INTO ops_alerts (kind, severity, message, details)
  VALUES (p_kind, p_severity, p_message, p_details);

  BEGIN
    SELECT webhook_url INTO v_url FROM ops_alert_config WHERE id = 1;
    IF v_url IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
      PERFORM net.http_post(
        url     := v_url,
        body    := jsonb_build_object(
                     'source','pintag-db','kind',p_kind,'severity',p_severity,
                     'message',p_message,'details',p_details,'at',now()),
        headers := '{"Content-Type":"application/json"}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

-- ── _properties_delete_guard — VERBATIM from 20260806030000 ─────────────────
CREATE OR REPLACE FUNCTION _properties_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM deleted_rows;
  IF v_count = 0 THEN
    RETURN NULL;
  END IF;

  IF v_count >= 10 THEN
    RAISE LOG 'PINTAG SECURITY EVENT mass_delete_blocked: statement attempted to hard-delete % properties rows (actor: %)',
      v_count, coalesce(auth.uid()::text, current_user);
    RAISE EXCEPTION
      'Mass hard-delete blocked: % rows in one statement (limit 10).', v_count;
  END IF;

  PERFORM _ops_raise_alert('hard_delete',
    CASE WHEN v_count >= 3 THEN 'critical' ELSE 'high' END,
    format('%s properties row(s) HARD-deleted (application only soft-deletes — investigate)', v_count),
    (SELECT jsonb_build_object('ids', jsonb_agg(d.id), 'actor', coalesce(auth.uid()::text, current_user)) FROM deleted_rows d));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_mass_delete_guard ON properties;
CREATE TRIGGER trg_properties_mass_delete_guard
  AFTER DELETE ON properties
  REFERENCING OLD TABLE AS deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION _properties_delete_guard();

-- ── _properties_softdelete_alert — VERBATIM from 20260806030000 ─────────────
CREATE OR REPLACE FUNCTION _properties_softdelete_alert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count bigint;
BEGIN
  SELECT count(*) INTO v_count
  FROM old_rows o JOIN new_rows n ON n.id = o.id
  WHERE o.deleted_at IS NULL AND n.deleted_at IS NOT NULL;
  IF v_count >= 5 THEN
    PERFORM _ops_raise_alert('mass_soft_delete','high',
      format('%s properties rows soft-deleted in one statement', v_count),
      jsonb_build_object('count', v_count, 'actor', coalesce(auth.uid()::text, current_user)));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_mass_softdelete_alert ON properties;
CREATE TRIGGER trg_properties_mass_softdelete_alert
  AFTER UPDATE ON properties
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION _properties_softdelete_alert();

-- ── pintag_sync_property_images — VERBATIM from 20260813000000 ─────────────
CREATE OR REPLACE FUNCTION pintag_sync_property_images(p_property uuid, p_images jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_paths text[];
BEGIN
  IF p_property IS NULL THEN RETURN; END IF;

  IF p_images IS NOT NULL AND jsonb_typeof(p_images) = 'array' THEN
    WITH cur AS (
      SELECT url, (ord - 1) AS idx
      FROM jsonb_array_elements_text(p_images) WITH ORDINALITY AS t(url, ord)
      WHERE url IS NOT NULL AND url <> ''
    ), parsed AS (
      SELECT
        url,
        idx,
        CASE WHEN url LIKE '%/property-images/%' THEN 'property-images' ELSE 'external' END AS bucket,
        CASE WHEN url LIKE '%/property-images/%'
             THEN regexp_replace(url, '^.*/property-images/', '')
             ELSE url END AS path
      FROM cur
    ), dedup AS (
      SELECT DISTINCT ON (path) path, url, idx, bucket
      FROM parsed ORDER BY path, idx
    )
    INSERT INTO property_images AS pi
      (property_id, storage_bucket, storage_path, storage_url, display_order, is_cover, status, updated_at)
    SELECT p_property, bucket, path, url, idx, (idx = 0), 'active', now()
    FROM dedup
    ON CONFLICT (property_id, storage_path) DO UPDATE
      SET display_order  = EXCLUDED.display_order,
          is_cover       = EXCLUDED.is_cover,
          storage_url    = EXCLUDED.storage_url,
          storage_bucket = EXCLUDED.storage_bucket,
          status         = 'active',
          updated_at     = now();
  END IF;

  SELECT coalesce(array_agg(
           CASE WHEN url LIKE '%/property-images/%'
                THEN regexp_replace(url, '^.*/property-images/', '') ELSE url END), '{}')
    INTO v_paths
  FROM jsonb_array_elements_text(coalesce(p_images, '[]'::jsonb)) AS q(url)
  WHERE url IS NOT NULL AND url <> '';

  UPDATE property_images
     SET status = 'removed', is_cover = false, updated_at = now()
   WHERE property_id = p_property
     AND status <> 'removed'
     AND NOT (storage_path = ANY (v_paths));
END $$;

-- ── pintag_property_images_trg — VERBATIM from 20260813000000 ──────────────
CREATE OR REPLACE FUNCTION pintag_property_images_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM pintag_sync_property_images(NEW.id, NEW.images);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'property_images sync failed for listing %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_property_images_sync ON properties;
CREATE TRIGGER trg_property_images_sync
  AFTER INSERT OR UPDATE OF images ON properties
  FOR EACH ROW EXECUTE FUNCTION pintag_property_images_trg();
