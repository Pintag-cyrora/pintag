# Pintag — Final Technical Security Report (repository-wide sweep)

**Date:** 2026-08-04 · **Project:** `pintag-cyrora/pintag` (production Supabase `eoladhcljbpbhnrmmpev`)
**Scope:** final repository-wide audit for residual privileged paths and secrets, per the nine
requested checks. **Result: 0 Critical, 0 High** → report issued. Maintenance mode remains ON;
this report does **not** authorize reopening.

## Method

Static audit of the whole repo (app HTML/JS, edge functions, SQL migrations, worker, docs, CI).
Every claim below is code-cited. The **live** authorization boundary
(`is_pintag_admin()` RLS + `REVOKE anon writes`) was already proven in production in P1/P2; this
sweep checks for any surface that could sidestep it.

## Verdict against the nine checks

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | No privileged page bypasses `admin-auth.js` | ⚠️ **PARTIAL** | 6 core admin pages gate on `PintagAdminAuth.protect` (admin, analytics, intelligence, analytics-inspector, watermark-migrate, agent-setup). Legacy password-only surfaces remain (M1, M2, L2) — but RLS yields **zero** read/write for their non-admin accounts. |
| 2 | No Edge Function bypasses `is_pintag_admin()` | ✅ **PASS** | All 4 functions authorize via `POST /rest/v1/rpc/is_pintag_admin` and fail closed with 401 (`generate-listing-content:25/43`, `generate-intelligence-report:75`, `smart-listing-importer:79`, `facebook-listing-fetcher:82`). Staff refs are comments only. |
| 3 | No remaining hardcoded admin emails | ✅ **PASS** | `admin@pintag.io` appears only in docs, tests, and immutable migration history — never in live app auth. `cyrora.trading@gmail.com` is the intended single-admin constant. `ninee@pintag.io` gates a separate founder page and grants **no** admin RLS (see M2). |
| 4 | No password-only auth flows | ⚠️ **PARTIAL** | Admin requires password + TOTP (AAL2). Legacy password-only logins persist on the agent portal (M1), marketing-os (M2), pintag-studio (L2) — RLS-backstopped, zero sensitive access. |
| 5 | No `getSession()` auto-login paths | ✅ **PASS** | Gates use server-side `getUser()`. The only residual `refreshSession()` auto-login (`agent-setup.html:1034`) is **dead code** — line 1031 calls `getElementById('pw-input').addEventListener` but no `id="pw-input"` element exists, so it throws before `refreshSession()` runs (L1). `admin-auth.js:236` / `reset-password.html:80` use `getSession` legitimately (token fetch / recovery detection), not auto-login. |
| 6 | No legacy staff authorization references | ✅ **PASS** | `is_pintag_staff()` is an intentional alias → `is_pintag_admin()` (`20260804130000:57-59`; Accepted item A1). All staff policies were recreated as `is_pintag_admin`; edge-fn references are comments. No functional staff path. |
| 7 | No public signup flows | ✅ **PASS (code)** | No `signUp()` anywhere (removed, `SECURITY.md:126`). `config.toml enable_signup=true` is the local CLI emulator only. Production dashboard setting is the P4c pre-reopen gate (your verification pending). |
| 8 | No exposed service-role keys or secrets | ✅ **PASS** | Client code uses only the public anon key (`window.PINTAG.anonKey`; `listing.html:609`, `index.html:517`, etc.). No `service_role` JWT literal anywhere; no hardcoded Gemini/Facebook keys (edge fns read `Deno.env`). The `#paa-secret` string is the runtime TOTP-enrollment secret shown to the admin, not a stored key. |
| 9 | No routes unintentionally bypass maintenance | ⚠️ **PARTIAL** | Worker 503s the public browsing surface (`/`, `/index.html`, `/listings.html`, `/listing.html` — `og-listing-preview.js:419-424`). Admin + `reset-password.html` intentionally pass through. Public agent-directory/profile + OG-tool pages also pass through (L3) — read-only public content only. |

## Findings register (severity · file · risk · fix)

### M1 — Medium · Agent portal is password-only and bypasses `admin-auth.js`
- **Files:** `agent-login.html:189`, `dashboard.html:577-580`, `edit-listing.html:799/1209`, `add-property.html:813/1018`
- **Risk:** These listing-editor pages authenticate with `signInWithPassword` (no TOTP, no cyrora restriction) and gate only on "is there a user." They deviate from the unified admin-auth model. **Data impact is nil today:** RLS restricts every write and every sensitive read to `is_pintag_admin()` (proven P2.2/P2.3), and `owners`/`leads` are admin-only for read too (`20260804130000:110-120`) — an agent session can neither write nor read PII. The exposure is architectural (a password-only privileged UI surface), not data.
- **Fix:** Decommission the legacy agent portal (single-admin model retired staff), or place these pages behind `PintagAdminAuth.protect` so they require cyrora + AAL2 like the other admin tools.

