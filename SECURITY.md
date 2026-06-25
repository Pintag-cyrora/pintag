# Pintag Security Posture

Last updated: 2026-06-25 (deep audit pass + verification pass)

## Summary

Pintag is a static HTML + Supabase real estate platform. There is no server-side
backend outside of Supabase (PostgREST, Auth, Storage, Edge Functions). All pages
are served as static files; runtime trust is enforced through Supabase RLS policies
and Postgres functions.

---

## Executive Summary

**Overall security rating: 8.0 / 10**

After three audit passes (initial hardening + deep audit + verification pass), all
critical and high-severity issues have been fixed. Medium-severity issues are either
fixed or accepted with documented rationale. Remaining risks are low-severity
operational items.

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 3     | ✅ Fixed |
| High     | 8     | ✅ Fixed |
| Medium   | 5     | ✅ Fixed (3) / ⚠ Accepted (2) |
| Low      | 5     | ⚠ Accepted / Deferred |

---

## Verified Security Checklist

| Area | Status | Notes |
|------|--------|-------|
| RLS — `properties` | ✅ | Enabled; anon reads active only; admin full; agents own-only |
| RLS — `agents` | ✅ | Fixed: ENABLE ROW LEVEL SECURITY was missing (migration 000003) |
| RLS — `lead_events` | ✅ | Anon INSERT rate-limited; agent SELECT own leads |
| RLS — `listing_events` | ⚠ | INSERT rate-limited; no SELECT policy (low sensitivity data) |
| XSS — `listings.html` | ✅ | CSP added; esc() added; all DB values escaped |
| XSS — `listing.html` | ✅ | CSP added; pre-existing esc() throughout |
| XSS — `admin.html` | ✅ | CSP added; esc() added; renderCustomTags, addNearby, buildAgentOptions, loadAnalytics, loadListings all escaped |
| XSS — `dashboard.html` | ✅ | Fixed in deep audit |
| XSS — `agents.html` | ✅ | Fixed in deep audit |
| XSS — `agent.html` | ✅ | Uses textContent throughout; onerror handler hardened |
| XSS — `index.html` | ✅ | CSP added; esc() added; renderCards() all DB values escaped |
| XSS — `for-agents.html` | ✅ | CSP added; esc() added; initial in innerHTML escaped |
| SSRF — `resolve-map-url` | ✅ | URL allowlist enforced (maps.app.goo.gl, goo.gl only) |
| SSRF — `smart-listing-importer` | ✅ | image_urls restricted to *.supabase.co only |
| Auth — `generate-listing-content` | ✅ | Admin JWT verified via Supabase auth API |
| Auth — `smart-listing-importer` | ✅ | Admin JWT verified via Supabase auth API |
| Open registration | ✅ | Signup mode removed from agent-login.html |
| CSP — `listings.html` | ✅ | Present |
| CSP — `listing.html` | ✅ | Present |
| CSP — `admin.html` | ✅ | Present |
| CSP — `dashboard.html` | ✅ | Added in deep audit |
| CSP — `agents.html` | ✅ | Added in deep audit |
| CSP — `agent.html` | ✅ | Added in deep audit |
| CSP — `agent-login.html` | ✅ | Added in deep audit |
| CSP — `index.html` | ✅ | Added in verification pass |
| CSP — `for-agents.html` | ✅ | Added in verification pass |
| Agent data isolation | ✅ | Properties RLS scoped: agents read/delete own rows only |
| `reset_weekly_views()` privilege | ✅ | Admin-only guard added inside function |
| Storage — `property-images` | ✅ | Extension check; admin-only write; public read |
| Storage — `agent-photos` | ✅ | Extension check added; admin-only write; public read |
| Supabase anon key | ✅ | Publishable key; gated by RLS; service_role not in client |
| Gemini API key | ✅ | Edge Function secret only; never in browser |
| CORS | ⚠ | All edge functions return `*`; acceptable for public functions |

---

## Vulnerability Details

### CRITICAL-1: SSRF in `resolve-map-url` Edge Function
- **Severity**: Critical
- **Root cause**: Function fetched any URL from the request body with no allowlist.
- **Fix**: Added `ALLOWED_HOSTS = ['maps.app.goo.gl', 'goo.gl', 'maps.google.com']` check. Non-matching hostnames return HTTP 403.
- **File**: `supabase/functions/resolve-map-url/index.ts`

