# Pintag Incident Recovery Playbook — CANONICAL

**Incident:** 2026-08-03 production breach (weak-password `testadmin@pintag.io` + permissive
`USING(true)` write policies reintroduced by dashboard drift → 93 listings defaced/deleted via
the REST API). **This document is the single source of truth for the recovery.**

**Current status: MAINTENANCE MODE IS ON — the public site returns HTTP 503 and MUST stay offline**
until every checklist below is PASS **with evidence** and the owner (`cyrora.trading@gmail.com`)
**explicitly approves** reopening. Do not disable maintenance mode. Do not reopen. Do not assume
production state. Do not fabricate results.

---

## Legend & rules

| Marker | Meaning |
|---|---|
| **✅ VERIFIED FROM CODE** | Confirmed from the repository this session. A *static* fact about code/scripts — **not** proof of production state. |
| **⬜ REQUIRES PRODUCTION VERIFICATION** | Must be run by the operator against the live Supabase project / Cloudflare / GitHub. **Not complete until its Evidence field is filled from real output.** |
| **▶ IN PROGRESS / ⏸ BLOCKED / ✔ DONE (evidence: …)** | Status of a production step. `✔ DONE` is only allowed with an evidence reference. |

**Hard rules:** (1) No production step is marked complete without captured evidence. (2) Never delete
an auth account, publish a listing, or reopen the site until the gates below pass. (3) The
sandbox/agent has **no network path to production** — it cannot run any Part B step; it can only
verify code (Part A) and interpret evidence you paste.

---

## Part A — Verified from code (static; completed 2026-08-04)

These are correct in the repository. They do **not** assert production is in this state.

| # | Item | Result | Evidence (in-repo) |
|---|------|--------|--------|
| A1 | Lockdown migrations present, last in chain | ✅ VERIFIED FROM CODE | `supabase/migrations/20260804120000_…`, `20260804130000_…cyrora…`, `20260804140000_…storage…` |
| A2 | Migrations structurally sound (balanced txn) | ✅ VERIFIED FROM CODE | each `BEGIN…COMMIT`; extra `BEGIN/END` are plpgsql bodies |
| A3 | No RLS write hole on data tables | ✅ VERIFIED FROM CODE | only `(true)` policies are public SELECT + anon analytics INSERT |
| A4 | Every data-table write = `is_pintag_admin()` | ✅ VERIFIED FROM CODE | `130000` drop-all-then-recreate per table |
| A5 | All 16 `is_pintag_staff` policies recreated as `is_pintag_admin` (0 survive) | ✅ VERIFIED FROM CODE | parsed every `CREATE POLICY`; remaining `is_pintag_staff` only in RPC bodies via the alias |
| A6 | anon write grants revoked | ✅ VERIFIED FROM CODE | `REVOKE INSERT,UPDATE,DELETE … FROM anon` in `130000` |
| A7 | Storage writes = `is_pintag_admin()`, public read only | ✅ VERIFIED FROM CODE | `140000` (both buckets) |
| A8 | 6 admin pages on unified `admin-auth.js` (cyrora+JWT+AAL2+`requireAdminSession`) | ✅ VERIFIED FROM CODE | `admin`, `analytics`, `intelligence`, `analytics-inspector`, `watermark-migrate`, `agent-setup` |
| A9 | 4 edge functions fail closed via `is_pintag_admin()` RPC | ✅ VERIFIED FROM CODE | `generate-listing-content`, `generate-intelligence-report`, `smart-listing-importer`, `facebook-listing-fetcher` |
| A10 | Verify/migrate/recovery scripts correct & idempotent | ✅ VERIFIED FROM CODE | `scripts/verify-single-admin-lockdown.sql`, `…migrate-admin…`, `…recover-listings…`, `…recover-photos…` |
| A11 | Maintenance worker deployed, 4 routes bound | ✅ VERIFIED FROM CODE + CI | `deploy-prod.yml` run #78, worker `pintag-og-listing-preview` v`d55e1ff4`; live 503 confirmed by owner |

**Do not infer any production fact from Part A.** Whether the migrations are *applied* is Step P0.

---

## Part B — Production execution steps (in order)

Run top to bottom. Do not pass a step until its Evidence field is filled and PASS met.

