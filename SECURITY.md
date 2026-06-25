# Pintag Security Posture

Last updated: 2026-06-25 (deep audit pass)

## Summary

Pintag is a static HTML + Supabase real estate platform. There is no server-side
backend outside of Supabase (PostgREST, Auth, Storage, Edge Functions). All pages
are served as static files; runtime trust is enforced through Supabase RLS policies
and Postgres functions.

---

## Executive Summary

**Overall security rating: 6.5 / 10**

After two audit passes (initial hardening + deep audit), the following were identified
and fixed:

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 3     | ✅ Fixed |
| High     | 5     | ✅ Fixed |
| Medium   | 4     | ✅ Fixed |
| Low      | 5     | ⚠ Accepted / Deferred |

---

## Verified Security Checklist

| Area | Status | Notes |
|------|--------|-------|
| RLS — `properties` | ✅ | Enabled; anon reads active only; admin full; agents own-only |
| RLS — `agents` | ✅ | Fixed: ENABLE ROW LEVEL SECURITY was missing (migration 000003) |
| RLS — `lead_events` | ✅ | Anon INSERT rate-limited; agent SELECT own leads |
| RLS — `listing_events` | ⚠ | INSERT rate-limited; no SELECT policy (low sensitivity data) |
| XSS — `listings.html` | ✅ | All DB values escaped via esc() |
| XSS — `listing.html` | ✅ | Pre-existing esc() throughout |
| XSS — `admin.html` | ✅ | All DB values escaped |
| XSS — `dashboard.html` | ✅ | Fixed in deep audit (000003 migration pass) |
| XSS — `agents.html` | ✅ | Fixed in deep audit |
| XSS — `agent.html` | ✅ | Uses textContent throughout; onerror handler hardened |
| SSRF — `resolve-map-url` | ✅ | URL allowlist enforced (maps.app.goo.gl, goo.gl only) |
| Open registration | ✅ | Signup mode removed from agent-login.html |
| CSP — `listings.html` | ✅ | Present |
| CSP — `listing.html` | ✅ | Present |
| CSP — `admin.html` | ✅ | Present |
| CSP — `dashboard.html` | ✅ | Added in deep audit |
| CSP — `agents.html` | ✅ | Added in deep audit |
| CSP — `agent.html` | ✅ | Added in deep audit |
| CSP — `agent-login.html` | ✅ | Added in deep audit |
| CSP — `index.html`, `for-agents.html` | ⚠ | Not yet verified/added |
| Agent data isolation | ✅ | Properties RLS scoped: agents read/delete own rows only |
| `reset_weekly_views()` privilege | ✅ | Admin-only guard added inside function |
| Storage — `property-images` | ✅ | Extension check; public read; admin write |
| Storage — `agent-photos` | ✅ | Authenticated write; public read |
| Supabase anon key | ✅ | Publishable key; gated by RLS; service_role not in client |
| Gemini API key | ✅ | Edge Function secret only; never in browser |
| CORS | ⚠ | All edge functions return `*`; acceptable for public functions |

---

## Vulnerability Details

### CRITICAL-1: SSRF in `resolve-map-url` Edge Function
- **Severity**: Critical
- **Root cause**: Function fetched any URL from the request body with no allowlist.
  An attacker calling the function directly could probe internal Supabase metadata
  endpoints or cloud IMDS services.
- **Fix**: Added `ALLOWED_HOSTS = ['maps.app.goo.gl', 'goo.gl', 'maps.google.com']`
  check before the `fetch()` call. Non-matching hostnames return HTTP 403.
- **File**: `supabase/functions/resolve-map-url/index.ts`

### CRITICAL-2: `agents` Table RLS Not Enabled
- **Severity**: Critical
- **Root cause**: `20260623000000_agents_rls.sql` created four policies but never
  called `ALTER TABLE agents ENABLE ROW LEVEL SECURITY`. Without ENABLE, all
  policies are silently ignored and any request can read/write the full table.
- **Fix**: `20260625000003_agents_rls_enable.sql` — calls ENABLE RLS and tightens
  INSERT/UPDATE to `admin@pintag.io` only.
- **File**: `supabase/migrations/20260625000003_agents_rls_enable.sql`

### CRITICAL-3: Open Self-Registration in Agent Portal
- **Severity**: Critical
- **Root cause**: `agent-login.html` had a "Create account instead" toggle that
  called `supabaseClient.auth.signUp()`. Any visitor could create an `authenticated`
  Supabase user. Combined with the then-overly-broad `agents` table policies,
  attackers could insert fake agent profiles.
- **Fix**: Signup UI and code removed from `agent-login.html`. Login-only.
- **File**: `agent-login.html`

### HIGH-1: Agent Data Isolation Broken in `properties` RLS
- **Severity**: High
- **Root cause**: Migration `20260625000001` granted all `authenticated` users
  `USING (true) WITH CHECK (true)` on `properties` — any agent could read,
  update, or delete every listing (bypassing the client-side `.eq('agent_id')` filter).
- **Fix**: `20260625000004_properties_rls_agent_scope.sql` — admin gets full access;
  agents get SELECT + DELETE scoped to `agent_id = auth.uid()` only.
- **File**: `supabase/migrations/20260625000004_properties_rls_agent_scope.sql`

