const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Only allow Google Maps short-link domains.
// Without this allowlist the function was an open SSRF proxy — any URL
// (including internal metadata endpoints) could be fetched server-side.
const ALLOWED_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'maps.google.com']);

// The short link is fetched with redirect:'follow', so the FINAL landing
// host must also be validated — a goo.gl link can redirect anywhere, and
// returning an internal/arbitrary resolved URL would leak redirect targets.
// Legitimate resolutions land on the google.* maps family.
const ALLOWED_FINAL_HOSTS = /^([a-z0-9-]+\.)*google(\.[a-z]{2,3}){1,2}$/i;

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
function errResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

// Raw control characters (CR/LF/NUL and the rest of C0, plus DEL) must never
// appear in a URL string. Rejecting them up front turns malformed input into a
// clean 400 instead of (a) a 200 for a CRLF-bearing allowlisted host or (b) a
// 500 when the parser chokes on a NUL byte.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // ── Parse + validate the request. Every failure here is the CALLER's
  //    fault, so it is a 4xx — never a 500. ────────────────────────────────
  let url: unknown;
  try {
    const body = await req.json();
    url = body?.url;
  } catch {
    return errResponse(400, 'Invalid JSON body');
  }
  if (!url || typeof url !== 'string') return errResponse(400, 'No URL provided');
  if (CONTROL_CHARS.test(url)) return errResponse(400, 'URL contains control characters');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return errResponse(400, 'Invalid URL');
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) return errResponse(403, 'URL not allowed');
  if (parsed.protocol !== 'https:') return errResponse(403, 'URL not allowed');

  // ── Fetch + validate the final host. A failure here is an UPSTREAM/gateway
  //    problem (goo.gl unreachable, timeout), so it is a 502 — still not a
  //    crash, and never a 2xx. ─────────────────────────────────────────────
  try {
    // DO NOT send a browser User-Agent here. maps.app.goo.gl decides what to
    // answer with based on it:
    //
    //   Chrome UA  -> 200 + a 34KB JavaScript interstitial, NO Location
    //                 header and no coordinate anywhere in the body, so
    //                 redirect:'follow' has nothing to follow and response.url
    //                 comes back EQUAL TO THE INPUT.
    //   non-browser -> 302 straight to
    //                 https://www.google.com/maps?q=<lat>,<lng>&entry=gps
    //                 at full precision.
    //
    // This function used to send 'Mozilla/5.0 ... Chrome/120.0.0.0 ...' and
    // therefore returned the un-expanded short link for 27 of 29 production
    // listings -- with a 200 and a resolved_url field, so every caller read it
    // as success. Measured across all 29 stored links: 23 now resolve to an
    // exact coordinate, 6 resolve to a URL that genuinely carries none.
    //
    // A neutral, honest UA identifying this service is what works.
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'PintagMapLinkResolver/1.0 (+https://pintag.io)' },
    });

    const resolved = response.url;
    const finalHost = new URL(resolved).hostname;
    if (!ALLOWED_FINAL_HOSTS.test(finalHost) && !ALLOWED_HOSTS.has(finalHost)) {
      return errResponse(403, 'Resolved outside Google Maps — refusing');
    }

    // Returning the input unchanged is not a resolution. It is the exact
    // failure that hid this bug: a 200 with resolved_url === url reads as
    // success to every caller. Say so explicitly instead.
    if (resolved === url) {
      return errResponse(502, 'Short link did not redirect — not expanded');
    }

    return new Response(JSON.stringify({ resolved_url: resolved }), { headers: jsonHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errResponse(502, 'Upstream fetch failed: ' + message);
  }
});