### P0 — Apply / confirm the lockdown migrations
- **Objective:** ensure `admin_accounts` + `is_pintag_admin()` + the locked-down policies exist in prod.
- **Action (SQL editor):**
  ```sql
  SELECT to_regclass('public.admin_accounts') IS NOT NULL AS admin_accounts_exists,
         EXISTS (SELECT 1 FROM pg_proc WHERE proname='is_pintag_admin') AS is_pintag_admin_exists;
  ```
  If either is `false`, paste and run, **in order**: `20260804120000_…`, `20260804130000_…`, `20260804140000_…`, then re-run the check.
- **PASS:** both columns `true`.
- **FAIL:** either `false` after applying → stop; capture the migration error output.
- **Rollback:** each migration is one `BEGIN…COMMIT`; a failed apply rolls back automatically, changing nothing. Migrations are idempotent (safe to re-run).
- **Evidence to capture:** GUARD 0 output (2 columns); if applied, the "Success. No rows returned" confirmations.
- **Status:** ✔ **DONE** (2026-08-04) — evidence: GUARD 0 returned `admin_accounts_exists=true`, `is_pintag_admin_exists=true`. The cyrora lockdown migrations are applied to production.

### P1 — Verify single administrator + authorization boundary
- **Objective:** prove cyrora is the only admin and `is_pintag_admin()` is true only for cyrora.
- **Action:** run checks **1** and **5** of `scripts/verify-single-admin-lockdown.sql`.
- **PASS:** C1 = exactly one row `cyrora.trading@gmail.com`; C5a `admin_cyrora`/`staff_cyrora`=`true`, `admin_random`/`staff_random`=`false`; C5b = 0 rows. **C5c (`staff_parties_remaining`) is expected to be `1` until P7** — the obsolete `admin@pintag.io` staff party is deleted in P7·STEP 4a; **`C5c=0` is a P7 post-condition, not a P1 gate.**
- **FAIL:** more than one admin row (C1), any random uid `true` (C5a), or any **policy** still referencing the staff model / an email check (C5b > 0).
- **Note (residual finding, Medium — tracked, closed by P6+P7):** `is_pintag_staff` is aliased to `is_pintag_admin`, so the leftover staff party grants **no RLS write access** (admin@pintag.io ∉ `admin_accounts`). However, the **currently-deployed** edge functions are still the pre-fix versions that trust `type='staff'`/`admin@pintag.io`, so that party + the live `admin@pintag.io` account remain a residual **edge-function-invocation** path (Gemini cost/abuse only — **not** DB writes, which RLS blocks) until **P6** redeploys the functions and **P7** removes the account + staff party.
- **Rollback:** read-only (probes run inside `BEGIN…ROLLBACK`) — nothing to roll back.
- **Evidence to capture:** SQL output of C1, C5a, C5b, C5c.
- **Status:** ✔ **DONE** (2026-08-04) — C1=1 (cyrora sole admin); C5a booleans true/true/false/false; C5b=0; C5c=0 after a surgical, side-effect-previewed deletion of the `95bdc7c6…` staff party (all 4 FKs `ON DELETE SET NULL`; blast-radius previewed before COMMIT). The retired staff model is gone from both the authorization layer and the data model. Evidence in Part D.

