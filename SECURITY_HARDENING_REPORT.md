# Security Hardening Report — Single-Admin Lockdown

**Date:** 2026-08-04
**Trigger:** production data-loss breach of 2026-08-03 (93 listings + agent/contact records defaced and deleted).
**Change:** `supabase/migrations/20260804120000_single_admin_lockdown.sql`
**Verification:** `scripts/verify-single-admin-lockdown.sql`

---

## 1. What the incident proved

An attacker logged into a weak-password account (`testadmin@pintag.io`) with `curl` from an Azure IP (`52.150.30.136`) and, in one ~30-second automated run, used three permissive RLS policies to `UPDATE … 'HACKED'` then `DELETE` every active listing, plus agent (`parties`) and buyer (`contacts`) records — all through the public REST API.

**Root cause:** `properties` (and `parties`) carried policies of the form
`… TO authenticated USING (true) WITH CHECK (true)`. Because RLS policies are *permissive* (OR-combined), these granted **every authenticated user** full write access, silently overriding the carefully scoped `Party …/Staff …` policies beside them. A single compromised login of *any* account therefore meant total write access to all production data. A second failure compounded it: the intended secure policy (`Staff full access` gated on `is_pintag_staff`) was never the operative path, because the owner account had no `staff` party row — so the admin panel had been running on the insecure permissive policies all along.

---

## 2. The new model — default-deny, single writer

| Concern | Before | After |
|---|---|---|
| Who can write core data | **any** authenticated user (`USING true`) | **only** `is_pintag_staff(auth.uid())` — today exactly one party (`admin@pintag.io`) |
| Public reads | mixed (some exposed drafts) | `TO public` on active listings / agent profiles / contacts & units of active listings only |
| Agent self-service writes | scoped policies existed (unused, and overridden by the permissive ones) | **removed** — agents are read-only, per policy |
| Analytics inserts | anon INSERT | unchanged (append-only tracking) |
| Internal/intelligence tables | staff read; service-role writes | unchanged (already correct) |
| anon table privileges | INSERT/UPDATE/DELETE granted broadly | **revoked** on all data tables (defense-in-depth floor) |

"Single-admin" is enforced by **data, not hardcoding**: writes require a `parties` row with `type='staff'` matching the caller's `auth_user_id`. There is exactly one such row. This is the future-proofing hook (§8).

---

## 3. Every policy that changes (per table)

The migration **drops every existing policy** on each table (by iterating `pg_policies`, so it catches the untracked dashboard-created policies that hid the vulnerability) and recreates a minimal set:

**Data tables — `properties`, `parties`, `contacts`, `unit_types`:**
- `public read …` — `FOR SELECT TO public` (active listings / all agent profiles / contacts & units of active listings). *Why: the website must render for anonymous and logged-in visitors alike; `TO public` avoids the trap where an authenticated non-staff user matches no read policy and sees nothing.*
- `staff write …` — `FOR ALL TO authenticated USING/CHECK is_pintag_staff`. *Why: the single, explicit administrator write path.*

**`owners`, `leads`:** staff-only `FOR ALL` (no public read — internal data).

**Analytics — `lead_events`, `listing_events`, `search_events`, `ui_events`, `page_views`:** anon `FOR INSERT` (tracking) + staff `FOR SELECT`; `listing_events` also keeps the anon dedup self-check `SELECT`. *Why: these are append-only; anon needs to write events but must never read or mutate them.*

**Internal — `intelligence_reports/insights`, `report_insights`, `daily_metrics_snapshot`, `properties_removal_log`:** staff `FOR SELECT` only (+ staff `DELETE` on reports for the manual delete feature). *Why: written exclusively by the service-role edge function and `SECURITY DEFINER` triggers, which bypass RLS — no client write policy is warranted.*

**Privilege-layer floor:** `REVOKE INSERT, UPDATE, DELETE … FROM anon` on all six data tables. *Why: even if a permissive policy is ever re-introduced by mistake, anon still cannot write core data.*

**Removed entirely:** every `USING (true)`/`WITH CHECK (true)` write policy, every `authenticated`-can-write policy, the legacy `is_admin()` and `agent_*` (keyed on the stale `auth.uid()=managed_by_party_id`) policies, and the scoped `Party …` write policies — none survive.

---

## 4. Why the incident cannot recur

