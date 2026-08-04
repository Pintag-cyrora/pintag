# Final Pre-Reopen Security Audit — Pintag

**Status: NOT cleared for reopen.** The site stays in maintenance until every
gate below passes and the product owner approves. Items are labelled
**VERIFIED** (confirmed in code this pass), **RUNTIME** (must be proven by
running the checks against production), or **FINDING** (needs a decision).

Related artifacts: `supabase/migrations/20260804130000_single_admin_cyrora_lockdown.sql`,
`scripts/verify-single-admin-lockdown.sql`, `SECURITY_HARDENING_REPORT.md`,
`scripts/migrate-admin-to-cyrora-and-remove-legacy-accounts.sql`.

---

## 1. No authentication bypasses

- **VERIFIED (admin.html):** password-only entry removed; auto-login from a
  persisted localStorage session removed (`verifyOnLoad()` now server-validates
  via `auth.getUser()` on every load); the hardcoded `admin@pintag.io` login and
  the token-length debug log are gone. Repo grep for `backdoor|bypass|skipAuth|
  hardcoded password` returns only comments/UI strings — no real bypass.
- **FINDING — other privileged pages not yet hardened:** `agent-setup.html`,
  `analytics-inspector.html`, `watermark-migrate.html`, `marketing-os.html` still
  use the old password-only gate and reference `admin@pintag.io`. Their **data is
  protected by RLS** (every read/write is gated by `is_pintag_admin`, so a
  non-cyrora session sees nothing and can write nothing), so this is a
  client-gate/defense-in-depth gap, **not** a data-exposure hole. **Decision
  needed before reopen:** harden these the same way as admin.html, or remove the
  ones no longer used (`watermark-migrate.html`, `copy-edge-function.html` look
  like one-off utilities). Until then, they are RLS-protected but should not be
  relied on as access control.

## 2. Every RLS policy

- **VERIFIED (design):** the lockdown migration drops **every** existing policy
  per table (iterating `pg_policies`, so drifted/dashboard-created names are
  caught) and recreates a minimal default-deny set — writes only via
  `is_pintag_admin(auth.uid())`, public reads only where the site needs them,
  anon INSERT only on the five analytics tables, admin-read on internal tables.
- **RUNTIME:** `verify-single-admin-lockdown.sql` checks 3–6 must all pass —
  no `USING(true)`/`WITH CHECK(true)` write policy; every core-table write
  predicate is `is_pintag_admin`; no policy references `type='staff'` /
  `is_pintag_staff` / `auth.email`; anon has no write grant.

## 3. Every production write endpoint

| Endpoint | Who can write | Gate | Status |
|---|---|---|---|
| PostgREST `/rest/v1/*` | any JWT | **RLS → `is_pintag_admin` only** | VERIFIED design / RUNTIME check 7–9 |
| Storage `property-images` | authenticated | **FINDING** — still `TO authenticated`; tighten to `is_pintag_admin` (SQL in `SECURITY_HARDENING_REPORT.md §7`) | Pending |
| `generate-intelligence-report` (edge) | staff JWT / service-role | `requireAdmin()` + service-role (bypasses RLS by design) | VERIFIED; rotate service-role key |
| `smart-listing-importer`, `facebook-listing-fetcher`, `generate-listing-content` | authenticated | uses caller JWT → RLS → admin only | VERIFIED |
| `public-listings-feed` (edge) | public | read-only | VERIFIED |
| Cloudflare Worker | public | read-only (OG); now also serves the 503 maintenance page | VERIFIED |

## 4. Only cyrora may access admin.html

- **VERIFIED:** `ADMIN_EMAIL = 'cyrora.trading@gmail.com'`; any other email is
  signed out and rejected after password entry; the panel is never shown without
  a server-validated cyrora + AAL2 session.
- **RUNTIME:** browser test — non-cyrora login → rejected; SQL check 1 → cyrora
  is the only `admin_accounts` row; check 3 (`is_pintag_admin` true only for cyrora).

## 5. admin.html requires email + password + 2FA and revalidates

- **VERIFIED:** login is email + password → **TOTP code (AAL2)**; first login
  with no factor runs guided TOTP enrollment; `verifyOnLoad()` revalidates on
  every load; `requireAdminSession()` revalidates (server-side, AAL2) before
  `deleteListing()`.
- **RUNTIME / MANUAL:** (a) enable **TOTP MFA** for the project in the Supabase
  dashboard — without it login correctly fails closed (no 1FA fallback); (b)
  enroll cyrora's authenticator; (c) confirm login without the code is blocked
  and reload mid-session revalidates.
- **RECOMMENDED:** extend `requireAdminSession()` to the remaining destructive
  spots (unit/contact deletes inside `saveListing`, agent/contact deletes) —
  RLS already blocks non-admins there, so this is defense-in-depth.

## 6. No hidden dev accounts, backdoors, or legacy permissions

- **VERIFIED:** legacy staff model retired — `is_pintag_staff()` no longer reads
  `parties.type='staff'`; it defers to the admin allowlist (check 5). No
  `USING(true)` write policy remains (check 3). No hardcoded credentials/backdoor
  in the repo.
- **RUNTIME:** delete `admin@pintag.io`, `testadmin@pintag.io`, and every unused
  test/legacy account (dashboard, after `migrate-admin-to-cyrora…sql` clears
  FKs); check 2 must return 0. Drop the obsolete staff `parties` row (check 5c → 0).

---

## Go / no-go checklist (all must pass before reopen)

1. [ ] Apply `20260804130000_single_admin_cyrora_lockdown.sql` (SQL editor).
2. [ ] `verify-single-admin-lockdown.sql` — every EXPECT passes (checks 1–9).
3. [ ] Enable TOTP MFA (dashboard) + enroll cyrora; confirm password-only login is blocked.
4. [ ] Run `migrate-admin-to-cyrora…sql`; delete legacy/test auth users; check 2 → 0.
5. [ ] Reset cyrora's password; enable Google 2FA + Supabase-dashboard 2FA.
6. [ ] Browser test admin.html (§4/§5 runtime cases) — all pass.
7. [ ] Decide on the other privileged pages (§1 FINDING) — harden or remove.
8. [ ] Rotate the service-role key; tighten Storage write policy (§3).
9. [ ] Listing + photo recovery to the extent feasible (separate recovery scripts).
10. [ ] Product-owner approval.

## Reopen procedure (only after 1–10)

Set `MAINTENANCE_MODE = false` in `cloudflare-worker/og-listing-preview.js`,
redeploy the Worker, and confirm the public browsing pages return 200 with the
recovered listings — while `admin.html` still enforces cyrora + 2FA.
