# Pintag Security Regression Suite

Automated penetration-style tests for every Pintag security control.
Run before every production deployment and on every PR to `main`.

---

## Quick Start

```bash
# Minimum — runs all anon-only tests
export APP_ENV=local
export SUPABASE_URL=https://eoladhcljbpbhnrmmpev.supabase.co
export SUPABASE_ANON_KEY=eyJ...   # from admin.html or Supabase Dashboard

bash tests/security/run.sh

# Full coverage — admin + cross-user + header checks
export APP_ENV=local
export ADMIN_EMAIL=admin@pintag.io
export ADMIN_PASSWORD=your-admin-password
export TEST_USER_EMAIL=agent@example.com
export TEST_USER_PASSWORD=your-test-user-password
export SITE_URL=https://pintag.io

bash tests/security/run.sh
```

Reports are written to `tests/security/output/reports/` (gitignored):
- `junit-<run-id>.xml` — JUnit XML for CI integration
- `summary-<run-id>.json` — JSON summary with timing, counts, and environment

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | **Yes** | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | **Yes** | Publishable anon key (safe to commit) |
| `APP_ENV` | Recommended | `local` or `staging`; **production is refused** (defaults to `local` with a warning) |
| `ADMIN_EMAIL` | Recommended | Enables admin auth, storage extension, XSS injection, and admin RLS tests |
| `ADMIN_PASSWORD` | Recommended | Password for `ADMIN_EMAIL` |
| `TEST_USER_EMAIL` | Optional | A non-admin Supabase user (an agent account) — enables cross-user access tests |
| `TEST_USER_PASSWORD` | Optional | Password for `TEST_USER_EMAIL` |
| `SITE_URL` | Optional | Base URL of the deployed frontend — enables security header checks |
| `DEBUG` | Optional | Set to `1` to print every request URL, status, and timing to stderr |

### Setting up the test user

The test user must be a real Supabase Auth user with `authenticated` role but **not** the admin email.
Create one in Supabase Dashboard → Authentication → Users, or via:

```bash
curl -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"test-agent@pintag.io","password":"test-password","email_confirm":true}'
```

---

## Running Individual Suites

```bash
# Run only specific suites
bash tests/security/run.sh auth rls
bash tests/security/run.sh ssrf storage
bash tests/security/run.sh headers

# Available suites (auto-discovered from tests/security/suites/*.sh):
#   auth             Edge Function JWT auth gating
#   rls              Row Level Security on all tables
#   edge_functions   Edge Function behaviour and payload handling
#   storage          Storage bucket upload/delete/extension restrictions
#   ssrf             SSRF allowlist on resolve-map-url and smart-listing-importer
#   xss              XSS payload injection and rendering safety
#   rate_limiting    lead_events and listing_events throttling
#   headers          HTTP security response headers (requires SITE_URL)
#   pintag_specific  Pintag-specific: error format, Smart Import edge cases, listing isolation
```

New suites are auto-discovered from `tests/security/suites/*.sh` — no changes to `run.sh` are needed.

---

## CI: GitHub Actions

Secrets to add in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
|--------|-------|
| `SUPABASE_URL` | `https://eoladhcljbpbhnrmmpev.supabase.co` |
| `SUPABASE_ANON_KEY` | Anon key from Supabase Dashboard → Settings → API |
| `ADMIN_EMAIL` | `admin@pintag.io` |
| `ADMIN_PASSWORD` | Admin account password |
| `TEST_USER_EMAIL` | Test agent email |
| `TEST_USER_PASSWORD` | Test agent password |
| `SITE_URL` | `https://pintag.io` (or staging URL) |

> `APP_ENV` is hardcoded to `staging` in the workflow — no secret needed. The suite refuses to run if `APP_ENV=production`.

The workflow runs on every push/PR to `main` and weekly on Mondays.

---

## Test Coverage

### Suite 01 — Authentication
- No token → 401 on each admin Edge Function
- Anon-role JWT used as Bearer → 401
- Garbage / invalid JWT → 401
- Non-admin authenticated user → 401
- Admin JWT → accepted (2xx or 5xx, not 401)

### Suite 02 — Row Level Security

**properties**
- Anon: SELECT active/available ✓, draft/sold filtered out ✓
- Anon: INSERT/UPDATE/DELETE → 403 ✓
- Non-admin: INSERT/UPDATE → 403; cross-user DELETE → 0 rows ✓
- Admin: full access ✓

