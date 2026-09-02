-- ============================================================================
-- restore-validation.sql — post-restore verification report
-- ============================================================================
-- Run against a RESTORED database. Emits one row per check with its live value,
-- so restore-production.sh can compare against the backup's metadata/backup.json
-- and print the ✓ report. Read-only.
-- ============================================================================
SELECT 'properties'        AS check, count(*)::text AS value FROM properties
UNION ALL SELECT 'parties',        count(*)::text FROM parties
UNION ALL SELECT 'owners',         count(*)::text FROM owners
UNION ALL SELECT 'contacts',       count(*)::text FROM contacts
UNION ALL SELECT 'leads',          count(*)::text FROM leads
UNION ALL SELECT 'lead_events',    count(*)::text FROM lead_events
UNION ALL SELECT 'storage_objects',
       coalesce((SELECT count(*)::text FROM storage.objects WHERE bucket_id='property-images'), 'n/a')
UNION ALL SELECT 'migration_head',
       coalesce((SELECT max(version) FROM supabase_migrations.schema_migrations), 'n/a')
UNION ALL SELECT 'rls_policies_present',
       (SELECT count(*)::text FROM pg_policies WHERE schemaname='public')
UNION ALL SELECT 'functions_present',
       (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
UNION ALL SELECT 'rls_enabled_tables',
       (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity)
ORDER BY "check";