### CRITICAL-2: `agents` Table RLS Not Enabled
- **Severity**: Critical
- **Root cause**: `20260623000000_agents_rls.sql` created four policies but never called `ALTER TABLE agents ENABLE ROW LEVEL SECURITY`. Without ENABLE, all policies are silently ignored.
- **Fix**: `20260625000003_agents_rls_enable.sql` — calls ENABLE RLS and tightens INSERT/UPDATE to `admin@pintag.io` only.
- **File**: `supabase/migrations/20260625000003_agents_rls_enable.sql`

### CRITICAL-3: Open Self-Registration in Agent Portal
- **Severity**: Critical
- **Root cause**: `agent-login.html` had a "Create account instead" toggle that called `supabaseClient.auth.signUp()`. Any visitor could create an `authenticated` Supabase user.
- **Fix**: Signup UI and code removed. Login-only.
- **File**: `agent-login.html`

### HIGH-1: Agent Data Isolation Broken in `properties` RLS
- **Severity**: High
- **Root cause**: Migration `20260625000001` granted all `authenticated` users `USING (true) WITH CHECK (true)` — any agent could read, update, or delete every listing.
- **Fix**: `20260625000004_properties_rls_agent_scope.sql` — admin gets full access; agents get SELECT + DELETE scoped to `agent_id = auth.uid()` only.
- **File**: `supabase/migrations/20260625000004_properties_rls_agent_scope.sql`

### HIGH-2: `reset_weekly_views()` Callable by Any Agent
- **Severity**: High
- **Root cause**: SECURITY DEFINER function was GRANTED to `authenticated` with no caller check.
- **Fix**: Added `IF auth.email() != 'admin@pintag.io' THEN RAISE EXCEPTION` guard.
- **File**: `supabase/migrations/20260625000005_reset_weekly_views_admin_only.sql`

### HIGH-3: Stored XSS in `dashboard.html`
- **Severity**: High
- **Fix**: Added `esc()`. All DB-sourced values escaped before innerHTML insertion.
- **File**: `dashboard.html`

### HIGH-4: Stored XSS in `agents.html`
- **Severity**: High
- **Fix**: Added `esc()`. All DB values escaped before innerHTML use.
- **File**: `agents.html`

### HIGH-5: `agents` INSERT/UPDATE Policies Allowed Any Authenticated User
- **Severity**: High
- **Fix**: Policies updated to `WITH CHECK (auth.email() = 'admin@pintag.io')`.
- **File**: `supabase/migrations/20260625000003_agents_rls_enable.sql`

### HIGH-6: SSRF in `smart-listing-importer` via `image_urls`
- **Severity**: High
- **Root cause**: `urlToBase64()` fetched any URL from the request body's `image_urls` array with no domain restriction. An attacker with the anon key could use this to probe internal metadata endpoints or cloud IMDS services.
- **Fix**: Added `ALLOWED_IMAGE_HOSTS = /^[a-z0-9-]+\.supabase\.co$/i` check before each `fetch()`. Non-matching hostnames are skipped (return null).
- **File**: `supabase/functions/smart-listing-importer/index.ts`

### HIGH-7: Stored XSS in `index.html`
- **Severity**: High
- **Root cause**: `renderCards()` built `grid.innerHTML` by concatenating `p.images[0]`, `p.price_display`, `p.district_en/lo`, `p.agent_name`, and `p.agent_photo` without escaping.
- **Fix**: Added `esc()`. All DB values escaped before innerHTML.
- **File**: `index.html`

### HIGH-8: Storage Bucket Policies Allowed Any Authenticated User
- **Severity**: High
- **Root cause**: Storage policies for `property-images` (INSERT/UPDATE/DELETE) and `agent-photos` (INSERT/UPDATE/DELETE) used `TO authenticated` with no `auth.email()` check. Any logged-in agent could upload, overwrite, or delete any file in either bucket. `agent-photos` also had no file-extension check.
- **Fix**: `20260625000006_storage_admin_only.sql` — all write policies now require `auth.email() = 'admin@pintag.io'`. Extension check added to agent-photos INSERT.
- **File**: `supabase/migrations/20260625000006_storage_admin_only.sql`

### MEDIUM-1: Missing CSP on Agent/Dashboard Pages
- **Severity**: Medium
- **Fix**: CSP `<meta>` tags added to `dashboard.html`, `agents.html`, `agent.html`, `agent-login.html`.

