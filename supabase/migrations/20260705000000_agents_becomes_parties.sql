-- Generalize `agents` into `parties`: the platform identity for "who manages
-- this listing inside Pintag" (staff, agent, owner, developer, property
-- manager, agency rep, etc.), decoupled from requiring a Supabase Auth login.
--
-- Rows here may or may not correspond to a real auth.users row — many will
-- represent owners, developers, or agencies that Pintag staff pre-register
-- on their behalf before they ever sign in. See the table comment below.

ALTER TABLE agents
  ADD COLUMN type text NOT NULL DEFAULT 'agent'
    CHECK (type IN ('staff','agent','owner','property_manager','developer','agency_rep','enterprise_user','other'));

ALTER TABLE agents
  ADD COLUMN auth_user_id uuid REFERENCES auth.users(id);

-- Backfill: every existing agents row was created under the "id == auth uid"
-- convention (agent-setup.html has staff type in the future auth uid as the
-- row's own PK). Preserve that linkage explicitly now that the two are
-- decoupled going forward.
UPDATE agents SET auth_user_id = id WHERE auth_user_id IS NULL;

CREATE UNIQUE INDEX idx_agents_auth_user_id ON agents(auth_user_id) WHERE auth_user_id IS NOT NULL;

ALTER TABLE agents RENAME TO parties;

COMMENT ON TABLE parties IS
  'Any person or organization Pintag has a relationship with for listing management or buyer contact purposes — may or may not have signed in; see type and the nullable auth_user_id.';

-- Seed a `staff` party for today's hardcoded admin account, replacing the
-- auth.email() = 'admin@pintag.io' string-match pattern used throughout RLS
-- and app code.
INSERT INTO parties (id, type, auth_user_id, name_en, slug)
SELECT gen_random_uuid(), 'staff', u.id, 'Pintag Staff', 'pintag-staff'
FROM auth.users u
WHERE u.email = 'admin@pintag.io'
  AND NOT EXISTS (SELECT 1 FROM parties p WHERE p.auth_user_id = u.id);

-- Role-check helpers used throughout RLS policies (Stage C) and, going
-- forward, app code — replacing auth.email() = 'admin@pintag.io' string
-- comparisons with real, queryable data.
CREATE OR REPLACE FUNCTION is_pintag_staff(p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM parties WHERE auth_user_id = p_uid AND type = 'staff'
  )
$$;
GRANT EXECUTE ON FUNCTION is_pintag_staff(uuid) TO authenticated, anon;

CREATE OR REPLACE FUNCTION owned_party_ids(p_uid uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM parties WHERE auth_user_id = p_uid
$$;
GRANT EXECUTE ON FUNCTION owned_party_ids(uuid) TO authenticated;