### P2 — RLS verification (no write holes; only admin writes)
- **Objective:** prove anon/non-admin/agents cannot write, cyrora can.
- **Action:** run checks **3, 4, 6, 7, 8, 9** of the verify script.
- **PASS:** C3 = 0 permissive write policies on data tables; C4 every write predicate = `is_pintag_admin(auth.uid())`; C6 = 0 anon write grants; C7 `nonadmin_rows_updated`=0 and `nonadmin_rows_deleted`=0 (this is also the **agents-cannot-modify-listings** proof); C8 `anon_rows_updated`=0; C9 `admin_rows_updated` = current `properties` row count.
- **FAIL:** any non-zero non-admin/anon write; any write policy not `is_pintag_admin`; C9 = 0 (admin locked out — investigate before anything else).
- **Rollback:** read-only (C7–C9 use `BEGIN…ROLLBACK`).
- **Evidence to capture:** SQL output of C3, C4, C6, C7, C8, C9.
- **Status:** ✅ **PASS (core boundary)** — all four live write tests confirmed in production:
  - **P2.1 (anon) PASS** — `permission denied for table properties` on UPDATE/DELETE/INSERT (blocked at the **privilege** layer; anon holds no write grants).
  - **P2.2 (authenticated non-admin) PASS** — `new row violates row-level security policy for table "properties"` (blocked at the **RLS** layer; `WITH CHECK is_pintag_admin`).
  - **P2.3 (real agent) PASS** — agent *Viengkhone Phomthavong* (`auth_user_id = bb7ff815-9db9-41a4-9914-c0f7b97f9046`): DELETE returned **0 rows** — an agent JWT cannot modify protected listing data. This is the agents-cannot-modify-listings proof (C7).
  - **P2.4 (sole administrator) PASS** — cyrora UPDATE affected `cyrora_update = 5` rows inside `BEGIN … ROLLBACK` (no data changed); the single admin retains full write access (C9).
  - **Deferred to P5 (final production verification), NOT part of this core-boundary PASS:**
    - **P2.5 — Storage live check** → see **P3** (Storage policy verification); run the `pg_policies` (storage) query in production.
    - **P2.6 — Edge-function live 401 test** → see **P6**; **blocked until the 4 fixed edge functions are deployed** (production currently runs the pre-fix versions). Live 401-for-non-admin / 200-for-cyrora must be tested *after* deploy, not before.

### P3 — Storage policy verification
- **Objective:** prove Storage writes require `is_pintag_admin()`, reads are public.
- **Action (SQL editor):**
  ```sql
  SELECT policyname, cmd, roles, qual, with_check
  FROM pg_policies WHERE schemaname='storage' AND tablename='objects' ORDER BY policyname;
  ```
- **PASS:** every INSERT/UPDATE/DELETE policy references `is_pintag_admin(auth.uid())`; only reads are the 2 public SELECTs; no `TO authenticated`/`auth.email` write policy.
- **FAIL:** any write policy on `TO authenticated` without `is_pintag_admin`, or an `auth.email` predicate remaining.
- **Rollback:** read-only.
- **Evidence to capture:** the full `pg_policies` (storage) output.
- **Status:** ⬜ REQUIRES PRODUCTION VERIFICATION

### P4 — Authentication path verification (admin pages)
- **Objective:** prove every admin page requires cyrora + valid JWT + AAL2, server-validated on load.
- **Action:** (a) **VERIFIED FROM CODE** — all 6 pages use `admin-auth.js` (Part A A8); (b) **live browser test** on the maintenance-passthrough admin pages: (i) log in as a non-cyrora account → rejected; (ii) cyrora with correct password but no 6-digit code → blocked at the code step; (iii) reload mid-session → re-validated (no auto-login); (iv) clear the Supabase session in devtools → next action drops to the login overlay.
- **PASS:** all four browser behaviors as described; code check already ✅.
- **FAIL:** any page reachable without cyrora+AAL2, or an auto-login from a stale session.
- **Rollback:** none (test only).
- **Evidence to capture:** screen recording/screenshots of (i)–(iv) for at least `admin.html` (repeat for others if desired).
- **Status:** ✅ VERIFIED FROM CODE / ⬜ live browser test REQUIRED

### P4b — Auth URL Configuration (fix localhost recovery redirect)
- **Objective:** password-recovery / auth emails redirect to production, not `localhost:3000`.
- **Root cause (VERIFIED FROM CODE):** the app set no `redirectTo`, so recovery used the project **Site URL**, whose factory default is `http://localhost:3000`. The only `3000` in the repo is `supabase/config.toml` (local CLI emulator) — **not** the hosted config.
- **Action (dashboard — production project `eoladhcljbpbhnrmmpev`, Authentication → URL Configuration):**
  - **Site URL:** `https://pintag.io`
  - **Redirect URLs:** `https://pintag.io/reset-password.html`
  - Dev project `ebtgoqrywdywuqrvudcp` (separate): Site URL `https://pintag-cyrora.github.io/pintag-dev/`; Redirect URLs `…/pintag-dev/reset-password.html` (+ `http://localhost:8000/reset-password.html`, `http://127.0.0.1:8000/reset-password.html` if the local flow is used). Full rationale + the exact lists: **`docs/AUTH_URL_CONFIGURATION.md`**.
