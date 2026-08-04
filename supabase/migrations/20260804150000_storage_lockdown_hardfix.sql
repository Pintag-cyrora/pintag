-- ============================================================================
-- STORAGE LOCKDOWN — HARD FIX (drift-proof, drop-all-then-recreate)
-- ============================================================================
-- Supersedes 20260804140000. That migration's DROP POLICY statements named
-- policies that did NOT exist in production (the live storage.objects policies
-- were created by earlier migrations / dashboard edits under DIFFERENT names),
-- so its drops were no-ops and its intended lockdown never took effect.
--
-- Production verification (2026-08-04, pg_policies on storage.objects) found the
-- storage layer effectively OPEN:
--   * agent_photos_insert: role {public}, WITH CHECK true  -> ANY caller
--     (including anonymous, anon key only) could upload objects.
--   * "Authenticated users can upload/update/delete images", authenticated_can_*
--     -> ANY authenticated user could write/delete property-images.
--   * agent_photos_delete/update -> ANY authenticated user could modify agent-photos.
--   * The only admin-scoped policies still keyed on auth.email()='admin@pintag.io'
--     (retired account) and were moot because permissive policies OR-in access.
--   * No is_pintag_admin() write policy existed.
--
-- This migration is NAME-INDEPENDENT: it dynamically drops EVERY policy on
-- storage.objects, then recreates exactly the intended minimal set:
--   * writes (INSERT/UPDATE/DELETE) require is_pintag_admin(auth.uid())
--   * reads are public (both buckets are public-read CDN buckets)
--   * INSERT keeps the image-extension allowlist (jpg/jpeg/png/webp/gif)
-- Idempotent and drift-proof: re-running drops whatever exists and recreates.
-- Depends on is_pintag_admin() from 20260804130000. Atomic (BEGIN/COMMIT).
-- ============================================================================

BEGIN;

-- 1. Drop EVERY existing policy on storage.objects, whatever it is named.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
  END LOOP;
END $$;

-- 2. Recreate the locked-down set.

-- ── property-images ─────────────────────────────────────────────────────────
CREATE POLICY "Admin upload property images"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'property-images'
    AND lower(storage.extension(name)) IN ('jpg','jpeg','png','webp','gif')
    AND is_pintag_admin(auth.uid())
  );

CREATE POLICY "Admin update property images"
  ON storage.objects FOR UPDATE TO authenticated
  USING  (bucket_id = 'property-images' AND is_pintag_admin(auth.uid()))
  WITH CHECK (bucket_id = 'property-images' AND is_pintag_admin(auth.uid()));

CREATE POLICY "Admin delete property images"
  ON storage.objects FOR DELETE TO authenticated
  USING  (bucket_id = 'property-images' AND is_pintag_admin(auth.uid()));

CREATE POLICY "Public read property images"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING  (bucket_id = 'property-images');

-- ── agent-photos ────────────────────────────────────────────────────────────
CREATE POLICY "Admin upload agent photos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'agent-photos'
    AND lower(storage.extension(name)) IN ('jpg','jpeg','png','webp','gif')
    AND is_pintag_admin(auth.uid())
  );

CREATE POLICY "Admin update agent photos"
  ON storage.objects FOR UPDATE TO authenticated
  USING  (bucket_id = 'agent-photos' AND is_pintag_admin(auth.uid()))
  WITH CHECK (bucket_id = 'agent-photos' AND is_pintag_admin(auth.uid()));

CREATE POLICY "Admin delete agent photos"
  ON storage.objects FOR DELETE TO authenticated
  USING  (bucket_id = 'agent-photos' AND is_pintag_admin(auth.uid()));

CREATE POLICY "Public read agent photos"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING  (bucket_id = 'agent-photos');

COMMIT;

-- Verify (expect EXACTLY these 8 rows; every write references is_pintag_admin;
-- the only SELECTs are the two public reads; no auth.email / no {public} write):
--   SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
--   WHERE schemaname='storage' AND tablename='objects' ORDER BY policyname;
