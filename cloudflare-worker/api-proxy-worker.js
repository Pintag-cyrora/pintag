// Pintag API Proxy Worker.
//
//   browser  ->  api.pintag.io  ->  Cloudflare WAF / rate limiting  ->  THIS Worker
//                                                                  ->  Supabase (fixed origin)
//
// WHY THIS EXISTS
// ---------------
// Pintag's browser traffic goes straight to *.supabase.co, which is NOT inside
// the pintag.io Cloudflare zone. Every rate-limiting rule in
// docs/RATE_LIMITING.md matches on /rest/v1/…, /auth/v1/… and /functions/v1/…
// paths, so until that traffic passes through the zone those rules match
// nothing at all. This Worker is "setup (a)" from that document: it puts the
// Supabase origin behind a Cloudflare hostname so Layer 1 can exist.
//
// Cloudflare's WAF and rate-limiting rules run at the edge BEFORE a Worker, on
// the inbound request to api.pintag.io — so the five documented rules apply
// unchanged, with their documented paths, without this file knowing anything
// about them.
//
// WHY A WORKER AND NOT A PROXIED CNAME / ORIGIN RULE
// --------------------------------------------------
// A proxied DNS record sends `Host: api.pintag.io` and SNI `api.pintag.io` to
// the origin. Supabase's edge has no certificate for that name and routes
// projects BY hostname, so the TLS handshake fails (Cloudflare error 526)
// before any request is served. Fixing it needs both a Host header override and
// an SNI override, and SNI override is not available on every plan.
//
// fetch() from inside a Worker is an ordinary outbound HTTPS request to
// SUPABASE_ORIGIN, so Host and SNI are correct BY CONSTRUCTION — there is no
// setting to misconfigure and the 526 failure class cannot occur. This mirrors
// image-cdn-worker.js, which already fronts img.pintag.io the same way.
//
// THIS IS NOT AN OPEN PROXY. Hard guarantees:
//   * The origin is a FIXED constant. The request can never choose it.
//   * Only the five Supabase API path prefixes below are served; every other
//     path — including "/" — is 404. An attacker cannot reach an arbitrary URL.
//   * Path traversal (".." in any encoding) is rejected before anything else.
//   * The Worker performs NO authentication of its own and never inspects,
//     rewrites, injects, or logs Authorization / apikey. Supabase remains the
//     sole authority on who may do what; RLS is still the security boundary.
//   * Caching is disabled outright, so an authenticated REST response can never
//     be stored at the edge and served to a different visitor.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   * No CORS synthesis. OPTIONS preflights are forwarded to Supabase, which
//     already answers them (every edge function sets
//     Access-Control-Allow-Origin: *). Answering them here would create a
//     second, drifting source of truth for CORS.
//   * No redirect following (`redirect: 'manual'`), so an auth flow's 3xx
//     reaches the browser as a 3xx instead of being silently resolved here.
//   * No body buffering. Request and response bodies are passed as streams so
//     a multi-megabyte Storage upload flows through without being held in
//     Worker memory.
//   * Nothing to do with img.pintag.io. image-cdn-worker.js keeps pointing
//     straight at Supabase — routing it through here would make every image a
//     Worker-to-Worker hop and double the Free-plan request count.

const SUPABASE_ORIGIN = 'https://eoladhcljbpbhnrmmpev.supabase.co'; // FIXED: production project only

// The complete Supabase browser API surface, and nothing else.
//   /rest/v1/      PostgREST (tables + RPC)
//   /auth/v1/      GoTrue (sign-in, token refresh, MFA, recovery)
//   /functions/v1/ Edge Functions
//   /storage/v1/   Storage (uploads and public objects)
//   /rpc/          bare RPC form, allowlisted for completeness
// Note /storage/v1/ is served here for UPLOADS. Public image DELIVERY continues
// to run through img.pintag.io, and the URLs persisted in the database keep the
// direct Supabase origin — see PINTAG.storagePublicOrigin in config.prod.js.
const ALLOWED_PREFIXES = [
  '/rest/v1/',
  '/auth/v1/',
  '/functions/v1/',
  '/storage/v1/',
  '/rpc/',
];

// Traversal is checked on the RAW path, before any normalization, and in the
// encoded forms a proxy might otherwise pass through untouched.
const TRAVERSAL = /\.\.|%2e%2e|%2E%2E|%252e|%c0%ae/i;

function isAllowedPath(pathname) {
  for (let i = 0; i < ALLOWED_PREFIXES.length; i++) {
    if (pathname.startsWith(ALLOWED_PREFIXES[i])) return true;
  }
  return false;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Reject traversal first: a rejected request must never reach the origin,
    // whatever prefix it claims.
    if (TRAVERSAL.test(url.pathname)) {
      return new Response('Not Found', { status: 404 });
    }
    if (!isAllowedPath(url.pathname)) {
      return new Response('Not Found', { status: 404 });
    }

    // Fixed origin + the caller's own path and query string, unchanged.
    // Host and SNI follow from this URL, which is why they are always correct.
    const originUrl = SUPABASE_ORIGIN + url.pathname + url.search;

    // `new Request(url, request)` copies method, headers and body (as a stream)
    // from the inbound request. Authorization and apikey ride along untouched —
    // this Worker never reads or rewrites them.
    const originRequest = new Request(originUrl, request);

    return fetch(originRequest, {
      // 3xx belongs to the browser, not to this Worker (auth flows depend on it).
      redirect: 'manual',
      // Caching off, explicitly and in both directions: no edge storage of an
      // authenticated API response, ever.
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  },
};

// Exported for the test suite only — keeping the allowlist assertable means a
// future edit that widens it fails a test rather than shipping quietly.
export const __TEST__ = { SUPABASE_ORIGIN, ALLOWED_PREFIXES, TRAVERSAL, isAllowedPath };
