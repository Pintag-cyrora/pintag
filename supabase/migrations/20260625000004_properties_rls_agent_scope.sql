-- FIX: The authenticated policy on properties granted full access to ALL
-- authenticated users (any agent who registered could read/modify ALL listings,
-- not just their own). This breaks agent data isolation.
--
-- Replace with scoped policies:
--   admin@pintag.io  → full access (all rows)
--   other authenticated → SELECT and DELETE own rows only (agent_id = auth.uid())

DROP POLICY IF EXISTS "Authenticated full access properties" ON properties;

-- Admin retains unrestricted full access
CREATE POLICY "Admin full access properties"
  ON properties TO authenticated
  USING  (auth.email() = 'admin@pintag.io')
  WITH CHECK (auth.email() = 'admin@pintag.io');

-- Agents may SELECT only their own listings
CREATE POLICY "Agent select own properties"
  ON properties FOR SELECT TO authenticated
  USING (
    auth.email() != 'admin@pintag.io'
    AND agent_id = auth.uid()
  );

-- Agents may DELETE their own listings (used by dashboard.html)
CREATE POLICY "Agent delete own properties"
  ON properties FOR DELETE TO authenticated
  USING (
    auth.email() != 'admin@pintag.io'
    AND agent_id = auth.uid()
  );

-- Agents have no INSERT or UPDATE access; only admin creates/updates listings.
