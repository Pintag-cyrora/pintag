-- Agents table RLS policies for admin operations
-- Run in Supabase SQL Editor → Database → SQL Editor

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
