-- agent-photos storage bucket policies
-- Run AFTER creating the bucket manually in Supabase Dashboard → Storage → New bucket
--   Name: agent-photos
--   Public bucket: YES (enables public URL access)

-- Allow authenticated users (admins) to upload photos
DROP POLICY IF EXISTS "Authenticated upload agent photos" ON storage.objects;
CREATE POLICY "Authenticated upload agent photos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'agent-photos');

-- Allow authenticated users to replace existing photos (x-upsert: true)
DROP POLICY IF EXISTS "Authenticated update agent photos" ON storage.objects;
CREATE POLICY "Authenticated update agent photos"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'agent-photos');

-- Allow authenticated users to delete photos
DROP POLICY IF EXISTS "Authenticated delete agent photos" ON storage.objects;
CREATE POLICY "Authenticated delete agent photos"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'agent-photos');

-- Allow anyone to view photos (public read)
DROP POLICY IF EXISTS "Public read agent photos" ON storage.objects;
CREATE POLICY "Public read agent photos"
  ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'agent-photos');
