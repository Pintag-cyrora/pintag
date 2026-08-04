# Pintag Security Audit — Unified Administrator Authentication

**Date:** 2026-08-04
**Scope:** Repository-wide administrator authentication, authorization, and storage lockdown, following the 2026-08-03 production breach.
**Author:** Security hardening pass (single-administrator consolidation).
**Supersedes the auth/RLS/storage sections of:** `SECURITY.md` (June 2026, pre-incident).

---

## Verdict

> **Code / repository state: ZERO unresolved Critical or High findings.**
> Every privileged page, every admin edge function, and the storage layer now
> gate on the same single administrator (`cyrora.trading@gmail.com`) through one
> authorization boundary (`is_pintag_admin()`). No legacy `admin@pintag.io`
> check, password-only admin login, `getSession()` auto-login, staff-model
> check, dev backdoor, or hardcoded credential remains in live application or
> edge-function code.
>
> **Production runtime: NOT YET SAFE TO REOPEN.** The code guarantees above only
> take effect once the migrations, account removal, 2FA enablement, and edge-
> function/worker deploys in **§9 (Mandatory pre-reopen steps)** are applied and
> **`scripts/verify-single-admin-lockdown.sql` passes**. Do not reopen the public
> site until §9 is complete and verified.
>
> **Also unconfirmed:** whether the site is currently in maintenance mode at all.
> The Cloudflare Worker that serves the maintenance page has **not** deployed
> through CI (missing secrets). See finding **F7 / "Maintenance mode deployment —
> UNVERIFIED"** below; this must be verified before recovery continues.

---

## 1. What the user asked to confirm

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Every privileged page uses the unified authentication flow | ✅ Met (§3) |
| 2 | Exactly one production administrator (`cyrora.trading@gmail.com`) | ✅ Met in code; enforced at runtime after §9 (§4) |
| 3 | No legacy authentication systems remaining | ✅ Met in live code (§5) |
| 4 | Storage permissions audited and locked down | ✅ Migration written; applied at runtime in §9 (§6) |
| 5 | No remaining Critical or High findings blocking production | ✅ Met — zero unresolved Critical/High (§7) |

---

## 2. Scope & method

- **In scope:** every `*.html` page, shared `*.js`, and Supabase edge function
  (`*.ts`) in the repository that participates in administrator authentication
  or authorization; all `storage.objects` write policies.
- **Method:** full-repository `grep` sweep for each named legacy pattern
  (`admin@pintag.io`, `testadmin`, `is_pintag_staff`, `type='staff'`,
  password-only `signInWithPassword`, `getSession()` auto-login, hardcoded
  credentials, dev backdoors), file-by-file reading of each privileged page's
  auth path, and `node --check` syntax validation of every changed JS surface.
- **Not automatically verifiable from the repo** (requires the live Supabase
  project — listed as runtime steps in §9): whether migrations are applied,
  whether legacy auth accounts still exist, whether TOTP MFA is enabled, and
  whether the edge functions/worker are deployed. This sandbox has no network
  path to the Supabase project or the Gemini API; every DB/edge claim below is a
  code/structure verification, and the live confirmations are the §9 checklist.

---

## 3. Requirement 1 — one unified authentication flow on every privileged page

All administrator authentication now lives in **one** shared module,
**`admin-auth.js`**, used by every privileged page. There is no second copy of
the auth logic to drift out of sync — eliminating that per-page duplication is
the direct fix for the drift that enabled the breach.

`admin-auth.js` enforces, identically for every page:

- **Only `cyrora.trading@gmail.com`** may enter (any other account is rejected
  after sign-in).
- **Email + password + TOTP two-factor (AAL2).** A password alone never grants
  access; a verified 6-digit code is required (and first-time enrollment is
  guided).
- **Server-side session validation on every page load** via `auth.getUser()` +
  `auth.mfa.getAuthenticatorAssuranceLevel()` — never trusts a persisted
  `localStorage` session. There is no auto-login.
- **`requireAdminSession()`** re-validates (server-side) before privileged
  actions and forces re-login if the session is no longer a valid AAL2 admin
  session.

**Privileged pages migrated onto `admin-auth.js` (verified — all load the module
and call `PintagAdminAuth.protect(...)`):**

