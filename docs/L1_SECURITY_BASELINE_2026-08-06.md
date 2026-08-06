# L1 Production Safe — Security Baseline Implementation (2026-08-06)

The Critical (L1) items from the Master Architecture Blueprint and the
2026-08-06 evidence audit, implemented as one reviewed batch. Everything here
is minimal, reversible, and verified per item. **The database migrations and
edge-function deploys are operator steps** (this repo cannot reach
production); the checklist below marks what activates when.

## Remediation checklist

| # | Item | Code status | Activates when |
|---|---|---|---|
| 1 | AAL2 (MFA) enforced server-side — RLS, RPCs, edge functions | ✅ implemented | Migration `20260806010000` applied + 4 edge functions redeployed |
| 2 | Soft delete + full-row snapshots + de-cascade | ✅ implemented | Migration `20260806020000` applied (admin UI fails closed until then) |
| 3 | DR: weekly backup verified, quarterly restore drill, RPO/RTO documented; PITR | ✅ workflows + docs | `ops/README.md` setup done (keys + secrets), first green backup + drill; PITR enabled in Dashboard |
| 4 | Mass-delete detection: alert on any hard delete, BLOCK ≥10-row statements, webhook | ✅ implemented | Migration `20260806030000` applied (+ optional webhook URL in `ops_alert_config`) |
| 5 | SSRF hardening on every server-side fetch (allowlist, size cap, timeout, redirect re-check, content-type) | ✅ implemented | Edge functions redeployed |
| 6 | Debug surface removed (login reset diagnostics) | ✅ implemented | Deploys with next push to main |
| 7 | XSS audit of admin rendering | ✅ done — see `docs/XSS_AUDIT_2026-08-06.md` | 2 sink fixes deploy with main |
| 8 | Baseline monitoring: uptime, count floor, alert backstop, security-event logs | ✅ implemented | `monitoring.yml` secrets/vars set (`PINTAG_PROD_DB_URL`, optional `ALERT_WEBHOOK_URL`, `MIN_EXPECTED_LISTINGS`) |
| 9 | Recovery environment discipline (dry run → preview → diff → commit → rollback) | ✅ policy codified | `docs/RECOVERY_CHANGE_POLICY.md` — in force now |

## Files modified / added

**Migrations (apply in order, production SQL editor):**
- `supabase/migrations/20260806010000_enforce_aal2_admin.sql`
- `supabase/migrations/20260806020000_soft_delete_and_snapshots.sql`
- `supabase/migrations/20260806030000_mass_delete_alerting.sql`

**Edge functions (redeploy all four; `resolve-map-url` too):**
- `supabase/functions/generate-listing-content/index.ts` — AAL2 gate, 403s, security-event logs
- `supabase/functions/smart-listing-importer/index.ts` — AAL2 gate + image fetch: size cap, content-type, final-host re-check
- `supabase/functions/facebook-listing-fetcher/index.ts` — AAL2 gate + **og:image SSRF fix** (fbcdn allowlist, https-only, 15 MB cap, content-type, redirect re-check)
- `supabase/functions/generate-intelligence-report/index.ts` — AAL2 gate on the user path (pg_cron service path exempt)
- `supabase/functions/resolve-map-url/index.ts` — timeout + final-redirect-host validation

**Frontend (auto-deploys on push to main):**
- `admin-auth.js` — reset-diagnostics debug block removed
- `admin.html` — `deleteListing()` is now SOFT delete (fail-closed if migration missing); listing view filters `deleted_at` (with pre-migration fallback); 2 XSS sink fixes
- `gallery-recovery.html` — `esc()` hardened (`'`)

**Operations:**
- `.github/workflows/monitoring.yml` — every 30 min: uptime, listing floor, unseen high/critical `ops_alerts`, admin-activity anomaly, webhook on failure
- `.github/workflows/restore-drill.yml` — quarterly + on-demand restore of the latest R2 backup into scratch Postgres, count-verified, fail-closed
- `ops/README.md` — key generation + secret setup (backup.yml unblocks when done)

**Docs:**
- `docs/BACKUP_AND_DISASTER_RECOVERY.md` §5b — committed RPO/RTO
- `docs/RECOVERY_CHANGE_POLICY.md`, `docs/XSS_AUDIT_2026-08-06.md`, this file

## Risk reduction

