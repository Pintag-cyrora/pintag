// Pintag Image CDN Worker (P1).
//
//   browser  ->  img.pintag.io  ->  THIS Worker  ->  Cloudflare cache
//                                              ->  Supabase property-images (on cache MISS only)
//
// Purpose: serve PUBLIC property images through Cloudflare's free cache so
// repeat views are served from the edge instead of Supabase egress. The DB
// image URLs are unchanged; the frontend (ptCdnImage, components.js) only
// rewrites the delivery host at render time.
//
// This is NOT an open proxy. Hard guarantees:
//   * The origin is a FIXED constant (SUPABASE_ORIGIN) — the request can never
//     choose an arbitrary origin.
//   * Only the public property-images path is allowed; every other path
//     (agent-photos, /rest/v1, /auth, authenticated storage, arbitrary URLs,
//     path traversal) returns 404.
//   * No credentials are used or exposed (the bucket is already public).
//   * Only GET/HEAD are served.
//   * Successful image responses are cached for 1 year; the query string is
//     dropped from the cache key (public property images carry no meaningful
//     query today), so a stray "?x=1" can't create duplicate cache entries.
//   * Bytes and Content-Type are passed through unchanged.
//
// Free-plan note: Workers Free allows ~100,000 requests/day, and this Worker
// runs on EVERY image request (cache HIT and MISS alike). The `x-pintag-cache`
// response header (HIT/MISS) plus Cloudflare's Workers analytics let you watch
// daily volume. See cloudflare-worker/IMAGE_CDN.md for the monitoring runbook
// and what to do near the limit (flip window.PINTAG.imageCdn = false to send
// images straight to Supabase again — no broken images, at the cost of egress).

const SUPABASE_ORIGIN = 'https://eoladhcljbpbhnrmmpev.supabase.co'; // FIXED: production project only
const ALLOWED_PREFIX  = '/storage/v1/object/public/property-images/';
const ONE_YEAR        = 31536000;

export default {
  async fetch(request, _env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Allowlist: only the public property-images path, no traversal. Everything
    // else — agent-photos, /rest/v1, /auth, authenticated storage, anything —
    // is 404. This is what prevents open-proxy / cross-bucket access.
    if (!path.startsWith(ALLOWED_PREFIX) || path.includes('..') || path.includes('%2e%2e')) {
      return new Response('Not Found', { status: 404 });
    }

    // Fixed origin + path ONLY (query dropped => stable cache key).
    const originUrl = SUPABASE_ORIGIN + path;
    const cacheKey  = new Request(originUrl, { method: 'GET' });
    const cache     = caches.default;

    // Cache HIT — served entirely by Cloudflare, zero Supabase egress.
    let cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set('x-pintag-cache', 'HIT');
      return hit;
    }

    // Cache MISS — fetch the fixed Supabase origin once.
    let originResp;
    try {
      originResp = await fetch(originUrl, { method: 'GET' });
    } catch (_e) {
      return new Response('Upstream fetch failed', { status: 502 });
    }
    if (!originResp.ok) {
      // Surface 404 as 404; anything else as 502. Errors are NOT cached long.
      return new Response(originResp.status === 404 ? 'Not Found' : 'Upstream error',
        { status: originResp.status === 404 ? 404 : 502 });
    }

    // Pass bytes + Content-Type through unchanged; set long immutable cache;
    // strip any cookies (never propagate credentials).
    const resp = new Response(originResp.body, originResp);
    resp.headers.set('Cache-Control', `public, max-age=${ONE_YEAR}, immutable`);
    resp.headers.set('x-pintag-cache', 'MISS');
    resp.headers.delete('set-cookie');
    resp.headers.delete('x-upsert');

    // Store in the edge cache for subsequent HITs (don't block the response).
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
