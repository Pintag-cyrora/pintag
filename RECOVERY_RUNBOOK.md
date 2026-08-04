# Pintag Backend Recovery & Lockdown Runbook

**Status: the site is in maintenance mode (HTTP 503) and MUST stay offline** until every
step below is verified PASS **and** the owner (cyrora.trading@gmail.com) explicitly approves
reopening. Do not disable maintenance mode. Do not reopen.

This runbook has two kinds of steps:
- **Part 0 — Repository verification** (already done, from the repo — *static* facts about the
  code/scripts, **not** production claims).
- **Part 1 — Production execution** (the operator runs these in the Supabase SQL editor /
  dashboard; each has an exact action, a PASS bar, and a "wait for output" gate). **No step is
  marked complete until its real output is verified.** Current status of every Part 1 step: ⬜ PENDING.

---

## Part 0 — Repository verification (static; completed 2026-08-04)

These confirm the *code and scripts* are correct. They are **not** evidence that production is in
this state — that is Part 1.

| # | Item | Result | Evidence |
|---|------|--------|----------|
| R1 | Lockdown migrations present on `main` | ✅ | `20260804120000`, `20260804130000` (cyrora), `20260804140000` (storage) — the last three in the chain; nothing after re-opens policies |
| R2 | Migrations structurally sound | ✅ | Each wrapped in `BEGIN…COMMIT` (extra `BEGIN/END` are plpgsql function bodies, not unbalanced transactions) |
| R3 | RLS: no write hole on data tables | ✅ | The only `USING/ WITH CHECK (true)` literals are **public SELECT** (`parties` read) and **anon INSERT** on the 5 analytics tables — never a write policy on `properties/parties/contacts/owners/unit_types/leads` |
| R4 | RLS: every data-table write = `is_pintag_admin()` | ✅ | `130000` drops **all** policies per table then recreates `… USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()))` |
| R5 | RLS: every `is_pintag_staff` **policy** is recreated as `is_pintag_admin` | ✅ | Parsed all `CREATE POLICY` blocks: **all 16** tables carrying a staff-based policy are in `130000`'s drop-recreate set; **zero** survive. (Remaining `is_pintag_staff` calls are inside analytics **RPC function bodies**, where the `is_pintag_staff → is_pintag_admin` alias is load-bearing and enforces single-admin — do **not** drop the alias.) |
| R6 | RLS: anon has no write grant | ✅ | `130000`: `REVOKE INSERT, UPDATE, DELETE ON properties, parties, contacts, owners, unit_types, leads FROM anon;` |
| R7 | Storage: writes gated by `is_pintag_admin()` | ✅ | `140000` re-keys both buckets' INSERT/UPDATE/DELETE to `is_pintag_admin(auth.uid())`; keeps 2 public-read SELECTs; extension allowlist preserved |
| R8 | Admin pages: unified auth | ✅ | All **6** privileged pages (`admin`, `analytics`, `intelligence`, `analytics-inspector`, `watermark-migrate`, `agent-setup`) load `admin-auth.js` and gate on `PintagAdminAuth.protect()` — cyrora email + `getUser()` JWT + AAL2 + `requireAdminSession()`, no `getSession()` auto-login |
| R9 | Edge functions: fail closed | ✅ | All **4** (`generate-listing-content`, `generate-intelligence-report`, `smart-listing-importer`, `facebook-listing-fetcher`) authorize via the `is_pintag_admin()` RPC and 401 on any error/non-admin; `generate-intelligence-report` keeps its service-role/pg_cron path |
| R10 | Verify + migrate + recovery scripts correct | ✅ | `verify-single-admin-lockdown.sql` (checks 0–10), `migrate-admin-to-cyrora-and-remove-legacy-accounts.sql` (FK-discovery → decouple → dashboard delete → 2FA), `recover-listings-from-manifest.sql` (original UUIDs, drafts), `recover-photos-storage-matching.sql` (inventory/cluster/Wayback) — reviewed, idempotent, safety-ordered |

**No production step is implied by Part 0.** The database may or may not have these migrations applied — Part 1, Step S0 is the gate that determines that.

---

## Part 1 — Production execution (operator runs; wait-for-output gates)

Run in order. Do not proceed past a ⬜ step until its output meets the PASS bar.

