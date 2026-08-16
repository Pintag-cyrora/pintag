# Pintag Image CDN — Worker runbook (P1) + immutable cache (P2)

Serve public property images through Cloudflare's free cache so repeat views are
served from the edge instead of Supabase egress — to stay on the Supabase Free
plan. **Nothing here is deployed yet; deploy is a manual, reviewed step.**

```
browser → img.pintag.io → pintag-image-cdn Worker → Cloudflare cache
                                                  → Supabase property-images (cache MISS only)
```

The database image URLs never change. The frontend (`ptCdnImage()` in
`components.js`, gated by `window.PINTAG.imageCdn`) rewrites only the delivery
host at render time.

## Cloudflare / DNS configuration to apply (manual)

1. **DNS** (zone `pintag.io`): add `img` → **Proxied (orange cloud)**. Value can
   be a placeholder `A 192.0.2.1` (the Worker route intercepts before origin);
   the Worker fetches the fixed Supabase origin itself.
2. **Worker**: deploy `image-cdn-worker.js` as service `pintag-image-cdn` with
   route `img.pintag.io/*` (see `image-cdn.wrangler.toml`):
   `wrangler deploy -c image-cdn.wrangler.toml`.
3. Nothing else — no Cache Rule, Origin Rule, or Page Rule is required; the
   Worker does the allowlisting, origin selection, caching, and headers.

## Request-volume protection (Workers Free = ~100,000 requests/day)

**The Worker runs on every image request — cache HIT and MISS alike** — so daily
Worker requests ≈ daily property-image loads.

- **Monitor daily requests:** Cloudflare dashboard → Workers & Pages →
  `pintag-image-cdn` → Metrics (requests/day, errors, CPU).
- **Cache HIT/MISS:** every response carries `x-pintag-cache: HIT|MISS`
  (`curl -sI https://img.pintag.io/storage/v1/object/public/property-images/<file>`).
  At steady state the vast majority should be HIT; only MISSes reach Supabase.
- **% of image traffic through the Worker:** ≈ 100% of property-image loads once
  the frontend flag is on (agent photos and external images bypass it).
- **Estimated requests/day:** `≈ pageviews/day × avg property images loaded per
  page`. With `loading="lazy"`, grids load only on-screen covers. Example: 2,000
  pageviews/day × ~8 images ≈ 16,000 Worker req/day — well under 100k. You'd need
  ~12,000+ image-heavy pageviews/day to approach the limit.

### What happens at the 100k/day limit — and how we avoid silent failure
When the Free daily limit is exceeded, Cloudflare stops running the Worker and
returns **error 1027** for `img.pintag.io` → images would fail to load until the
daily reset. This must not be allowed to happen silently:

1. **Watch the metric** (above). If sustained daily requests approach ~70–80k,
   act before the limit.
2. **Instant mitigation — flip the flag:** set `window.PINTAG.imageCdn = false`
   in `config.js` and redeploy Pages (~2–3 min). The frontend immediately serves
   images from their **direct Supabase URLs** again — no broken images. The cost
   is that Supabase egress returns (the thing we were reducing), which is the
   correct trade at that traffic level (and a signal to revisit P3 smaller images
   or a paid tier decision).
3. **Optional resilience (not yet implemented):** an `<img onerror>` fallback that
   swaps a failed `img.pintag.io` src back to the Supabase URL, so a Worker
   outage degrades to direct-Supabase automatically. Adds per-image handlers;
   propose separately if you want belt-and-suspenders.

## Rollback

- **Instant, code-only:** `window.PINTAG.imageCdn = false` in `config.js` +
  Pages redeploy → images revert to direct Supabase URLs. No Cloudflare change,
  no DB change.
- **Full:** revert the `components.js` / `listing.html` / `listings.html` helper
  wiring, delete the `img` DNS record and the `pintag-image-cdn` Worker. No data
  touched.

## P2 — immutable cache headers

New property-image uploads now send `Cache-Control: public, max-age=31536000,
immutable` (safe: filenames are content-unique and never overwritten). Existing
objects are **not** modified — the Worker sets the same immutable header on
delivery for every image it serves, so all images (old and new) get the long
browser/edge cache without re-uploading a single byte.

## Security summary

- No new exposure: the property-images bucket is already public.
- Fixed origin constant; only the public property-images path is reachable via
  `img.pintag.io`; everything else 404s (no cross-bucket, no /rest, no /auth, no
  open proxy). No credentials used or exposed. GET/HEAD only. Cookies stripped.
