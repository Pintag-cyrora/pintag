-- ============================================================================
-- create-backup-ro-role.sql — least-privilege role for the DR backup workflow
-- ============================================================================
-- Run ONCE by the project owner in the production SQL editor. Creates a role
-- that can READ EVERY ROW of every table (BYPASSRLS) but can never write —
-- exactly what a backup needs, and nothing more. Do NOT use the postgres
-- superuser or service_role connection string for backups when this exists.
--
-- BYPASSRLS is required: a plain SELECT role is subject to RLS and would silently
-- back up only the rows its policies expose. If your managed project refuses to
-- grant BYPASSRLS to a custom role (some do), see the FALLBACK note at the end.
-- ============================================================================

-- 1. The role. Replace the password before running; put the SAME value in the
--    PINTAG_PROD_DB_URL GitHub secret. LOGIN + BYPASSRLS, no write grants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_ro') THEN
    CREATE ROLE backup_ro LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD' BYPASSRLS;
  END IF;
END$$;

-- 2. Read access to every schema we back up. public = business data; storage =
--    the object manifest; auth = reference-only user export; the migrations
--    table = applied-version head. No write privileges are ever granted.
GRANT USAGE ON SCHEMA public, storage, auth TO backup_ro;

GRANT SELECT ON ALL TABLES IN SCHEMA public  TO backup_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA storage TO backup_ro;   -- storage.objects (manifest)
GRANT SELECT ON auth.users TO backup_ro;                     -- reference export only

-- supabase_migrations.schema_migrations = the applied migration head.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='supabase_migrations') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA supabase_migrations TO backup_ro';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA supabase_migrations TO backup_ro';
  END IF;
END$$;

-- 3. Future tables created in public are covered automatically (so the backup
--    keeps working as the schema evolves — see point 4 of the DR design).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO backup_ro;

-- 4. Verify: this must return BYPASSRLS = true and no write membership.
SELECT rolname, rolbypassrls, rolcanlogin
FROM pg_roles WHERE rolname = 'backup_ro';

-- ── FALLBACK (only if BYPASSRLS cannot be granted on your project) ───────────
-- Use the service_role connection string for backups instead (it bypasses RLS
-- by attribute). It is read+write, so treat its secret with extra care and NEVER
-- expose it to any restore/write step that isn't explicitly intended. Document
-- in the runbook that you took this fallback.