- **Code (VERIFIED FROM CODE):** `admin-auth.js` now initiates recovery via the **Forgot password?** link → `resetPasswordForEmail(email, { redirectTo: new URL('reset-password.html', location.href).href })`, gated to `cyrora.trading@gmail.com`; new handler `reset-password.html` consumes the token → `updateUser({password})` → signs out → `admin.html` (AAL2 gate unchanged). Deterministic even if a Site URL is ever wrong again.
- **Full auth-flow audit (VERIFIED FROM CODE):** password recovery is the app's **only** email-link flow and now carries an explicit `redirectTo`. There are **no** magic-link (`signInWithOtp`), invite (`inviteUserByEmail`/`generateLink`), or email-verification (`signUp`) flows anywhere (signup was removed — `SECURITY.md:126`; accounts are dashboard-provisioned). Standing rule recorded in `docs/AUTH_URL_CONFIGURATION.md`: any future such flow must pass an explicit `redirectTo` + allow-list entry.
- **Maintenance reachability (VERIFIED FROM CODE):** the worker 503s only `/`, `/index.html`, `/listings.html`, `/listing.html` (`og-listing-preview.js:419-424`); `reset-password.html` passes through, so recovery works during maintenance. Test plan in `docs/AUTH_URL_CONFIGURATION.md`.
- **PASS:** dashboard shows the values above; a real reset email's link opens `https://pintag.io/reset-password.html` (not localhost); setting a new password succeeds and the next admin sign-in still requires AAL2.
- **FAIL:** link still opens localhost (Site URL not saved), or the redirect target isn't allow-listed (Supabase shows "redirect URL not allowed").
- **Rollback:** dashboard settings are reversible; the code path is additive (no change to the existing login/AAL2 gate).
- **Evidence to capture:** screenshot of the URL Configuration screen; the opened reset link URL; a successful password update.
- **Status:** ✅ CODE + DOCS DONE / ⬜ dashboard values REQUIRE PRODUCTION VERIFICATION

### P4c — Public sign-up disabled (single-admin model)
- **Objective:** no unauthenticated visitor can create an account in production; new accounts are created only through the intentional dashboard/admin process.
- **Local vs production distinction (VERIFIED FROM CODE):** `supabase/config.toml` has `enable_signup = true`, but that file configures **only the local Supabase CLI emulator** (`supabase start`) and has **no effect** on the hosted production project. `enable_signup = true` is acceptable for local development. The **hosted production project** must have public sign-up **disabled** in the dashboard, consistent with the single-admin model — and the app itself has no `signUp` call (removed, `SECURITY.md:126`).
- **Action (dashboard — production project `eoladhcljbpbhnrmmpev`):** Authentication → Sign In / Providers → **disable "Allow new users to sign up"** (email provider) so account creation is admin-initiated only.
- **Verification step — "Attempt to access the public sign-up flow in production":**
  - Try to self-register as an unauthenticated user against production — e.g. `POST https://eoladhcljbpbhnrmmpev.supabase.co/auth/v1/signup` with the anon key and a fresh email/password, and/or any public registration UI.
  - **PASS:** public sign-up is disabled or unavailable — the request is rejected (e.g. "Signups not allowed for this instance") and **no** unauthenticated user can create an account.
  - **FAIL:** a new public account can be created.
- **Rollback:** the setting is reversible in the dashboard (do not re-enable without cause).
- **Evidence to capture:** screenshot of the sign-up setting = disabled; the rejected `signup` response body/status.
- **Status:** ⬜ REQUIRES PRODUCTION VERIFICATION — **final pre-reopen gate (see checklist 11)**

### P5 — MFA (TOTP / AAL2) verification
- **Objective:** MFA is enabled in the project and enforced for cyrora; also protect the Supabase account itself.
- **Action (dashboard):** Authentication → Providers → confirm **TOTP MFA enabled**; confirm cyrora has an **enrolled + verified** TOTP factor; enable 2FA on the **Supabase account** (Account → Security) and on cyrora's Google login.
- **PASS:** TOTP enabled; cyrora AAL2 login succeeds; login without code is rejected (ties to P4-ii).
- **FAIL:** TOTP disabled (admin pages would error at enrollment), or cyrora has no verified factor.
- **Rollback:** MFA settings are reversible in the dashboard (do not disable).
- **Evidence to capture:** screenshot of the MFA/providers setting + cyrora's factor list; the P4-ii result.
- **Status:** ⬜ REQUIRES PRODUCTION VERIFICATION

