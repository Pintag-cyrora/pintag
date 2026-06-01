const SUPABASE_URL = 'https://eoladhcljbpbhnrmmpev.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbGFkaGNsamJwYmhucm1tcGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTE4NDQsImV4cCI6MjA5MTgyNzg0NH0.z1K8CqRFPIqiC7Gvfv1GekcQLIIkLodgyOksio1Upn0';

function fetchOrigin(url) {
  return fetch(url.toString(), { method: 'GET', headers: { 'Accept': 'text/html' } });
}

export default {
  async fetch(request, env) {
    try {
      const url  = new URL(request.url);
      const page = url.pathname.replace(/^\//, '');

      // Always inject OG tags for agent/listing pages — harmless for browsers,
      // essential for WhatsApp/Facebook crawlers which may not match any UA pattern.
      if (page === 'agent.html') {
        const slug = url.searchParams.get('slug') || '';
        if (slug) return handleAgent(url, slug, env);
      }

      if (page === 'listing.html') {
        const slug = url.searchParams.get('slug') || '';
        if (slug) return handleListing(url, slug, env);
      }

      return fetch(request);
    } catch (e) {
      return fetch(request);
    }
  }
};

// ─── Agent preview ────────────────────────────────────────────────────────────

async function handleAgent(url, slug, env) {
  const sbUrl = (env && env.SUPABASE_URL) || SUPABASE_URL;
  const sbKey = (env && env.SUPABASE_KEY) || SUPABASE_KEY;

  try {
    const [htmlRes, agentRes] = await Promise.all([
      fetchOrigin(url),
      fetch(`${sbUrl}/rest/v1/agents?slug=eq.${encodeURIComponent(slug)}&limit=1&select=name_en,name_lo,bio_en,bio_lo,photo_url,agency_name`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
      })
    ]);

    const agents = await agentRes.json().catch(() => []);
    const a = Array.isArray(agents) ? agents[0] : null;
    if (!a) return htmlRes;

    const name  = a.name_en || a.name_lo || 'Agent';
    const bio   = a.bio_en  || a.bio_lo  || '';
    const title = `Pintag · ${name}`;
    const desc  = bio || `${name}${a.agency_name ? ' · ' + a.agency_name : ''} — Real estate agent in Vientiane`;
    const image = a.photo_url || '';

    return injectOG(htmlRes, { title, desc, image, pageUrl: url.toString(), type: 'profile' });
  } catch (e) {
    return fetchOrigin(url);
  }
}

// ─── Listing preview ──────────────────────────────────────────────────────────

async function handleListing(url, slug, env) {
  const sbUrl = (env && env.SUPABASE_URL) || SUPABASE_URL;
  const sbKey = (env && env.SUPABASE_KEY) || SUPABASE_KEY;

  try {
    const [htmlRes, propRes] = await Promise.all([
      fetchOrigin(url),
      fetch(`${sbUrl}/rest/v1/properties?slug=eq.${encodeURIComponent(slug)}&limit=1&select=title_en,title_lo,description_en,description_lo,price_display,district_en,district_lo,images,transaction_type`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
      })
    ]);

    const props = await propRes.json().catch(() => []);
    const p = Array.isArray(props) ? props[0] : null;
    if (!p) return htmlRes;

    const title  = p.title_en || p.title_lo || 'Pintag Property';
    const desc   = p.description_en || p.description_lo || `${p.price_display || ''} · ${p.district_en || p.district_lo || 'Vientiane'}`.trim().replace(/^·\s*/, '');
    const images = Array.isArray(p.images) ? p.images : [];
    const image  = images[0] || '';

    return injectOG(htmlRes, { title, desc, image, pageUrl: url.toString(), type: 'website', largeCard: true });
  } catch (e) {
    return fetchOrigin(url);
  }
}

// ─── OG tag injector ──────────────────────────────────────────────────────────

async function injectOG(htmlRes, { title, desc, image, pageUrl, type, largeCard }) {
  const html = await htmlRes.text();
  const card = largeCard && image ? 'summary_large_image' : 'summary';

  const lines = [
    `<meta property="og:site_name" content="Pintag">`,
    `<meta property="og:type" content="${esc(type)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(pageUrl)}">`,
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    `<meta name="twitter:card" content="${card}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    image ? `<meta name="twitter:image" content="${esc(image)}">` : '',
    `<meta name="description" content="${esc(desc)}">`,
    `<title>${esc(title)}</title>`,
  ].filter(Boolean).join('\n  ');

  // Remove old title and any existing og/twitter/description meta tags
  let out = html
    .replace(/<title>[^<]*<\/title>/i, '')
    .replace(/<meta\s+(?:property="og:[^"]*"|name="(?:twitter:[^"]*|description)")\s*(?:content="[^"]*")?\s*\/?>\n?/gi, '');

  // Inject before </head> — case-insensitive match
  out = out.replace(/<\/head>/i, `  ${lines}\n</head>`);

  return new Response(out, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
    }
  });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
