-- Add the two decoupled FKs at the heart of this redesign:
--   properties.contact_id        -> contacts   (mandatory buyer contact, eventually NOT NULL)
--   properties.managed_by_party_id -> parties  (optional platform identity / agent profile)
--
-- properties.agent_id has never had a real FK constraint (confirmed: not
-- defined in any tracked migration) — PostgREST resource embedding needs a
-- real FK to auto-detect the join, so add it as part of the rename.

-- Backfill safety: null out any properties.agent_id that doesn't match a real
-- parties.id before the FK can be added (dangling values would abort the
-- ALTER otherwise). Pre-migration check for this was run manually; see
-- migration notes.
UPDATE properties SET agent_id = NULL
WHERE agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM parties);

ALTER TABLE properties RENAME COLUMN agent_id TO managed_by_party_id;

ALTER TABLE properties
  ADD CONSTRAINT properties_managed_by_party_id_fkey
  FOREIGN KEY (managed_by_party_id) REFERENCES parties(id) ON DELETE SET NULL;

ALTER TABLE properties ADD COLUMN contact_id uuid REFERENCES contacts(id);

CREATE INDEX idx_properties_contact_id ON properties(contact_id);
CREATE INDEX idx_properties_managed_by_party_id ON properties(managed_by_party_id);

-- Now that properties.contact_id exists, add the public contact-visibility
-- policy deferred from 20260705000100_contacts_table.sql: a contact is
-- publicly readable only when linked to a listing that's actually public.
CREATE POLICY "Public read contacts of active properties"
  ON contacts FOR SELECT TO anon
  USING (id IN (SELECT contact_id FROM properties WHERE status IN ('active','available')));