### P6 — Edge function deployment + fail-closed live test
- **Objective:** the 4 admin edge functions are deployed and deny non-admin callers.
- **Action:** deploy `supabase functions deploy generate-listing-content generate-intelligence-report smart-listing-importer facebook-listing-fetcher`; then a live test — call one with (a) no token and (b) a non-admin JWT.
- **PASS:** deploy succeeds; both (a) and (b) return **401 "Admin only" / "Missing auth token"** (fail closed). Code path already ✅ (A9).
- **FAIL:** any function returns 200 for a non-admin, or errors open.
- **Rollback:** redeploy the prior version (functions are versioned in Supabase).
- **Evidence to capture:** `functions deploy` output; the 401 responses from the live test.
- **Status:** ✅ VERIFIED FROM CODE / ⬜ deploy + live 401 test REQUIRED

### P7 — Admin account cleanup (remove legacy/test accounts)
- **Objective:** exactly one auth account (cyrora) has any privileged standing.
- **Action:** run `scripts/migrate-admin-to-cyrora-and-remove-legacy-accounts.sql` STEP 1→4 (confirm cyrora sole admin → discover FK references → decouple parties → verify `non_cyrora_party_links`=0), then **STEP 5 in the dashboard**: Authentication → Users → delete `admin@pintag.io`, `testadmin@pintag.io`, and any other confirmed-unused test accounts. Re-run verify **C2**.
- **PASS:** STEP 4 shows `non_cyrora_party_links`=0 *before* any deletion; post-deletion C2 = 0 legacy rows.
- **FAIL:** any non-cyrora reference remains, or C2 returns a legacy account after deletion.
- **Rollback:** STEP 4 is transactional — `ROLLBACK` before `COMMIT` if the counts look wrong. **STEP 5 (auth-user deletion) is effectively irreversible** — the safeguard is the *pre-conditions*: **do not delete any account until P1 (cyrora sole admin) and P2·C9 (cyrora can write) are PASS and STEP 4 shows 0 references.**
- **Evidence to capture:** STEP 4 `non_cyrora_party_links` output; screenshot of the Users list before/after deletion; post-deletion C2 output.
- **Status:** ⬜ REQUIRES PRODUCTION VERIFICATION — **gated on P1 + P2 PASS**

### P8 — Listing recovery (skeletons as hidden drafts)  ← *user "P3"*
- **Objective:** re-create the deleted listings from the manifest, using original UUIDs, as hidden drafts only, preserving every field exactly, fabricating nothing.
- **Manifest columns available** (`properties_removal_log`): `property_id` (original UUID), `title_lo` (real Lao title, preserved), `property_type`, `district_en`, `transaction_type`, plus `title_en` (**corrupted to `HACKED` — deliberately NOT copied**), `status_at_removal`, `listed_at`, `removed_at`. Everything not in this list (price, bedrooms, sizes, images, description, slug, title_en/zh, coordinates, amenities, contacts/owner/agent) is left **NULL** for P9 enrichment.
- **PRE-CHECK RESULT (production, 2026-08-04):** the only NOT-NULL-no-default column is **`title_en` (text)**. Its sole manifest value is the attacker's `'HACKED'`, which must not be restored, and the column cannot be NULL — so the INSERT writes `title_en = ''` (empty string): satisfies the constraint, fabricates no title, and marks the English title as the P9 enrichment worklist. `title_lo` is **not** copied into it (that would misrepresent the Lao title as English). No CHECK/non-empty constraint exists on `title_en` (verified from migrations), so `''` is accepted.
- **Action — run `scripts/recover-listings-from-manifest.sql` in order, one block at a time:**
  1. **PRE-CHECK** (outside the txn): list NOT-NULL columns without a default. ✔ Done — returned `title_en` only; handled as above.
  2. **STEP 1 — restore** (`BEGIN … INSERT … SELECT` from the deduped `recoverable` CTE, `COMMIT`). Sets `id`(UUID)+`title_lo`+`title_en=''`+`property_type`+`district_en`+`transaction_type`, `workflow_status='draft'`, `status='draft'`, `market_status='available'`. `DISTINCT ON (property_id) … ORDER BY removed_at DESC` dedups the one-row-per-delete manifest so no duplicate-PK error; `NOT EXISTS(id)` makes it idempotent.
  3. **STEP 2 — recovery statistics** (read-only): `restored`, `partially_restored`, `missing_property_type/district/transaction_type`, `missing_english_title`, `missing_photos`, `unrecoverable`.
  4. **STEP 3 — post-recovery validation V1–V4** (read-only, all must PASS).
