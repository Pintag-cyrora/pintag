-- ============================================================================
-- MIGRATE ADMINISTRATION TO cyrora.trading@gmail.com + REMOVE LEGACY ACCOUNTS
-- ============================================================================
-- Run AFTER 20260804130000_single_admin_cyrora_lockdown.sql (which creates the
-- admin_accounts allowlist and seeds cyrora).
--
-- Order matters and is safety-first: discover references, migrate/clear them,
-- THEN delete the auth users in the dashboard. Do not delete an auth user while
-- a foreign key still points at it — the delete will fail (or, worse, cascade).
-- ============================================================================

-- ── STEP 1 — Confirm cyrora is the sole administrator ───────────────────────
-- EXPECT: exactly one row, cyrora.trading@gmail.com.
SELECT a.auth_user_id, u.email, a.note
FROM admin_accounts a JOIN auth.users u ON u.id = a.auth_user_id;

-- If cyrora is missing (e.g. the email differs), add it explicitly:
-- INSERT INTO admin_accounts (auth_user_id, note)
-- SELECT id, 'Sole production administrator' FROM auth.users
-- WHERE email = 'cyrora.trading@gmail.com' ON CONFLICT DO NOTHING;

-- ── STEP 2 — Discover EVERY foreign key that references auth.users ──────────
-- These are the columns that will block (or cascade) an auth-user deletion.
SELECT tc.table_schema, tc.table_name, kcu.column_name, rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
JOIN information_schema.referential_constraints rc
  ON tc.constraint_name = rc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_schema = 'auth' AND ccu.table_name = 'users'
ORDER BY tc.table_name, kcu.column_name;

-- ── STEP 3 — Show what the accounts being removed are referenced by ─────────
-- Legacy/test accounts to remove (everything except cyrora):
--   admin@pintag.io      8d4116b1-5751-488c-8d6a-ff98e8418828
--   testadmin@pintag.io  036a738f-80e8-4343-a8a6-ab76419582c6
--   + any other unused @pintag.io / @pintag.la accounts you confirm are not needed.

-- parties rows pointing at any non-cyrora account (the obsolete staff row is here):
SELECT p.id, p.type, p.name_en, p.auth_user_id, u.email
FROM parties p JOIN auth.users u ON u.id = p.auth_user_id
WHERE u.email <> 'cyrora.trading@gmail.com';

-- ── STEP 4 — Migrate / clear references (transactional) ─────────────────────
BEGIN;

-- 4a. The legacy staff model is retired — drop the obsolete staff party
--     (admin@pintag.io's restored row). Authorization is now admin_accounts,
--     so no listing or contact needs it.
DELETE FROM parties WHERE type = 'staff';

-- 4b. Decouple any remaining parties from the accounts being deleted WITHOUT
--     deleting the party itself (agents/profiles must survive). Setting
--     auth_user_id = NULL keeps the agent record and its listing relationships
--     intact; it just marks the login as "not yet claimed", exactly the
--     intended state for an unregistered party.
UPDATE parties p
SET auth_user_id = NULL
FROM auth.users u
WHERE p.auth_user_id = u.id
  AND u.email IN ('admin@pintag.io','testadmin@pintag.io');
  -- add any other accounts you are removing

-- 4c. If STEP 2 surfaced other referencing columns (e.g. a created_by), repoint
--     them to cyrora to preserve audit continuity rather than nulling. Example
--     (uncomment and adjust per the columns STEP 2 actually reports):
-- UPDATE contacts SET created_by = (SELECT id FROM auth.users WHERE email='cyrora.trading@gmail.com')
--   WHERE created_by IN (SELECT id FROM auth.users WHERE email IN ('admin@pintag.io','testadmin@pintag.io'));

-- Verify nothing except cyrora is still referenced by parties:
SELECT count(*) AS non_cyrora_party_links
FROM parties p JOIN auth.users u ON u.id = p.auth_user_id
WHERE u.email <> 'cyrora.trading@gmail.com';   -- EXPECT: 0

COMMIT;
-- ROLLBACK; -- if anything looks off

-- ── STEP 5 — Delete the auth users (Supabase DASHBOARD, not SQL) ─────────────
-- Only after STEP 4 shows 0 remaining references:
--   Authentication → Users → delete testadmin@pintag.io, admin@pintag.io, and
--   every other unused test/legacy account. cyrora.trading@gmail.com stays.
-- Then re-run STEP 1 and the verification script to confirm cyrora is the only
-- account with write access.

-- ── STEP 6 — Reminder: enable 2FA on cyrora.trading@gmail.com ────────────────
-- Supabase does not enforce end-user MFA from SQL. Enable it on the account's
-- own Google login (Google 2-Step Verification), and enable 2FA on the Supabase
-- *dashboard* account that owns this project (Account → Security). Both matter:
-- the Google login guards the app admin; the Supabase-account 2FA guards the
-- SQL editor / project dashboard the attacker never touched but must stay safe.
