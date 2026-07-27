// Pintag — language-aware Open Graph preview generator.
//
// WHY THIS EXISTS: WhatsApp/Facebook/Telegram link-preview crawlers request
// the page once, un-authenticated, with no user session and no reliable
// language signal (Accept-Language is not preserved by these bots) — so the
// only way a shared link can produce a preview in the *sharer's* language is
// for that language to be explicit in the URL itself (?lang=en|lo|zh), read
// here server-side, before any client JS ever runs. listing.html's own
// updateOGTags() does the equivalent rewrite client-side for real visitors
// with JS enabled, but a crawler never executes that JS — this Worker is
// what makes the *crawler-visible* HTML correct.
//
// This is a fetch-through Worker: it never re-implements the page. It fetches
// the real origin response (GitHub Pages) unmodified, then uses HTMLRewriter
// to patch just the <head> meta/link tags and <html lang>, streaming
// everything else — markup, CSS, client JS — straight through untouched.
// Real users still get the fully-functional page; only the crawler-visible
// <head> differs, and only for /listing.html requests carrying a slug.
//
// DISCLOSURE: production (pintag.io) already has a Cloudflare-level setup
// generating a WhatsApp preview for listing URLs today, per a comment found
// in listing.html — but its source is not in this git repository, and this
// sandbox has no Cloudflare account/dashboard access to inspect it. This
// script is a fresh, complete implementation built from the product spec,
// not a diff against that unseen script. Whoever deploys this should confirm
// nothing the current Worker does (e.g. a different image pipeline) needs
// to be preserved before replacing it — see README.md in this folder.

const VALID_LANGS = ['en', 'lo', 'zh'];
const DEFAULT_LANG = 'lo'; // matches listing.html's static <html lang="lo">

const OG_IMG_ALT_PREFIX = { lo: 'ຮູບພາບ: ', en: 'Photo: ', zh: '照片：' };
const OG_GENERIC_DESC = {
  lo: 'ຄົ້ນພົບອະສັງຫາລິມະຊັບຄຸນນະພາບສູງສຳລັບຂາຍ ແລະ ເຊົ່າ ໃນນະຄອນຫຼວງວຽງຈັນ.',
  en: 'Discover premium properties for sale and rent in Vientiane, Laos.',
  zh: '探索万象优质房产，涵盖出售与出租房源。',
};
const DEFAULT_OG_IMAGE = 'https://pintag.io/og-preview.jpg';

// Public by design — anon keys are meant to be embeddable (RLS is the real
// security boundary), same convention already committed in config.prod.js.
// Overridable via Worker environment variables/secrets if ever rotated
// without touching this file.
const DEFAULT_SUPABASE_URL = 'https://eoladhcljbpbhnrmmpev.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbGFkaGNsamJwYmhucm1tcGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTE4NDQsImV4cCI6MjA5MTgyNzg0NH0.z1K8CqRFPIqiC7Gvfv1GekcQLIIkLodgyOksio1Upn0';

const LISTING_COLUMNS = [
  'slug', 'title_en', 'title_lo', 'title_zh',
  'description_en', 'description_lo', 'description_zh',
  'property_highlight', 'property_highlight_en', 'property_highlight_zh',
  'images',
].join(',');

function resolveLang(rawLang) {
  return VALID_LANGS.includes(rawLang) ? rawLang : DEFAULT_LANG;
}

function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k]) return row[k];
  }
  return null;
}

// Same fallback order as listing.html's updateOGTags(): the requested
// language's own value, then English, then Lao — "fall back to English if a
// translation is missing," per the product spec, with Lao as the ultimate
// catch-all since every listing is guaranteed to have Lao content.
function buildOgFields(row, lang) {
  const title = pick(row, `title_${lang}`, 'title_en', 'title_lo') || 'Pintag Property';
  const desc =
    pick(row, `property_highlight_${lang}`, 'property_highlight_en', 'property_highlight') ||
    pick(row, `description_${lang}`, 'description_en') ||
    OG_GENERIC_DESC[lang] || OG_GENERIC_DESC.en;
  const images = Array.isArray(row.images) ? row.images.filter((u) => typeof u === 'string' && u) : [];
  const image = images[0] || DEFAULT_OG_IMAGE;
  const imageAlt = (OG_IMG_ALT_PREFIX[lang] || OG_IMG_ALT_PREFIX.en) + title;
  return { title: `${title} · Pintag`, desc, image, imageAlt, hasZh: !!row.title_zh };
}

