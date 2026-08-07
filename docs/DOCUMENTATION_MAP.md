# Documentation Map — one owner per responsibility

*Adopted 2026-08-07. The rule: every responsibility has exactly ONE owning
document that describes NOW. Everything else is either a pointer to it, a
point-in-time historical record (never updated), or a parked design. When
two documents claim the same territory, this map decides — and the loser
gets a banner, not a rewrite.*

## Canonical (describe NOW; update in place)

| Responsibility | Owner |
|---|---|
| Company strategy, principles, governance | **Architecture & Company Blueprint** (`docs/BLUEPRINT.md` → published v4) |
| Code-level architecture: module ownership, canonical APIs, extension rules | `ARCHITECTURE.md` |
| Security posture (current) | `SECURITY.md` |
| L1 baseline: what changed / how to verify / whether verified | `docs/L1_SECURITY_BASELINE_2026-08-06.md` · `docs/L1_VERIFICATION_PACK.md` · `docs/L1_PRODUCTION_SAFE_CERTIFICATION.md` |
| Backup & disaster recovery (incl. RPO/RTO §5b) | `docs/BACKUP_AND_DISASTER_RECOVERY.md` (+ `ops/README.md` for key/secret setup) |
| Recovery batch write policy (dry-run → rollback) | `docs/RECOVERY_CHANGE_POLICY.md` |
| Recovery KPI scoreboard (canonical numbers) | `docs/LAUNCH_ROADMAP.md` |
| Recovery evidence (what survives, per listing) | `docs/RECOVERY_EVIDENCE_REGISTER.md` (active until recovery closes, then historical) |
| Incident response steps | `RECOVERY_RUNBOOK.md` + `docs/EMERGENCY_RECOVERY_CHECKLIST.md` (review/merge at L1 certification) |
| Operator onboarding (admin account, TOTP) | `FIRST_ADMIN_ONBOARDING.md` |
| Auth URL / reset configuration | `docs/AUTH_URL_CONFIGURATION.md` |
| OG/share metadata pipeline | `docs/OG_METADATA_ARCHITECTURE.md` |
| Dev/prod environments & branch preview | `PREVIEW.md` |
| System-level keep/merge/archive decisions | `docs/OVER_ENGINEERING_REGISTER.md` |

## Historical (point-in-time; banner applied; never updated)

`SECURITY_AUDIT_2026-08-04.md` · `docs/FINAL_SECURITY_REPORT_2026-08-04.md` ·
`docs/XSS_AUDIT_2026-08-06.md` · `docs/intelligence/PHASE1_COMPLETION.md` ·
`docs/LEGACY_AGENT_PORTAL.md`

## Parked designs (Designed, not Built — no maintenance burden)

`docs/find-my-home/PLAN.md` · `docs/intelligence/ROADMAP.md`,
`PHASE2_PLAN.md` (see the Over-Engineering Register for the parking
decision and its reasoning)

## The maintenance rule

Adding a document requires adding a row here and naming the responsibility
it owns — if the responsibility already has an owner, extend the owner
instead. This map is reviewed at the quarterly architecture review; the
target direction is **fewer rows, not more**.
