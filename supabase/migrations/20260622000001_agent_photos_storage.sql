-- agent-photos storage bucket policies
-- Run AFTER creating the bucket manually in Supabase Dashboard → Storage → New bucket
--   Name: agent-photos
--   Public bucket: YES (enables public URL access)

-- Allow authenticated users (admins) to upload photos
CREATE POLICY "Authenticated upload agent photos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'agent-photos');

-- Allow authenticated users to replace existing photos (x-upsert: true)
CREATE POLICY "Authenticated update agent photos"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'agent-photos');

-- Allow authenticated users to delete photos
CREATE POLICY "Authenticated delete agent photos"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'agent-photos');

-- Allow anyone to view photos (public read)
CREATE POLICY "Public read agent photos"
  ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'agent-photos');
