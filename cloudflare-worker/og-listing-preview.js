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
// <head> differs, and only for /listing.html, /listings.html, and
// /index.html (or "/") requests -- see the fetch handler below.
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

// Matches listing.html's own OG_LOCALE map, so the crawler-visible
// og:locale (rewritten here, server-side) and the real-visitor og:locale
// (set client-side once the page's own JS runs) always agree.
const OG_LOCALE = { lo: 'lo_LA', en: 'en_US', zh: 'zh_CN' };

// index.html's HOME_META_I18N and listings.html's LISTINGS_META_I18N
// (default/unfiltered copy only), duplicated here by hand — this Worker is
// a separate Cloudflare deploy from the static site and can't literally
// import a browser file. Keep in sync manually whenever either client-side
// copy changes. listings.html's per-filter title/description variants are
// NOT reproduced here: filters aren't reflected in listings.html's URL
// today (see that file's updateListingsMetaForFilters() comment), so a
// crawler visiting a bare /listings.html request has no filter state to
// read in the first place — only the unfiltered default applies.
const HOME_META_I18N = {
  lo: {
    title: 'Pintag — ຄົ້ນຫາອະສັງຫາລິມະຊັບທົ່ວລາວ',
    desc: 'ຄົ້ນຫາອະສັງຫາລິມະຊັບສຳລັບຂາຍ ແລະ ເຊົ່າທົ່ວປະເທດລາວ. Pintag ເຊື່ອມຕໍ່ຜູ້ຊື້, ຜູ້ເຊົ່າ ແລະ ນາຍໜ້າ ໃນເວັບໄຊອະສັງຫາລິມະຊັບຊັ້ນນຳຂອງລາວ.',
  },
  en: {
    title: 'Pintag — Discover Properties Across Laos',
    desc: "Discover properties for sale and rent across Laos. Pintag connects buyers, renters and agents on Laos's premier real estate platform.",
  },
  zh: {
    title: 'Pintag — 探索老挝各地房产',
    desc: 'Pintag 帮助您在老挝各地寻找出售与出租的房产，连接买家、租户与房产经纪人的领先平台。',
  },
};
const LISTINGS_META_I18N = {
  lo: {
    title: 'ຊັບສິນໃຫ້ເຊົ່າ ແລະ ຂາຍ ໃນລາວ | Pintag',
    desc: 'ຄົ້ນຫາອາພາດເມັນ, ເຮືອນ, ຄອນໂດ, ທີ່ດິນ ແລະ ອາຄານທຸລະກິດທີ່ຢືນຢັນແລ້ວທົ່ວປະເທດລາວ. ອັບເດດທຸກມື້ພ້ອມຮູບພາບ, ລາຄາ ແລະ ແຜນທີ່.',
  },
  en: {
    title: 'Properties for Rent & Sale in Laos | Pintag',
    desc: 'Browse verified apartments, houses, condos, land and commercial properties across Laos. Updated daily with photos, prices and maps.',
  },
  zh: {
    title: '老挝出租出售房产 | Pintag',
    desc: '浏览老挝各地已核实的公寓、房屋、公寓大楼、土地和商业地产。每日更新，含照片、价格与地图。',
  },
};

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
  'images', 'market_status',
].join(',');

// Mirrors listing-status.js's LISTING_UNAVAILABLE_MARKET_STATUSES /
// MARKET_STATUS_LABELS / UNAVAILABLE_MESSAGE (only the subset needed for a
// crawler-visible title/description suffix) -- duplicated by hand for the
// same reason every other shared vocabulary in this file is (OG_LOCALE,
// HOME_META_I18N, ...): this Worker is a separate Cloudflare deploy that
// can't import a browser file. Keep in sync manually whenever
// listing-status.js's market_status vocabulary changes.
const UNAVAILABLE_MARKET_STATUSES = ['reserved', 'rented', 'sold', 'fully_occupied', 'off_market'];
const MARKET_STATUS_LABEL = {
  reserved: { en: 'Reserved', lo: 'ຖືກຈອງແລ້ວ', zh: '已预订' },
  rented: { en: 'Rented', lo: 'ເຊົ່າແລ້ວ', zh: '已出租' },
  sold: { en: 'Sold', lo: 'ຂາຍແລ້ວ', zh: '已售出' },
  fully_occupied: { en: 'Fully Occupied', lo: 'ເຕັມແລ້ວ', zh: '已满租' },
  off_market: { en: 'Off Market', lo: 'ຖອນອອກຈາກຕະຫຼາດ', zh: '已下架' },
};
// Mirrors listing-status.js's UNAVAILABLE_MESSAGE -- the status-specific
// lead sentence, e.g. "This property has been rented." -- so the
// crawler-visible description reads the same as what a real visitor with
// JS sees via listing.html's updateOGTags().
const UNAVAILABLE_MESSAGE = {
  reserved: { en: 'This property is currently reserved.', lo: 'ອະສັງຫາລາຍການນີ້ຖືກຈອງໄວ້ແລ້ວ.', zh: '该房源目前已被预订。' },
  sold: { en: 'This property has been sold.', lo: 'ອະສັງຫາລາຍການນີ້ຂາຍໄປແລ້ວ.', zh: '该房源已售出。' },
  rented: { en: 'This property has been rented.', lo: 'ອະສັງຫາລາຍການນີ້ຖືກເຊົ່າໄປແລ້ວ.', zh: '该房源已出租。' },
  fully_occupied: { en: 'This property is fully occupied.', lo: 'ອະສັງຫາລາຍການນີ້ເຕັມແລ້ວ.', zh: '该房源目前已满租。' },
  off_market: { en: 'This listing is currently off market.', lo: 'ລາຍການນີ້ຖືກຖອນອອກຈາກຕະຫຼາດຊົ່ວຄາວ.', zh: '该房源已暂时下架。' },
};
const UNAVAILABLE_DESC_SUFFIX = {
  en: 'Browse similar available properties on Pintag.',
  lo: 'ຄົ້ນຫາອະສັງຫາລິມະຊັບທີ່ຄ້າຍຄືກັນທີ່ຍັງວ່າງຢູ່ໃນ Pintag.',
  zh: '请在Pintag浏览类似的可预订房源。',
};

