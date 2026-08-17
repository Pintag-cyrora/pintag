-- ============================================================================
-- Minimal, faithful fixture of the Pintag data layer — enough to exercise the
-- authorization boundaries the regression assertions test, and nothing else.
-- ============================================================================
-- This deliberately mirrors PRODUCTION SHAPE, not production data:
--   * the same roles (anon / authenticated) and the same Supabase default
--     grants on the public schema, because the bugs under test are grant- and
--     ownership-sensitive;
--   * the same auth.uid()/auth.jwt() surface RLS policies call, backed by a
--     settable GUC so a test can "become" anon, a signed-up non-admin, or the
--     administrator;
--   * the REAL policy predicates and the REAL function bodies, copied verbatim
--     from the migrations they come from (each block names its source file).
-- If a migration changes a predicate, this fixture must change with it —
-- that divergence is exactly what the assertions are here to catch.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE
);

-- Supabase exposes the verified JWT claims through these two functions; RLS
-- policies and SECURITY DEFINER bodies alike are written against them.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT auth.jwt() ->> 'email'
$$;

-- Roles + the standard Supabase default privileges on the public schema.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

-- ── properties ──────────────────────────────────────────────────────────────
CREATE TABLE properties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text UNIQUE,
  title_en       text,
  district_en    text,
  status         text,
  deleted_at     timestamptz,
  view_count     integer DEFAULT 0,
  views_week     integer DEFAULT 0,
  favorite_count integer DEFAULT 0,
  contact_count  integer DEFAULT 0,
  trending_score numeric DEFAULT 0,
  images         jsonb
);
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

-- VERBATIM from 20260806020000_soft_delete_and_snapshots.sql
CREATE POLICY "public read active properties" ON properties
  FOR SELECT TO public
  USING (status IN ('active','available') AND deleted_at IS NULL);
-- (the administrator's own FOR ALL policy is created below, once
--  is_pintag_admin() exists — a policy body cannot reference it before then.)

