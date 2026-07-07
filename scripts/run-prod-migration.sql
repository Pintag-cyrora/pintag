-- run-prod-migration.sql — the parties/contacts Stage A-C migration, as one
-- self-contained script. Run non-interactively so there's no manual "check
-- the number, decide" step and no dependence on the invoking shell's current
-- directory (uses \ir, which resolves relative to *this file's* location,
-- not wherever psql was launched from).
--
-- Usage (from anywhere, any working directory):
--   psql "<production connection string>" -v ON_ERROR_STOP=1 -f scripts/run-prod-migration.sql
--
-- Safe by construction: if the post-backfill check finds any property still
-- missing a contact_id, this RAISEs an exception, ON_ERROR_STOP halts the
-- script immediately, and since COMMIT is never reached, Postgres rolls the
-- whole transaction back automatically the moment the connection closes.
-- Nothing partial is ever left committed.

BEGIN;

\ir ../supabase/migrations/20260705000000_agents_becomes_parties.sql
\ir ../supabase/migrations/20260705000100_contacts_table.sql
\ir ../supabase/migrations/20260705000200_properties_contact_and_managed_by_fk.sql
\ir ../supabase/migrations/20260705000300_backfill_contacts_from_properties.sql

\echo '--- Backfill verification (still_null must be 0) ---'
SELECT count(*) FILTER (WHERE contact_id IS NULL) AS still_null,
       count(*) FILTER (WHERE contact_id = '00000000-0000-0000-0000-0000000000c1') AS sentinel_count
FROM properties;

DO $$
DECLARE
  v_still_null int;
BEGIN
  SELECT count(*) FILTER (WHERE contact_id IS NULL) INTO v_still_null FROM properties;
  IF v_still_null > 0 THEN
    RAISE EXCEPTION 'ABORTING: % properties still have a NULL contact_id after backfill. Transaction will roll back automatically — nothing has been committed.', v_still_null;
  END IF;
END $$;

\ir ../supabase/migrations/20260705000400_staff_rls_rewrite_and_self_service.sql

COMMIT;

\echo '=== MIGRATION COMMITTED SUCCESSFULLY ==='
