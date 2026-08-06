-- ============================================================================
-- verify-l1-baseline.sql — L1 Production Safe verification (database side)
-- ============================================================================
-- Run in the PRODUCTION SQL editor AFTER applying migrations
-- 20260806010000 / 020000 / 030000. Parts are independent — run each block
-- as its own query and record the output in
-- docs/L1_PRODUCTION_SAFE_CERTIFICATION.md.
--
-- PART A is read-only. PARTS B/C create their own clearly-marked TEST rows
-- (title_en LIKE 'L1-VERIFY-%') and only ever touch those rows.
--
-- Note: the SQL editor runs as postgres (bypasses RLS; auth.uid() is NULL).
-- That is why RLS/MFA behavior is verified with the curl tests in
-- docs/L1_VERIFICATION_PACK.md — the editor CANNOT prove those. Triggers,
-- however, fire regardless of role, so B/C are valid from here.
-- ============================================================================

-- ─── PART A · Structural checks (read-only; expect 8 × PASS) ────────────────
SELECT 'A1 aal2 enforced in is_pintag_admin' AS check,
       CASE WHEN pg_get_functiondef('is_pintag_admin(uuid)'::regprocedure) ILIKE '%aal%'
            THEN 'PASS' ELSE 'FAIL' END AS result
UNION ALL
SELECT 'A2 properties.deleted_at exists',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='public' AND table_name='properties'
                           AND column_name='deleted_at')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'A3 properties_row_snapshots exists',
       CASE WHEN to_regclass('public.properties_row_snapshots') IS NOT NULL
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'A4 zero ON DELETE CASCADE FKs into properties',
       CASE WHEN NOT EXISTS (SELECT 1 FROM pg_constraint
                             WHERE confrelid='public.properties'::regclass
                               AND confdeltype='c')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'A5 all four delete/alert triggers present',
       CASE WHEN (SELECT count(*) FROM pg_trigger
                  WHERE tgrelid='public.properties'::regclass AND NOT tgisinternal
                    AND tgname IN ('trg_snapshot_property_delete',
                                   'trg_snapshot_property_softdelete',
                                   'trg_properties_mass_delete_guard',
                                   'trg_properties_mass_softdelete_alert')) = 4
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'A6 ops_alerts + config exist',
       CASE WHEN to_regclass('public.ops_alerts') IS NOT NULL
             AND to_regclass('public.ops_alert_config') IS NOT NULL
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'A7 public read policy excludes soft-deleted',
       CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                         WHERE schemaname='public' AND tablename='properties'
                           AND policyname='public read active properties'
                           AND qual ILIKE '%deleted_at%')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'A8 listing_timeline internally admin-gated',
       CASE WHEN pg_get_functiondef('listing_timeline(uuid)'::regprocedure) ILIKE '%is_pintag_admin%'
            THEN 'PASS' ELSE 'FAIL' END
ORDER BY check;

-- ─── PART B · Soft-delete lifecycle (uses ONE self-created test row) ────────
-- B-1: create the test listing (note the returned id):
INSERT INTO properties (id, title_en, status, workflow_status)
VALUES (gen_random_uuid(), 'L1-VERIFY-SOFT-DELETE-TEST', 'draft', 'draft')
RETURNING id;

-- B-2: NOW DELETE IT THROUGH THE APPLICATION:
--   admin.html → Listings → search "L1-VERIFY" → Delete → confirm.
--   (This is the point: the app path must soft-delete, snapshot, and log.)

-- B-3: verify all effects (expect 3 × PASS):
SELECT 'B1 deleted_at populated' AS check,
       CASE WHEN deleted_at IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS result
FROM properties WHERE title_en='L1-VERIFY-SOFT-DELETE-TEST'
UNION ALL
SELECT 'B2 full-row snapshot written (op=soft_delete)',
       CASE WHEN EXISTS (SELECT 1 FROM properties_row_snapshots s
                         JOIN properties p ON p.id = s.property_id
                         WHERE p.title_en='L1-VERIFY-SOFT-DELETE-TEST'
                           AND s.op='soft_delete'
                           AND s.row_data->>'title_en'='L1-VERIFY-SOFT-DELETE-TEST')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT 'B3 provenance/audit event written',
       CASE WHEN EXISTS (SELECT 1 FROM listing_provenance lp
                         JOIN properties p ON p.id = lp.listing_id
                         WHERE p.title_en='L1-VERIFY-SOFT-DELETE-TEST'
                           AND lp.event_type='deleted')
            THEN 'PASS' ELSE 'FAIL' END;

-- B-4: public invisibility — run the anon curl from the VERIFICATION PACK
--      (must return []). Cannot be proven from this editor (RLS bypassed here).

-- B-5: restore works:
UPDATE properties SET deleted_at = NULL
WHERE title_en='L1-VERIFY-SOFT-DELETE-TEST'
RETURNING id, deleted_at;   -- expect the row back with deleted_at = NULL

-- B-6: cleanup — and this SINGLE HARD DELETE is itself test C-1:
DELETE FROM properties WHERE title_en='L1-VERIFY-SOFT-DELETE-TEST';

-- B-7: verify the hard delete was snapshotted AND alerted (expect 2 × PASS):
SELECT 'C1a hard-delete snapshot written' AS check,
       CASE WHEN EXISTS (SELECT 1 FROM properties_row_snapshots
                         WHERE op='hard_delete'
                           AND row_data->>'title_en'='L1-VERIFY-SOFT-DELETE-TEST')
            THEN 'PASS' ELSE 'FAIL' END AS result
UNION ALL
SELECT 'C1b hard-delete alert raised',
       CASE WHEN EXISTS (SELECT 1 FROM ops_alerts
                         WHERE kind='hard_delete'
                           AND created_at > now() - interval '15 minutes')
            THEN 'PASS' ELSE 'FAIL' END;

-- ─── PART C · Mass-delete guard (10 self-created test rows) ─────────────────
-- C-2: create ten disposable rows:
INSERT INTO properties (id, title_en, status, workflow_status)
SELECT gen_random_uuid(), 'L1-VERIFY-BULK-'||g, 'draft', 'draft'
FROM generate_series(1,10) g;

-- C-3: attempt the forbidden bulk hard delete — RUN AS ITS OWN QUERY.
--      EXPECTED RESULT: **ERROR** "Mass hard-delete blocked: 10 rows ..."
--      The error IS the pass. If this succeeds, the guard FAILED.
DELETE FROM properties WHERE title_en LIKE 'L1-VERIFY-BULK-%';

-- C-4: verify the database is intact (expect 10):
SELECT 'C4 rows survived the blocked statement' AS check,
       CASE WHEN count(*) = 10 THEN 'PASS' ELSE 'FAIL' END AS result
FROM properties WHERE title_en LIKE 'L1-VERIFY-BULK-%';

-- C-5: cleanup via two sub-threshold statements (each also exercises the
--      hard-delete alert path — two more ops_alerts rows are EXPECTED):
DELETE FROM properties WHERE title_en LIKE 'L1-VERIFY-BULK-%'
  AND right(title_en, 1) IN ('1','2','3','4','5') AND title_en <> 'L1-VERIFY-BULK-10';
DELETE FROM properties WHERE title_en LIKE 'L1-VERIFY-BULK-%';

-- C-6: review the alert trail (expect hard_delete rows from B-6/C-5; and if
--      a webhook URL is configured in ops_alert_config, each of these must
--      ALSO have arrived in that channel — check the channel, not just here):
SELECT created_at, kind, severity, message
FROM ops_alerts
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC;