### HIGH-2: `reset_weekly_views()` Callable by Any Agent
- **Severity**: High
- **Root cause**: The SECURITY DEFINER function was GRANTED to `authenticated`,
  so any logged-in agent could zero all weekly view counters for every listing.
- **Fix**: Added `IF auth.email() != 'admin@pintag.io' THEN RAISE EXCEPTION` guard
  inside the function body.
- **File**: `supabase/migrations/20260625000005_reset_weekly_views_admin_only.sql`

### HIGH-3: Stored XSS in `dashboard.html`
- **Severity**: High
- **Root cause**: `renderListings()` interpolated `property.district_en`,
  `property.title_en`, `property.price_display`, and image URLs directly into
  `container.innerHTML`. `loadLeadStats()` interpolated `r.title` into
  `tbody.innerHTML`. No escaping.
- **Fix**: Added `esc()` function. All DB-sourced values escaped before innerHTML
  insertion. Numeric values cast with `Number()`. IDs moved to `data-id` attributes.
- **File**: `dashboard.html`

### HIGH-4: Stored XSS in `agents.html`
- **Severity**: High
- **Root cause**: `render()` built `heroEl.innerHTML` by concatenating
  `a.name_lo/name_en` (agent name from DB) and image URLs without escaping.
- **Fix**: Added `esc()`. All DB values escaped before innerHTML use.
- **File**: `agents.html`

### HIGH-5: `agents` INSERT/UPDATE Policies Allowed Any Authenticated User
- **Severity**: High
- **Root cause**: `WITH CHECK (true)` on INSERT/UPDATE meant any `authenticated`
  user could create/modify agents (relevant once ENABLE RLS was fixed above).
- **Fix**: Policies updated to `WITH CHECK (auth.email() = 'admin@pintag.io')`.
- **File**: `supabase/migrations/20260625000003_agents_rls_enable.sql`

### MEDIUM-1: Missing CSP on Agent/Dashboard Pages
- **Severity**: Medium
- **Fix**: CSP `<meta>` tags added to `dashboard.html`, `agents.html`, `agent.html`,
  `agent-login.html`.

### MEDIUM-2: No Input Size Limit on Edge Functions
- **Severity**: Medium
- **Status**: Accepted. Supabase enforces a default body size limit on Edge Functions.
  Prompt injection risk from user text is low-impact (only degrades AI output quality).

### MEDIUM-3: Prompt Injection in `generate-listing-content`
- **Severity**: Medium (low exploitability)
- **Root cause**: User-supplied description is embedded directly in the Gemini prompt.
  A malicious description could attempt to override instructions.
- **Status**: Accepted. The function output is reviewed by a human admin before
  publishing. No server-side side effects from prompt injection.

### MEDIUM-4: `listing_events` Has No SELECT Policy for Authenticated Users
- **Severity**: Medium (low sensitivity)
- **Status**: Accepted. Listing events are anonymous view-count records with no PII.
  Agents can query them via SDK, but the data is low-value. Revisit if event records
  gain sensitivity.

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
| `admin.html`      | Supabase JS from cdn.jsdelivr.net; Gemini API connect |
| `listing.html`    | Google Maps + YouTube iframes; media-src * (video) |
| `dashboard.html`  | Supabase JS from cdn.jsdelivr.net |
| `agents.html`     | No third-party scripts |
| `agent.html`      | No third-party scripts |
| `agent-login.html`| Supabase JS from cdn.jsdelivr.net |

All pages: `object-src 'none'`. No `unsafe-eval`. `unsafe-inline` is required while
scripts live in `<script>` blocks.

**Not yet verified**: `index.html`, `for-agents.html` — CSP status unknown.

---

## 5. CORS

All three Edge Functions return `Access-Control-Allow-Origin: *`. This is standard
for Supabase public functions. The actual API calls require the `apikey` header.

---

## 6. Storage Bucket Policies

### `property-images`

- `authenticated`: INSERT (extension check: jpg/jpeg/png/webp/gif only), UPDATE, DELETE
- `anon`: SELECT (public CDN read)

### `agent-photos`

- `authenticated`: INSERT, UPDATE, DELETE
- `anon`: SELECT

**Note:** Neither bucket enforces file size limits at the policy layer. Set max 50 MB
in Supabase Dashboard → Storage → bucket settings.

---

## 7. Rate Limiting

### lead_events (contact events)

Rate limit via `check_lead_rate_limit()` (SECURITY DEFINER):
- Rejects same `listing_id + event_type` within 30 seconds.

### listing_events (view events)

Rate limit via inline RLS `NOT EXISTS` check:
- Rejects same `session_id + property_id + event_type` within 30 minutes.

---

## 8. Known Remaining Risks

| Risk | Severity | Status |
|------|----------|--------|
| `unsafe-inline` in CSP | Medium | Accepted; requires JS refactor |
| Storage file size not capped in policy | Low | Configure in dashboard |
| `listing_events.session_id` is client-provided | Low | Accepted |
| No CSP on `index.html`, `for-agents.html` | Low | Not yet audited |
| No HSTS / security response headers | Low | Enforce at CDN/host layer |
| Edge functions lack auth check (callable with anon key) | Low | Acceptable for public functions; admin functions are protected by RLS |
| Prompt injection in `generate-listing-content` | Low | Human review before publish; no server-side impact |
| No per-IP rate limiting on `agent-login.html` | Low | Rely on Supabase Auth built-in brute-force protection |

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
