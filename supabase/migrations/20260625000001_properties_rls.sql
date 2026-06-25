-- RLS for properties table
-- Safe to run even if already enabled (idempotent).
-- IMPORTANT: Run this in Supabase SQL Editor and verify policies in
-- Dashboard → Authentication → Policies before deploying to production.

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

-- Remove any prior policies so this file is idempotent
DROP POLICY IF EXISTS "Public read active properties"          ON properties;
DROP POLICY IF EXISTS "Admin full access properties"           ON properties;
DROP POLICY IF EXISTS "Authenticated full access properties"   ON properties;
DROP POLICY IF EXISTS "Anon read active properties"            ON properties;

-- Anonymous visitors can only read published listings
CREATE POLICY "Public read active properties"
  ON properties FOR SELECT TO anon
  USING (status IN ('active', 'available'));

-- Authenticated admins have full access (insert, select, update, delete)
CREATE POLICY "Authenticated full access properties"
  ON properties TO authenticated
  USING (true)
  WITH CHECK (true);