### M2 — Medium · `marketing-os.html` founder page: password-only, no identity check, reads an unaudited table
- **File:** `marketing-os.html:60,119,136`
- **Risk:** Password-only login as `ninee@pintag.io` (no TOTP, outside `admin-auth.js`). Its `getUser()` gate checks only that *a* user exists — it does **not** verify `email === FOUNDER_EMAIL` — so any authenticated session reaches `fetchAndShowBrief()`. It reads `morning_briefs` (a separate founder-server subsystem table **not** present in the audited migrations, so its production RLS is unverifiable from this repo). Content is marketing briefs, not customer PII; the page performs no writes.
- **Fix:** Verify `morning_briefs` RLS in production (must be `is_pintag_admin`-gated), or gate the page on `admin-auth.js`. Confirm whether `ninee@pintag.io` should exist at all under the single-admin model — if not, remove it in P7 ("any other non-cyrora logins").

### L1 — Low · Dead legacy auto-login block in `agent-setup.html`
- **File:** `agent-setup.html:1030-1044`
- **Risk:** A second `DOMContentLoaded` handler intends a `refreshSession()` auto-login, contradicting the file's comment "No page-local login logic remains." It is **non-functional** — it throws at `getElementById('pw-input').addEventListener` (element absent) before reaching `refreshSession()`. Effect today: a console error on load; no bypass. Left in place it is a latent hazard if the missing element is ever re-added.
- **Fix:** Delete lines 1030-1044; `PintagAdminAuth.protect(sb, bootAgentSetup)` (line 581) is the sole, correct entry point.

### L2 — Low · `pintag-studio/dashboard/index.html` ships under pintag.io with placeholder credentials
- **File:** `pintag-studio/dashboard/index.html:195-196,241`
- **Risk:** A password-only dashboard for a **separate** Supabase project (`org_settings`, `content_calendar`, `approvals_queue`…), deployed to `pintag.io/pintag-studio/…` by the `path: .` Pages upload. Its `SUPABASE_URL`/`SUPABASE_ANON` are unfilled placeholders, so it is non-functional in production, but it is a stray password-only surface on the production origin.
- **Fix:** Exclude `pintag-studio/` from the pintag.io deploy (or confirm it is an intentionally separate, separately-hardened product); do not ship placeholder-credential admin UIs on the production origin.

### L3 — Low · Public non-browsing pages remain reachable during maintenance
- **Files:** `agents.html`, `agent.html`, `for-agents.html`, `viengkhone-phomthavong.html`, `og-preview-gen.html`, `og-preview-listings-gen.html`, `agent-login.html`
- **Risk:** The worker fronts only the four browsing routes, so these pass through during maintenance. They serve read-only, already-public content (agent directory/profiles, OG tools); storage writes from the OG tools are `is_pintag_admin`-gated. `admin.html`, `reset-password.html`, and the agent login are intended to remain reachable. No sensitive exposure; a completeness gap only.
- **Fix (optional):** If a full public lockdown is desired, extend the worker's `isPublicBrowsing` set (and `wrangler.toml` routes) to the public marketing pages; otherwise accept as intended and note it in the runbook.

## What remains before reopening (unchanged by this sweep)

This report clears the code for residual privileged paths/secrets. The production runtime gates
still owed are tracked in `RECOVERY_RUNBOOK.md`: **P4c** (disable public signup + verify), **P5**
(MFA live), **P6** (deploy 4 edge fns + live 401), **P7** (remove legacy accounts), **P8/P9**
(listing + photo recovery as hidden drafts), **P10** (final audit assembly), **P11** (owner Go/No-Go).

## Sign-off

- **0 Critical, 0 High.** Medium/Low findings above are architectural/defense-in-depth; none permits
  unauthorized data read or write, because `is_pintag_admin()` RLS is the proven boundary.
- The single-admin model, AAL2 admin gate, fail-closed edge functions, storage lockdown, and
  anon-write revocation are intact.
- **Maintenance mode remains ON. This report does not reopen the site, does not disable maintenance,
  and does not publish recovered listings.** Reopening awaits the owner's explicit approval after the
  remaining runbook gates pass.