-- ── Analytics event tables: anon may INSERT, never SELECT (except the one
--    dedup self-check listing_events needs). Shapes and policies VERBATIM from
--    20260811000000_restore_analytics_insert_protections.sql — the PRE-FIX
--    state, where every limit keys on the client-supplied session_id.
CREATE TABLE lead_events (
  id         bigserial PRIMARY KEY,
  listing_id uuid,
  event_type text,
  session_id text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE listing_events (
  id          bigserial PRIMARY KEY,
  property_id uuid,
  event_type  text,
  session_id  text,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE listing_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION check_lead_rate_limit(p_listing_id uuid, p_event_type text, p_session_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_session_id IS NULL THEN RETURN true; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM lead_events
    WHERE session_id = p_session_id AND listing_id = p_listing_id
      AND event_type = p_event_type AND created_at > now() - interval '30 seconds');
END $$;
GRANT EXECUTE ON FUNCTION check_lead_rate_limit(uuid, text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION check_listing_event_dedup(p_session_id text, p_property_id uuid, p_event_type text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_session_id IS NULL THEN RETURN true; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM listing_events
    WHERE session_id = p_session_id AND property_id = p_property_id
      AND event_type = p_event_type AND created_at > now() - interval '30 minutes');
END $$;
GRANT EXECUTE ON FUNCTION check_listing_event_dedup(text, uuid, text) TO anon, authenticated;

CREATE POLICY "anon insert lead_events" ON lead_events FOR INSERT TO anon
  WITH CHECK (
    listing_id IN (SELECT id FROM properties WHERE status IN ('active','available'))
    AND check_lead_rate_limit(listing_id, event_type, session_id));

CREATE POLICY "anon insert listing_events" ON listing_events FOR INSERT TO anon
  WITH CHECK (
    property_id IN (SELECT id FROM properties WHERE status IN ('active','available'))
    AND check_listing_event_dedup(session_id, property_id, event_type));

GRANT INSERT ON lead_events, listing_events TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;

-- The PRIVILEGE-LAYER FLOOR beneath RLS, VERBATIM from
-- 20260804130000_single_admin_cyrora_lockdown.sql §6. Supabase's default
-- privileges grant ALL on public tables to anon, so without this REVOKE the
-- anon role holds table-level write privileges and RLS is the ONLY thing
-- standing in the way. The lockdown deliberately removes them so that a
-- permissive policy re-introduced by accident still cannot write.
-- (Omitted from an earlier draft of this fixture; caught by
-- scripts/verify-production-security.sql, which is exactly its job.)
REVOKE INSERT, UPDATE, DELETE ON properties FROM anon;

-- ── admin allowlist + the single authorization primitive ────────────────────
-- VERBATIM from 20260804130000 as amended by 20260806010000 (AAL2 required).
CREATE TABLE admin_accounts (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note         text,
  added_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE admin_accounts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION is_pintag_admin(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM admin_accounts WHERE auth_user_id = p_uid)
     AND coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
$$;
GRANT EXECUTE ON FUNCTION is_pintag_admin(uuid) TO authenticated, anon;

-- VERBATIM from 20260804130000_single_admin_cyrora_lockdown.sql. FOR ALL, so
-- it is also the administrator's READ path — which is why an invoker-mode view
-- still shows the admin everything while showing anon only what is published.
CREATE POLICY "admin write properties" ON properties
  FOR ALL TO authenticated
  USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

-- ── property_images (admin-only registry) ───────────────────────────────────
-- VERBATIM policies from 20260813000000_property_images_registry.sql
CREATE TABLE property_images (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid,
  storage_bucket text,
  storage_path   text,
  storage_url    text,
  display_order  integer,
  is_cover       boolean,
  status         text,
  sha256         text,
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (property_id, storage_path)
);
ALTER TABLE property_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read property_images"  ON property_images FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));
CREATE POLICY "admin write property_images" ON property_images FOR ALL    TO authenticated USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

-- ── The view under test — VERBATIM from 20260622000000_engagement_metrics.sql
-- (created here exactly as production created it: no security_invoker, which
-- is the vulnerable default the hardening migration corrects).
CREATE OR REPLACE VIEW property_engagement AS
SELECT
  id, slug, view_count, favorite_count, contact_count, trending_score,
  ROUND(view_count * 1.0 + contact_count * 5.0 + favorite_count * 2.0, 2) AS computed_score,
  CASE
    WHEN (view_count * 1.0 + contact_count * 5.0 + favorite_count * 2.0) >= 100 THEN 'hot'
    WHEN (view_count * 1.0 + contact_count * 5.0 + favorite_count * 2.0) >= 50  THEN 'trending'
    WHEN (view_count * 1.0 + contact_count * 5.0 + favorite_count * 2.0) >= 20  THEN 'popular'
    ELSE 'normal'
  END AS engagement_tier
FROM properties;

-- ── The three functions under test, in their PRE-FIX form ───────────────────
-- VERBATIM from 20260813000000 (no admin gate).
CREATE OR REPLACE FUNCTION rebuild_images_from_registry(p_property uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(storage_url ORDER BY display_order), '[]'::jsonb)
  FROM property_images
  WHERE property_id = p_property AND status = 'active';
$$;
REVOKE ALL ON FUNCTION rebuild_images_from_registry(uuid) FROM public;
GRANT EXECUTE ON FUNCTION rebuild_images_from_registry(uuid) TO authenticated;

-- VERBATIM from 20260625000005 (guard names a since-deleted account).
CREATE OR REPLACE FUNCTION reset_weekly_views()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.email() != 'admin@pintag.io' THEN
    RAISE EXCEPTION 'Access denied: admin only';
  END IF;
  UPDATE properties SET views_week = 0;
END;
$$;
GRANT EXECUTE ON FUNCTION reset_weekly_views() TO authenticated;

-- VERBATIM from 20260623000004 (no visibility gate).
CREATE OR REPLACE FUNCTION public_listing_stats(p_listing_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lead_count INTEGER := 0; v_lead_week INTEGER := 0; v_lead_month INTEGER := 0;
  v_view_count INTEGER := 0; v_views_week INTEGER := 0;
  v_is_top BOOLEAN := FALSE; v_district TEXT;
BEGIN
  SELECT COUNT(*)::INTEGER,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::INTEGER,
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::INTEGER
  INTO v_lead_count, v_lead_week, v_lead_month
  FROM lead_events WHERE listing_id = p_listing_id;

  SELECT COALESCE(view_count,0), COALESCE(views_week,0), district_en
  INTO v_view_count, v_views_week, v_district
  FROM properties WHERE id = p_listing_id;

  IF v_district IS NOT NULL AND v_view_count > 0 THEN
    SELECT (p_listing_id = (SELECT id FROM properties
       WHERE district_en = v_district AND status = 'active'
       ORDER BY COALESCE(view_count,0) DESC LIMIT 1)) INTO v_is_top;
  END IF;

  RETURN json_build_object(
    'lead_count', v_lead_count, 'lead_week', v_lead_week, 'lead_month', v_lead_month,
    'view_count', v_view_count, 'views_week', v_views_week,
    'is_top_district', COALESCE(v_is_top,FALSE), 'district', v_district);
END;
$$;
GRANT EXECUTE ON FUNCTION public_listing_stats(UUID) TO anon, authenticated;

-- VERBATIM from 20260623000004.
CREATE OR REPLACE FUNCTION increment_listing_view(p_listing_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE properties
  SET view_count = COALESCE(view_count,0)+1, views_week = COALESCE(views_week,0)+1
  WHERE id = p_listing_id AND status = 'active';
END;
$$;
GRANT EXECUTE ON FUNCTION increment_listing_view(UUID) TO anon, authenticated;

-- ── Seed: one published listing, one draft, one soft-deleted ────────────────
INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cyrora.trading@gmail.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'signed-up-attacker@example.com'),
  -- The attacker re-registering the DELETED legacy admin address. This row is
  -- the whole point of the reset_weekly_views() assertion: the email is real
  -- again, but the uid is new and is not on the allowlist.
  ('cccccccc-0000-0000-0000-000000000003', 'admin@pintag.io');

INSERT INTO admin_accounts (auth_user_id, note)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'Sole production administrator');

INSERT INTO properties (id, slug, title_en, district_en, status, view_count) VALUES
  ('11111111-0000-0000-0000-000000000001', 'published-villa', 'Published Villa', 'Sisattanak', 'active', 500),
  ('22222222-0000-0000-0000-000000000002', 'secret-draft',    'Unpublished draft — internal', 'Sisattanak', 'draft', 90);
INSERT INTO properties (id, slug, title_en, district_en, status, deleted_at, view_count) VALUES
  ('33333333-0000-0000-0000-000000000003', 'removed-listing', 'Soft-deleted listing', 'Sisattanak', 'active', now(), 40);

INSERT INTO lead_events (listing_id, event_type, session_id) VALUES
  ('11111111-0000-0000-0000-000000000001', 'whatsapp_click', 's1'),
  ('22222222-0000-0000-0000-000000000002', 'whatsapp_click', 's2'),
  ('22222222-0000-0000-0000-000000000002', 'whatsapp_click', 's3');

INSERT INTO property_images (property_id, storage_bucket, storage_path, storage_url, display_order, is_cover, status) VALUES
  ('22222222-0000-0000-0000-000000000002', 'property-images', 'draft-secret-photo.jpg',
   'https://example.supabase.co/storage/v1/object/public/property-images/draft-secret-photo.jpg', 0, true, 'active');
