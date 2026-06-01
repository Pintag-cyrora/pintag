/**
 * Cloudflare Worker — Pintag OG preview injector
 *
 * Intercepts requests from social crawlers (WhatsApp, Telegram, Facebook,
 * Twitter, LinkedIn, Discord, Slack, Signal) and injects live OG meta tags
 * so link previews show the real image + title + description.
 *
 * Regular browser requests pass straight through to the GitHub Pages origin
 * with zero overhead.
 *
 * Routes to cover in the Cloudflare dashboard:
 *   pintag.io/agent.html*
 *   pintag.io/listing.html*
 *
 * Environment variables (set in Workers Settings → Variables):
 *   SUPABASE_URL   https://eoladhcljbpbhnrmmpev.supabase.co
 *   SUPABASE_KEY   <anon public key>
 */

const SUPABASE_URL = 'https://eoladhcljbpbhnrmmpev.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbGFkaGNsamJwYmhucm1tcGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTE4NDQsImV4cCI6MjA5MTgyNzg0NH0.z1K8CqRFPIqiC7Gvfv1GekcQLIIkLodgyOksio1Upn0';

const BOT_UA = /WhatsApp|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|TelegramBot|Slackbot|Discordbot|Signal\/|curl|wget|python-requests|Go-http-client|Java\/|bot|crawler|spider/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ua  = request.headers.get('user-agent') || '';

    // Only intercept social bots — browsers pass straight through
    if (!BOT_UA.test(ua)) {
      return fetch(request);
    }

    const page = url.pathname.replace(/^\//, '');

    if (page === 'agent.html') {
      const slug = url.searchParams.get('slug') || '';
      if (slug) return handleAgent(request, url, slug, env);
    }

    if (page === 'listing.html') {
      const slug = url.searchParams.get('slug') || '';
      if (slug) return handleListing(request, url, slug, env);
    }

    // No slug or unrecognised page — pass through
    return fetch(request);
  }
};

// ─── Agent preview ────────────────────────────────────────────────────────────

async function handleAgent(request, url, slug, env) {
  const sbUrl = env?.SUPABASE_URL || SUPABASE_URL;
  const sbKey = env?.SUPABASE_KEY || SUPABASE_KEY;

  const [htmlRes, agentRes] = await Promise.all([
    fetch(request),
    fetch(`${sbUrl}/rest/v1/agents?slug=eq.${encodeURIComponent(slug)}&limit=1&select=name_en,name_lo,bio_en,bio_lo,photo_url,agency_name`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
    })
  ]);

  const agents = await agentRes.json().catch(() => []);
  const a = agents[0];

  if (!a) return htmlRes;

  const name    = a.name_en || a.name_lo || 'Agent';
  const bio     = a.bio_en  || a.bio_lo  || '';
  const agency  = a.agency_name ? `${name} · ${a.agency_name}` : name;
  const title   = `Pintag · ${name}`;
  const desc    = bio || `${agency} — Pintag`;
  const image   = a.photo_url || '';
  const pageUrl = url.toString();

  return injectOG(htmlRes, { title, desc, image, pageUrl, type: 'profile' });
}

// ─── Listing preview ──────────────────────────────────────────────────────────

async function handleListing(request, url, slug, env) {
  const sbUrl = env?.SUPABASE_URL || SUPABASE_URL;
  const sbKey = env?.SUPABASE_KEY || SUPABASE_KEY;

  const [htmlRes, propRes] = await Promise.all([
    fetch(request),
    fetch(`${sbUrl}/rest/v1/properties?slug=eq.${encodeURIComponent(slug)}&limit=1&select=title_en,title_lo,description_en,description_lo,price_display,district_en,district_lo,images,transaction_type`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
    })
  ]);

  const props = await propRes.json().catch(() => []);
  const p = props[0];

  if (!p) return htmlRes;

  const title   = p.title_en || p.title_lo || 'Pintag Property';
  const desc    = p.description_en || p.description_lo || `${p.price_display || ''} · ${p.district_en || p.district_lo || 'Vientiane'}`.trim().replace(/^·\s*/, '');
  const images  = Array.isArray(p.images) ? p.images : [];
  const image   = images[0] || '';
  const pageUrl = url.toString();

  return injectOG(htmlRes, { title, desc, image, pageUrl, type: 'website', largeCard: true });
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

  let out = html
    .replace(/<title>[^<]*<\/title>/i, '')
    .replace(/<meta\s+(?:property="og:[^"]*"|name="(?:twitter:[^"]*|description)")\s*(?:content="[^"]*")?\s*\/?>\n?/gi, '')
    .replace('</head>', `  ${lines}\n</head>`);

  return new Response(out, {
    status: htmlRes.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300', // 5 min cache for bot responses
    }
  });
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
