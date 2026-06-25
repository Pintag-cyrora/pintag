# Pintag Security Posture

Last updated: 2026-06-25

## Summary

Pintag is a static HTML + Supabase real estate platform. There is no server-side
backend outside of Supabase (PostgREST, Auth, Storage, Edge Functions). All pages
are served as static files; runtime trust is enforced through Supabase RLS policies
and Postgres functions.

---

## 1. Row Level Security (RLS)

### properties

RLS is enabled via `20260625000001_properties_rls.sql`.

| Role            | SELECT                       | INSERT/UPDATE/DELETE |
|-----------------|------------------------------|----------------------|
| `anon`          | `status IN ('active','available')` only | Denied |
| `authenticated` | All rows                     | Allowed (admin only) |

**Action required after deploy:** Open Supabase Dashboard → Authentication → Policies
and confirm the two policies appear under `properties`. If RLS was already enabled with
different policies, reconcile before going live.

### agents

RLS enabled. Policies in `20260623000000_agents_rls.sql`:
- `anon`: SELECT all rows (public agent profiles)
- `authenticated`: INSERT, UPDATE, SELECT all rows (admin manages agents)
- No DELETE policy (agents are soft-removed by disabling, not deleted)

### lead_events

RLS enabled. Policies in `20260623000001_lead_events.sql` + `20260625000002_security_hardening.sql`:
- `anon`: INSERT only — restricted to active listings + 30-second rate limit per listing+event_type
- `authenticated (admin@pintag.io)`: Full access
- `authenticated (agent)`: SELECT own leads (`agent_id = auth.uid()`)

### listing_events

RLS enabled. Policy in `20260625000002_security_hardening.sql`:
- `anon`: INSERT — restricted to active listings + 30-minute dedup per session+event+property

---

## 2. API Keys

### Supabase anon key

The `SUPABASE_ANON` constant is present in `listings.html`, `listing.html`, and
`admin.html`. This is intentional and expected: Supabase's anon key is a **publishable
key** gated by RLS policies. It grants no elevated access beyond what RLS allows.

The `service_role` key is **not present** in any client-side file. It is used only
inside Supabase Edge Functions via `Deno.env`.

### Gemini API key

Stored exclusively as a Supabase Edge Function secret (`GEMINI_API_KEY`). Never
exposed to the browser.

---

## 3. XSS Protections

All database-sourced values are HTML-escaped through `esc()` before insertion into
`innerHTML`. The function is defined identically in all three main pages:

```javascript
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
```

Pages audited and fixed (2026-06-25):
- `listings.html` — card titles, districts, prices, agent names, image URLs, map preview
- `admin.html` — listing table, analytics tables, agent dropdown, custom tag pills, nearby form inputs
- `listing.html` — already used `esc()` throughout `buildMockupLayout()`; similar card grid verified

`textContent` is used wherever the value is plain text and no HTML markup is needed
(titles on map preview, agent preview, activity lines).

---

## 4. Content Security Policy

A CSP `<meta>` tag is present in all three main pages. Policy summary:

| Page          | Notable allowances                                      |
|---------------|---------------------------------------------------------|
| `listings.html` | Leaflet from unpkg; no frame-src                      |
| `admin.html`  | Supabase JS from cdn.jsdelivr.net; Gemini API connect  |
| `listing.html` | Google Maps + YouTube iframes; media-src * (video)    |

All pages: `object-src 'none'`; no `unsafe-eval`. `unsafe-inline` is required while
scripts live in `<script>` blocks (not separate `.js` files). Moving scripts to
external files with nonces would allow removing `unsafe-inline` — deferred as a
future improvement.

---

## 5. CORS

All three Edge Functions return `Access-Control-Allow-Origin: *`. This is standard
for Supabase public functions. The actual API calls require the `apikey` header which
cross-origin pages cannot provide without being granted it, so this does not expose
sensitive data to third-party origins.

Functions that return sensitive data in the future should restrict CORS to
`https://pintag.io`.

---

## 6. Storage Bucket Policies

Two buckets are in use:

### `property-images`

Policies in `20260625000002_security_hardening.sql`:
- `authenticated`: INSERT (with file extension check: jpg/jpeg/png/webp/gif), UPDATE, DELETE
- `anon`: SELECT (public CDN read)
- File extension enforcement prevents non-image uploads.

### `agent-photos`

Policies in `20260622000001_agent_photos_storage.sql`:
- `authenticated`: INSERT, UPDATE, DELETE
- `anon`: SELECT

**Note:** Neither bucket enforces file size limits at the policy layer. Size limits
should be configured in Supabase Dashboard → Storage → bucket settings (max 50 MB
recommended). File-name collisions are mitigated by prepending a UUID or timestamp
in the upload code (`admin.html`).

---

## 7. Rate Limiting

### lead_events (contact events)

Rate limit implemented via `check_lead_rate_limit()` (SECURITY DEFINER function):
- Rejects any INSERT where the same `listing_id + event_type` was inserted within
  the last **30 seconds**.
- Also validates that `listing_id` belongs to an active or available listing.

### listing_events (view events)

Rate limit via inline RLS `NOT EXISTS` check:
- Rejects view events where the same `session_id + property_id + event_type` was
  recorded within the last **30 minutes**.
- `session_id` is client-provided; abuse is mitigated but not fully prevented.

### View count (`increment_listing_view`)

The `increment_listing_view()` Edge Function is called once per page load in
`listing.html`. There is no per-IP deduplication; bot/scraper views are not filtered.
This is acceptable for the current traffic level; revisit if view counts become a KPI.

---

## 8. Known Remaining Risks

| Risk | Severity | Status |
|------|----------|--------|
| `unsafe-inline` in CSP — reduces XSS containment | Medium | Accepted; requires JS refactor to resolve |
| Storage file size not capped in policy | Low | Configure in dashboard |
| `listing_events.session_id` is client-provided | Low | Accepted; used only for analytics dedup |
| `agents` write policy allows any authenticated user (not just admin email) | Low | No agent login portal exists; revisit if added |
| No HTTPS enforcement (static files) | Low | Enforced by host (verify in deployment config) |

---

## Deployment Checklist

When deploying to a new environment:

1. Run all migrations in `supabase/migrations/` in order.
2. Verify `properties` RLS is active in Dashboard → Authentication → Policies.
3. Create `property-images` and `agent-photos` buckets (Public) before running the storage policies.
4. Set `GEMINI_API_KEY` in Edge Function secrets.
5. Confirm `service_role` key is never in any committed file (`git grep service_role`).