function canonicalUrl(slug, lang) {
  return `https://pintag.io/listing.html?slug=${encodeURIComponent(slug)}&lang=${encodeURIComponent(lang)}`;
}

async function fetchListing(env, slug) {
  const supabaseUrl = env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
  const url =
    `${supabaseUrl}/rest/v1/properties?slug=eq.${encodeURIComponent(slug)}` +
    `&select=${LISTING_COLUMNS}&limit=1`;
  const res = await fetch(url, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    // Crawlers re-request the same URLs constantly; a short edge cache keeps
    // this Worker from hammering Supabase for identical (slug, lang) pairs.
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

class AttrSetter {
  constructor(attr, value) {
    this.attr = attr;
    this.value = value;
  }
  element(el) {
    el.setAttribute(this.attr, this.value);
  }
}

class TextSetter {
  constructor(value) {
    this.value = value;
  }
  element(el) {
    el.setInnerContent(this.value);
  }
}

// hreflang alternates for a language that only conditionally exists (zh):
// removes any static placeholder when absent, appends a fresh <link> into
// <head> when present — the static HTML never has a zh tag to begin with,
// so this can't just be a content-rewrite like the others.
class ZhHreflangHandler {
  constructor(shouldHaveZh, href) {
    this.shouldHaveZh = shouldHaveZh;
    this.href = href;
  }
  element(el) {
    if (!this.shouldHaveZh) el.remove();
  }
}

class HeadAppender {
  constructor(html) {
    this.html = html;
  }
  element(el) {
    el.append(this.html, { html: true });
  }
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function rewriteListingHead(response, row, lang, slug) {
  const { title, desc, image, imageAlt, hasZh } = buildOgFields(row, lang);
  const url = canonicalUrl(slug, lang);
  const enUrl = canonicalUrl(slug, 'en');
  const loUrl = canonicalUrl(slug, 'lo');

  let rewriter = new HTMLRewriter()
    .on('html', new AttrSetter('lang', lang))
    .on('title', new TextSetter(title))
    .on('meta[name="description"]', new AttrSetter('content', desc))
    .on('meta[property="og:title"]', new AttrSetter('content', title))
    .on('meta[property="og:description"]', new AttrSetter('content', desc))
    .on('meta[property="og:image"]', new AttrSetter('content', image))
    .on('meta[property="og:image:alt"]', new AttrSetter('content', imageAlt))
    .on('meta[property="og:url"]', new AttrSetter('content', url))
    .on('meta[name="twitter:title"]', new AttrSetter('content', title))
    .on('meta[name="twitter:description"]', new AttrSetter('content', desc))
    .on('meta[name="twitter:image"]', new AttrSetter('content', image))
    .on('link[rel="canonical"]', new AttrSetter('href', url))
    .on('link[rel="alternate"][hreflang="en"]', new AttrSetter('href', enUrl))
    .on('link[rel="alternate"][hreflang="lo"]', new AttrSetter('href', loUrl))
    .on('link[rel="alternate"][hreflang="x-default"]', new AttrSetter('href', loUrl))
    .on('link[rel="alternate"][hreflang="zh"]', new ZhHreflangHandler(hasZh));

  if (hasZh) {
    const zhUrl = canonicalUrl(slug, 'zh');
    rewriter = rewriter.on(
      'head',
      new HeadAppender(`<link rel="alternate" hreflang="zh" href="${escapeAttr(zhUrl)}">`)
    );
  }

  return rewriter.transform(response);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only /listing.html is a per-property page; everything else (the site
    // shell, listings.html, static assets) passes straight through with no
    // Supabase call and no rewriting.
    if (!url.pathname.endsWith('/listing.html') && url.pathname !== '/listing.html') {
      return fetch(request);
    }

    const slug = url.searchParams.get('slug');
    const origin = await fetch(request);

    if (!slug) return origin;

    const lang = resolveLang(url.searchParams.get('lang'));

    let row;
    try {
      row = await fetchListing(env, slug);
    } catch (err) {
      // Network/parse failure talking to Supabase — degrade to the
      // unmodified origin response rather than showing a broken preview.
      return origin;
    }
    if (!row) return origin;

    try {
      return await rewriteListingHead(origin, row, lang, slug);
    } catch (err) {
      // HTMLRewriter failure of any kind — never let a preview-generation
      // bug break the actual page for a real visitor.
      return origin;
    }
  },
};

// Named exports of the pure logic (no fetch/HTMLRewriter) purely so it can
// be unit-tested with plain Node — unused by the Worker runtime itself,
// which only ever imports the default export.
export { resolveLang, buildOgFields, canonicalUrl };
