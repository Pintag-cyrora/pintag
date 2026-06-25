-- Security hardening: rate limiting + storage bucket policies

-- ── RATE LIMITING: lead_events ────────────────────────────────────────────────
-- Prevents spam by rejecting a repeat click of the same event_type
-- on the same listing within a 30-second window.
-- Also validates that the target listing actually exists and is published.

CREATE OR REPLACE FUNCTION check_lead_rate_limit(p_listing_id UUID, p_event_type TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN NOT EXISTS (
    SELECT 1 FROM lead_events
    WHERE listing_id  = p_listing_id
      AND event_type  = p_event_type
      AND created_at  > NOW() - INTERVAL '30 seconds'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_lead_rate_limit(UUID, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION check_lead_rate_limit(UUID, TEXT) TO authenticated;

-- Replace the unrestricted public insert policy
DROP POLICY IF EXISTS "Public insert lead_events" ON lead_events;
CREATE POLICY "Public insert lead_events"
  ON lead_events FOR INSERT TO anon
  WITH CHECK (
    listing_id IN (
      SELECT id FROM properties WHERE status IN ('active', 'available')
    )
    AND check_lead_rate_limit(listing_id, event_type)
  );

-- ── RATE LIMITING: listing_events ─────────────────────────────────────────────
-- Prevent the same session_id from recording duplicate view events within 30 min.

DROP POLICY IF EXISTS "Allow anon event inserts" ON listing_events;
CREATE POLICY "Allow anon event inserts"
  ON listing_events FOR INSERT TO anon
  WITH CHECK (
    property_id IN (
      SELECT id FROM properties WHERE status IN ('active', 'available')
    )
    AND (
      session_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM listing_events existing
        WHERE existing.property_id = listing_events.property_id
          AND existing.session_id  = listing_events.session_id
          AND existing.event_type  = listing_events.event_type
          AND existing.created_at  > NOW() - INTERVAL '30 minutes'
      )
    )
  );

-- ── STORAGE: property-images bucket ───────────────────────────────────────────
-- Run AFTER creating the bucket manually in Supabase Dashboard → Storage.
-- Bucket name: property-images  |  Public: YES

-- Drop stale policies if any exist
DROP POLICY IF EXISTS "Admin upload property images"        ON storage.objects;
DROP POLICY IF EXISTS "Admin update property images"        ON storage.objects;
DROP POLICY IF EXISTS "Admin delete property images"        ON storage.objects;
DROP POLICY IF EXISTS "Public read property images"         ON storage.objects;
DROP POLICY IF EXISTS "Authenticated upload property images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated update property images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated delete property images" ON storage.objects;

-- Only authenticated admins may upload, with extension check
CREATE POLICY "Admin upload property images"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'property-images'
    AND lower(storage.extension(name)) IN ('jpg','jpeg','png','webp','gif')
  );

-- Authenticated admins may replace existing objects
CREATE POLICY "Admin update property images"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'property-images');

-- Authenticated admins may delete objects
CREATE POLICY "Admin delete property images"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'property-images');

-- Anyone may read from the public bucket (CDN-served)
CREATE POLICY "Public read property images"
  ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'property-images');
