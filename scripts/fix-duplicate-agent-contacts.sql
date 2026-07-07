-- fix-duplicate-agent-contacts.sql — one-time data cleanup, not a schema
-- migration. The Stage B backfill (20260705000300_backfill_contacts_from_properties.sql)
-- grouped listings into contacts by exact-matching (managed_by_party_id,
-- agent_name, agent_name_lo, agent_whatsapp) — correct as written, but real
-- agents had inconsistently-formatted phone numbers across their own
-- listings in the legacy data (e.g. "+856 20 54 296 665" vs "020 54296665"
-- vs blank), so a single real person ended up split across multiple
-- contacts rows, or landed on the shared sentinel despite a good number
-- being available on their own party profile.
--
-- Usage: psql "<production connection string>" -v ON_ERROR_STOP=1 -f scripts/fix-duplicate-agent-contacts.sql
--
-- Found via manual inspection after go-live (2026-07-07): Tik split across
-- 3 contacts rows (2 identical, 1 missing the +856 country code), Keomany's
-- 11 listings all landed on the sentinel despite her party profile having a
-- correctly-formatted number. Safe to re-run — every step is conditional on
-- the specific rows it's fixing already existing in the state described.

BEGIN;

-- Tik: merge the malformed + duplicate contacts rows into the canonical one
UPDATE properties SET contact_id = '3e61a4d3-a29e-4565-8a91-fb0e60863b18'
WHERE contact_id IN (
  '283861e2-acda-4626-80cd-67c9730955cb',
  '212bfb93-0c91-4720-b247-c1f520f9a556'
);

DELETE FROM contacts WHERE id IN (
  '283861e2-acda-4626-80cd-67c9730955cb',
  '212bfb93-0c91-4720-b247-c1f520f9a556'
);

-- Keomany: repoint her sentinel-linked listings to her real contact record
UPDATE properties SET contact_id = '8c13e7f8-04e7-4bab-9168-07dab75f24ee'
WHERE contact_id = '00000000-0000-0000-0000-0000000000c1'
  AND managed_by_party_id = 'e4c1678d-9c54-48c6-a290-3f3585140cf7';

\echo '--- Verification ---'
SELECT count(*) AS tik_contacts_remaining FROM contacts WHERE name ILIKE '%tik%';
SELECT count(*) AS keomany_still_on_sentinel FROM properties
  WHERE contact_id = '00000000-0000-0000-0000-0000000000c1'
    AND managed_by_party_id = 'e4c1678d-9c54-48c6-a290-3f3585140cf7';

DO $$
DECLARE
  v_tik_count int;
  v_keomany_sentinel_count int;
BEGIN
  SELECT count(*) INTO v_tik_count FROM contacts WHERE name ILIKE '%tik%';
  SELECT count(*) INTO v_keomany_sentinel_count FROM properties
    WHERE contact_id = '00000000-0000-0000-0000-0000000000c1'
      AND managed_by_party_id = 'e4c1678d-9c54-48c6-a290-3f3585140cf7';

  IF v_tik_count != 1 THEN
    RAISE EXCEPTION 'ABORTING: expected exactly 1 contacts row for Tik after merge, found %. Rolling back.', v_tik_count;
  END IF;
  IF v_keomany_sentinel_count != 0 THEN
    RAISE EXCEPTION 'ABORTING: expected 0 of Keomany''s listings still on the sentinel contact, found %. Rolling back.', v_keomany_sentinel_count;
  END IF;
END $$;

COMMIT;

\echo '=== CLEANUP COMMITTED SUCCESSFULLY ==='
