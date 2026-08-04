-- ============================================================================
-- STORAGE LOCKDOWN — cyrora single administrator (is_pintag_admin)
-- ============================================================================
-- Completes the single-admin lockdown for the two storage buckets. Before this,
-- storage.objects write policies required auth.email() = 'admin@pintag.io'
-- (20260625000006_storage_admin_only.sql) — a hardcoded legacy account that is
-- being removed. Once that account is gone, NO ONE (including cyrora) could
-- upload, replace, or delete a property or agent photo. This migration re-keys
-- every write policy to is_pintag_admin(auth.uid()) — the SAME single
-- authorization boundary now used by RLS on every data table and by every admin
-- edge function. Reads stay public (both buckets are public-read CDN buckets).
--
-- Depends on 20260804130000_single_admin_cyrora_lockdown.sql, which defines
-- is_pintag_admin() and seeds cyrora.trading@gmail.com into admin_accounts.
--
-- Idempotent: drops every known policy name (current + legacy variants) first,
-- then recreates. Wrapped in BEGIN/COMMIT — any error rolls the whole thing back.
-- The filename-extension allowlist on INSERT is preserved (jpg/jpeg/png/webp/gif).
-- ============================================================================

BEGIN;

-- ── property-images ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Admin upload property images"          ON storage.objects;
DROP POLICY IF EXISTS "Admin update property images"          ON storage.objects;
DROP POLICY IF EXISTS "Admin delete property images"          ON storage.objects;
DROP POLICY IF EXISTS "Public read property images"           ON storage.objects;
DROP POLICY IF EXISTS "Authenticated upload property images"  ON storage.objects;
DROP POLICY IF EXISTS "Authenticated update property images"  ON storage.objects;
DROP POLICY IF EXISTS "Authenticated delete property images"  ON storage.objects;

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
DROP POLICY IF EXISTS "Admin upload agent photos"             ON storage.objects;
DROP POLICY IF EXISTS "Admin update agent photos"             ON storage.objects;
DROP POLICY IF EXISTS "Admin delete agent photos"             ON storage.objects;
DROP POLICY IF EXISTS "Public read agent photos"              ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated upload agent photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated update agent photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated delete agent photos" ON storage.objects;

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

-- Verify (Supabase SQL editor):
--   SELECT policyname, cmd, roles, qual, with_check
--   FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
--   ORDER BY policyname;
-- EXPECT: every write (INSERT/UPDATE/DELETE) policy references
-- is_pintag_admin(auth.uid()); the only reads are the two public SELECTs.
