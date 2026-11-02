-- Minimal fixture for the listing_events regression (supabase/migrations/20261104010000_listing_events_no_anon_select.sql): the table, its policies, grants and the two
-- SECURITY DEFINER guards as they exist today (20260715010000, 20260804130000, 20260811000000, 20260817010000). Trimmed, not a replica. Values are synthetic.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION is_pintag_admin(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.admin', true), '') = '1' AND p_uid IS NOT NULL $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), is_pintag_admin(uuid) TO anon, authenticated;

CREATE TABLE properties (id uuid PRIMARY KEY, status text, deleted_at timestamptz);
CREATE TABLE listing_events (
  id BIGSERIAL PRIMARY KEY,
  property_id uuid REFERENCES properties(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('view','contact','save','share','impression','click')),
  session_id text, source text, search_position integer,
  created_at timestamptz DEFAULT now()
);
INSERT INTO properties VALUES ('00000000-0000-0000-0000-0000000000b1', 'active', NULL), ('00000000-0000-0000-0000-0000000000b2', 'active', NULL), ('00000000-0000-0000-0000-0000000000b3', 'draft', NULL);
INSERT INTO listing_events (property_id, event_type, session_id, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'view', 'SYN-SESSION-1', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000000b1', 'view', 'SYN-SESSION-2', now() - interval '5 minutes'),
  ('00000000-0000-0000-0000-0000000000b2', 'click', 'SYN-SESSION-2', now() - interval '5 minutes');

CREATE FUNCTION check_listing_event_dedup(p_session_id text, p_property_id uuid, p_event_type text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_session_id IS NULL THEN RETURN true; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM listing_events WHERE session_id = p_session_id AND property_id = p_property_id AND event_type = p_event_type AND created_at > now() - interval '30 minutes');
END $$;
CREATE FUNCTION check_event_target_ceiling(p_table text, p_target uuid, p_type text, p_max int) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM listing_events WHERE property_id = p_target AND event_type = p_type AND created_at > now() - interval '1 minute';
  RETURN n < p_max;
END $$;
GRANT EXECUTE ON FUNCTION check_listing_event_dedup(text, uuid, text), check_event_target_ceiling(text, uuid, text, int) TO anon, authenticated;

-- grants as production has them: Supabase default privileges, then the lockdown's REVOKE INSERT/UPDATE/DELETE and GRANT INSERT
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON listing_events FROM anon;
GRANT INSERT ON listing_events TO anon;

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read properties" ON properties FOR SELECT TO public USING (status = 'active' AND deleted_at IS NULL);
ALTER TABLE listing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert listing_events" ON listing_events FOR INSERT TO anon
  WITH CHECK (property_id IN (SELECT id FROM properties WHERE status = 'active' AND deleted_at IS NULL)
              AND check_listing_event_dedup(session_id, property_id, event_type)
              AND check_event_target_ceiling('listing_events', property_id, event_type, 300));
CREATE POLICY "anon dedup read listing_events" ON listing_events FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anon dedup self-check" ON listing_events FOR SELECT TO anon USING (session_id IS NOT NULL AND created_at > now() - interval '30 minutes');
CREATE POLICY "admin read listing_events" ON listing_events FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));
