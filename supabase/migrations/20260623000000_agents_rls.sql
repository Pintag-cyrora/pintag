-- Agents table RLS policies for admin operations
-- Run in Supabase SQL Editor → Database → SQL Editor

-- Guarded: every policy here is later DROPped and superseded (first by
-- 20260625000004's admin/agent-scoped rewrite, then fully replaced once
-- 20260705000000_agents_becomes_parties.sql RENAMEs this table to
-- `parties`). Re-running this file after that rename would otherwise fail
-- on "relation agents does not exist" for a file whose entire purpose is
-- already moot by then.
DO $$
BEGIN
  IF to_regclass('public.agents') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Admin insert agents"   ON agents;
    DROP POLICY IF EXISTS "Admin update agents"   ON agents;
    DROP POLICY IF EXISTS "Admin select agents"   ON agents;
    DROP POLICY IF EXISTS "Public read agents"    ON agents;

    CREATE POLICY "Admin insert agents"
      ON agents FOR INSERT
      TO authenticated
      WITH CHECK (true);

    CREATE POLICY "Admin update agents"
      ON agents FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);

    CREATE POLICY "Admin select agents"
      ON agents FOR SELECT
      TO authenticated
      USING (true);

    CREATE POLICY "Public read agents"
      ON agents FOR SELECT
      TO anon
      USING (true);
  END IF;
END $$;
