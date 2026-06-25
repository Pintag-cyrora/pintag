# Pintag Security Regression Framework

**Version:** 1.0.0 — automated penetration-style tests for every Pintag security control.

Run before every production deployment, on every PR to `main`, and weekly on Mondays.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Environment Variables](#environment-variables)
3. [Running Suites](#running-suites)
4. [Architecture Overview](#architecture-overview)
5. [Adding a New Suite](#adding-a-new-suite)
6. [Adding a New Resource](#adding-a-new-resource)
7. [CI: GitHub Actions](#ci-github-actions)
8. [Local Execution Guide](#local-execution-guide)
9. [Interpreting Reports](#interpreting-reports)
10. [Troubleshooting](#troubleshooting)
11. [Test Coverage](#test-coverage)
12. [Known Limitations](#known-limitations)

---

## Quick Start

```bash
# Minimum — runs all anon-only tests (no credentials required)
export APP_ENV=local
export SUPABASE_URL=https://eoladhcljbpbhnrmmpev.supabase.co
export SUPABASE_ANON_KEY=eyJ...        # from admin.html or Supabase Dashboard → Settings → API

bash tests/security/run.sh

# Full coverage — all 12 suites with all credentials
export APP_ENV=local
export SUPABASE_URL=https://eoladhcljbpbhnrmmpev.supabase.co
export SUPABASE_ANON_KEY=eyJ...
export ADMIN_EMAIL=admin@pintag.io
export ADMIN_PASSWORD=your-admin-password
export TEST_USER_EMAIL=agent@example.com
export TEST_USER_PASSWORD=your-test-user-password
export SITE_URL=https://pintag.io

bash tests/security/run.sh

# Check which resources are covered (no network requests)
bash tests/security/generate-manifest.sh
```

Reports are written to `tests/security/output/reports/` (gitignored):
- `junit-<run-id>.xml` — JUnit XML for CI integration
- `summary-<run-id>.json` — JSON summary with timing, counts, and version

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | **Yes** | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | **Yes** | Publishable anon key (safe to commit) |
| `APP_ENV` | Recommended | `local` or `staging` — **production is refused**; defaults to `local` with a warning |
| `ADMIN_EMAIL` | Recommended | Enables admin auth, storage, XSS, Smart Import, and admin RLS tests |
| `ADMIN_PASSWORD` | Recommended | Password for `ADMIN_EMAIL` |
| `TEST_USER_EMAIL` | Optional | A non-admin Supabase Auth user — enables cross-user access tests |
| `TEST_USER_PASSWORD` | Optional | Password for `TEST_USER_EMAIL` |
| `SITE_URL` | Optional | Base URL of the deployed frontend — enables Suite 08 (security headers) |
| `DEBUG` | Optional | Set to `1` to print every request URL, status, and timing to stderr |

### Setting up the test user

The test user must be a real Supabase Auth user with the `authenticated` role but **not** the admin email.
Create one via the Supabase Dashboard → Authentication → Users, or via the service role API:

```bash
curl -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"test-agent@pintag.io","password":"test-password","email_confirm":true}'
```

---

## Running Suites

```bash
# Run all suites
bash tests/security/run.sh

# Run specific suites by name
bash tests/security/run.sh auth rls
bash tests/security/run.sh ssrf storage
bash tests/security/run.sh sql_injection secret_scan

# Print test manifest without running anything
bash tests/security/generate-manifest.sh

# Print manifest as JSON
bash tests/security/generate-manifest.sh --json
```

Available suite names (auto-discovered — no changes to `run.sh` when adding new suites):

| Name | Tests |
|---|---|
| `auth` | JWT authentication gating |
| `rls` | Row Level Security on all tables |
| `edge_functions` | Edge Function payload and auth validation |
| `storage` | Storage bucket upload/delete/extension restrictions |
| `ssrf` | SSRF allowlist on `resolve-map-url` and `smart-listing-importer` |
| `xss` | XSS payload injection and rendering safety |
| `rate_limiting` | `lead_events` and `listing_events` throttling |
| `headers` | HTTP security response headers (requires `SITE_URL`) |
| `pintag_specific` | Error format, Smart Import edge cases, listing isolation |
| `sql_injection` | SQL injection through all public input surfaces |
| `secret_scan` | Repository scan for accidentally committed secrets |
| `open_redirect` | Open redirect bypass attacks on `resolve-map-url` |

---

## Architecture Overview

```
tests/security/
├── run.sh                   Entry point — sources helpers, discovers suites, runs them
├── resources.sh             Resource registry — single source of truth for all API resources
├── generate-manifest.sh     Standalone manifest generator (no tests run)
├── lib/
│   └── helpers.sh           Shared utilities: HTTP, assertions, JWT, cleanup, reports
├── suites/
│   ├── 01_auth.sh           Suite functions: run_<name>_tests()
│   ├── 02_rls.sh
│   └── ...
└── output/                  Gitignored at runtime
    ├── requests-<id>.log    TSV request log (timestamp, suite, test, method, url, status, duration)
    ├── perf-baseline.json   Performance regression baseline (updated each run)
    └── reports/
        ├── junit-<id>.xml   JUnit XML report
        └── summary-<id>.json JSON summary
```

### How a run works

1. `run.sh` sources `helpers.sh`, which sources `resources.sh` and sets up global state
2. `check_app_env()` refuses `APP_ENV=production`
3. All suite files under `suites/` are sourced automatically — no manual registration required
4. Admin and test-user JWTs are acquired (if credentials are set)
5. A version banner is printed showing commit, environment, credentials, and feature flags
6. Each requested suite's `run_<name>_tests()` function is called in order
7. After all suites finish, `generate_reports()` writes JUnit XML and JSON
8. `generate_coverage_report()` shows which resources were exercised
9. `compare_perf_history()` warns if any endpoint is >50% slower than the stored baseline
10. Exit code: 0 = all passed, 1 = one or more failures

### Key design decisions

**UUID-based run isolation.** Every run gets a UUID (`RUN_ID`). All test data (slugs, sessions) is prefixed with `RUN_ID_SHORT` (first 8 chars) to prevent cross-run collisions when running in parallel CI jobs.

**Retry logic.** `http_request()` retries on transient errors (000/429/500–504) with exponential backoff (2^attempt seconds, max 3 retries). It never retries on 401/403/404/422.

**Performance budget.** Every request checks against a per-endpoint budget: Edge Functions 2000ms, Storage 5000ms, DB/other 500ms. Violations are reported but never fail the suite.

**Auto-discovery.** Suite files named `NN_name.sh` are loaded and their `run_name_tests()` function is called automatically. Adding a new suite requires no changes to `run.sh`.

**Cleanup registry.** Suites call `register_cleanup_listing()` and `register_cleanup_storage()` to enqueue test data for deletion. A `trap` on EXIT calls `run_cleanup()` even if the run aborts mid-suite.

---

## Adding a New Suite

### 1. Create the file

Create `tests/security/suites/NN_name.sh` where `NN` is the next available two-digit number.
The function name must match: `run_name_tests()`.

```bash
#!/usr/bin/env bash
# Suite NN — My New Suite
#
# @suite    My New Suite
# @purpose  One sentence describing what security property this tests
# @covers   fn:my-function table:my-table bucket:my-bucket
# @needs    optional:ADMIN_EMAIL,ADMIN_PASSWORD
# @runtime  ~20s

run_my_new_suite_tests() {
  suite_start "My New Suite"

  local r status body

  # Example: test that something returns 403
  CURRENT_TEST="my test description"
  r=$(api_get "my-table?status=eq.active&limit=1")
  check_status "my test: anon access → 200" 200 "$(resp_status "$r")"

  suite_end
}
```

### 2. Register covered resources

Add the resources your suite tests to its `@covers` line using these prefixes:
- `fn:name` — Edge Function at `/functions/v1/name`
- `table:name` — PostgREST table
- `bucket:name` — Storage bucket
- `header:name` — HTTP security header
- `static` — No network requests (static analysis)

### 3. Register new resources in resources.sh

If your suite tests a resource that doesn't exist in `resources.sh` yet, add it there:

```bash
# In tests/security/resources.sh
RESOURCE_FNS+=(   "my-new-function" )
RESOURCE_TABLES+=( "my-new-table"   )
RESOURCE_BUCKETS+=("my-new-bucket"  )
```

### 4. Verify the manifest

```bash
bash tests/security/generate-manifest.sh
```

The new suite and its covered resources should appear in the output with ✓ marks.

### Assertion helpers

| Helper | Signature | Use when |
|---|---|---|
| `check` | `check LABEL PATTERN ACTUAL` | Pattern must match actual (ERE via `grep -E`) |
| `check_status` | `check_status LABEL CODE ACTUAL_CODE` | HTTP status code must equal expected |
| `check_empty` | `check_empty LABEL BODY` | Body must be exactly `[]` |
| `fail_hard` | `fail_hard LABEL REASON` | Unconditional failure with reason |
| `skip` | `skip LABEL REASON` | Skip with explanation (increments skip counter) |
| `info` | `info TEXT` | Informational print (not a test result) |

### HTTP helpers

| Helper | Usage |
|---|---|
| `api_get PATH [JWT]` | GET `/rest/v1/PATH` |
| `api_post PATH BODY [JWT]` | POST `/rest/v1/PATH` |
| `api_patch PATH BODY [JWT]` | PATCH `/rest/v1/PATH` |
| `api_delete PATH [JWT]` | DELETE `/rest/v1/PATH` |
| `fn_post FN BODY [JWT]` | POST `/functions/v1/FN` |
| `storage_upload BUCKET PATH CTYPE BODY [JWT]` | PUT object to storage |
| `storage_delete BUCKET PATH [JWT]` | DELETE object from storage |

All helpers return `BODY\nHTTP_STATUS` — use `resp_body "$r"` and `resp_status "$r"` to split.

---

## Adding a New Resource

### New Edge Function

1. Deploy the function to Supabase
2. Add to `RESOURCE_FNS` in `tests/security/resources.sh`
3. Add auth tests in `01_auth.sh` (if the function requires admin JWT)
4. Add payload tests in `03_edge_functions.sh` (empty body, malformed JSON)
5. Add SSRF tests in `05_ssrf.sh` (if the function accepts URLs)
6. Update `@covers` in any suite that calls the new function

### New PostgREST table

1. Add to `RESOURCE_TABLES` in `tests/security/resources.sh`
2. Add RLS tests in `02_rls.sh`: anon SELECT, anon INSERT/UPDATE/DELETE, admin full access
3. Add SQL injection tests in `10_sql_injection.sh`: filter injection on key columns
4. Update `@covers` in suites that use the table

### New storage bucket

1. Add to `RESOURCE_BUCKETS` in `tests/security/resources.sh`
2. Add upload/delete tests in `04_storage.sh`: anon blocked, admin allowed, extension check

---

## CI: GitHub Actions

The workflow at `.github/workflows/security-regression.yml` runs automatically on:
- Every push or PR to `main`
- Weekly on Mondays at 02:00 UTC
- Manual trigger via GitHub Actions UI

### Required secrets

| Secret | Value |
|---|---|
| `SUPABASE_URL` | `https://eoladhcljbpbhnrmmpev.supabase.co` |
| `SUPABASE_ANON_KEY` | Anon key from Supabase Dashboard → Settings → API |
| `ADMIN_EMAIL` | `admin@pintag.io` |
| `ADMIN_PASSWORD` | Admin account password |
| `TEST_USER_EMAIL` | Test agent email |
| `TEST_USER_PASSWORD` | Test agent password |
| `SITE_URL` | `https://pintag.io` (or staging URL) |

`APP_ENV` is hardcoded to `staging` in the workflow — no secret needed.
The suite refuses to run if `APP_ENV=production`.

### Artifacts

JUnit XML and JSON summary reports are uploaded as the `security-reports` artifact on every run (pass or fail), retained for 30 days.

---

## Local Execution Guide

### Prerequisites

- `bash` 4.0+ (`brew install bash` on macOS; Linux systems have it by default)
- `curl` and `jq` (standard on most Linux/macOS)
- `python3` (optional — for UUID generation, JWT decoding, and perf history; falls back gracefully)
- `git` (optional — for secret scan suite and run banner commit info)

### Check your bash version

```bash
bash --version    # must be 4.0+
```

On macOS, system bash is 3.x. Install with Homebrew:
```bash
brew install bash
# Then run with: /opt/homebrew/bin/bash tests/security/run.sh
```

### Running with a .env file

```bash
set -a && source .env.local && set +a
bash tests/security/run.sh
```

### Debug mode

```bash
DEBUG=1 bash tests/security/run.sh auth
```

Prints every request URL, status code, and timing to stderr.

### Running a single test manually

```bash
# Source helpers to get all HTTP functions in your shell
export SUPABASE_URL=... SUPABASE_ANON_KEY=...
source tests/security/lib/helpers.sh

# Then call any helper directly
r=$(api_get "properties?status=eq.active&limit=1")
resp_status "$r"   # → 200
resp_body "$r"     # → [{"id": "...", ...}]
```

---

## Interpreting Reports

### Console output

```
▸ Authentication                     ← suite name
    PASS  generate-listing-content: no Bearer token → 401
    PASS  smart-listing-importer: no Bearer token → 401
    SKIP  Non-admin JWT rejection — TEST_USER_EMAIL/TEST_USER_PASSWORD not set
  ✓ 6 passed, 2 skipped (3.2s)

════════════════════════════════════════
 Summary
════════════════════════════════════════
 PASS  auth                (6 passed, 2 skipped, 3.2s)
 FAIL  storage             (8 passed, 1 failed, 2 skipped, 12.1s)

 Overall:
   Passed:   47
   Failed:   1
   Skipped:  15  (set env vars for full coverage)
   Requests: 83
```

### JUnit XML

Integrates with GitHub Actions "Test Results" view, Jenkins, and any CI system that accepts JUnit XML. Each `<testcase>` includes the test name, suite name, duration, and failure message if applicable.

### JSON summary

`summary-<run-id>.json` contains:
```json
{
  "framework_version": "1.0.0",
  "run_id": "...",
  "environment": "staging",
  "passed": 47,
  "failed": 1,
  "skipped": 15,
  "total_requests": 83,
  "perf_warnings": 0,
  "suites": [...]
}
```

### Coverage report

Printed after every run — shows ✓/✗ for each registered resource:

```
════════════════════════════════════════
 Coverage
════════════════════════════════════════
  Edge Functions:
    ✓  generate-listing-content
    ✓  smart-listing-importer
    ✗  resolve-map-url  (not tested)   ← missing coverage
```

A ✗ means no suite made a request to that resource this run. Either the relevant suite was not requested, or a new resource was added to `resources.sh` without corresponding tests.

### Performance history

`perf-baseline.json` stores per-endpoint average latency from the most recent run. On subsequent runs:

```
════════════════════════════════════════
 Performance History
════════════════════════════════════════
  PERF REGRESSION  fn:smart-listing-importer  3200ms  (+60% vs baseline 2000ms)
  Baseline: tests/security/output/perf-baseline.json
```

Performance regressions are **warnings only** — they never fail CI. The baseline is updated after every run.

---

## Troubleshooting

### "SECURITY TESTS REFUSED ON PRODUCTION"

The suite refuses to run against `APP_ENV=production`. Set `APP_ENV=staging` or `APP_ENV=local`.

### "Required environment variables not set: SUPABASE_URL"

Export `SUPABASE_URL` and `SUPABASE_ANON_KEY` before running. See the [Quick Start](#quick-start) section.

### "Admin login failed — admin-only tests will be skipped"

`ADMIN_EMAIL` / `ADMIN_PASSWORD` are set but login failed. Verify:
1. The email exists in Supabase Dashboard → Authentication → Users
2. The password is correct
3. `SUPABASE_URL` points to the correct project

### "bash 4+ required"

On macOS, system bash is 3.x. Run with:
```bash
/opt/homebrew/bin/bash tests/security/run.sh
```

### Tests pass locally but fail in CI

Check that all required secrets are set in GitHub → Settings → Secrets and variables → Actions.
Run with `DEBUG=1` to see request details:
```yaml
env:
  DEBUG: 1
```

### A new suite is not being discovered

- Filename must match `tests/security/suites/NN_name.sh`
- Function name must match `run_name_tests()` (name derived by stripping leading digits and underscore from filename)
- Run `bash tests/security/generate-manifest.sh` to confirm discovery

### "No active listing found" in rate_limiting or rls suite

These suites need at least one listing with `status='active'` in the database.
Create one via `admin.html` before running the full suite.

### Cleanup test data manually

If a test run aborts before cleanup, stale test rows may remain. They are prefixed `pentest-` and can be removed with:
```bash
# In Supabase SQL editor:
DELETE FROM properties WHERE slug LIKE 'pentest-%';
```

---

## Test Coverage

### Suite 01 — Authentication (~15s)
- No token → 401 on each admin Edge Function
- Anon-role JWT used as Bearer → 401
- Garbage / invalid JWT → 401
- Non-admin authenticated user → 401 *(requires TEST_USER)*
- Admin JWT → accepted (2xx or 5xx, not 401) *(requires ADMIN)*

### Suite 02 — Row Level Security (~25s)

**properties** — anon SELECT active ✓, draft/sold filtered ✓, anon INSERT/UPDATE/DELETE → 403 ✓  
**agents** — anon SELECT all ✓, anon/non-admin INSERT/UPDATE/DELETE → 403 ✓  
**lead_events** — anon INSERT active listing ✓, non-existent listing → 403 ✓, anon SELECT → empty ✓  
**listing_events** — anon INSERT active ✓, duplicate within window → 403 ✓, anon SELECT → empty ✓

### Suite 03 — Edge Functions (~20s)
- Auth gating on `generate-listing-content` and `smart-listing-importer`
- Empty body, malformed JSON → structured error (not crash) *(requires ADMIN)*
- `resolve-map-url`: allowed/disallowed domains, missing URL field

### Suite 04 — Storage (~30s)
- Anon upload/delete → 4xx on both buckets
- Admin upload `.php`, `.js`, `.sh` → 4xx (WITH CHECK extension policy) *(requires ADMIN)*
- Admin upload valid `.jpg` → 2xx *(requires ADMIN)*
- MIME disguise (`.jpg` name, PHP body) → documents known limitation *(requires ADMIN)*
- Double-extension `shell.php.jpg` → documents known limitation *(requires ADMIN)*
- Reversed double `image.jpg.php` → 4xx *(requires ADMIN)*
- SVG with embedded JS → 4xx *(requires ADMIN)*
- `.htaccess` upload → 4xx *(requires ADMIN)*
- Path traversal in object path → documents behaviour *(requires ADMIN)*
- Non-admin overwrite of admin file → 4xx *(requires ADMIN + TEST_USER)*

### Suite 05 — SSRF (~20s)
- `resolve-map-url` allowed domains → not 403
- Disallowed domains, private IPs, loopback → 403
- Userinfo bypass (`goo.gl@evil.com`), subdomain bypass → 403
- `smart-listing-importer` auth gate fires before SSRF check → 401
- Admin + IMDS URL → silently discarded (photo_analysis: []) *(requires ADMIN)*

### Suite 06 — XSS (~20s)
- Inserts 5 XSS payloads via admin *(requires ADMIN)*
- Verifies draft not visible to anon (RLS confirmation)
- Verifies API returns raw unescaped value (correct — escaping is frontend responsibility)
- Optional Playwright browser check: confirms no `alert()` fires *(requires SITE_URL + Playwright)*

### Suite 07 — Rate Limiting (~15s)
- First `lead_event` insert → 201
- Duplicate within 30s → 403
- Different event_type → 201 (independent limit)
- Different session → 201 (per-listing, not global)
- Flood (5 rapid) → all 5 blocked
- `listing_events` 30-minute dedup

### Suite 08 — Security Headers (~20s, requires SITE_URL)
- CSP (response header or `<meta>` tag), no `unsafe-eval`
- X-Frame-Options or `frame-ancestors` in CSP
- X-Content-Type-Options: nosniff
- Referrer-Policy (not `unsafe-url`)
- Permissions-Policy
- Strict-Transport-Security

### Suite 09 — Pintag-Specific (~25s)
- Error responses contain no stack traces, SQL errors, env var names
- Smart Import: wrong `image_urls` types, >10 URLs, null description — no 500 *(requires ADMIN)*
- Draft invisible to anon and non-admin by ID and slug *(requires ADMIN)*
- Anon cannot promote draft to active *(requires ADMIN)*
- `resolve-map-url` edge cases: empty URL, numeric URL, `data:`, `file:` → clean errors

### Suite 10 — SQL Injection (~30s)
- 7 payloads against `slug=eq.`, `id=eq.`, `title_en=ilike.*` PostgREST filters
- Edge Function JSON body injection (`listing_id`, `description` fields)
- RPC injection (`increment_listing_view`)
- DB integrity: tables still accessible after all attack payloads

### Suite 11 — Secret Scan (~5s)
- No committed `.env` files (`.env.local`, `.env.production`, etc.)
- No PEM private keys (`-----BEGIN PRIVATE KEY-----`)
- No service-role JWTs (decoded and checked for `role=service_role`)
- No OpenAI API key patterns (`sk-...`)
- No Google API key patterns (`AIza...`)
- No hardcoded DB credentials

### Suite 12 — Open Redirect (~15s)
- Protocol-relative `//evil.com`, bare hostname, leading-space URL → 4xx
- CRLF injection (`\r\n`, `%0d%0a`) → 4xx or no 500
- Null-byte hostname confusion → no 500
- Fragment bypass (`evil.com#maps.app.goo.gl`) → 4xx
- Percent-encoded hostname (`evil%2ecom`) → 4xx
- `javascript:` and `data:` URLs → 403
- `resolved_url` domain verified against google.com for legitimate input

---

## Known Limitations

1. **Storage MIME validation**: Extension check only verifies the filename's last extension. A file named `shell.php.jpg` passes the policy (extension = `jpg`). Enable MIME-type validation in Supabase Dashboard → Storage → bucket settings to mitigate.

2. **Open redirect via redirect chain**: `resolve-map-url` does not re-validate the resolved URL after following HTTP redirects. If a permitted shortlink (e.g., `goo.gl`) redirects to `evil.com`, the returned `resolved_url` will be `https://evil.com`. Client code must not use this value directly for browser navigation without re-validating the hostname.

3. **XSS browser test**: Full rendering safety can only be confirmed in a real browser. The suite includes optional Playwright automation but requires `@playwright/test` to be installed.

4. **Expired JWT testing**: Generating a cryptographically valid but expired JWT requires knowledge of the JWT secret, which is not available to the test suite.

5. **HTTP security headers**: Headers checked in Suite 08 (X-Frame-Options, Referrer-Policy, etc.) must be configured at the CDN/hosting layer. These tests will fail until the CDN is configured, even though the `<meta>` CSP tag is present.

6. **Agent cross-row isolation**: Full cross-user tests (agent A cannot delete agent B's listings) require two agents with actual listings assigned. The suite tests the policy logic; full isolation requires either manual verification or a more complex fixture setup.

---

## Extending the Framework

When Pintag gains a new feature, the expected process is:

1. **Deploy the feature** (new Edge Function, table, or bucket)
2. **Add the resource** to `tests/security/resources.sh`
3. **Add tests** in the most appropriate existing suite, or create a new `NN_name.sh`
4. **Update `@covers`** in any suite that exercises the new resource
5. **Run `generate-manifest.sh`** to confirm 100% resource coverage
6. **Run the full suite** and fix any failures before merging to `main`

The framework is intentionally not self-extending — new tests are added by engineers in response to new features, not generated automatically. The coverage report and manifest make it obvious when a resource has no corresponding tests.
