-- FIX: The authenticated policy on properties granted full access to ALL
-- authenticated users (any agent who registered could read/modify ALL listings,
-- not just their own). This breaks agent data isolation.
--
-- Replace with scoped policies:
--   admin@pintag.io  → full access (all rows)
--   other authenticated → SELECT and DELETE own rows only (agent_id = auth.uid())

DROP POLICY IF EXISTS "Authenticated full access properties" ON properties;

-- Every policy below references properties.agent_id, which
-- 20260705000200_properties_contact_and_managed_by_fk.sql later RENAMEs to
-- managed_by_party_id -- and every one of these policies is itself DROPped
-- and superseded by 20260705000400_staff_rls_rewrite_and_self_service.sql.
-- Guard the whole block on agent_id still existing, so this file stays
-- fully safe to re-run even long after both of those have already
-- happened (re-creating a policy against a column that no longer exists
-- would otherwise error, not just be redundant).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'properties' AND column_name = 'agent_id'
  ) THEN
    -- Admin retains unrestricted full access
    DROP POLICY IF EXISTS "Admin full access properties" ON properties;
    CREATE POLICY "Admin full access properties"
      ON properties TO authenticated
      USING  (auth.email() = 'admin@pintag.io')
      WITH CHECK (auth.email() = 'admin@pintag.io');

    -- Agents may SELECT only their own listings
    DROP POLICY IF EXISTS "Agent select own properties" ON properties;
    CREATE POLICY "Agent select own properties"
      ON properties FOR SELECT TO authenticated
      USING (
        auth.email() != 'admin@pintag.io'
        AND agent_id = auth.uid()
      );

    -- Agents may DELETE their own listings (used by dashboard.html)
    DROP POLICY IF EXISTS "Agent delete own properties" ON properties;
    CREATE POLICY "Agent delete own properties"
      ON properties FOR DELETE TO authenticated
      USING (
        auth.email() != 'admin@pintag.io'
        AND agent_id = auth.uid()
      );
  END IF;
END $$;

-- Agents have no INSERT or UPDATE access; only admin creates/updates listings.