| Risk (audit finding) | Before | After |
|---|---|---|
| Stolen password ⇒ full admin (no MFA server-side) | Every RLS write + every edge fn passed with AAL1 | Denied at the database (`is_pintag_admin` requires `aal='aal2'`) AND at each function (403 + logged). One chokepoint, so coverage is total. |
| One DELETE destroys listings + cascades leads/units/analytics (the incident mechanism) | Structurally possible | App only soft-deletes; every delete (any path) full-row snapshotted; cascades → SET NULL; ≥10-row hard-delete statements BLOCKED in the database |
| Nobody told when data vanishes | True (91 rows, silence) | Any hard delete alerts (webhook in seconds when configured); mass soft-delete alerts; monitoring floor-checks every 30 min |
| SSRF via og:image fetch | Blind `fetch()` of page-derived URLs | Full checklist on every server-side fetch |
| No backup restore ever proven; RPO/RTO undefined | True | Drill workflow proves every quarter; RPO/RTO committed in the DR doc |
| Auth internals dumped at login screen | True | Removed |

## Verification steps (operator, after applying)

1. **AAL2:** password-only sign-in (stop before TOTP) → `PATCH /rest/v1/properties?...` updates **0 rows**; any edge fn → **403 "MFA required"**. Complete TOTP → both succeed.
2. **Soft delete:** admin Delete on a TEST listing → disappears from the public site, remains restorable (`UPDATE properties SET deleted_at=NULL WHERE id=...`); `properties_row_snapshots` has the full row.
3. **De-cascade:** `SELECT conname, conrelid::regclass FROM pg_constraint WHERE confrelid='public.properties'::regclass AND confdeltype='c';` → 0 rows.
4. **Guard:** in a transaction, `DELETE FROM properties WHERE id IN (<10+ test ids>)` → statement fails with the guard message; single-row delete → `ops_alerts` gains `hard_delete`.
5. **DR:** run **Production DR Backup** then **DR Restore Drill** from Actions → both green.
6. **Monitoring:** run **Production Monitoring** manually → green; then set `MIN_EXPECTED_LISTINGS` above the real count and run again → red (proves it can fail).
7. **SSRF:** re-run `tests/security/suites/05_ssrf.sh`; import a test FB post → images still arrive (fbcdn is allowlisted).

## Rollback procedure

Each piece is independent:
- **AAL2:** re-run the `is_pintag_admin` definition from `20260804130000` (one `CREATE OR REPLACE`). Frontend/edge functions keep working either way.
- **Soft delete:** drop the two triggers; recreate the public-read policy without the `deleted_at` predicate; the column is additive and can stay. (Re-adding CASCADE is possible but reopens the incident mechanism — don't.)
- **Alerting:** `DROP TRIGGER trg_properties_mass_delete_guard ON properties;` (and the soft-delete alert trigger). For deliberate bulk maintenance, `DISABLE TRIGGER` is the sanctioned, temporary path.
- **Edge functions:** redeploy the previous version (Supabase retains prior deploys); `git revert` covers the repo side.
- **Frontend:** `git revert` of the single commit; deploy-prod republishes.
- **Workflows:** delete the file — zero production impact.

## Remaining known risks (accepted at L1, scheduled later)

| Risk | Tier |
|---|---|
| `service_role` key used as a bearer token by pg_cron path in `generate-intelligence-report` | Medium (next quarter) |
| anon `SELECT USING(true)` on `listing_events` (engagement metadata exposure) | High-30-days (verify tracking dedup first) |
| Public signup enabled (dashboard setting — operator toggle) | High-30-days |
| Schema drift vs migrations; no staging environment; CSP; rate limiting | L2 |
| `pintag-studio` CI holds a service_role key | Medium |
| Admin `innerHTML` sink count (escaped but numerous) | L2 structural |

## Scorecard movement (claimed only once operator steps complete)

| Category | Before | After L1 verified |
|---|---|---|
| Security | 6 | **7.5** (AAL2 server-side, SSRF closed, debug gone; CSP/audit-log still ahead) |
| Data Integrity | 5 | **7** (soft delete + snapshots + de-cascade + statement guard) |
| Disaster Recovery | 4 | **6.5** (proven weekly backup + drilled restore + committed RPO/RTO; PITR + cross-region ahead) |
| Operations | 4 | **6** (tripwires + uptime/floor monitoring + security-event logs; SLOs/on-call ahead) |
| Overall | 5.5 | **≈ 6.5–7** |
