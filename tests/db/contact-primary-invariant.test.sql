-- Migration tests for 20260823000000_contact_primary_invariant.sql
-- Every case the invariant has to survive. Each assert RAISEs on failure, so a
-- non-zero psql exit means a real regression, not a diff to eyeball.
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION assert_eq(actual anyelement, expected anyelement, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL % — expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE '  ok  %', label;
END $$;

TRUNCATE property_contacts, properties, contacts CASCADE;

INSERT INTO contacts (id, name, phone, languages) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','Contact A','2001','{lo}'),
  ('bbbbbbbb-0000-0000-0000-000000000002','Contact B','2002','{en}'),
  ('cccccccc-0000-0000-0000-000000000003','Contact C','2003','{zh}');

-- ── T1: INSERT with a contact_id creates exactly one primary link ───────────
INSERT INTO properties (id, slug, status, contact_id)
VALUES ('11111111-0000-0000-0000-000000000001','t1','active','aaaaaaaa-0000-0000-0000-000000000001');

SELECT assert_eq((SELECT count(*)::int FROM property_contacts WHERE property_id='11111111-0000-0000-0000-000000000001'),
                 1, 'T1 insert with contact_id -> exactly one link');
SELECT assert_eq((SELECT is_primary FROM property_contacts WHERE property_id='11111111-0000-0000-0000-000000000001'),
                 true, 'T1 link is primary');
SELECT assert_eq((SELECT sort_order FROM property_contacts WHERE property_id='11111111-0000-0000-0000-000000000001'),
                 0, 'T1 link sort_order = 0');
SELECT assert_eq((SELECT contact_id FROM property_contacts WHERE property_id='11111111-0000-0000-0000-000000000001'),
                 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'T1 link points at contact A');

-- ── T2: INSERT with NULL contact_id creates NO link ─────────────────────────
INSERT INTO properties (id, slug, status, contact_id)
VALUES ('22222222-0000-0000-0000-000000000002','t2','draft',NULL);
SELECT assert_eq((SELECT count(*)::int FROM property_contacts WHERE property_id='22222222-0000-0000-0000-000000000002'),
                 0, 'T2 insert with NULL contact -> no link (draft stays linkless)');

-- ── T3: UPDATE NULL -> contact creates the link ─────────────────────────────
-- This is the exact production drift path: a manifest-recovered, contact-less
-- row that the 20260820000000 backfill correctly skipped, later assigned a
-- contact by edit-listing.html.
UPDATE properties SET contact_id='bbbbbbbb-0000-0000-0000-000000000002'
 WHERE id='22222222-0000-0000-0000-000000000002';
SELECT assert_eq((SELECT count(*)::int FROM property_contacts WHERE property_id='22222222-0000-0000-0000-000000000002'),
                 1, 'T3 update NULL -> contact creates the link');
SELECT assert_eq((SELECT is_primary FROM property_contacts WHERE property_id='22222222-0000-0000-0000-000000000002'),
                 true, 'T3 created link is primary');

-- ── T4: secondary contacts survive, and are not promoted ────────────────────
INSERT INTO property_contacts (property_id, contact_id, sort_order, is_primary)
VALUES ('11111111-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002',1,false),
       ('11111111-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000003',2,false);
SELECT assert_eq((SELECT count(*)::int FROM property_contacts WHERE property_id='11111111-0000-0000-0000-000000000001'),
                 3, 'T4 listing now has three numbers');

-- ── T5: idempotence — re-running the trigger changes nothing ────────────────
UPDATE properties SET contact_id='aaaaaaaa-0000-0000-0000-000000000001'
 WHERE id='11111111-0000-0000-0000-000000000001';
UPDATE properties SET contact_id='aaaaaaaa-0000-0000-0000-000000000001'
 WHERE id='11111111-0000-0000-0000-000000000001';
SELECT assert_eq((SELECT count(*)::int FROM property_contacts WHERE property_id='11111111-0000-0000-0000-000000000001'),
                 3, 'T5 repeated trigger runs create no duplicates');
SELECT assert_eq((SELECT count(*)::int FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001' AND is_primary),
                 1, 'T5 still exactly one primary');
SELECT assert_eq((SELECT contact_id FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001' AND is_primary),
                 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'T5 primary unchanged');

-- ── T6: reassignment A -> B promotes B, demotes A, destroys nothing ─────────
UPDATE properties SET contact_id='bbbbbbbb-0000-0000-0000-000000000002'
 WHERE id='11111111-0000-0000-0000-000000000001';
SELECT assert_eq((SELECT count(*)::int FROM property_contacts WHERE property_id='11111111-0000-0000-0000-000000000001'),
                 3, 'T6 reassignment keeps all three numbers');
SELECT assert_eq((SELECT count(*)::int FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001' AND is_primary),
                 1, 'T6 exactly one primary after reassignment');
SELECT assert_eq((SELECT contact_id FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001' AND is_primary),
                 'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'T6 B is now primary (promoted in place)');
SELECT assert_eq((SELECT is_primary FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001'
                     AND contact_id='aaaaaaaa-0000-0000-0000-000000000001'),
                 false, 'T6 old primary A demoted, NOT deleted');
SELECT assert_eq((SELECT sort_order FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001'
                     AND contact_id='cccccccc-0000-0000-0000-000000000003'),
                 2, 'T6 unrelated secondary C untouched');
SELECT assert_eq((SELECT sort_order FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001' AND is_primary),
                 0, 'T6 promoted primary occupies sort_order 0');
SELECT assert_eq((SELECT sort_order > 0 FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001'
                     AND contact_id='aaaaaaaa-0000-0000-0000-000000000001'),
                 true, 'T6 demoted ex-primary vacated slot 0');
-- The two resolvers must name the SAME person. resolveContactForLanguage()
-- tier 2 reads is_primary; resolvePrimaryContact() reads all[0] after sorting
-- by sort_order. This asserts the row that is flagged primary is also the row
-- that sorts first -- the bug this ordering rule exists to prevent.
SELECT assert_eq((SELECT contact_id FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001'
                   ORDER BY sort_order, contact_id LIMIT 1),
                 (SELECT contact_id FROM property_contacts
                   WHERE property_id='11111111-0000-0000-0000-000000000001' AND is_primary),
                 'T6 flag-primary and sort-first agree');

-- ── T7: reassignment to a contact with NO existing row inserts one ──────────
UPDATE properties SET contact_id='cccccccc-0000-0000-0000-000000000003'
 WHERE id='22222222-0000-0000-0000-000000000002';
SELECT assert_eq((SELECT count(*)::int FROM property_contacts WHERE property_id='22222222-0000-0000-0000-000000000002'),
                 2, 'T7 B kept as secondary, C added');
SELECT assert_eq((SELECT contact_id FROM property_contacts
                   WHERE property_id='22222222-0000-0000-0000-000000000002' AND is_primary),
                 'cccccccc-0000-0000-0000-000000000003'::uuid, 'T7 C is primary');

-- ── T8: setting contact_id back to NULL leaves links alone ──────────────────
-- Deliberate: the trigger never deletes. A number that was advertised is not
-- silently withdrawn because the legacy column was cleared.
UPDATE properties SET contact_id=NULL WHERE id='22222222-0000-0000-0000-000000000002';
SELECT assert_eq((SELECT count(*)::int FROM property_contacts WHERE property_id='22222222-0000-0000-0000-000000000002'),
                 2, 'T8 clearing contact_id deletes nothing');

-- ── T9: the global invariant across every row ───────────────────────────────
SELECT assert_eq((SELECT count(*)::int FROM (
                    SELECT property_id FROM property_contacts WHERE is_primary
                    GROUP BY property_id HAVING count(*) > 1) x),
                 0, 'T9 no listing has more than one primary');
SELECT assert_eq((SELECT count(*)::int FROM properties p
                   WHERE p.contact_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM property_contacts pc
                                      WHERE pc.property_id=p.id AND pc.contact_id=p.contact_id
                                        AND pc.is_primary)),
                 0, 'T9 every non-NULL contact_id has a matching PRIMARY link');

-- ── T10: the production drift is now unreproducible ─────────────────────────
-- Replays exactly what edit-listing.html / agent-setup.html do: a bare PATCH
-- of contact_id with no property_contacts write at all.
INSERT INTO properties (id, slug, status, contact_id)
VALUES ('33333333-0000-0000-0000-000000000003','listing-drifty','active',NULL);
UPDATE properties SET contact_id='aaaaaaaa-0000-0000-0000-000000000001'
 WHERE id='33333333-0000-0000-0000-000000000003';
SELECT assert_eq((SELECT count(*)::int FROM properties p
                   WHERE p.contact_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM property_contacts pc WHERE pc.property_id=p.id)),
                 0, 'T10 a bare contact_id PATCH can no longer strand a listing');

DROP FUNCTION assert_eq(anyelement, anyelement, text);
