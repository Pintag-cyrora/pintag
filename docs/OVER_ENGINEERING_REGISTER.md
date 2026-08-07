# Over-Engineering Register

*Adopted 2026-08-07 under the standing principle: the architecture should
become easier to understand every year. Test applied to every system:
"If Pintag were started today, would we still build this — now?"*

**Nothing is deleted yet.** Verdicts are decisions-in-waiting: `Delete later`
items are executed as one reviewed cleanup commit **after L1 certification**
(never before — no destructive housekeeping on an unverified baseline).
`Archive` = keep in the repo, remove from the production deploy and from
active maintenance. Every verdict names its reasoning; overturning one goes
through architecture review like any other proposal.

| System / file | Verdict | Reasoning |
|---|---|---|
| **Intelligence platform — snapshot capture** (`daily_metrics_snapshot`, report metric snapshots) | **Keep** | The honest surprise of this review: these "just in case" snapshots recovered 73 listing titles after the breach. Data capture compounds (M8) and costs almost nothing. Capture stays on. |
| **Intelligence platform — report generation + page** (`generate-intelligence-report`, pg_cron schedule, `intelligence.html/.js`, 6 docs in `docs/intelligence/`) | **Archive** | A scheduled AI-report pipeline for a site in maintenance mode generates reports about nothing. Genuinely good engineering, built ahead of its need. Park as **Designed**, disable the cron, revive at P2 when there is traffic to analyze. Removes a service_role-bearing surface in the meantime. |
| **Legacy agent portal** (`agent-login.html`, `dashboard.html`, `edit-listing.html`, `add-property.html`, `agent-setup.html`, `docs/LEGACY_AGENT_PORTAL.md`) | **Delete later** | Retired model (password-only auth, pre-`admin-auth.js`), already pruned from deploys, still contains three hard-delete code paths. Multi-admin arrives at L3 with RBAC — it will not be built on this code. Git history preserves it. |
| **`marketing-os.html` + `pintag-studio/`** (separate pipeline, service_role key in its CI) | **Archive** | A second system with its own auth model and a production service_role credential, for marketing content generation that pre-reopening Pintag does not need. Archiving reduces the credential surface — a security win, not just tidiness. Revisit as Marketing AI (Blueprint §10) at P2+. |
| **`watermark-migrate.html`** | **Delete later** | One-off migration tool; its migration is done. |
| **`og-preview-gen.html`, `og-preview-listings-gen.html`** | **Archive** | Occasional internal generator tools publicly deployed today. Keep the capability, remove from the production artifact (extend the deploy prune list). |
| **`analytics-inspector.html`** | **Archive** (after recovery closes) | Forensic tool that earned its keep in the incident. Not a permanent public surface; park with the recovery toolkit. |
| **`gallery-recovery.html`** | **Keep** (until recovery closes, then Archive) | The active Phase-2 recovery tool. New listings get galleries via Smart Import, so it retires with the recovery — into the same parked toolkit as the inspector. |
| **`viengkhone-phomthavong.html`** | **Delete later** | A hardcoded single-agent page duplicating what the templated agent page does. One agent = one data row, not one HTML file. |
| **`database-migration.sql`** (repo root) | **Delete later** | Ambiguous second home for schema next to `supabase/migrations/` — exactly the "two sources of truth" failure mode. Confirm superseded, then remove. |
| **`is_pintag_staff()` shim** | **Delete later** | Aliases `is_pintag_admin()` for a retired model; one grep + one migration after L1 cert. |
| **Security test suite** (`tests/security/`, 13 suites) | **Keep** | Cheap, real, catches regressions of everything L1 hardened. Point it at staging in CI at L2. |
| **Cloudflare OG worker, public site pages, shared JS modules (terminology, currency, rental-terms, components…)** | **Keep** | The product itself; each module is the single owner of its concept per `ARCHITECTURE.md` — the pattern working as designed. |
| **Provenance / snapshots / alerting stack** (L1 migrations) | **Keep** | The opposite of over-engineering: the incident's lesson made structural. Constitution §III enforced in schema. |

## Net effect if all verdicts execute

Public/deployed HTML surfaces drop from **22 → ~12**; one service_role
credential surface is removed; the intelligence cron goes quiet until it has
something to say; the repo loses its second schema home and its retired auth
model. No capability the company actually needs today is lost — and every
archived design remains one governance review away from revival.
