-- ============================================================================
-- VERIFY SINGLE-ADMIN LOCKDOWN — cyrora.trading@gmail.com
-- ============================================================================
-- Run AFTER 20260804130000_single_admin_cyrora_lockdown.sql. Proves the whole
-- security posture: one administrator, staff model retired, no permissive write
-- policies, non-admins cannot write, and every write path is gated by
-- is_pintag_admin(). Read-only except the SET LOCAL ROLE probes, which run
-- inside BEGIN/ROLLBACK and change nothing.
-- ============================================================================

-- ── GUARD 0 — has the migration been applied? ───────────────────────────────
-- If either column is false, STOP: apply the cyrora lockdown migration first.
-- (This is what caused the "relation admin_accounts does not exist" error.)
SELECT
  to_regclass('public.admin_accounts') IS NOT NULL                   AS admin_accounts_exists,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_pintag_admin')   AS is_pintag_admin_exists;

-- ── 1 — cyrora is the ONLY administrator ────────────────────────────────────
-- EXPECT: exactly one row, cyrora.trading@gmail.com.
SELECT u.email, a.note, a.added_at
FROM admin_accounts a JOIN auth.users u ON u.id = a.auth_user_id;

-- ── 2 — legacy admin/test accounts are gone ─────────────────────────────────
-- EXPECT: 0 rows. (If any appear, delete them in Authentication → Users.)
SELECT id, email FROM auth.users
WHERE lower(email) IN ('admin@pintag.io','testadmin@pintag.io')
   OR lower(email) LIKE 'test%@pintag%';

-- ── 3 — NO permissive write policy remains anywhere ─────────────────────────
-- EXPECT: only anon INSERT rows on the five analytics tables. Any row on a
-- data/admin table = FAIL.
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND cmd IN ('ALL','INSERT','UPDATE','DELETE')
  AND (qual = 'true' OR with_check = 'true')
ORDER BY tablename, cmd;

-- ── 4 — EVERY write path is gated by is_pintag_admin ────────────────────────
-- Lists every write-capable policy on the core tables and the exact predicate.
-- EXPECT: each one's qual/with_check is is_pintag_admin(auth.uid()); nothing
-- else, nothing referencing parties.type / is_pintag_staff / auth.email.
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN ('properties','parties','contacts','owners','unit_types','leads')
  AND cmd IN ('ALL','INSERT','UPDATE','DELETE')
ORDER BY tablename, policyname;

-- ── 5 — the legacy staff model is retired ───────────────────────────────────
-- 5a. is_pintag_staff now simply defers to the admin allowlist (no more
--     parties.type='staff' lookup). EXPECT: staff() == admin() for both.
SELECT
  is_pintag_admin((SELECT id FROM auth.users WHERE email='cyrora.trading@gmail.com')) AS admin_cyrora,
  is_pintag_staff((SELECT id FROM auth.users WHERE email='cyrora.trading@gmail.com')) AS staff_cyrora,  -- EXPECT both true
  is_pintag_admin(gen_random_uuid()) AS admin_random,
  is_pintag_staff(gen_random_uuid()) AS staff_random;                                                   -- EXPECT both false
-- 5b. No policy anywhere still references the old staff model or an email check.
--     EXPECT: 0 rows.
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname='public'
  AND (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~* '(type\s*=\s*''staff''|is_pintag_staff|auth\.email|jwt.*email)';
-- 5c. No staff parties remain. EXPECT: 0.
SELECT count(*) AS staff_parties_remaining FROM parties WHERE type = 'staff';

-- ── 6 — the anon role has no write grant on data tables ─────────────────────
-- EXPECT: 0 rows.
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee='anon'
  AND table_name IN ('properties','parties','contacts','owners','unit_types','leads')
  AND privilege_type IN ('INSERT','UPDATE','DELETE');

-- ── 7 — LIVE: a non-admin authenticated user cannot write ───────────────────
-- Uses a random (non-allowlisted) uid. EXPECT: 0 rows updated; public read works.
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000ff"}';
  SELECT count(*) AS nonadmin_can_read FROM properties;                         -- may be >0 (public read of active)
  WITH x AS (UPDATE properties SET title_en = title_en RETURNING 1)
  SELECT count(*) AS nonadmin_rows_updated FROM x;                              -- EXPECT: 0
  WITH d AS (DELETE FROM properties WHERE true RETURNING 1)
  SELECT count(*) AS nonadmin_rows_deleted FROM d;                             -- EXPECT: 0
ROLLBACK;

-- ── 8 — LIVE: the anon role cannot write ────────────────────────────────────
BEGIN;
  SET LOCAL ROLE anon;
  WITH x AS (UPDATE properties SET title_en = title_en RETURNING 1)
  SELECT count(*) AS anon_rows_updated FROM x;                                  -- EXPECT: 0
ROLLBACK;

-- ── 9 — LIVE: cyrora (the admin) CAN write (admin still works, via RLS) ──────
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims =
    ('{"sub":"' || (SELECT id FROM auth.users WHERE email='cyrora.trading@gmail.com') || '"}');
  WITH x AS (UPDATE properties SET title_en = title_en RETURNING 1)
  SELECT count(*) AS admin_rows_updated FROM x;                                 -- EXPECT: = current properties row count
ROLLBACK;

-- ── 10 — admin.html client enforcement (NOT SQL — verify in code + browser) ─
-- The following are enforced in admin.html (commit 99a9545) and cannot be
-- proven from SQL; confirm by inspection + a live browser test:
--   * ADMIN_EMAIL = 'cyrora.trading@gmail.com' (the only allowed login).
--   * verifyOnLoad() calls auth.getUser() on EVERY load and requires
--     cyrora + AAL2 before showing the panel (no localStorage auto-login).
--   * login() requires email + password + TOTP code (AAL2); rejects any
--     other email; enrolls TOTP on first login.
--   * requireAdminSession() re-validates (server-side, AAL2) before
--     deleteListing().
-- Browser test: (a) non-cyrora login → rejected; (b) cyrora w/o code →
-- blocked at code step; (c) reload mid-session → re-validated; (d) clear the
-- Supabase session in devtools → next action drops to login.
