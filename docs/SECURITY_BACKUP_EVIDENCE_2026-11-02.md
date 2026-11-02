# Security and backup evidence record — 2026-11-02

> **This is an evidence record, not a certification.** It does **not** certify L1
> Production Safe. `docs/L1_PRODUCTION_SAFE_CERTIFICATION.md` remains
> **PENDING** and is deliberately unchanged. This page only separates what is
> *shown by completed workflow runs* from what still needs an operator.
>
> Every "verified" row below cites a completed GitHub Actions run whose log was
> read for this record. Nothing was run, dispatched or queried to write it, and
> no production system was touched. A green workflow proves only what that
> workflow checks; the "limits" column says what it does not.

## 1. Verified by completed runs

| # | Control | Result | Run (date) | Limits — what this does NOT prove |
|---|---|---|---|---|
| V1 | Weekly encrypted backup | Succeeded. Per-table live-vs-backup row counts within tolerance (e.g. leads 399/399, lead_events 437/437, contacts 198/198, import_records 89/89, gallery_assignments 136/136, intelligence_insights 1099/1099); `property_images` registry exported (1,556 rows); object store synced with a checksum check | [41296920224](https://github.com/Pintag-cyrora/pintag/actions/runs/41296920224) (2026-11-01). Earlier weekly runs on 2026-10-11, 10-18, 10-25 also succeeded | Counts match; contents were not restored from this backup in the same run. Off-platform key custody is not visible in a log |
| V2 | Quarterly restore drill (database) | Succeeded. Restored to a scratch database: properties 170, parties 11, owners 44, contacts 180, leads 253, lead_events 291; RLS policies present (49) and functions present (57) | [36993545347](https://github.com/Pintag-cyrora/pintag/actions/runs/36993545347) (2026-10-02). Two earlier drill attempts failed on 2026-09-02 and a later one passed the same day | **Storage objects were not restored** (`storage_objects` reported 0 and the log says "Storage restored (run with --storage / operator step)"). The drill's own last line asks for storage verification and admin re-provisioning |
| V3 | Production security drift check, database catalog | Succeeded: RLS enabled on every public base table; every public view `security_invoker`; no write policy bypasses an identity gate; every storage write policy requires `is_pintag_admin()`; `is_pintag_admin()` requires an `aal2` session and binds to the caller; no SECURITY DEFINER function authorizes on `auth.email()`; admin-gated `rebuild_images_from_registry()` and `reset_weekly_views()`; `public_listing_stats()` filters to visible listings; analytics inserts bounded by a target ceiling; anonymous holds no INSERT/UPDATE/DELETE on core tables; exactly 1 administrator; migrations `20260813000000`, `20260817000000`, `20260817010000` present | [40317944089](https://github.com/Pintag-cyrora/pintag/actions/runs/40317944089) (2026-10-26; the check is scheduled weekly) | Checks catalog/definitions, not behaviour under an authenticated admin session. The L1 migrations `20260806010000/020000/030000` are not individually listed in this report |
| V4 | Production security drift check, anonymous HTTP surface | 22 passed, 0 failed, 0 warnings, 5 unverifiable: public sign-up disabled; internal tables return no rows to the anonymous key (owners, leads, admin_accounts, property_images, intelligence_reports, properties_row_snapshots, listing_view_throttle, ops_alerts); privileged RPCs denied; anonymous INSERT/UPDATE of `properties` refused; anonymous upload/delete in the image bucket refused; the three AI edge functions return 401 | same run | 5 checks were *unverifiable*, see O3 |
| V5 | Listing-count floor and ops-alert monitor | Succeeded 4× in the last day. At 2026-11-02 00:00 UTC: **183 listings not soft-deleted**; high/critical ops alerts check ran | [41364797511](https://github.com/Pintag-cyrora/pintag/actions/runs/41364797511) (2026-11-02) | The floor is `MIN_EXPECTED_LISTINGS=1`, so it detects a collapse, not a partial loss. The alert webhook secret is empty in the log (`ALERT_WEBHOOK_URL:` blank), so alert *delivery* is not evidenced |
| V6 | Catalogue facts (aggregate) | `properties` rows 184 incl. soft-deleted; `properties.updated_at` does not exist; 87 listings have a Gallery Recovery record | [39749742187](https://github.com/Pintag-cyrora/pintag/actions/runs/39749742187) (2026-10-22, read-only probe) | Historical by 11 days; superseded for the live count by V5 |

## 2. Outstanding operator checks (NOT verified — do not treat as done)

| # | Check | Why it is outstanding |
|---|---|---|
| O1 | **Storage restore** — restore the object store from the off-platform copy into a scratch project and compare object counts/checksums | The 2026-10-02 drill reported 0 storage objects and deferred storage to an operator step |
| O2 | **Point-in-time recovery enabled** on the production project | A dashboard setting; not observable from any workflow log |
| O3 | **Authenticated admin lockdown matrix** — AAL1 refused (RLS write, `is_pintag_admin` RPC, `listing_timeline` RPC, edge function, storage write) and AAL2 succeeds | In the last run the matrix was `1 passed, 0 failed, 3 skipped`: *authenticated non-admin*, *admin aal1* and *admin with MFA* were skipped because no admin credentials are configured for CI (by design). Needs an operator run with a TOTP-enrolled admin |
| O4 | **Live XSS / security-header proof against the real pages** | 5 HTTP checks and 2 XSS checks were *unverifiable*: Cloudflare (Bot Fight Mode, `cf-mitigated: challenge`, HTTP 403) blocks the CI runner from fetching production HTML. Not a failure and not a pass |
| O5 | **L1 structural checks A1–A8, soft-delete behaviour B1–B5, mass-delete block and alert (A5/A6)** from `docs/L1_VERIFICATION_PACK.md` | The drift report confirms the `aal2` gate and storage-policy parts, but the soft-delete / snapshot / mass-delete behaviour tests need the verification pack run by an operator (mutating tests belong on a dev database) |
| O6 | **Edge functions redeployed** (the five listed in the L1 certification) — deploy timestamps | Not visible in the logs read for this record |
| O7 | **Alert delivery** — a test alert reaches the operator | `ALERT_WEBHOOK_URL` is blank in the monitoring log |
| O8 | **Backup decryption** — decrypt a backup with the offline private key and open it | Key custody is an operator matter; the log shows encryption only to the public key |
| O9 | **Cloudflare WAF / rate limiting** (`docs/RATE_LIMITING.md` Layer 1) | Documented as not configured; needs the Cloudflare account administrator |
| O10 | **Weekly image-integrity check is failing** (553 unreferenced originals; failing since at least 2026-10-12) | A known data-hygiene finding with a parked investigation; it is a standing red check, not an incident |

## 3. What this means for L1

* **L1 Production Safe remains PENDING.** It is certified only when *every* criterion in
  `docs/L1_PRODUCTION_SAFE_CERTIFICATION.md` has real evidence. Nothing in this record, and no risk acceptance below,
  certifies L1. The outstanding items below include rows of that template that cannot be filled from CI logs.
* The evidence does support: scheduled backups and a database restore path are working and monitored (V1, V2); the
  database authorization model matches the repository (V3); the anonymous surface is closed to the probed tables and
  functions (V4).

### Launch gate for the public viewing-request form (owner decision, 2026-11-02)
| Item | Role | Status |
|---|---|---|
| O1 storage restore | **Required** — completed with evidence, or explicitly risk-accepted | OPEN |
| O2 point-in-time recovery | **Required** — completed with evidence, or explicitly risk-accepted | OPEN |
| O3 authenticated admin lockdown matrix | **Required** — completed with evidence, or explicitly risk-accepted | OPEN |
| O9 Cloudflare rate limiting / WAF | **Required** — completed with evidence, or explicitly risk-accepted | OPEN |
| O4 live security-header / XSS proof | Tracked; does not block by itself | OPEN |
| O7 alert delivery | Tracked; does not block by itself | OPEN |
| O8 backup decryption | Tracked; does not block by itself | OPEN |

Exact public location exposure is a separate gate: `docs/LOCATION_PRIVACY_AUDIT_AND_SPEC.md`.

### Accepted-risk register (empty until the owner decides)
A risk is accepted only by an entry here with: the item, the date, who accepted it, the reason, what could go wrong, any
compensating control, and a review date. No risk has been accepted yet. An accepted risk **does not** change the item's status
to done and **does not** affect L1.

| Item | Date | Accepted by | Reason | Compensating control | Review by |
|---|---|---|---|---|---|
| *(none)* | | | | | |

## 4. How to refresh this record

Re-read the same four workflows (`backup.yml`, `restore-drill.yml`,
`verify-production-security.yml`, `monitoring.yml`) and update the run links and
dates. Never mark an O-row done without the artefact that proves it (run URL,
screenshot, or operator note with date).