// Server-side counterpart to lang.js's resolvePintagLang(), used identically
// for all three rewritten paths (listing.html/index.html/listings.html).
// Only the URL ?lang= tier of that shared precedence is reproducible here:
// a persisted preference lives in the visitor's own browser localStorage,
// and the browser-language tier reads navigator.language — both
// fundamentally client-only, unavailable to a Worker running ahead of any
// page load for an anonymous crawler request. Accept-Language *is*
// available server-side but is deliberately NOT used as a stand-in for
// either tier: crawlers (WhatsApp/Facebook/etc.) don't send a header that
// reflects the original sharer's language, so keying off it here would
// produce a preview language uncorrelated with what any real person chose
// — worse than just falling through to the same 'lo' default the client
// uses. ?lang= explicit in the URL is the one signal both sides can always
// see and agree on; everything else collapses to the shared default.
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
  const titleBase = pick(row, `title_${lang}`, 'title_en', 'title_lo') || 'Pintag Property';
  let desc =
    pick(row, `property_highlight_${lang}`, 'property_highlight_en', 'property_highlight') ||
    pick(row, `description_${lang}`, 'description_en') ||
    OG_GENERIC_DESC[lang] || OG_GENERIC_DESC.en;
  const images = Array.isArray(row.images) ? row.images.filter((u) => typeof u === 'string' && u) : [];
  const image = images[0] || DEFAULT_OG_IMAGE;
  const imageAlt = (OG_IMG_ALT_PREFIX[lang] || OG_IMG_ALT_PREFIX.en) + titleBase;
  // Rented Listings UX: never 404/redirect a sold/rented/etc. listing, and
  // never let the crawler-visible title/description keep silently claiming
  // it's still available -- mirrors listing.html's own updateOGTags()
  // logic exactly (see that function's comment), just server-side.
  const isUnavailable = UNAVAILABLE_MARKET_STATUSES.includes(row.market_status);
  let title = titleBase;
  if (isUnavailable) {
    const statusLabel = MARKET_STATUS_LABEL[row.market_status];
    if (statusLabel) title += ` — ${statusLabel[lang] || statusLabel.en}`;
    const lead = UNAVAILABLE_MESSAGE[row.market_status];
    const leadText = (lead && (lead[lang] || lead.en)) || (statusLabel && (statusLabel[lang] || statusLabel.en)) || '';
    desc = `${leadText} ${UNAVAILABLE_DESC_SUFFIX[lang] || UNAVAILABLE_DESC_SUFFIX.en}`.trim();
  }
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
    .on('meta[property="og:locale"]', new AttrSetter('content', OG_LOCALE[lang] || OG_LOCALE.lo))
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

// Rewrites the static, non-listing pages' <head> (index.html, listings.html)
// to the resolved language's generic trilingual copy. Unlike
// rewriteListingHead(), there's no per-property data and no lang-suffixed
// og:url/canonical to compute — those pages' own client-side
// updateHeadMeta()/updateListingsMetaForFilters() deliberately leave og:url
// untouched by language too (see listings.html's own comment on that), so
// this mirrors that exactly rather than introducing a URL scheme the client
// doesn't use.
function rewriteGenericHead(response, lang, i18n) {
  const t = i18n[lang] || i18n[DEFAULT_LANG];
  return new HTMLRewriter()
    .on('html', new AttrSetter('lang', lang))
    .on('title', new TextSetter(t.title))
    .on('meta[name="description"]', new AttrSetter('content', t.desc))
    .on('meta[property="og:title"]', new AttrSetter('content', t.title))
    .on('meta[property="og:description"]', new AttrSetter('content', t.desc))
    .on('meta[property="og:locale"]', new AttrSetter('content', OG_LOCALE[lang] || OG_LOCALE.lo))
    .on('meta[name="twitter:title"]', new AttrSetter('content', t.title))
    .on('meta[name="twitter:description"]', new AttrSetter('content', t.desc))
    .transform(response);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // /listing.html: per-property page, needs a Supabase lookup for its
    // title/description/image — the original, most involved case.
    if (path === '/listing.html' || path.endsWith('/listing.html')) {
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
    }

    // index.html (including a bare "/" request) and listings.html: no
    // per-property data needed, just the resolved language's static
    // trilingual copy — but still worth guarding with the same
    // never-break-the-real-page try/catch as the listing.html path.
    const isHome = path === '/' || path === '/index.html' || path.endsWith('/index.html');
    const isListings = path === '/listings.html' || path.endsWith('/listings.html');
    if (isHome || isListings) {
      const origin = await fetch(request);
      const lang = resolveLang(url.searchParams.get('lang'));
      try {
        return rewriteGenericHead(origin, lang, isHome ? HOME_META_I18N : LISTINGS_META_I18N);
      } catch (err) {
        return origin;
      }
    }

    // Everything else (static assets, other pages) passes straight through
    // with no Supabase call and no rewriting.
    return fetch(request);
  },
};

// Named exports of the pure logic (no fetch/HTMLRewriter) purely so it can
// be unit-tested with plain Node — unused by the Worker runtime itself,
// which only ever imports the default export.
export { resolveLang, buildOgFields, canonicalUrl, HOME_META_I18N, LISTINGS_META_I18N };
