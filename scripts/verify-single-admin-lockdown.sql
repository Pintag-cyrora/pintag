-- ============================================================================
-- VERIFY SINGLE-ADMIN LOCKDOWN — run after 20260804120000_single_admin_lockdown.sql
-- ============================================================================
-- Read-only. Proves that only the staff (admin) account can write, that the
-- public site can still read, and that the incident's vulnerability is gone.
-- Run each block in the Supabase SQL Editor and check the "EXPECT" note.
-- ============================================================================

-- 1. NO permissive write policy remains anywhere except the intentional
--    anon analytics inserts. EXPECT: only rows on lead_events / listing_events
--    / search_events / ui_events / page_views, all cmd=INSERT, role={anon}.
--    Any row on properties/parties/contacts/owners/unit_types/leads = FAIL.
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND cmd IN ('ALL','INSERT','UPDATE','DELETE')
  AND (qual = 'true' OR with_check = 'true')
ORDER BY tablename, cmd;

-- 2. Every core data table's WRITE path is gated on is_pintag_staff and
--    nothing else. EXPECT: one 'staff write ...'/'staff all ...' ALL policy
--    per table, qual = is_pintag_staff(auth.uid()).
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('properties','parties','contacts','owners','unit_types','leads')
  AND cmd IN ('ALL','INSERT','UPDATE','DELETE')
ORDER BY tablename, policyname;

-- 3. The anon role has NO write privilege on data tables (privilege-layer
--    floor). EXPECT: zero rows.
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon'
  AND table_name IN ('properties','parties','contacts','owners','unit_types','leads')
  AND privilege_type IN ('INSERT','UPDATE','DELETE')
ORDER BY table_name, privilege_type;

-- 4. anon DID keep INSERT on the analytics tables (tracking still works).
--    EXPECT: one INSERT row for each of the five event tables.
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon'
  AND table_name IN ('lead_events','listing_events','search_events','ui_events','page_views')
  AND privilege_type = 'INSERT'
ORDER BY table_name;

-- 5. Exactly one staff identity exists, and it is the owner account.
--    EXPECT: one row, admin@pintag.io.
SELECT p.id, p.type, u.email
FROM parties p
JOIN auth.users u ON u.id = p.auth_user_id
WHERE p.type = 'staff';

-- 6. is_pintag_staff correctly separates admin from everyone else.
--    EXPECT: admin = true, every other account = false.
SELECT u.email, is_pintag_staff(u.id) AS is_staff
FROM auth.users u
ORDER BY is_staff DESC, u.email;

-- 7. LIVE write test as the anonymous role (proves the public key cannot
--    write even though it can read). EXPECT: the UPDATE affects 0 rows /
--    is blocked; the SELECT still returns active listings.
--    (RLS is enforced for SET ROLE the same way it is for a real anon JWT.)
BEGIN;
  SET LOCAL ROLE anon;
  SELECT count(*) AS anon_can_read_active FROM properties;          -- EXPECT: > 0
  -- The next line must delete/update ZERO rows (RLS blocks it):
  WITH x AS (UPDATE properties SET title_en = title_en RETURNING 1)
  SELECT count(*) AS anon_rows_updated FROM x;                       -- EXPECT: 0
ROLLBACK;

-- 8. LIVE write test as a NON-staff authenticated user. EXPECT: 0 rows
--    updated. Replace the uid with any non-staff account's id.
--    (request.jwt.claims drives auth.uid(); we stub it here.)
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"269f7b70-8277-4d71-8c6e-45df8271c141"}';  -- tik@pintag.la (non-staff)
  WITH x AS (UPDATE properties SET title_en = title_en RETURNING 1)
  SELECT count(*) AS nonstaff_rows_updated FROM x;                   -- EXPECT: 0
ROLLBACK;

-- 9. LIVE write test as the STAFF (admin) user. EXPECT: it CAN update
--    (proves legitimate administration still works without bypassing RLS).
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"8d4116b1-5751-488c-8d6a-ff98e8418828"}';  -- admin@pintag.io (staff)
  WITH x AS (UPDATE properties SET title_en = title_en RETURNING 1)
  SELECT count(*) AS staff_rows_updated FROM x;                      -- EXPECT: = current row count
ROLLBACK;