- **PASS (all of):**
  - STEP 1 counts: `drafts_now` = the recoverable manifest UUIDs not already present; `properties_total_now` rose by exactly that many.
  - STEP 2: `restored` = `manifest_recoverable`; `missing_photos` = `restored` (expected — photos re-attach in P9); `unrecoverable` = manifest UUIDs with no `title_lo`.
  - **V1** `match_gap = 0` (restored UUIDs = recoverable manifest UUIDs).
  - **V2** 0 rows (no duplicate UUID).
  - **V3** `not_draft = 0` (every restored row is `workflow_status='draft'` AND `status='draft'`).
  - **V4** `publicly_visible_recovered = 0` **and** `recovered_publicly_reachable_by_slug = 0` (reproduces the live public predicate `or=(status.neq.draft,status.is.null)` — `listings.html:1018` — plus the slug guard).
- **FAIL:** a NOT-NULL column error (add per PRE-CHECK, retry); any non-zero `match_gap`/`not_draft`/`publicly_visible_recovered`/duplicate row; `restored` ≠ `manifest_recoverable`.
- **Rollback:** STEP 1 is transactional — `ROLLBACK` before `COMMIT` if STEP-1 counts look wrong. After commit, recovered rows are drafts (never public) and can be deleted by `id`. Idempotent — safe to re-run.
- **Evidence to capture:** PRE-CHECK output; STEP-1 count row; STEP-2 statistics row; V1–V4 outputs.
- **Status:** ✅ **PASS — recovered in production 2026-08-04.** Evidence: PRE-CHECK = `title_en` only (handled `''`); dry-run = 91 recoverable / 2 unrecoverable (91+2 = the 93 breached) / 5 survivors; STEP 1 = `properties_total_now` 5→**96** (+91), `manifest_recoverable`=91; STEP 2 = `restored`=91, `partially_restored`=4 (all = `missing_district`=4; `property_type`/`transaction_type` complete), `missing_english_title`=91 (by design), `missing_photos`=91 (P9 worklist), `unrecoverable`=2; STEP 3 = **V1 `match_gap`=0, V2 dup=0, V3 `not_draft`=0, V4 `publicly_visible`=0 & `reachable_by_slug`=0**. 91 hidden drafts; nothing published; maintenance ON. **P9 worklist:** 91 English titles, 91 photo sets, 4 districts.

### P9 — Photo + metadata recovery (manual enrichment)
- **Objective:** re-attach surviving Storage photos and enrich remaining fields — no fabrication.
- **Action:** run `scripts/recover-photos-storage-matching.sql` STEP A–B (inventory + orphan count), STEP C clustering; assign clusters→listings via Wayback/Google-cache/Facebook (per-file link was destroyed — human step). Enrich price/description/bedrooms/sizes from caches + agents. Keep everything `draft` until complete.
- **PASS (data collection, not one number):** `orphaned_photos` counted; clusters produced; each assignment + enrichment recorded in the Phase-4 audit; a listing is only published when genuinely complete.
- **FAIL:** any listing published while incomplete; any fabricated value entered.
- **Rollback:** the guarded attach step in the script sets `images` and can be reverted to `NULL`; drafts stay unpublished.
- **Evidence to capture:** STEP A/B counts; per-listing enrichment log (source of each recovered field); before/after of any publish.
- **Status:** ⬜ REQUIRES PRODUCTION VERIFICATION

