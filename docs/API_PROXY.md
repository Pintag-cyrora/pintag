# api.pintag.io — the Cloudflare API proxy

Puts the Supabase origin behind a hostname inside the `pintag.io` Cloudflare
zone, so edge rate limiting and the WAF can see Pintag's API traffic at all.

**Status: prepared, NOT cut over.** The Worker, the config abstraction, the CSP
entry and the tests are all in the repository. `window.PINTAG.supabaseUrl` still
points at `https://eoladhcljbpbhnrmmpev.supabase.co`. Flipping it is a separate,
deliberate one-line change — see [Cutover](#cutover).

---

## Why this exists

Every rule in [RATE_LIMITING.md](RATE_LIMITING.md) matches on `/rest/v1/…`,
`/auth/v1/…` and `/functions/v1/…` paths. Pintag's browser traffic goes directly
to `*.supabase.co`, which is **not** in the `pintag.io` zone — so until that
traffic passes through the zone, those five rules match nothing whatsoever.
This is "setup (a)" from that document.

## Architecture, in plain English

```
  Browser (pintag.io)
        │
        │  https://api.pintag.io/rest/v1/…  /auth/v1/…  /functions/v1/…  /storage/v1/…
        ▼
  Cloudflare edge  ──  WAF + the five rate-limiting rules run HERE, first
        │
        ▼
  pintag-api-proxy Worker   ── fixed origin, closed path allowlist, no caching
        │
        │  https://eoladhcljbpbhnrmmpev.supabase.co/…  (Host + SNI correct by construction)
        ▼
  Supabase  ──  RLS is still the security boundary. The Worker authorizes nothing.
```

Two things deliberately do **not** follow that path:

- **Public property images.** They keep being delivered by `img.pintag.io`
  (`image-cdn-worker.js`), which fetches Supabase directly. Chaining it through
  the API proxy would make every image a Worker-to-Worker hop and double the
  Free-plan request count for no benefit.
- **Server-side Supabase access.** Edge Functions resolve their own project from
  `Deno.env.get('SUPABASE_URL')`. Server-to-server traffic must never egress
  through Cloudflare.

### The two-origin split

The single most important idea here, because getting it wrong fails silently:

| Value | Meaning | Moves at cutover? |
|---|---|---|
| `window.PINTAG.supabaseUrl` | **API delivery** host — where the browser sends requests | **Yes** → `https://api.pintag.io` |
| `window.PINTAG.storagePublicOrigin` | **Stored data** — the host baked into public image URLs in `properties.images` | **No**, ever |
| `window.PINTAG.authStorageKey` | Session identity, pinned to the project ref | **No**, ever |

An uploaded image's public URL is *persisted in the database*, so its host is
part of a stored data format, not a delivery choice. If it followed
`supabaseUrl`, `properties.images` would split into two URL shapes and
`ptCdnImage()` would stop matching every row written before the cutover —
silently routing every existing listing photo around the image CDN and straight
at Supabase egress. No broken image, no error, just a bill.

Uploads still `POST` through `supabaseUrl` (and therefore through Cloudflare);
only the URL written to the database uses `storagePublicOrigin`.

### Why a Worker, not a proxied CNAME or an Origin Rule

A proxied DNS record sends `Host: api.pintag.io` and SNI `api.pintag.io` to the
origin. Supabase's edge has no certificate for that name and routes projects *by*
hostname, so the TLS handshake fails (Cloudflare error 526) before anything is
served. Fixing that needs a Host header override **and** an SNI override, and SNI
override is not available on every plan.

`fetch()` from inside a Worker is an ordinary outbound HTTPS request to the
Supabase origin, so Host and SNI are correct **by construction** — there is no
setting to misconfigure. `img.pintag.io` has already worked this way for months.

---

## Every reference to `eoladhcljbpbhnrmmpev.supabase.co`, classified

45 files, 112 occurrences. Only **browser API delivery** moves.

| Class | Where | Moves to `api.pintag.io`? |
|---|---|---|
| **Browser API delivery** | `config.prod.js` → `supabaseUrl` (read by all 14 `createClient()` calls and every raw `fetch`) | **Yes — at cutover.** The only value that moves. |
| **Storage / public URL** | `config.*.js` → `storagePublicOrigin`; the two persisted-URL sites in `admin.html`; `ptCdnImage()`/`ptCdnImageFallback()` in `components.js` | **No.** Stored data format. |
| **Image CDN** | `cloudflare-worker/image-cdn-worker.js`, `image-cdn.wrangler.toml` | **No.** Fetches Supabase directly. |
| **Server-side Edge Functions** | 6 × `supabase/functions/*/index.ts` via `Deno.env.get('SUPABASE_URL')` | **No.** Never egresses through Cloudflare. |
| **CSP policy** | `scripts/csp-policy.mjs` (+ 17 stamped pages, 4 occurrences each) | **Both listed.** Supabase origins stay for stored image URLs and rollback. |
| **Backup / DR** | `scripts/backup-production-assets.sh`, `backup-property-images.py`, `docs/BACKUP_AND_DISASTER_RECOVERY.md` | **No.** A backup must not depend on the proxy being up. |
| **Dev tooling** | `scripts/bootstrap-dev-db.sh`, `seed-dev-from-prod.sh`, `recover-photos-storage-matching.sql` | **No.** Operator tooling, direct. |
| **Tests** | `image-cdn.test.js`, `tests/security/*`, `tests/agent-visibility/*`, `tests/smart-import-vision/*` | **No**, except where they assert the split. |
| **OG preview Worker** | `cloudflare-worker/og-listing-preview.js` | **No.** Server-side render, direct. |
| **Documentation** | `RECOVERY_RUNBOOK.md`, `docs/AUTH_URL_CONFIGURATION.md`, audit reports, `PREVIEW.md`, … | **No.** Historical/operational records. |

Supabase **Auth URL configuration** (Site URL, Redirect URLs) is also unchanged:
`resetRedirectUrl()` derives the redirect from `window.location.href`, which is
`pintag.io` — the API host never appears in it.

---

## Deployment

### 1. DNS record (Cloudflare dashboard — phone-friendly)

*DNS → Records → Add record*

| Field | Value |
|---|---|
| Type | `AAAA` |
| Name | `api` |
| IPv6 address | `100::` |
| Proxy status | **Proxied** (orange cloud) |
| TTL | Auto |

`100::` is the IPv6 discard prefix. The Worker route intercepts the request
before the address is ever used, so this is the standard Cloudflare
"Worker-only hostname" pattern — and if the Worker is ever unbound, the hostname
is inert rather than pointing somewhere real.

### 2. Deploy the Worker

```bash
cd cloudflare-worker
wrangler deploy -c api-proxy.wrangler.toml
```

Deliberately **not** wired into CI, matching the image CDN Worker. A Worker in
front of every API call the site makes should not deploy on a push.

### 3. Verify independently, before touching production config

```bash
# Allowed path reaches Supabase (401 is a valid answer — it proves reachability)
curl -sS -o /dev/null -w '%{http_code}\n' https://api.pintag.io/auth/v1/health

# REST answers through the proxy
curl -sS -D- -o /dev/null "https://api.pintag.io/rest/v1/properties?select=id&limit=1" \
  -H "apikey: $PINTAG_ANON_KEY"

# The allowlist holds: everything outside the five prefixes is 404
for p in / /admin /.env /rest/v2/properties; do
  printf '%s -> ' "$p"; curl -sS -o /dev/null -w '%{http_code}\n' "https://api.pintag.io$p"
done

# Traversal is refused
curl -sS -o /dev/null -w '%{http_code}\n' 'https://api.pintag.io/rest/v1/../../etc/passwd'

# CORS preflight is forwarded and answered by Supabase
curl -sS -X OPTIONS -D- -o /dev/null https://api.pintag.io/rest/v1/lead_events \
  -H 'Origin: https://pintag.io' -H 'Access-Control-Request-Method: POST'
```

Expect `200`/`401` on the first two, `404` on every allowlist probe and on
traversal, and `access-control-allow-origin` present on the preflight.

---

## Cutover

Only after steps 1–3 above pass.

```diff
--- a/config.prod.js
-  supabaseUrl: 'https://eoladhcljbpbhnrmmpev.supabase.co',
+  supabaseUrl: 'https://api.pintag.io',
```

Update the matching assertion in `supabase-origins.test.js`
(`production supabaseUrl has NOT been flipped yet`) in the **same commit** — it
exists so this flip cannot happen as an unnoticed side effect of another change.

Nothing else changes. `storagePublicOrigin` and `authStorageKey` stay put; the
CSP already permits both hosts.

### Post-cutover smoke test

1. Admin sign-in **including TOTP** — proves `/auth/v1/` and that the session
   key survived (you should *not* be asked to re-enrol).
2. Save a listing — `/rest/v1/` writes.
3. Upload a photo, then reload the listing — `/storage/v1/` upload through the
   proxy, and the stored URL still rendering via `img.pintag.io`.
4. Open a public listing page — anonymous `/rest/v1/` reads.
5. Submit a lead (WhatsApp click) — anonymous writes.
6. Run Smart Import — `/functions/v1/`.

### Rollback

```diff
-  supabaseUrl: 'https://api.pintag.io',
+  supabaseUrl: 'https://eoladhcljbpbhnrmmpev.supabase.co',
```

Redeploy. Traffic returns to the direct origin immediately.

Rollback is complete and dependency-free **by design**: the CSP still lists both
hosts, `storagePublicOrigin` never moved so no image URL changed, and
`authStorageKey` never moved so sessions survive the rollback too. There is no
DNS change, no Worker teardown and no data migration in the rollback path — the
Worker and DNS record can be left in place indefinitely, serving nothing.

---

## Tests

| Suite | Covers |
|---|---|
| `cloudflare-worker/api-proxy-worker.test.js` | Allowlist, traversal, method/header/query/body preservation, Authorization+apikey untouched, OPTIONS forwarding, caching disabled, redirects passed through |
| `supabase-origins.test.js` | Every `createClient()` passes an explicit `storageKey`; key pinned to the project ref; the two-origin split; CSP contains the proxy AND both Supabase origins with no wildcard; image CDN and Edge Functions stay direct |
| `image-cdn.test.js` | Pre- and post-cutover `ptCdnImage()` behaviour, including that existing stored URLs are still rewritten and the fallback lands on the storage origin |
| `tests/csp/` | The stamped policy in a real browser |
