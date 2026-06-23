-- Agents table RLS policies for admin operations
-- Run in Supabase SQL Editor → Database → SQL Editor

-- Allow authenticated admins to insert new agents
CREATE POLICY IF NOT EXISTS "Admin insert agents"
  ON agents FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Allow authenticated admins to update agent profiles
CREATE POLICY IF NOT EXISTS "Admin update agents"
  ON agents FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Allow authenticated admins to select all agents
CREATE POLICY IF NOT EXISTS "Admin select agents"
  ON agents FOR SELECT
  TO authenticated
  USING (true);

-- Allow public (anon) to read agents for listings pages
CREATE POLICY IF NOT EXISTS "Public read agents"
  ON agents FOR SELECT
  TO anon
  USING (true);
