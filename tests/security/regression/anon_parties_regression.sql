-- ANON PARTIES REGRESSION (supabase/migrations/20261104000000_restrict_anon_parties_columns.sql)
--   bash tests/security/regression/run-anon-parties-pg.sh
-- Proves: the public site's queries still work for anon; anon cannot read auth_user_id, phone, email, created_by or internal notes by any route (direct column,
-- SELECT *, whole-row functions, joins, filters, ordering, subqueries); anon cannot enumerate account associations; a signed-in non-admin sees only their own row;
-- an administrator still sees everything; anon cannot write; the migration is idempotent.
\set ON_ERROR_STOP on
\set QUIET on
CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'REGRESSION FAILED: %', p_what; END IF; RAISE NOTICE '  ok  %', p_what; END $$;
-- runs SQL as a role; the statement MUST fail with insufficient_privilege (42501)
CREATE OR REPLACE FUNCTION assert_denied(p_role text, p_sql text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; RAISE NOTICE '  ok  denied (42501) for %: %', p_role, p_what; RETURN;
  END;
  RESET ROLE; RAISE EXCEPTION 'REGRESSION FAILED: % was able to: %', p_role, p_what;
END $$;
CREATE OR REPLACE FUNCTION count_as(p_role text, p_sql text, p_uid text DEFAULT '', p_admin text DEFAULT '') RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('test.uid', p_uid, true); PERFORM set_config('test.admin', p_admin, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE p_sql INTO n; RESET ROLE; RETURN n;
END $$;

\echo ''
\echo '=== What the public site needs still works for anon ==='
DO $$
BEGIN
  PERFORM assert(count_as('anon', 'SELECT count(*) FROM parties') = 3, 'anon can still read all rows of the public columns (row filter unchanged)');
  PERFORM assert(count_as('anon', $q$SELECT count(*) FROM (SELECT id, type, slug, name_en, name_lo, photo_url, agency_name, bio_en, bio_lo, is_verified, is_active, whatsapp, languages, created_at FROM parties WHERE type = 'agent' AND is_active = true AND slug = 'agent-one' ORDER BY created_at LIMIT 1) s$q$) = 1, 'the agent-profile query (agent.html / agents.html) works');
  PERFORM assert(count_as('anon', $q$SELECT count(*) FROM (SELECT id, slug, name_lo, name_en, photo_url, bio_lo, bio_en, is_verified FROM parties WHERE type = 'agent' AND is_active = true ORDER BY created_at ASC) s$q$) = 1, 'the for-agents roster query works (filter + order on granted columns)');
  PERFORM assert(count_as('anon', $q$SELECT count(*) FROM properties p JOIN parties a ON a.id = p.managed_by_party_id WHERE a.name_en IS NOT NULL AND a.is_verified$q$) = 1, 'a listing joined to its managing party (the embedded parties(...) shape) works');
END $$;

\echo ''
\echo '=== anon cannot read identities or account associations by ANY route ==='
DO $$
BEGIN
  PERFORM assert_denied('anon', 'SELECT auth_user_id FROM parties', 'read auth_user_id');
  PERFORM assert_denied('anon', 'SELECT phone FROM parties', 'read phone');
  PERFORM assert_denied('anon', 'SELECT email FROM parties', 'read email');
  PERFORM assert_denied('anon', 'SELECT created_by FROM parties', 'read created_by');
  PERFORM assert_denied('anon', 'SELECT internal_notes FROM parties', 'read an unknown extra column (allowlist, not denylist)');
  PERFORM assert_denied('anon', 'SELECT * FROM parties', 'SELECT * (what a bare REST request means)');
  PERFORM assert_denied('anon', 'SELECT p.* FROM parties p', 'SELECT p.*');
  PERFORM assert_denied('anon', 'SELECT to_jsonb(p) FROM parties p', 'whole-row to_jsonb(p)');
  PERFORM assert_denied('anon', 'SELECT row_to_json(p) FROM parties p', 'whole-row row_to_json(p)');
  PERFORM assert_denied('anon', 'SELECT p::text FROM parties p', 'whole-row text cast');
  PERFORM assert_denied('anon', $q$SELECT id FROM parties WHERE auth_user_id IS NOT NULL$q$, 'FILTER on auth_user_id (a boolean oracle: which parties have a login)');
  PERFORM assert_denied('anon', $q$SELECT id FROM parties WHERE auth_user_id = '00000000-0000-0000-0000-0000000000f1'$q$, 'probe a known auth id');
  PERFORM assert_denied('anon', 'SELECT id FROM parties ORDER BY auth_user_id', 'ORDER BY auth_user_id');
  PERFORM assert_denied('anon', $q$SELECT id FROM parties WHERE email LIKE '%@%'$q$, 'filter on email');
  PERFORM assert_denied('anon', $q$SELECT id FROM parties WHERE phone IS NOT NULL$q$, 'filter on phone');
  PERFORM assert_denied('anon', $q$SELECT (SELECT auth_user_id FROM parties LIMIT 1)$q$, 'scalar subquery');
  PERFORM assert_denied('anon', $q$SELECT 1 FROM properties p WHERE EXISTS (SELECT 1 FROM parties a WHERE a.id = p.managed_by_party_id AND a.auth_user_id IS NOT NULL)$q$, 'EXISTS through a join');
  PERFORM assert_denied('anon', 'SELECT count(auth_user_id) FROM parties', 'aggregate over auth_user_id');
  PERFORM assert(NOT has_column_privilege('anon', 'parties', 'auth_user_id', 'SELECT') AND NOT has_column_privilege('anon', 'parties', 'phone', 'SELECT')
                 AND NOT has_column_privilege('anon', 'parties', 'email', 'SELECT') AND NOT has_column_privilege('anon', 'parties', 'created_by', 'SELECT')
                 AND NOT has_table_privilege('anon', 'parties', 'SELECT'), 'catalog: anon has no table-level SELECT and no SELECT on the sensitive columns');
  PERFORM assert((SELECT count(*) FROM information_schema.column_privileges WHERE table_name = 'parties' AND grantee = 'anon' AND privilege_type = 'SELECT') = 14, 'catalog: anon holds SELECT on exactly the 14 public columns');
END $$;

\echo ''
\echo '=== anon cannot write ==='
DO $$
BEGIN
  PERFORM assert_denied('anon', $q$UPDATE parties SET name_en = 'x'$q$, 'UPDATE');
  PERFORM assert_denied('anon', $q$INSERT INTO parties (id) VALUES (gen_random_uuid())$q$, 'INSERT');
  PERFORM assert_denied('anon', 'DELETE FROM parties', 'DELETE');
END $$;

\echo ''
\echo '=== signed-in non-administrator, administrator ==='
DO $$
BEGIN
  PERFORM assert(count_as('authenticated', 'SELECT count(*) FROM parties', '00000000-0000-0000-0000-0000000000f1', '') = 1, 'a signed-in agent sees only their own party row');
  PERFORM assert(count_as('authenticated', 'SELECT count(*) FROM parties WHERE auth_user_id IS NOT NULL', '00000000-0000-0000-0000-0000000000f1', '') = 1, 'a signed-in agent cannot enumerate other parties'' account associations');
  PERFORM assert(count_as('authenticated', 'SELECT count(*) FROM parties', '00000000-0000-0000-0000-0000000000ee', '') = 0, 'a signed-in user with no party sees none');
  PERFORM assert(count_as('authenticated', 'SELECT count(*) FROM parties', '00000000-0000-0000-0000-0000000000f1', '1') = 3, 'an administrator sees every party row');
  PERFORM assert(count_as('authenticated', 'SELECT count(phone) FROM parties', '00000000-0000-0000-0000-0000000000f1', '1') = 2, 'an administrator can read every column (phone)');
  PERFORM assert(count_as('authenticated', $q$WITH u AS (UPDATE parties SET name_en = 'Agent One' WHERE auth_user_id = auth.uid() RETURNING 1) SELECT count(*) FROM u$q$, '00000000-0000-0000-0000-0000000000f1', '') = 1, 'a signed-in agent can still update their own profile');
  PERFORM assert(count_as('authenticated', $q$WITH u AS (UPDATE parties SET name_en = 'Hacked' WHERE id = '00000000-0000-0000-0000-0000000000a2' RETURNING 1) SELECT count(*) FROM u$q$, '00000000-0000-0000-0000-0000000000f1', '') = 0, 'a signed-in agent cannot update another party');
END $$;

\echo ''
\echo 'All anon-parties assertions passed.'