### MEDIUM-2: Missing CSP on `index.html` and `for-agents.html`
- **Severity**: Medium
- **Fix**: CSP `<meta>` tags added in verification pass.

### MEDIUM-3: `generate-listing-content` and `smart-listing-importer` Callable Without Auth
- **Severity**: Medium
- **Root cause**: Both edge functions accepted requests from any caller with the public anon key. Since each call triggers Gemini API invocations (maxOutputTokens 1500–4000), an attacker could exhaust the Gemini API quota or cause significant API cost.
- **Fix**: Both functions now call `requireAdmin()` before processing: extracts the Bearer token, verifies it via `/auth/v1/user`, and rejects non-admin callers with HTTP 401.
- **Files**: `supabase/functions/generate-listing-content/index.ts`, `supabase/functions/smart-listing-importer/index.ts`

### MEDIUM-4: Stored XSS in `admin.html`
- **Severity**: Medium (admin-only page reduces exploitability)
- **Root cause**: `renderCustomTags`, `addNearby`, `buildAgentOptions`, analytics tables, and `loadListings` table all used unescaped DB values in innerHTML.
- **Fix**: Added `esc()`. All DB-sourced values escaped.
- **File**: `admin.html`

### MEDIUM-5: Stored XSS in `listings.html`
- **Severity**: Medium
- **Root cause**: `getAgentHtml()`, `showMapPreview()`, `renderListings()`, and `getActivityLine()` used unescaped `agent_name`, `agent_photo`, `images[0]`, `price_display`, `title`, and `district` values in innerHTML.
- **Fix**: Added `esc()`. All DB values escaped.
- **File**: `listings.html`

### LOW-1: Minor XSS in `for-agents.html`
- **Severity**: Low (single char from agent name, attacker would need a stored malicious agent record)
- **Root cause**: `initial = (a.name_en||'A').charAt(0).toUpperCase()` used unescaped in `port.innerHTML`.
- **Fix**: `esc()` applied to `initial`.
- **File**: `for-agents.html`

---

## 1. Row Level Security (RLS)

### properties

RLS enabled via `20260625000001_properties_rls.sql` + scoped via `20260625000004`.

| Role                  | SELECT                               | INSERT/UPDATE/DELETE |
|-----------------------|--------------------------------------|----------------------|
| `anon`                | `status IN ('active','available')` only | Denied |
| `authenticated (admin)`| All rows                            | Allowed |
| `authenticated (agent)`| Own rows (`agent_id = auth.uid()`) | SELECT + DELETE own only |

### agents

RLS enabled via `20260625000003_agents_rls_enable.sql`.

| Role            | SELECT       | INSERT/UPDATE |
|-----------------|--------------|---------------|
| `anon`          | All rows     | Denied |
| `authenticated (admin)` | All rows | Allowed |
| `authenticated (agent)` | All rows | Denied |

### lead_events

RLS enabled. Policies in `20260623000001_lead_events.sql` + `20260625000002_security_hardening.sql`:
- `anon`: INSERT only — restricted to active listings + 30-second rate limit per listing+event_type
- `authenticated (admin@pintag.io)`: Full access
- `authenticated (agent)`: SELECT own leads (`agent_id = auth.uid()`)

### listing_events

RLS enabled. Policy in `20260625000002_security_hardening.sql`:
- `anon`: INSERT — restricted to active listings + 30-minute dedup per session+event+property
- No SELECT policy (data is low-sensitivity anonymous analytics)

---

## 2. API Keys

### Supabase anon key

The `SUPABASE_ANON` / `KEY` constant is present in all client pages. This is intentional:
Supabase's anon key is a **publishable key** gated by RLS policies.

The `service_role` key is **not present** in any client-side file. It is used only
inside Supabase Edge Functions via `Deno.env`.

### Gemini API key

Stored exclusively as a Supabase Edge Function secret (`GEMINI_API_KEY`). Never
exposed to the browser.

---

## 3. XSS Protections

All database-sourced values are HTML-escaped through `esc()` before insertion into
`innerHTML`. The function is defined identically in all pages that use innerHTML:

```javascript
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
```

Pages using DOM APIs (`textContent`, `createElement`/`appendChild`) are inherently safe.

---

## 4. Content Security Policy

A CSP `<meta>` tag is present in all main pages:

| Page              | Notable allowances |
|-------------------|--------------------|
| `listings.html`   | Leaflet from unpkg; no frame-src |
| `admin.html`      | Supabase JS from cdn.jsdelivr.net; Gemini API connect-src |
| `listing.html`    | Google Maps + YouTube frame-src; no external scripts |
| `dashboard.html`  | Supabase JS from cdn.jsdelivr.net |
| `agents.html`     | No third-party scripts |
| `agent.html`      | No third-party scripts |
| `agent-login.html`| Supabase JS from cdn.jsdelivr.net |
| `index.html`      | No third-party scripts |
| `for-agents.html` | No third-party scripts |

All pages: `object-src 'none'`. No `unsafe-eval`. `unsafe-inline` is required while
scripts live in `<script>` blocks.

---

## 5. CORS

All three Edge Functions return `Access-Control-Allow-Origin: *`. This is standard
for Supabase public functions. The actual API calls require the `apikey` header.

---

## 6. Storage Bucket Policies

### `property-images`

- `admin@pintag.io`: INSERT (extension check: jpg/jpeg/png/webp/gif only), UPDATE, DELETE
- `anon`: SELECT (public CDN read)

### `agent-photos`

- `admin@pintag.io`: INSERT (extension check: jpg/jpeg/png/webp/gif), UPDATE, DELETE
- `anon`: SELECT

**Note:** Neither bucket enforces file size limits at the policy layer. Set max 50 MB
in Supabase Dashboard → Storage → bucket settings.

**Note on MIME validation**: `storage.extension(name)` checks the filename extension only,
not actual file content. A file named `malware.js` saved as `malware.jpg` would pass the
extension check. True MIME validation requires Supabase platform-level configuration
(Content-Type inspection) which cannot be enforced via SQL policies. Impact is low since
the admin is a single trusted user and the bucket is public read (not execute).

---

## 7. Rate Limiting

### lead_events (contact events)

Rate limit via `check_lead_rate_limit()` (SECURITY DEFINER):
- Rejects same `listing_id + event_type` within 30 seconds.

### listing_events (view events)

Rate limit via inline RLS `NOT EXISTS` check:
- Rejects same `session_id + property_id + event_type` within 30 minutes.

---

## 8. Could Not Be Verified From Repository

| Item | Why | What to check |
|------|-----|---------------|
| Storage MIME type validation | `storage.extension()` checks filename only; actual content-type validation is a Supabase platform feature | Supabase Dashboard → Storage → bucket settings → allowed MIME types |
| Storage file size limits | Not enforceable in SQL policies | Supabase Dashboard → Storage → bucket settings → max file size |
| Supabase Auth brute-force protection | Built-in to Supabase Auth; not configurable via SQL or JS | Supabase Dashboard → Authentication → Rate Limits |
| HSTS / security response headers | Must be set at CDN/hosting layer | CDN/host config (Vercel, Netlify, Cloudflare, etc.) |
| `service_role` key not deployed | Verified absent from committed files, but cannot verify runtime environment | `git grep service_role` + check Supabase Dashboard → Settings → API |

---

## 9. Known Remaining Risks

| Risk | Severity | Status |
|------|----------|--------|
| `unsafe-inline` in CSP | Medium | Accepted; requires JS refactor to eliminate |
| Storage file size not capped in policy | Low | Configure in Supabase Dashboard |
| Storage MIME type bypass (extension check only) | Low | Accepted; admin-only write access limits impact |
| `listing_events.session_id` is client-provided | Low | Accepted |
| No HSTS / security response headers | Low | Enforce at CDN/host layer |
| Prompt injection in `generate-listing-content` / `smart-listing-importer` | Low | Human review before publish; no server-side impact |
| No per-IP rate limiting on `agent-login.html` | Low | Rely on Supabase Auth built-in brute-force protection |
| `listing_events` has no SELECT policy | Low | Data is low-sensitivity anonymous analytics; accepted |

---

## Deployment Checklist

When deploying to a new environment:

1. Run all migrations in `supabase/migrations/` in chronological order.
2. Verify `properties` and `agents` RLS is active in Dashboard → Authentication → Policies.
3. Create `property-images` and `agent-photos` buckets (Public) before running storage policies.
4. Set `GEMINI_API_KEY` in Edge Function secrets.
5. Confirm `service_role` key is never in any committed file (`git grep service_role`).
6. Set file size limit (50 MB max) on both storage buckets in Dashboard → Storage.
7. Confirm HTTPS is enforced by the CDN/host.
8. Deploy all three Edge Functions: `supabase functions deploy generate-listing-content smart-listing-importer resolve-map-url`.