1. **No `USING(true)` write policy exists** — verification query #1 returns only the intentional anon analytics inserts.
2. **Compromising any single non-admin login grants no write access** — the only write path is `is_pintag_staff`, and only `admin@pintag.io` satisfies it (verify #5/#6). A stolen agent password can now read public data at most.
3. **The vulnerable role itself is gone** — `testadmin` deleted, its password reset, all others rotated (containment steps, done live).
4. **Defense-in-depth** — even a future policy mistake is caught by the anon grant REVOKE (verify #3).
5. **Regression-safe** — every public write path (view counter, lead creation, removal-log audit, rate-limit check) runs `SECURITY DEFINER`, so the lockdown breaks none of them (confirmed in the repo before writing the migration).

---

## 5. Regression testing (the site keeps working)

Run `scripts/verify-single-admin-lockdown.sql` (queries #7–#9 are live write tests): anon read works, anon/non-staff write affects **0 rows**, staff write affects all rows. Then the functional checklist:

- [ ] `pintag.io` and `/listings.html` load and show active listings (anon read).
- [ ] A listing detail page renders price/contacts/units and increments its view count (`SECURITY DEFINER` counter).
- [ ] Clicking WhatsApp on a listing records a `lead_events` row and creates a `leads` row (anon insert + definer trigger).
- [ ] `admin.html` (logged in as `admin@pintag.io`) can create, edit, publish, archive, and delete listings, agents, contacts, and owners.
- [ ] A logged-in **non-staff** account cannot write anything.

---

## 6. Endpoint / write-surface inventory

| Surface | Who can call | Authorization | Abuse risk after lockdown |
|---|---|---|---|
| PostgREST `/rest/v1/*` writes | anyone with a JWT | **RLS → staff only** | None: non-staff writes rejected |
| PostgREST reads | anyone | RLS (public data + staff full) | None |
| `increment_listing_view`, `public_listing_stats`, `check_lead_rate_limit` (RPC) | anon | `SECURITY DEFINER`, narrow single-purpose | Low: bounded, no arbitrary write |
| `generate-intelligence-report` (edge) | staff JWT **or** service-role key | `requireAdmin()` + service-role | Guard the service-role key (Vault, rotate) |
| `smart-listing-importer`, `facebook-listing-fetcher`, `generate-listing-content` (edge) | authenticated | uses **caller's** JWT → RLS → staff only | None beyond staff |
| `public-listings-feed` (edge) | public | read-only allowlist | None |
| Cloudflare Worker (OG) | public | anon key, read-only | None |
| Storage `objects` (image upload) | authenticated | *(still any authenticated — see §7)* | **Follow-up: tighten to staff** |

---

## 7. Residual risks & recommended follow-ups (not in this migration)

1. **Storage uploads** are still `TO authenticated` (any logged-in user could upload images). Low impact, but for true single-admin, replace with `is_pintag_staff` on the `storage.objects` INSERT/UPDATE/DELETE policies. SQL provided below — left out of the core migration to avoid touching the image pipeline without a live test.
2. **`listings` (0 rows) and `profiles` (1 row)** are untracked, unused-by-the-app tables. Investigate and `DROP` if confirmed cruft; until then they are not exposed by any policy this migration creates.
3. **Service-role key** is used by the intelligence edge function and five `pintag-studio` GitHub Actions. Store in Supabase Vault, rotate on a schedule, and confirm no external automation holds it.
4. **Auth hardening** (operational, done in the dashboard): sign-ups disabled, leaked-password protection on, strong-password policy, 2FA on the Supabase account, no test accounts.

```sql
-- Optional follow-up: staff-only Storage writes
DROP POLICY IF EXISTS "Admin upload property images"  ON storage.objects;
DROP POLICY IF EXISTS "Admin update property images"  ON storage.objects;
DROP POLICY IF EXISTS "Admin delete property images"  ON storage.objects;
-- recreate each FOR {INSERT|UPDATE|DELETE} TO authenticated
--   USING/WITH CHECK ( bucket_id IN ('property-images','agent-photos')
--                      AND is_pintag_staff(auth.uid()) );
```

---

## 8. Future-proofing — enabling agents safely later

The design makes future agent editing a **controlled, additive** change that never reopens broad access:

- **Grant one more admin:** insert a `parties` row with `type='staff'` for that person's `auth_user_id`. They immediately get full write access; nobody else does. Zero policy changes.
- **Grant scoped agent editing (their own listings only):** add a *new, explicitly-scoped* policy, e.g.
  `FOR UPDATE TO authenticated USING (managed_by_party_id IN (SELECT owned_party_ids(auth.uid())))` — never `USING (true)`. The default-deny base means such a grant is opt-in and auditable.
- **The invariant to preserve forever:** no write policy may use `USING (true)`/`WITH CHECK (true)` for `authenticated`. Every write must name a condition (`is_pintag_staff` or an ownership scope). This is now also enforced structurally by the anon grant floor and checkable at any time with verification query #1.

Default state, today and until deliberately changed: **one administrator writes; everyone else reads.**