### P10 — Final security audit (full sweep)
- **Objective:** one complete audit across all surfaces; report every remaining issue.
- **Action + split:**
  | Surface | Verified from code | Requires production verification |
  |---|---|---|
  | Authentication | ✅ A8 (6 pages, cyrora+JWT+AAL2) | ⬜ P4 live browser test |
  | Authorization | ✅ A4/A5 (`is_pintag_admin` boundary) | ⬜ P1/P2 outputs |
  | RLS | ✅ A3/A4/A5/A6 | ⬜ P1/P2 outputs |
  | Storage | ✅ A7 | ⬜ P3 output |
  | Edge Functions | ✅ A9 (fail closed) | ⬜ P6 deploy + live 401 |
  | Admin pages | ✅ A8 | ⬜ P4 |
  | GitHub Actions | ✅ deploy-prod green; no workflow applies migrations/secrets to DB | ⬜ confirm secrets present, none printed in logs |
  | Cloudflare Worker | ✅ A11 (maintenance on) | ✅ live 503 confirmed |
  | Worker routes | ✅ 4 routes bound to canonical worker | ⬜ delete legacy `pintag-og` worker (consolidation) |
  | Secrets | ✅ anon key publishable; service-role absent from client; CF token user-owned | ⬜ confirm service-role/GEMINI/CF secrets only in Supabase/GitHub secret stores |
  | MFA | ✅ AAL2 enforced in code | ⬜ P5 |
  | Recovery scripts | ✅ A10 | ⬜ P8/P9 outputs |
- **PASS:** zero unresolved **High/Critical**; every "requires production verification" cell has evidence.
- **FAIL:** any High/Critical open → it is recorded here and **maintenance stays ON**.
- **Evidence to capture:** links to each step's evidence; a written finding for anything not PASS.
- **Status:** ⬜ REQUIRES PRODUCTION VERIFICATION (assembled from P0–P9)

### P11 — Go / No-Go decision
- **Objective:** a single explicit decision, owner-approved, on whether to reopen.
- **Action:** review P0–P10 evidence; owner records GO or NO-GO below.
- **PASS (GO) allowed only if:** P0–P9 all PASS with evidence **and** P10 shows zero High/Critical **and** the owner explicitly approves. Only then: disable `MAINTENANCE_MODE` (flip the flag, redeploy the worker) — a *separate*, owner-initiated action, not part of any earlier step.
- **FAIL (NO-GO):** any gate unmet → keep maintenance ON, list the blockers, do not reopen.
- **Rollback (if reopened then a problem appears):** set `MAINTENANCE_MODE=true`, redeploy the worker (the documented "kill switch").
- **Evidence to capture:** the completed checklists, the P10 audit, and the owner's dated GO/NO-GO note.
- **Status:** ⬜ NOT ISSUED

---

## Part C — The 11 checklists

Legend per line: `✅` verified from code · `⬜` requires production verification (fill evidence).

### 1. Security lockdown
- ✅ Lockdown migrations exist & sound (A1/A2) · ⬜ **applied to prod** (P0)
- ✅ No `USING(true)` write policy on data tables (A3) · ⬜ confirmed live (P2·C3)
- ✅ anon write grants revoked (A6) · ⬜ confirmed live (P2·C6)

### 2. Authentication
- ✅ 6 admin pages on `admin-auth.js`, cyrora-only, server-validated JWT (A8)
- ✅ password recovery uses an **explicit `redirectTo`** (deterministic per-env), never the Site URL; handler `reset-password.html` added (P4b)
- ⬜ live: non-cyrora rejected; reload re-validates; cleared session → login (P4)
- ⬜ **Auth URL Configuration** set in the prod project — Site URL `https://pintag.io`, Redirect URL `https://pintag.io/reset-password.html` (P4b; see `docs/AUTH_URL_CONFIGURATION.md`)
- ⬜ **Public sign-up disabled** in the prod project; "attempt public sign-up" verification PASS — no unauthenticated account creation (P4c). `config.toml enable_signup=true` is local-emulator only.

### 3. MFA verification
- ✅ AAL2 enforced in `admin-auth.js` code
- ⬜ TOTP enabled in project; cyrora factor enrolled+verified; login without code rejected (P5)
- ⬜ 2FA on the Supabase *account* + cyrora Google login (P5)

### 4. RLS verification
- ✅ every data-table write = `is_pintag_admin()` (A4); all staff policies recreated (A5)
- ⬜ C4 predicates live (P2·C4); C7 non-admin/agents cannot write (P2·C7); C8 anon cannot (P2·C8); C9 cyrora can (P2·C9)