**agents**
- Anon: SELECT all ✓ (intentional — public agents page)
- Anon/non-admin: INSERT/UPDATE/DELETE → 403 ✓

**lead_events**
- Anon: INSERT active listing ✓, non-existent listing → 403 ✓
- Anon: SELECT → empty (no policy) ✓

**listing_events**
- Anon: INSERT active listing ✓, duplicate within window → 403 ✓
- Anon: SELECT → empty ✓

### Suite 03 — Edge Functions
- Auth gating on `generate-listing-content` and `smart-listing-importer`
- Payload validation: empty body, malformed JSON → structured error (not crash)
- `resolve-map-url`: allowed/disallowed domains

### Suite 04 — Storage
- Anon upload to `property-images` and `agent-photos` → 4xx
- Anon delete → 4xx
- Admin upload `.php`, `.js`, `.sh`, `.html`, `.exe` → 4xx (WITH CHECK extension policy)
- Admin upload valid `.jpg` → 2xx
- MIME-disguise (`.jpg` name, PHP body) → documents known limitation
- Non-admin overwrite of admin file → 4xx

### Suite 05 — SSRF

**resolve-map-url**
- Allowed: `maps.app.goo.gl`, `goo.gl`, `maps.google.com` → not 403
- Disallowed: `evil.com`, `google.com`, `notgoo.gl` → 403
- Private IPs: `169.254.169.254`, `10.x`, `192.168.x` → 403
- Loopback: `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0` → 403
- Bypass attempts: `goo.gl@evil.com` (userinfo), `sub.maps.app.goo.gl` → 403
- Encoded hosts: percent-decoded by URL constructor → documents behaviour

**smart-listing-importer**
- No auth → 401 (SSRF never reached)
- Admin + IMDS URL → silently discarded (photo_analysis: [])
- Admin + `*.supabase.co@evil.com` userinfo bypass → discarded

### Suite 06 — XSS
- Inserts 5 XSS payloads via admin: `<script>`, `<img onerror>`, `<svg onload>`, `javascript:`, `<iframe>`
- Verifies draft not visible to anon (RLS confirmation)
- Verifies API returns raw unescaped value (correct — escaping is frontend responsibility)
- Optional Playwright browser check: confirms no `alert()` fires on `/listings.html`

### Suite 07 — Rate Limiting
- First `lead_event` insert → 201
- Duplicate within 30s → 403
- Different event_type → 201 (independent limit)
- Different session → 201 (per-listing, not global)
- Flood (5 rapid) → all 5 blocked

### Suite 09 — Pintag-Specific Security
- Error response format: no stack traces, SQL errors, env var names, or internal Supabase details in any error body
- Smart Import extended: `image_urls` wrong type (object/string), >10 URLs, null description — all handled without 500 crash
- Listing data isolation: draft invisible to anon and non-admin via direct ID and slug; anon cannot promote draft to active
- `resolve-map-url` edge cases: empty URL, numeric URL, `data:` URI, `file:` URI — all rejected cleanly

### Suite 08 — Security Headers
- CSP (response header or `<meta>` tag)
- X-Frame-Options or `frame-ancestors` in CSP
- X-Content-Type-Options: nosniff
- Referrer-Policy
- Permissions-Policy
- Strict-Transport-Security

---

## Known Limitations

1. **MIME type validation**: Storage extension check only verifies the filename. A file named `evil.jpg` with PHP body passes the `WITH CHECK` policy. This is a Supabase platform limitation; enable MIME-type validation in Supabase Dashboard → Storage → bucket settings.

2. **XSS browser test**: Full rendering safety can only be confirmed in a real browser. The suite includes optional Playwright automation but requires `@playwright/test` to be installed.

3. **Expired JWT**: Generating a cryptographically valid but expired JWT requires knowledge of the JWT secret, which is not available to the test suite.

4. **HTTP security headers**: Headers checked in suite 08 (X-Frame-Options, Referrer-Policy, etc.) must be configured at the CDN/hosting layer, not in HTML `<meta>` tags. These are expected to fail until the CDN is configured.

5. **Agent cross-row isolation**: The full cross-user test (agent A cannot delete agent B's listings) requires two agent accounts with actual listings assigned. The suite tests the policy logic via policy checks; full isolation requires manual verification or a more complex fixture setup.