### S0 — Confirm the lockdown is applied  ⬜ PENDING (verification required)
**Action:** in the Supabase SQL editor, run **GUARD 0** (top of `scripts/verify-single-admin-lockdown.sql`):
```sql
SELECT to_regclass('public.admin_accounts') IS NOT NULL AS admin_accounts_exists,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname='is_pintag_admin') AS is_pintag_admin_exists;
```
**PASS:** both columns `true`.
**If FAIL:** apply, in order, `supabase/migrations/20260804120000_…`, `20260804130000_…`, `20260804140000_…` (paste each file's SQL into the editor and run), then re-run GUARD 0. → **paste the GUARD 0 output.**

### S1 — Verify single-admin + RLS (Phase 1 + Phase 2 core)  ⬜ PENDING (verification required)
**Action:** run the remainder of `scripts/verify-single-admin-lockdown.sql` (checks 1–9).
**PASS (all must hold):**
- **C1** exactly one admin row = `cyrora.trading@gmail.com`.
- **C3** zero permissive write policies on data tables.
- **C4** every write policy predicate = `is_pintag_admin(auth.uid())`.
- **C5** `admin_cyrora`/`staff_cyrora`=true, `admin_random`/`staff_random`=false; **C5b** 0 policies referencing staff/email; **C5c** 0 staff parties.
- **C6** anon has no INSERT/UPDATE/DELETE grant on data tables.
- **C7** non-admin authenticated: `nonadmin_rows_updated`=0, `nonadmin_rows_deleted`=0 (this is also the "agents cannot modify listings" proof — agents are non-admin under single-admin).
- **C8** anon: `anon_rows_updated`=0.
- **C9** cyrora: `admin_rows_updated` = current `properties` row count (admin still works).
→ **paste all check outputs.**

### S2 — Verify Storage policies (Phase 2)  ⬜ PENDING (verification required)
**Action:**
```sql
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
ORDER BY policyname;
```
**PASS:** every INSERT/UPDATE/DELETE policy references `is_pintag_admin(auth.uid())`; the only reads are the two public SELECTs (`property-images`, `agent-photos`). No `TO authenticated`/`auth.email` write policy remains. → **paste the output.**

### S3 — Enable + enforce MFA/TOTP (Phase 1.3)  ⬜ PENDING (confirmation required)
**Action (dashboard):** Authentication → confirm **TOTP MFA is enabled** for the project; confirm `cyrora.trading@gmail.com` has an **enrolled + verified** TOTP factor (the admin pages already *enforce* AAL2 in code). Also enable 2FA on the **Supabase account** that owns the project (Account → Security) and on cyrora's Google login.
**PASS:** TOTP enabled; cyrora AAL2 login works; a login without the 6-digit code is rejected. → **confirm.**

### S4 — Remove legacy/test accounts (Phase 1.4) — only after S1 PASS  ⬜ PENDING
**Action:** run `scripts/migrate-admin-to-cyrora-and-remove-legacy-accounts.sql` STEP 1→4 (confirms cyrora sole admin → discovers FKs → decouples parties → `non_cyrora_party_links`=0), then **STEP 5 in the dashboard**: Authentication → Users → delete `admin@pintag.io`, `testadmin@pintag.io`, and any other confirmed-unused test accounts. cyrora stays.
**PASS:** STEP 4 shows `non_cyrora_party_links`=0 before deletion; after deletion, verify-script **C2** returns 0 legacy accounts. → **paste STEP 4 output + post-deletion C2.**
> ⚠ Do **not** delete any auth user while S1/C9 hasn't proven cyrora writes — losing admin access is the one irreversible risk here.

### S5 — Recover listings, as hidden drafts (Phase 3)  ⬜ PENDING
**Action:** run `scripts/recover-listings-from-manifest.sql` (run the PRE-CHECK, then the `BEGIN…INSERT…` block, inspect the counts, then `COMMIT`). Restores original `id` (UUID) + `title_lo` + `property_type` + `district_en` + `transaction_type` as `status='draft'` (hidden).
**PASS:** `manifest_recoverable`, `drafts_now`, and `properties_total_now` are consistent (drafts = recoverable manifest rows not already present); nothing published. → **paste the count output.**

### S6 — Recover photos + remaining metadata (Phase 3, manual)  ⬜ PENDING
**Action:** run `scripts/recover-photos-storage-matching.sql` STEP A–B (inventory + orphan count), then STEP C clustering; assign clusters → listings using Wayback/Google-cache/Facebook (the UUID→file link was destroyed, so per-file assignment is human). Enrich price/description/bedrooms/sizes from the same caches + the agents. Keep everything `draft` until complete.
**PASS (data-collection, not a single number):** `orphaned_photos` counted; clusters produced; each assignment recorded. → **paste STEP A/B counts;** per-listing enrichment is tracked in the Phase 4 audit below.

---

## Part 2 — Phase 2 PASS/FAIL report (filled from S1–S2 outputs; nothing marked PASS without output)

| Assertion | Source | Result |
|---|---|---|
| Only cyrora can write | S1 · C4 + C9 | ⬜ pending output |
| anon cannot write | S1 · C6 + C8 | ⬜ pending output |
| authenticated non-admin cannot write | S1 · C7 | ⬜ pending output |
| agents cannot modify listings | S1 · C7 (agents are non-admin) | ⬜ pending output |
| Storage policies correct | S2 | ⬜ pending output |
| Edge functions fail closed | Part 0 · R9 (code) + a live 401 test with a non-admin JWT | ✅ code / ⬜ live |

## Part 3 — Phase 4 recovery audit (filled from S5–S6; nothing fabricated)

| Bucket | Count | Source |
|---|---|---|
| Fully restored (all core fields + photos + description) | ⬜ | manual, post-enrichment |
| Partially restored (skeleton only: UUID/title_lo/type/district/txn) | ⬜ | S5 `drafts_now` |
| Requiring manual review (no usable `title_lo`, or ambiguous cluster) | ⬜ | manifest rows with null `title_lo` + unassigned clusters |
| Missing photos | ⬜ | S6 orphaned/unassigned |
| Missing metadata (price/desc/beds/size/etc.) | ⬜ | not in manifest — enrichment backlog |

## Part 4 — Go/No-Go gate (Phase 6)

**Not issued.** A "Go" is only produced when S0–S6 are all PASS from real output, the final security
audit (Phase 5) shows **zero unresolved High/Critical**, and the owner explicitly approves. Until then:
**maintenance mode stays ON; the site stays offline.** If any High/Critical remains, it is reported here
and maintenance stays on — reopening is never the fallback.