### 5. Storage policy verification
- ✅ `140000` gates writes on `is_pintag_admin()` (A7)
- ⬜ live `pg_policies(storage.objects)` shows admin-only writes, public reads (P3)

### 6. Edge function deployment
- ✅ 4 functions fail closed via `is_pintag_admin()` RPC (A9)
- ⬜ deployed to prod; live non-admin call → 401 (P6)

### 7. Admin account cleanup
- ⬜ cyrora sole admin (P1·C1) · ⬜ `non_cyrora_party_links`=0 (P7 STEP 4)
- ⬜ `admin@pintag.io`, `testadmin@pintag.io`, other test accounts deleted (P7 STEP 5) · ⬜ C2=0 after (P7)

### 8. Listing recovery
- ✅ recovery SQL correct: original UUIDs, hidden drafts only, dedup-by-UUID, idempotent, no fabrication, NULL for missing (A10 / P8)
- ✅ recovery statistics + V1–V4 post-recovery validation queries written into the script (P8 STEP 2 / STEP 3)
- ✅ executed 2026-08-04: 91 hidden drafts restored; `restored`=`manifest_recoverable`=91; V1 `match_gap=0`; V2 no dupes; V3 `not_draft=0`; V4 `publicly_visible_recovered=0`; nothing published (P8)

### 9. Photo recovery
- ✅ photo-matching script correct (A10)
- ⬜ inventory/orphan/cluster run; clusters assigned via Wayback/FB; enrichment logged; no fabrication (P9)

### 10. Final security audit
- ⬜ all 12 surfaces in P10 table have evidence; zero unresolved High/Critical

### 11. Go / No-Go decision
- ⬜ **Public sign-up disabled in production + "attempt public sign-up" verification PASS** (P4c) — mandatory final pre-reopen gate
- ⬜ every checklist above PASS with evidence · ⬜ owner explicitly approves · ⬜ only then reopen

---

## Part D — Evidence log (fill as you go)

| Step | Date (UTC) | Operator | Evidence (output / screenshot / log ref) | Result |
|---|---|---|---|---|
| P0 | 2026-08-04 | owner | GUARD 0: `admin_accounts_exists=true`, `is_pintag_admin_exists=true` | ✔ PASS |
| P1 | 2026-08-04 | owner | C1=1 (cyrora); C5a=t/t/f/f; C5b=0; C5c=0 after deleting staff party `95bdc7c6` (FKs SET NULL, side-effects previewed) | ✔ PASS |
| P2 | 2026-08-04 | owner | P2.1 anon `permission denied`; P2.2 non-admin `new row violates RLS`; P2.3 agent Viengkhone Phomthavong (`bb7ff815…`) DELETE=0 rows; P2.4 cyrora `cyrora_update=5` in BEGIN/ROLLBACK. P2.5 (storage)→P3, P2.6 (edge-fn 401)→P6 after deploy. | ✔ PASS (core boundary) |
| P3 | | | | ⬜ |
| P4 | | | | ⬜ |
| P5 | | | | ⬜ |
| P6 | | | | ⬜ |
| P7 | | | | ⬜ |
| P8 | 2026-08-04 | owner | 91 restored as hidden drafts (total 5→96); STEP2 restored=91/partial=4(district)/missing_en_title=91/missing_photos=91/unrecoverable=2; V1 gap=0, V2 dup=0, V3 not_draft=0, V4 0/0 | ✔ PASS |
| P9 | | | | ⬜ |
| P10 | | | | ⬜ |

---

## Part E — Go / No-Go record (not yet issued)

> **Decision:** ☐ GO ☐ NO-GO
> **By:** ____________________  **Date (UTC):** ____________________
> **Basis:** all of P0–P10 PASS with evidence, zero unresolved High/Critical.
> **Blockers (if NO-GO):** ____________________
>
> Reopening = a separate owner-initiated action: set `MAINTENANCE_MODE=false` in
> `cloudflare-worker/og-listing-preview.js`, commit, and let `deploy-prod.yml` redeploy the worker.
> **Until GO is recorded and approved, maintenance mode stays ON and the site stays offline.**
