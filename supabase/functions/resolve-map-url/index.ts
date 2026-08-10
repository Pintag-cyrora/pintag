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
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });

    const resolved = response.url;
    const finalHost = new URL(resolved).hostname;
    if (!ALLOWED_FINAL_HOSTS.test(finalHost) && !ALLOWED_HOSTS.has(finalHost)) {
      return errResponse(403, 'Resolved outside Google Maps — refusing');
    }

    return new Response(JSON.stringify({ resolved_url: resolved }), { headers: jsonHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errResponse(502, 'Upstream fetch failed: ' + message);
  }
});
