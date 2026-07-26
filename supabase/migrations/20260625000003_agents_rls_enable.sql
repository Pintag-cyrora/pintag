-- FIX: agents table had RLS policies defined in 20260623000000 but
-- ENABLE ROW LEVEL SECURITY was never called, so all policies were silently ignored.
-- Any client could read/write the agents table without restriction.

-- Guarded: superseded once 20260705000000_agents_becomes_parties.sql
-- RENAMEs this table to `parties` — see that file's own guard comment for
-- why an unguarded re-run against a database where that's already
-- happened would otherwise fail outright.
DO $$
BEGIN
  IF to_regclass('public.agents') IS NOT NULL THEN
    ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

    -- Tighten write access: previously WITH CHECK (true) allowed ANY authenticated
    -- user (i.e. any agent who registered) to INSERT or UPDATE agent records.
    -- Lock down to admin email only.

    DROP POLICY IF EXISTS "Admin insert agents" ON agents;
    DROP POLICY IF EXISTS "Admin update agents" ON agents;

    CREATE POLICY "Admin insert agents"
      ON agents FOR INSERT TO authenticated
      WITH CHECK (auth.email() = 'admin@pintag.io');

    CREATE POLICY "Admin update agents"
      ON agents FOR UPDATE TO authenticated
      USING  (auth.email() = 'admin@pintag.io')
      WITH CHECK (auth.email() = 'admin@pintag.io');

    -- SELECT policies remain unchanged (public read + authenticated read are appropriate).
  END IF;
END $$;
