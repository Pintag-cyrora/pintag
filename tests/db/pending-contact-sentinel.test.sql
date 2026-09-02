-- tests/db/pending-contact-sentinel.test.sql
--
-- Proves 20260901000000_protect_pending_contact_sentinel.sql: the shared
-- PENDING sentinel contact (…0000000000c1) can be inserted and referenced,
-- but never updated -- while every other contacts row stays fully editable.
--
-- Same conventions as contact-primary-invariant.test.sql: run with psql
-- against a SCRATCH database that has the contacts table and the migration
-- applied. Every assertion raises on failure (ON_ERROR_STOP aborts the run).
--
--   psql "$SCRATCH_DB_URL" -v ON_ERROR_STOP=1 -f tests/db/pending-contact-sentinel.test.sql

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION assert_eq(actual anyelement, expected anyelement, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL % — expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE '  ok  %', label;
END $$;

-- Runs one statement and reports whether it was rejected by the guard.
CREATE OR REPLACE FUNCTION rejected_by_guard(stmt text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RETURN false;
EXCEPTION WHEN check_violation THEN
  IF SQLERRM LIKE '%PENDING placeholder%' THEN RETURN true; END IF;
  RAISE;
END $$;

DELETE FROM contacts WHERE id IN (
  '00000000-0000-0000-0000-0000000000c1',
  'dddddddd-0000-0000-0000-000000000004');

-- ── T1: the seed still works (INSERT is untouched) ──────────────────────────
INSERT INTO contacts (id, role, name, phone, whatsapp)
VALUES ('00000000-0000-0000-0000-0000000000c1', 'other',
        'PENDING — Pintag staff to confirm buyer contact', '0000000000', NULL)
ON CONFLICT (id) DO NOTHING;
SELECT assert_eq((SELECT count(*)::int FROM contacts WHERE id='00000000-0000-0000-0000-0000000000c1'),
                 1, 'T1 sentinel can be inserted (seed / ensurePendingContact)');

-- ── T2: the self-heal re-insert is a no-op, not an error ────────────────────
INSERT INTO contacts (id, role, name, phone, whatsapp)
VALUES ('00000000-0000-0000-0000-0000000000c1', 'other',
        'PENDING — Pintag staff to confirm buyer contact', '0000000000', NULL)
ON CONFLICT (id) DO NOTHING;
SELECT assert_eq((SELECT count(*)::int FROM contacts WHERE id='00000000-0000-0000-0000-0000000000c1'),
                 1, 'T2 repeated seed leaves exactly one sentinel');

-- ── T3: the exact write the old admin path made is rejected ─────────────────
SELECT assert_eq(rejected_by_guard(
  $q$UPDATE contacts SET role='owner', name='Real Person', phone='02055512345',
       whatsapp='02055512345', languages='{lo,en}'
     WHERE id='00000000-0000-0000-0000-0000000000c1'$q$),
  true, 'T3 UPDATE of the sentinel with a real person is rejected');

-- ── T4: even a single-column / no-op UPDATE is rejected ─────────────────────
SELECT assert_eq(rejected_by_guard(
  $q$UPDATE contacts SET phone='0000000000' WHERE id='00000000-0000-0000-0000-0000000000c1'$q$),
  true, 'T4 any UPDATE targeting the sentinel is rejected');

-- ── T5: the sentinel row is byte-for-byte what was seeded ───────────────────
SELECT assert_eq((SELECT name || '|' || phone || '|' || role || '|' || coalesce(whatsapp,'<null>')
                    FROM contacts WHERE id='00000000-0000-0000-0000-0000000000c1'),
                 'PENDING — Pintag staff to confirm buyer contact|0000000000|other|<null>',
                 'T5 sentinel content unchanged after the rejected writes');

-- ── T6: an ordinary contact is still fully editable ─────────────────────────
INSERT INTO contacts (id, role, name, phone)
VALUES ('dddddddd-0000-0000-0000-000000000004', 'agent', 'Contact D', '2004');
SELECT assert_eq(rejected_by_guard(
  $q$UPDATE contacts SET name='Contact D (edited)', phone='2044'
     WHERE id='dddddddd-0000-0000-0000-000000000004'$q$),
  false, 'T6 a normal contact UPDATE is not rejected');
SELECT assert_eq((SELECT name FROM contacts WHERE id='dddddddd-0000-0000-0000-000000000004'),
                 'Contact D (edited)', 'T6 the normal contact was actually updated');

-- ── T7: a bulk UPDATE that would sweep the sentinel in is rejected whole ────
SELECT assert_eq(rejected_by_guard(
  $q$UPDATE contacts SET whatsapp = phone WHERE whatsapp IS NULL$q$),
  true, 'T7 a bulk UPDATE touching the sentinel is rejected');
SELECT assert_eq((SELECT whatsapp FROM contacts WHERE id='00000000-0000-0000-0000-0000000000c1'),
                 NULL::text, 'T7 sentinel whatsapp still NULL (statement rolled back)');

DELETE FROM contacts WHERE id = 'dddddddd-0000-0000-0000-000000000004';
DROP FUNCTION rejected_by_guard(text);
DROP FUNCTION assert_eq(anyelement, anyelement, text);
