-- Tighten storage bucket policies to admin-only write access.
-- Previously the policies were named "Admin ..." but the TO clause
-- was `TO authenticated` with no email check, allowing any logged-in
-- agent to upload, overwrite, or delete files in either bucket.
-- Also adds a file-extension check to agent-photos (was missing entirely).

-- ── property-images ───────────────────────────────────────────────

DROP POLICY IF EXISTS "Admin upload property images"  ON storage.objects;
DROP POLICY IF EXISTS "Admin update property images"  ON storage.objects;
DROP POLICY IF EXISTS "Admin delete property images"  ON storage.objects;

CREATE POLICY "Admin upload property images"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'property-images'
    AND lower(storage.extension(name)) IN ('jpg','jpeg','png','webp','gif')
    AND auth.email() = 'admin@pintag.io'
  );

CREATE POLICY "Admin update property images"
  ON storage.objects FOR UPDATE TO authenticated
  USING  (bucket_id = 'property-images' AND auth.email() = 'admin@pintag.io');

CREATE POLICY "Admin delete property images"
  ON storage.objects FOR DELETE TO authenticated
  USING  (bucket_id = 'property-images' AND auth.email() = 'admin@pintag.io');

-- ── agent-photos ──────────────────────────────────────────────────
-- Original policies had no email restriction and no extension check.

DROP POLICY IF EXISTS "Allow authenticated upload agent photos"  ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated update agent photos"  ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated delete agent photos"  ON storage.objects;
DROP POLICY IF EXISTS "Admin upload agent photos"               ON storage.objects;
DROP POLICY IF EXISTS "Admin update agent photos"               ON storage.objects;
DROP POLICY IF EXISTS "Admin delete agent photos"               ON storage.objects;

CREATE POLICY "Admin upload agent photos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'agent-photos'
    AND lower(storage.extension(name)) IN ('jpg','jpeg','png','webp','gif')
    AND auth.email() = 'admin@pintag.io'
  );

CREATE POLICY "Admin update agent photos"
  ON storage.objects FOR UPDATE TO authenticated
  USING  (bucket_id = 'agent-photos' AND auth.email() = 'admin@pintag.io');

CREATE POLICY "Admin delete agent photos"
  ON storage.objects FOR DELETE TO authenticated
  USING  (bucket_id = 'agent-photos' AND auth.email() = 'admin@pintag.io');
