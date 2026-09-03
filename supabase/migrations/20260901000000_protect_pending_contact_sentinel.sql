-- ============================================================================
-- THE PENDING SENTINEL CONTACT CAN NEVER BE UPDATED
-- ============================================================================
-- contacts row 00000000-0000-0000-0000-0000000000c1 (seeded by
-- 20260705000300_backfill_contacts_from_properties.sql, self-healed by
-- admin.html's ensurePendingContact()) is a PLACEHOLDER shared by every draft
-- that has no buyer contact yet. It is deliberately one row, referenced by
-- many listings, so that "no contact yet" is a single, recognisable id.
--
-- THE BUG (data-integrity audit, 2026-09-01):
--   admin.html saveListing() reused the contact_id loaded into the form for
--   every save that carried a phone number. For a Smart Import draft that
--   contact_id WAS the sentinel, so the first time staff typed the real
--   owner's phone into the draft and saved, the sentinel row itself was
--   PATCHed with that person's name, phone, role and party. Every other
--   phone-less draft -- current and future -- then showed that person as its
--   contact, and the listing itself stayed pointed at the sentinel id.
--
-- The application fix (saveListing treats the sentinel as "no existing
-- contact" and POSTs a new row) is what makes the flow correct. This trigger
-- is the safety net underneath it, in the same spirit as
-- 20260823000000_contact_primary_invariant.sql: no writer -- the admin, a
-- legacy page, a bulk tool, a hand-written UPDATE in the SQL editor -- can
-- turn the shared placeholder into a real person.
--
-- WHAT IT DOES
--   Rejects any UPDATE whose target row is the sentinel. Nothing legitimate
--   updates that row: the seed uses ON CONFLICT DO NOTHING, ensurePendingContact()
--   only INSERTs, and no admin path edits it on purpose.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It does NOT touch INSERT, so the seed and the self-heal keep working.
--   * It does NOT touch DELETE. The row is FK-referenced by every phone-less
--     draft (properties.contact_id, property_contacts.contact_id), which
--     already prevents deleting it while it is in use.
--   * It does NOT change any policy, grant, or existing row.
--   * It does NOT alter draft behaviour: a draft still receives the sentinel
--     as its contact_id and still cannot be published until a real contact
--     replaces it (publishDraft() in admin.html).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION contacts_protect_pending_sentinel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id = '00000000-0000-0000-0000-0000000000c1'::uuid THEN
    RAISE EXCEPTION
      'contacts row % is the shared PENDING placeholder and can never be updated -- create a new contacts row for the real contact instead',
      OLD.id
      USING ERRCODE = 'check_violation',
            HINT = 'admin.html saveListing() treats the sentinel as "no existing contact" and POSTs a new row; do the same.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION contacts_protect_pending_sentinel() IS
  'Rejects any UPDATE of the shared PENDING sentinel contact (…0000000000c1). The sentinel is a placeholder referenced by every phone-less draft; a real contact is always a NEW contacts row.';

DROP TRIGGER IF EXISTS trg_contacts_protect_pending_sentinel ON contacts;
CREATE TRIGGER trg_contacts_protect_pending_sentinel
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION contacts_protect_pending_sentinel();

COMMIT;
