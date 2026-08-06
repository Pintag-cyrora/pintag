# L1 Production Safe — Certification

> **STATUS: ⏳ PENDING — NOT YET CERTIFIED.**
> This document certifies nothing until every evidence field below is filled
> with a real result. Implementation is complete (commit `71d3432`); L1 is
> complete only when verification is. *Implemented ≠ Complete.*

| | |
|---|---|
| **Milestone** | L1 Production Safe (Master Architecture Blueprint, Engineering ladder) |
| **Implementation commit** | `71d3432` — L1 baseline batch (see `docs/L1_SECURITY_BASELINE_2026-08-06.md`) |
| **Verification pack** | `docs/L1_VERIFICATION_PACK.md` + `scripts/verify-l1-baseline.sql` |
| **Certification date** | *(fill when all evidence is in)* |
| **Certified by** | *(operator)* |

## Operator steps

| Step | Done (date) | Evidence |
|---|---|---|
| Migration `20260806010000_enforce_aal2_admin` applied | | Part A1/A8 = PASS |
| Migration `20260806020000_soft_delete_and_snapshots` applied | | Part A2–A5, A7 = PASS |
| Migration `20260806030000_mass_delete_alerting` applied | | Part A5/A6 = PASS |
| Edge functions redeployed (×5: listing-content, importer, fb-fetcher, intelligence, resolve-map-url) | | deploy timestamps |
| Backup secrets + keys configured (`ops/README.md`) | | backup run green |
| PITR enabled | | Dashboard screenshot / note |

## Verification evidence

| # | Verification | Expected | Result | Evidence (paste output / run URL) |
|---|---|---|---|---|
| A | Structural checks (SQL Part A) | 8 × PASS | ⏳ | |
| 1b | AAL1 refused: RLS write | `[]` | ⏳ | |
| 1b | AAL1 refused: `is_pintag_admin` RPC | `false` | ⏳ | |
| 1b | AAL1 refused: `listing_timeline` RPC | admin-only error | ⏳ | |
| 1b | AAL1 refused: edge function | HTTP 403 "MFA required" | ⏳ | |
| 1b | AAL1 refused: storage write | policy violation | ⏳ | |
| 1c | AAL2 succeeds: save / AI title / photo upload | all work | ⏳ | |
| B | Soft delete: `deleted_at` + snapshot + provenance event | 3 × PASS | ⏳ | |
| B4 | Soft-deleted row invisible to anon | `[]` | ⏳ | |
| B5 | Restore (deleted_at → NULL) | row returns | ⏳ | |
| C1 | Single hard delete: snapshot + alert | 2 × PASS | ⏳ | |
| C3 | Bulk hard delete (10 rows) | **ERROR (blocked)** | ⏳ | |
| C4 | Rows intact after blocked statement | count = 10 | ⏳ | |
| 4 | Production DR Backup run | green, verify steps passed | ⏳ | run URL |
| 4 | DR Restore Drill run | green, counts match, duration ≤ 60 min | ⏳ | run URL + duration |
| 4 | Storage object spot-check | SHA-256 match R2 vs live | ⏳ | |
| 5 | Security event visible in function logs | `aal2_required` line | ⏳ | |
| 5 | Delete alert DELIVERED to webhook channel | message received | ⏳ | |
| 5 | Monitoring failure DELIVERED (email/webhook) | notification received | ⏳ | |

## Remaining accepted risks (carried into L2 planning)

- `service_role` key used as bearer by the pg_cron path of
  `generate-intelligence-report` (Medium — next quarter).
- anon `SELECT USING(true)` on `listing_events` (High — 30 days; verify
  tracking dedup dependency first).
- Public signup enabled (High — 30 days; dashboard toggle).
- Schema drift vs migrations; no staging; CSP; rate limiting (L2).
- `pintag-studio` CI holds a service_role key (Medium).
- Admin `innerHTML` sink count — escaped but numerous (L2 structural).

## Rollback references

- AAL2: re-run `is_pintag_admin` from `20260804130000` (one statement).
- Soft delete/snapshots/guard: per-piece `DROP TRIGGER` / policy re-create —
  exact statements in each migration's header and in
  `docs/L1_SECURITY_BASELINE_2026-08-06.md`.
- Edge functions: redeploy previous version; `git revert 71d3432` for repo.
- Workflows: delete the file; zero production impact.

## The standing rule this milestone establishes

A feature is complete only when it is **implemented, verified, documented,
monitored, and recoverable** — five states, not one. This applies to every
future feature, not just security. (Also recorded in the Master Architecture
Blueprint, Governance → Feature Lifecycle.)