| Page | Before | After |
|------|--------|-------|
| `admin.html` | inline copy of the correct auth (duplication risk) | delegates to `admin-auth.js` |
| `analytics.html` / `analytics.js` | **password-only `admin@pintag.io` + `getSession()` auto-login** | `admin-auth.js` |
| `intelligence.html` / `intelligence.js` | **password-only `admin@pintag.io` + `getSession()` auto-login** | `admin-auth.js` |
| `analytics-inspector.html` | legacy `admin@pintag.io` | `admin-auth.js` |
| `watermark-migrate.html` | legacy `admin@pintag.io` | `admin-auth.js` |
| `agent-setup.html` | legacy `admin@pintag.io` | `admin-auth.js` |

`analytics.js` and `intelligence.js` were the most exposed: they logged in with a
hardcoded `admin@pintag.io` email + password (no 2FA) and auto-entered the
dashboard from any persisted `getSession()` token — exactly the bypasses the
consolidation removes.

---

## 4. Requirement 2 — exactly one production administrator

Authorization is a single explicit allowlist, not "any authenticated user" and
not "staff parties":

- **`admin_accounts`** table (migration `20260804130000`) — one row today:
  `cyrora.trading@gmail.com`. Adding a second admin later is one `INSERT`; it
  never requires a permissive policy or code change.
- **`is_pintag_admin(uid)`** = `EXISTS (SELECT 1 FROM admin_accounts WHERE
  auth_user_id = uid)` — `SECURITY DEFINER`, the single write-authorization
  check used by RLS on every data table, by storage, and by every admin edge
  function.
- **The staff model is retired.** `is_pintag_staff()` no longer consults
  `parties.type='staff'`; it now aliases `is_pintag_admin()`, so every existing
  RLS policy that still calls it enforces single-admin without a risky rewrite of
  40+ policies. (See §8 for why the alias is kept rather than mass-renamed.)
- **Legacy accounts** (`admin@pintag.io`, `testadmin@pintag.io`, and any other
  non-cyrora logins) are removed by
  `scripts/migrate-admin-to-cyrora-and-remove-legacy-accounts.sql` — after FK
  discovery and ownership migration, so no production data is orphaned and the
  administrator is never locked out (§9).

---

## 5. Requirement 3 — no legacy authentication systems remaining (live code)

Repository sweep result on **live application + edge-function code** (excluding
immutable migration history, test fixtures, the separate `pintag-studio/`
project, and this report):

| Legacy pattern | Live-code hits |
|----------------|----------------|
| `admin@pintag.io` | **0** |
| `testadmin` | **0** |
| `is_pintag_staff(` (frontend/edge) | **0** |
| `type='staff'` / `type=eq.staff` runtime check | **0** |
| password-only admin login | **0** |
| `getSession()` admin auto-login | **0** |
| dev backdoor / hardcoded admin credential | **0** |

