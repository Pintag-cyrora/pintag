-- LISTING_EVENTS ANON REGRESSION (supabase/migrations/20261104010000_listing_events_no_anon_select.sql)
--   bash tests/security/regression/run-listing-events-anon-pg.sh
-- Proves: before the migration anon CAN read every event (the finding is real in the fixture); after it anon cannot read or enumerate events by any route, yet
-- public event insertion and the 30-minute per-session dedup still work, the active-listing rule still holds, the administrator can still read, and the migration is idempotent.
\set ON_ERROR_STOP on
\set QUIET on
CREATE OR REPLACE FUNCTION assert(p_condition boolean, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'REGRESSION FAILED: %', p_what; END IF; RAISE NOTICE '  ok  %', p_what; END $$;
CREATE OR REPLACE FUNCTION assert_denied(p_role text, p_sql text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; RAISE NOTICE '  ok  denied for %: %', p_role, p_what; RETURN;
  END;
  RESET ROLE; RAISE EXCEPTION 'REGRESSION FAILED: % was able to: %', p_role, p_what;
END $$;
CREATE OR REPLACE FUNCTION run_as(p_role text, p_sql text, p_admin text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('test.admin', p_admin, true); PERFORM set_config('test.uid', CASE WHEN p_admin = '1' THEN '00000000-0000-0000-0000-0000000000ad' ELSE '' END, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role); EXECUTE p_sql; RESET ROLE; END $$;
CREATE OR REPLACE FUNCTION count_as(p_role text, p_sql text, p_admin text DEFAULT '') RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN PERFORM set_config('test.admin', p_admin, true); PERFORM set_config('test.uid', CASE WHEN p_admin = '1' THEN '00000000-0000-0000-0000-0000000000ad' ELSE '' END, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role); EXECUTE p_sql INTO n; RESET ROLE; RETURN n; END $$;

\echo ''
\echo '=== anon cannot read or enumerate events, by any route ==='
DO $$
BEGIN
  PERFORM assert_denied('anon', 'SELECT * FROM listing_events', 'SELECT * (a bare REST request)');
  PERFORM assert_denied('anon', 'SELECT session_id FROM listing_events', 'read session ids');
  PERFORM assert_denied('anon', 'SELECT property_id, event_type FROM listing_events', 'read per-listing engagement');
  PERFORM assert_denied('anon', 'SELECT count(*) FROM listing_events', 'count rows (even a count needs a column privilege)');
  PERFORM assert_denied('anon', 'SELECT 1 FROM listing_events LIMIT 1', 'probe existence');
  PERFORM assert_denied('anon', $q$SELECT 1 FROM listing_events WHERE session_id = 'SYN-SESSION-1'$q$, 'probe a known session id');
  PERFORM assert_denied('anon', 'SELECT to_jsonb(e) FROM listing_events e', 'whole-row to_jsonb');
  PERFORM assert_denied('anon', 'SELECT e::text FROM listing_events e', 'whole-row text cast');
  PERFORM assert_denied('anon', 'SELECT p.id FROM properties p WHERE EXISTS (SELECT 1 FROM listing_events e WHERE e.property_id = p.id)', 'EXISTS through a join');
  PERFORM assert_denied('anon', 'SELECT (SELECT max(id) FROM listing_events)', 'scalar subquery');
  PERFORM assert_denied('anon', $q$INSERT INTO listing_events (property_id, event_type, session_id) VALUES ('00000000-0000-0000-0000-0000000000b2', 'view', 'SYN-RET-1') RETURNING id$q$, 'INSERT ... RETURNING (would read back the row)');
  PERFORM assert(NOT has_table_privilege('anon', 'listing_events', 'SELECT') AND NOT has_any_column_privilege('anon', 'listing_events', 'SELECT'), 'catalog: anon has no SELECT on the table or any column');
  PERFORM assert((SELECT count(*) FROM pg_policies WHERE tablename = 'listing_events' AND cmd = 'SELECT' AND 'anon' = ANY (roles)) = 0, 'catalog: no SELECT policy for anon remains');
  PERFORM assert((SELECT count(*) FROM pg_policies WHERE tablename = 'listing_events' AND cmd = 'SELECT' AND 'public' = ANY (roles)) = 0, 'catalog: no SELECT policy for PUBLIC remains');
END $$;

\echo ''
\echo '=== anon cannot update or delete either ==='
DO $$
BEGIN
  PERFORM assert_denied('anon', $q$UPDATE listing_events SET session_id = 'x'$q$, 'UPDATE');
  PERFORM assert_denied('anon', 'DELETE FROM listing_events', 'DELETE');
END $$;

\echo ''
\echo '=== public event insertion and the per-session deduplication still work ==='
DO $$
DECLARE before_n bigint; b1 uuid := '00000000-0000-0000-0000-0000000000b1'; b2 uuid := '00000000-0000-0000-0000-0000000000b2'; b3 uuid := '00000000-0000-0000-0000-0000000000b3';
BEGIN
  before_n := count_as('postgres', 'SELECT count(*) FROM listing_events');
  PERFORM run_as('anon', format($q$INSERT INTO listing_events (property_id, event_type, session_id, source) VALUES (%L, 'view', 'SYN-NEW-1', 'detail_page')$q$, b1));
  PERFORM assert(count_as('postgres', 'SELECT count(*) FROM listing_events') = before_n + 1, 'anon can still record a view (Prefer: return=minimal shape)');
  PERFORM assert_denied('anon', format($q$INSERT INTO listing_events (property_id, event_type, session_id) VALUES (%L, 'view', 'SYN-NEW-1')$q$, b1), 'a duplicate (same session, listing, type within 30 minutes) is rejected by the dedup guard');
  PERFORM run_as('anon', format($q$INSERT INTO listing_events (property_id, event_type, session_id) VALUES (%L, 'click', 'SYN-NEW-1')$q$, b1));
  PERFORM run_as('anon', format($q$INSERT INTO listing_events (property_id, event_type, session_id) VALUES (%L, 'view', 'SYN-NEW-2')$q$, b2));
  PERFORM assert(count_as('postgres', 'SELECT count(*) FROM listing_events') = before_n + 3, 'a different event type, and a different session, are still recorded');
  PERFORM run_as('anon', format($q$INSERT INTO listing_events (property_id, event_type, session_id) VALUES (%L, 'view', 'SYN-SESSION-1')$q$, b1));   -- 2 hours ago: outside the window
  PERFORM assert(count_as('postgres', 'SELECT count(*) FROM listing_events') = before_n + 4, 'an event older than 30 minutes does not block a new one');
  PERFORM assert_denied('anon', format($q$INSERT INTO listing_events (property_id, event_type, session_id) VALUES (%L, 'view', 'SYN-NEW-3')$q$, b3), 'an event for a non-active listing is still rejected');
  PERFORM assert(count_as('anon', $q$SELECT check_listing_event_dedup('SYN-NEW-1', '00000000-0000-0000-0000-0000000000b1', 'view')::int$q$) = 0, 'the SECURITY DEFINER dedup guard still sees all rows for anon (it did not depend on the SELECT policy)');
  PERFORM assert(count_as('anon', $q$SELECT check_listing_event_dedup('SYN-UNSEEN', '00000000-0000-0000-0000-0000000000b1', 'view')::int$q$) = 1, 'and answers true for an unseen session');
END $$;

\echo ''
\echo '=== the administrator can still read ==='
DO $$
BEGIN
  PERFORM assert(count_as('authenticated', 'SELECT count(*) FROM listing_events', '1') >= 6, 'an administrator reads every event (analytics-inspector)');
  PERFORM assert(count_as('authenticated', 'SELECT count(*) FROM listing_events', '') = 0, 'a signed-in non-administrator reads none');
END $$;
\echo ''
\echo 'All listing_events anonymous-access assertions passed.'
