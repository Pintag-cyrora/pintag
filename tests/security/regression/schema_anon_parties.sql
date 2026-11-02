-- Minimal fixture for the anonymous-parties regression (supabase/migrations/20261104000000_restrict_anon_parties_columns.sql).
-- Recreates `parties` as it exists today: every column readable by anon (Supabase's default privileges), RLS with "public read parties" TO public USING (true),
-- plus the admin write policy and the party-self-update policy. Trimmed, not a replica of production. The sensitive values are synthetic.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION is_pintag_admin(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.admin', true), '') = '1' AND p_uid IS NOT NULL $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), is_pintag_admin(uuid) TO anon, authenticated;

CREATE TABLE parties (
  id            uuid PRIMARY KEY,
  type          text,
  auth_user_id  uuid,
  name_en       text, name_lo text, slug text, photo_url text, agency_name text,
  bio_en        text, bio_lo text,
  is_verified   boolean, is_active boolean,
  whatsapp      text, languages text[], created_at timestamptz DEFAULT now(),
  phone         text, email text, created_by uuid, internal_notes text
);
CREATE TABLE properties (id uuid PRIMARY KEY, status text, managed_by_party_id uuid REFERENCES parties(id));

INSERT INTO parties (id, type, auth_user_id, name_en, name_lo, slug, photo_url, agency_name, bio_en, bio_lo, is_verified, is_active, whatsapp, languages, phone, email, created_by, internal_notes) VALUES
 ('00000000-0000-0000-0000-0000000000a1', 'agent', '00000000-0000-0000-0000-0000000000f1', 'Agent One', 'ຕົວແທນ 1', 'agent-one', 'https://x.invalid/1.jpg', 'Agency', 'bio', 'ປະຫວັດ', true, true, '020 0000 0001', ARRAY['lo','en'], '021-SYN-PHONE-1', 'syn-one@example.invalid', '00000000-0000-0000-0000-0000000000f9', 'SYN-NOTE-1'),
 ('00000000-0000-0000-0000-0000000000a2', 'agent', '00000000-0000-0000-0000-0000000000f2', 'Agent Two', 'ຕົວແທນ 2', 'agent-two', NULL, NULL, NULL, NULL, false, false, NULL, NULL, '021-SYN-PHONE-2', 'syn-two@example.invalid', NULL, 'SYN-NOTE-2'),
 ('00000000-0000-0000-0000-0000000000a3', 'staff', NULL, 'Staff', NULL, 'staff', NULL, NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO properties VALUES ('00000000-0000-0000-0000-0000000000b1', 'active', '00000000-0000-0000-0000-0000000000a1');

-- as production has it today
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read parties" ON parties FOR SELECT TO public USING (true);
CREATE POLICY "admin write parties" ON parties FOR ALL TO authenticated USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));
CREATE POLICY "Party update own profile" ON parties FOR UPDATE TO authenticated USING (auth_user_id = auth.uid()) WITH CHECK (auth_user_id = auth.uid());
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read properties" ON properties FOR SELECT TO public USING (status = 'active');