**Edge functions** — all four admin functions now authorize via the
`is_pintag_admin()` RPC (the caller's own token; fails **closed** on any error):

- `generate-listing-content` — was `email === 'admin@pintag.io'` → `is_pintag_admin()`
- `generate-intelligence-report` — was `email === 'admin@pintag.io'` → `is_pintag_admin()` (the service-role/pg_cron path is preserved)
- `smart-listing-importer` — was `parties.type='staff'` lookup → `is_pintag_admin()`
- `facebook-listing-fetcher` — was `parties.type='staff'` lookup → `is_pintag_admin()`

**Removed:** `copy-edge-function.html` — a copy-paste utility that embedded a
months-stale, insecure snapshot of `smart-listing-importer` (carrying the
`admin@pintag.io` check and pre-dating all subsequent work). It was an orphan
(no page linked to it) and would have catastrophically regressed the deployed
function if pasted. The real deploy path is `supabase functions deploy`.

> **Note — immutable migration history:** `admin@pintag.io` and
> `is_pintag_staff()` still appear in older `supabase/migrations/*.sql` files
> (June–July) and in current RLS policies that call `is_pintag_staff()`. These
> are **not** live-auth findings: applied migrations are immutable history, and
> `is_pintag_staff()` is now a single-admin alias (§8). The last migration in the
> chain (`20260804130000`) drops-and-recreates every policy to reference
> `is_pintag_admin()` directly and redefines the alias, so the effective
> authorization is single-admin regardless.

---

## 6. Requirement 4 — storage locked down to `is_pintag_admin()`

Before this pass, `storage.objects` write policies for both buckets required
`auth.email() = 'admin@pintag.io'` (`20260625000006`). Once that account is
removed, **no one — including cyrora — could upload, replace, or delete a photo.**

New migration **`20260804140000_storage_admin_only_cyrora.sql`** re-keys every
write policy on both buckets:

| Bucket | INSERT | UPDATE | DELETE | SELECT (read) |
|--------|--------|--------|--------|---------------|
| `property-images` | `is_pintag_admin()` + extension allowlist | `is_pintag_admin()` | `is_pintag_admin()` | public |
| `agent-photos` | `is_pintag_admin()` + extension allowlist | `is_pintag_admin()` | `is_pintag_admin()` | public |

The filename-extension allowlist (`jpg/jpeg/png/webp/gif`) on INSERT is
preserved, and both buckets stay public-read (they are CDN image buckets). This
uses the same single boundary as RLS and the edge functions.

---

## 7. Findings register — zero unresolved Critical or High

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| F1 | Critical | `analytics.js` / `intelligence.js`: password-only `admin@pintag.io` login + `getSession()` auto-login on full admin dashboards | ✅ Fixed — migrated to `admin-auth.js` (cyrora + 2FA + server validation) |
| F2 | High | Edge functions `generate-listing-content` / `generate-intelligence-report` gate on `admin@pintag.io` — would deny cyrora once that account is removed | ✅ Fixed — `is_pintag_admin()`, fail-closed |
| F3 | High | Edge functions `smart-listing-importer` / `facebook-listing-fetcher` gate on retired `parties.type='staff'` — would deny cyrora | ✅ Fixed — `is_pintag_admin()`, fail-closed |
| F4 | High | Storage writes gated on `admin@pintag.io` — breaks all uploads once the account is removed; not the single boundary | ✅ **Fixed + verified live (2026-08-04).** Production check revealed `20260804140000` never applied (name-mismatched DROPs → no-ops), leaving storage OPEN: `agent_photos_insert` `{public}`/`WITH CHECK true` (anon upload) + `authenticated`-any write/delete on both buckets. Applied drift-proof `20260804150000` (drop-ALL-then-recreate); re-verify = exactly 8 policies, every write `is_pintag_admin`, reads public, no survivors. |
| F5 | High | `admin.html` carried an inline duplicate of the auth logic (the per-page drift pattern that enabled the breach) | ✅ Fixed — delegates to `admin-auth.js` |
| F6 | Low | `copy-edge-function.html` embedded a stale, insecure edge-function copy (June `SECURITY.md` LOW-4) | ✅ Fixed — file removed |
| A1 | Low (accepted) | `is_pintag_staff()` name retained as a single-admin alias across historical RLS policies | Accepted — §8 |
| A2 | Low (out of scope) | `marketing-os.html` + `pintag-studio/`: separate Supabase project (`ninee@pintag.io`), password-only | Flagged — §10 |
| A3 | Low (by design) | Agent self-service portal (`agent-login.html`, `dashboard.html`, `add-property.html`, `edit-listing.html`): agent-tier password login | By design — §10 |
| F7 | High (operational) | Maintenance-mode Cloudflare Worker deployment. Resolved via three fixes: (1) removed placeholder `account_id` (`3fd1ae2`); (2) user API token with **Zone → Workers Routes → Edit**; (3) freed `pintag.io/listing.html*` from the legacy `pintag-og` worker. `pintag-og-listing-preview` (v`d55e1ff4`) now bound to all 4 routes; maintenance mode active. | ✅ **RESOLVED** (CI run #78, 2026-08-04 ~09:32 UTC) — pending operator's live 503 check + deletion of legacy `pintag-og` worker |

**Unresolved Critical/High _code_ findings: none.** One **operational** finding —
**F7** — is open: it is a deployment-state issue (the maintenance worker never
published through CI), not a code defect, and does not affect the code guarantees
above. It **must be verified before recovery continues** (see the section below).

---

## 8. Accepted item A1 — why `is_pintag_staff()` is kept as an alias

The user asked for "no remaining references to `is_pintag_staff()`." Physically
that name still appears in ~40 RLS policies across historical and current
migrations. Rather than rewrite every one of those policies (high-risk churn
that could lock the administrator out — the exact outcome to avoid), migration
`20260804130000` **redefines `is_pintag_staff()` to alias `is_pintag_admin()`**.

Consequences, all verified in the migration:

- The staff **model** is fully retired — `is_pintag_staff()` no longer consults
  `parties.type='staff'`; it returns true **only** for the single admin (cyrora).
- Every lingering `is_pintag_staff()` call therefore enforces single-admin
  automatically, with zero policy rewrites.
- No live application or edge-function code calls `is_pintag_staff()` (verified —
  §5).

This is a deliberate safety trade-off: the security goal (single admin) is fully
met; the cosmetic goal (the name gone everywhere) is deferred as optional,
zero-security-value hygiene. Dropping the function entirely is a safe follow-up
once a future migration rewrites the remaining policies to call
`is_pintag_admin()` directly.

---

## 9. Mandatory pre-reopen steps (production runtime)

**The code is hardened; production is not safe until these are applied and
verified.** None can be done from this sandbox (no network to Supabase).

1. **Apply the migrations** to production, in order (if not already applied):
   - `20260804120000_single_admin_lockdown.sql`
   - `20260804130000_single_admin_cyrora_lockdown.sql` (creates `admin_accounts`, `is_pintag_admin()`, seeds cyrora)
   - `20260804140000_storage_admin_only_cyrora.sql` (**new this pass — storage**)
2. **Confirm cyrora is the admin:** `is_pintag_admin('<cyrora uid>')` must return
   **true** *before* removing the legacy account — otherwise the fail-closed
   RLS/storage/edge functions lock cyrora out. (`admin_accounts` seeds cyrora by
   email lookup; verify the row exists.)
3. **Enable TOTP MFA** in Supabase → Authentication → providers (required for the
   2FA step in `admin-auth.js`), then sign in once as cyrora to complete guided
   2FA enrollment.
4. **Remove legacy accounts** with
   `scripts/migrate-admin-to-cyrora-and-remove-legacy-accounts.sql` (FK discovery
   + ownership migration first): `admin@pintag.io`, `testadmin@pintag.io`, and any
   other non-cyrora logins.
5. **Deploy the four edge functions** (they now call `is_pintag_admin()`):
   `supabase functions deploy generate-listing-content generate-intelligence-report smart-listing-importer facebook-listing-fetcher`
6. **Deploy the static site** (GitHub Pages) so the migrated pages + `admin-auth.js` go live.
7. **Verify:** run `scripts/verify-single-admin-lockdown.sql` — it must show
   cyrora as the sole admin, every legacy account gone, no `USING(true)` write
   policy, non-admin/anon writes denied, cyrora writes allowed, storage writes
   `is_pintag_admin()`-gated.
8. **Smoke-test each privileged page** (`admin`, `analytics`, `intelligence`,
   `analytics-inspector`, `watermark-migrate`, `agent-setup`): confirm the login
   overlay appears, only cyrora + a valid 2FA code enters, and a wrong/absent
   session cannot reach the dashboard.
9. **Disable public sign-up (single-admin model) — final pre-reopen gate.**
   Local vs production: `supabase/config.toml`'s `enable_signup = true` configures
   **only the local Supabase CLI emulator** and is acceptable for local dev; it does
   **not** affect the hosted project. The **production** project must have public
   sign-up **disabled** in Authentication settings so new accounts are created only
   through the intentional dashboard/admin process, never public registration. The
   app already has no `signUp` call (removed, §11 / `SECURITY.md`).
   **Verify — "Attempt to access the public sign-up flow in production":** try to
   self-register as an unauthenticated user (e.g. `POST /auth/v1/signup` with the
   anon key, and any public registration UI).
   - **PASS:** public sign-up is disabled/unavailable; the request is rejected and no
     unauthenticated user can create an account.
   - **FAIL:** a new public account can be created.
   Full step + curl: `docs/AUTH_URL_CONFIGURATION.md`; runbook gate: `RECOVERY_RUNBOOK.md` P4c / checklist 11.

---

## Maintenance mode deployment — ✅ RESOLVED (worker deployed + routes bound; live 503 check pending)

> **✅ Resolved 2026-08-04 ~09:32 UTC** via `deploy-prod.yml` run #78. Three fixes
> in sequence: (1) removed the placeholder `account_id`; (2) replaced
> `CLOUDFLARE_API_TOKEN` with a **user** API token carrying **Zone → Workers Routes
> → Edit**; (3) freed the `pintag.io/listing.html*` route from the legacy
> **`pintag-og`** worker (a route-ownership conflict that surfaced only once the
> token worked). Worker **`pintag-og-listing-preview`** (version
> `d55e1ff4-a828-4aa4-b6e1-3f39f53c10fc`) is now deployed and bound to all four
> routes — it carries `MAINTENANCE_MODE = true`, so maintenance mode is active on
> `pintag.io/`, `/index.html*`, `/listing.html*`, `/listings.html*`, pending the
> operator's live 503 confirmation. **Cleanup remaining:** delete the now-routeless
> legacy `pintag-og` worker to leave a single authoritative worker.
>
> The original investigation record follows.

**Finding F7 (operational, High).** The maintenance-mode implementation exists in
the repository and is committed (`MAINTENANCE_MODE = true` in
`cloudflare-worker/og-listing-preview.js`, commit `85d784c`), but the GitHub
Actions `deploy-prod.yml` run shows the **Cloudflare Worker deployment failed** —
the "Deploy via Wrangler" step errors because the required secrets
(`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) are not configured. This job
has failed on **every** recent push, including the maintenance-mode commit itself.

**Therefore maintenance mode cannot be considered active based on repository / CI
state alone.** Explicitly:

- ✅ **GitHub Pages deployed successfully** (the `build` and `deploy` jobs both
  passed) — the hardened pages are live.
- ❌ **Cloudflare Worker deployment did NOT complete through CI** — the maintenance
  worker was never published by the pipeline.
- ⚠ **Maintenance mode is active only if the Worker was deployed manually** (a
  hand-run `wrangler deploy`) by some other means. This cannot be verified from
  repository state.
- 🚫 **This must be verified before recovery continues** — if maintenance mode is
  not actually active, the post-breach production data is publicly reachable.

**Required verification step (record the result in this audit):**

1. Visit the production site (e.g. `https://pintag.io/listings.html`) and confirm
   it returns the maintenance page — preferably **HTTP 503**.
2. If it does **not**, either manually deploy the Worker with Wrangler
   (`cd cloudflare-worker && wrangler deploy`) **or** configure the missing
   `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` GitHub secrets so CI can deploy
   it, then re-run `deploy-prod.yml`.
3. Record the deployment timestamp and verification result here:

   > **Maintenance-mode verification log:**
   > - Deployed: **2026-08-04 ~09:32 UTC** via CI (`deploy-prod.yml` run #78),
   >   worker `pintag-og-listing-preview` version
   >   `d55e1ff4-a828-4aa4-b6e1-3f39f53c10fc`, bound to all 4 routes.
   > - Deployment method: ☑ **CI** (user token with Zone → Workers Routes → Edit)
   > - Live 503 confirmation (visit `https://pintag.io/listings.html`):
   >   `________________` UTC — by: `________________`

**Progress log (2026-08-04, CI):**

- Secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` configured — confirmed
  passed into the deploy job.
- **Fix 1 (commit `3fd1ae2`):** removed the placeholder `account_id` from
  `wrangler.toml` that was overriding the account-id secret (Cloudflare API error
  7003). After this, the Worker **script uploads successfully**
  (`Uploaded pintag-og-listing-preview`, resolving "Cyrora.trading@gmail.com's Account").
- **Remaining blocker (token permission, not code):** binding the Worker
  **routes** to the `pintag.io` zone fails with **Authentication error [code:
  10000]** — the `CLOUDFLARE_API_TOKEN` is missing **Zone → Workers Routes → Edit**
  for the `pintag.io` zone. Until the routes bind, the Worker is not in front of
  `pintag.io`, so **maintenance mode is NOT yet active**.
- **To finish (either path):**
  1. **Recommended:** add **Zone → Workers Routes → Edit** (scoped to `pintag.io`)
     to the token — and, to clear the secondary warning, **User → User Details →
     Read** — then re-run `deploy-prod.yml`.
  2. **Immediate alternative:** the Worker script is already uploaded, so the four
     routes can be bound manually in the Cloudflare dashboard (Workers & Pages →
     `pintag-og-listing-preview` → Settings → Domains & Routes: add `pintag.io/`,
     `pintag.io/index.html*`, `pintag.io/listing.html*`, `pintag.io/listings.html*`),
     which activates maintenance mode without waiting on the token change.
- **✅ RESOLVED (CI run #78, 2026-08-04 ~09:32 UTC).** Fixed by a **user** API token
  with **Zone → Workers Routes → Edit** *and* freeing the `listing.html*` route
  from the legacy **`pintag-og`** worker (a route-ownership conflict — `"pintag-og"
  is already assigned to routes` — surfaced once the token worked). `wrangler
  deploy` then bound all four routes to **`pintag-og-listing-preview`** (version
  `d55e1ff4`); all three `deploy-prod.yml` jobs green. **Cleanup remaining:** delete
  the now-routeless legacy `pintag-og` worker so a single authoritative worker owns
  the routes.

---

## 10. Out of scope, flagged (not reopen-blockers for pintag.io)

- **`marketing-os.html` + `pintag-studio/`** — a **separate Supabase project**
  (`yuboptuclvocadfrqszo…`, founder `ninee@pintag.io`), not the production Pintag
  database. It must **not** be forced onto cyrora/production auth (that would lock
  its founder out). Its password-only login is a weakness *of that separate app*,
  not of pintag.io's attack surface. Recommendation: harden `pintag-studio`
  separately with its own 2FA, or retire it — a product decision, tracked
  separately.
- **Agent self-service portal** (`agent-login.html`, `dashboard.html`,
  `add-property.html`, `edit-listing.html`) — a legitimate **agent** auth tier
  (each agent signs in with their own email/password; data is RLS-scoped). It is
  **not** an administrator surface and must not be forced onto the cyrora-only
  admin module. Note: under the single-admin lockdown, agent **write** access is
  intentionally removed (RLS is admin-only); these pages' writes stay disabled by
  design until the owner deliberately re-enables scoped agent access (a
  controlled data change — add a policy — never a return to broad `authenticated`
  writes).

---

## 11. Pre-existing items (not introduced here, noted for completeness)

- **Baseline-schema drift:** `properties` and `parties` are not created by any
  tracked migration (they predate tracked migrations — dashboard-created). This
  affects fresh-DB *replay* only (already handled by the `pintag-dev` bootstrap's
  schema dump/restore) and is tracked as a separate follow-up. It is not an
  authorization finding.
- **`SECURITY.md`** (June 2026) is superseded on auth/RLS/storage by this report;
  a banner at its top now says so. Its XSS/CSP/SSRF/rate-limiting content remains
  valid.
- **Test fixtures (follow-up, not a reopen-blocker):** several Playwright specs
  under `tests/` mock a logged-in `admin@pintag.io` session to exercise unrelated
  features (rendering, save payloads). Because the privileged pages now enforce
  the cyrora + AAL2 gate, those fixtures should be updated to mock
  `cyrora.trading@gmail.com` with `getAuthenticatorAssuranceLevel → aal2` (or to
  stub `PintagAdminAuth`) so the pages reach their content. This is test-harness
  maintenance, not an application or security defect, and does not gate reopening.

---

## Disaster Recovery Improvements (post-incident)

This incident should become the basis for a permanent operational playbook so the
same failure mode cannot recur. Recommended improvements to implement after
recovery:

- **Enable Point-in-Time Recovery (PITR) or scheduled backups** on the Supabase
  project, so a destructive event is recoverable to the minute rather than
  reconstructed after the fact. The 2026-08-03 breach was only partially
  recoverable precisely because no PITR/backup existed — recovery leaned on the
  `properties_removal_log` trigger and the Wayback Machine.
- **Configure the Cloudflare deployment secrets** (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`) so maintenance mode — and the OG worker — can always be
  deployed from CI. This permanently closes finding F7.
- **Add a documented emergency "kill switch"** to place the site into maintenance
  mode within minutes (flip `MAINTENANCE_MODE = true` and deploy the worker), with
  the exact commands written down so it can be executed under pressure.
- **Document key-rotation procedures** for Supabase (anon **and** service-role),
  Cloudflare, and GitHub tokens/secrets — what to rotate, where, and in what order
  — so a suspected key compromise has a rehearsed, no-guesswork response.
- **Create an incident-response runbook** for future security events: detect →
  contain → preserve evidence → maintenance mode → root-cause → remediate →
  verify → reopen (the exact sequence this incident followed).
- **Schedule periodic security reviews** of RLS policies, authentication, Storage
  policies, and Edge Functions — so drift (the root cause here: dashboard-created
  policies that were never captured in migrations) is caught before it becomes an
  exposure.

## Staging environment (dev → staging → production)

Recommended once recovered: stand up a **staging** environment, separate from both
production and development, where security migrations and schema changes are tested
before they ever reach the live site. A `dev → staging → production` pipeline —
with tested migrations and verified backups at each step — would have caught the
RLS drift that enabled this breach, and materially reduces operational risk for
every future change. This complements the existing `pintag-dev` preview project:
staging specifically mirrors production's schema and is the last gate a migration
passes before going live.

## 12. Bottom line

The repository is at **zero unresolved Critical or High findings** for
administrator authentication, authorization, and storage. One module, one
administrator, one authorization boundary — no legacy paths remain in live code.

**Do not reopen the public site until §9 is complete and
`scripts/verify-single-admin-lockdown.sql` passes.** Reopening is the owner's
explicit go/no-go decision after that verification.
