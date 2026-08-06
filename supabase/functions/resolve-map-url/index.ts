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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== 'string') throw new Error('No URL provided');

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid URL');
    }

    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      return new Response(JSON.stringify({ error: 'URL not allowed' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (parsed.protocol !== 'https:') {
      return new Response(JSON.stringify({ error: 'URL not allowed' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });

    const resolved = response.url;
    const finalHost = new URL(resolved).hostname;
    if (!ALLOWED_FINAL_HOSTS.test(finalHost) && !ALLOWED_HOSTS.has(finalHost)) {
      return new Response(JSON.stringify({ error: 'Resolved outside Google Maps — refusing' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ resolved_url: resolved }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
