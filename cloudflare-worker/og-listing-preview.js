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
// <head> differs, and only for /listing.html and /listings.html requests --
// see the fetch handler below. "/" and /index.html are a separate, simpler
// case: customer-first homepage strategy, they now 301-redirect straight to
// /listings.html rather than being fetched/rewritten at all (see the isHome
// branch below).
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

// Share Strategy: "the ideal preview contains price and neighborhood" --
// minimal, hand-duplicated counterparts of currency.js's CURRENCIES/
// formatMoney() and components.js's PT_FREQUENCY_SUFFIX/PT_PRICE_ON_REQUEST/
// formatPropertyPrice() (single-price path only -- a sale_or_rent dual-price
// listing falls back to price_display, same "coarse is fine for a preview
// snippet" precedent as this file's other duplicated vocabulary). This
// Worker is a separate Cloudflare deploy that can't import a browser file --
// keep in sync manually whenever currency.js/components.js's price
// formatting changes.
const CURRENCY_SYMBOL = { USD: '$', LAK: '₭', THB: '฿' };
const FREQUENCY_SUFFIX = {
  monthly: { lo: '/ ເດືອນ', en: '/ month', zh: '/ 月' },
  yearly: { lo: '/ ປີ', en: '/ year', zh: '/ 年' },
  weekly: { lo: '/ ອາທິດ', en: '/ week', zh: '/ 周' },
  daily: { lo: '/ ມື້', en: '/ day', zh: '/ 天' },
  negotiable: { lo: '(ເຈລະຈາໄດ້)', en: '(negotiable)', zh: '(可议价)' },
};
const PRICE_ON_REQUEST = { lo: 'ສອບຖາມລາຄາ', en: 'Price on request', zh: '价格面议' };

// ── Pricing (ported from components.js/currency.js) ─────────────────────
// This Worker is a separate Cloudflare deploy that can't import a browser
// file, so the functions below are a careful, field-for-field port of
// formatPropertyPrice()/ptResolveUnitTypesPriceEntry()/
// ptResolveUnitTypesPrice()/ptBuildUnitPriceText()/_ptLegacyRentText()/
// _ptTransactionKind() (components.js) and formatMoney() (currency.js) --
// same precedence, same branches, same fallback order. Keep in sync by hand
// whenever any of those functions change, same convention already used
// above for OG_LOCALE/HOME_META_I18N/MARKET_STATUS_LABEL/etc.

// Mirrors currency.js's formatMoney(amount, currency): whole-number,
// thousands-separated, currency-symbol-prefixed. CURRENCY_SYMBOL (above)
// already matches currency.js's CURRENCIES map value-for-value.
function formatMoneyEdge(amount, currency) {
  const n = Number(amount);
  if (amount == null || isNaN(n)) return null;
  const symbol = CURRENCY_SYMBOL[currency] || '$';
  return symbol + Math.round(n).toLocaleString('en-US');
}

function transactionKind(transactionType) {
  if (transactionType === 'sale_or_rent') return 'sor';
  if (transactionType === 'for_sale' || transactionType === 'sale') return 'sale';
  return 'rent';
}

// Mirrors components.js's _ptLegacyRentText(property, lang) -- the rent leg
// of a LEGACY sale_or_rent row that has no structured rent_price_amount yet.
const RENT_PERIOD_FREQUENCY = { month: 'monthly', year: 'yearly', week: 'weekly', day: 'daily' };
const LEGACY_SUFFIX_RE = /\s*\/\s*(month|year|week|day)s?\s*$/i;
function legacyRentText(row, lang) {
  const raw = row && row.rent_price;
  if (!raw) return null;
  const text = String(raw).trim();
  const known = text.match(LEGACY_SUFFIX_RE);
  if (known) {
    const suffix = FREQUENCY_SUFFIX[RENT_PERIOD_FREQUENCY[known[1].toLowerCase()] || 'monthly'] || FREQUENCY_SUFFIX.monthly;
    return text.slice(0, known.index) + ' ' + (suffix[lang] || suffix.en);
  }
  if (/\d[^/]*\/\s*\S/.test(text)) return text;
  const suffix = FREQUENCY_SUFFIX[RENT_PERIOD_FREQUENCY[row.rent_period] || 'monthly'] || FREQUENCY_SUFFIX.monthly;
  return text + ' ' + (suffix[lang] || suffix.en);
}

// Mirrors terminology.js's resolveUnitType(): a unit_types row's own value
// wins, falling back to the building's (property-level) column when the
// unit's own is null/undefined -- pricing-relevant columns only (this
// Worker has no use for the rest of that function's fields).
function resolveUnitPriceFields(row, unit) {
  function pick(col) {
    const v = unit[col];
    return v !== null && v !== undefined ? v : row[col];
  }
  return {
    priceDisplay: pick('price_display'),
    salePrice: pick('sale_price'),
    rentPrice: pick('rent_price'),
    rentPeriod: pick('rent_period'),
    priceAmount: pick('price_amount'),
    priceCurrency: pick('price_currency'),
    priceFrequency: pick('price_frequency'),
    rentPriceAmount: pick('rent_price_amount'),
    rentPriceCurrency: pick('rent_price_currency'),
    rentPriceFrequency: pick('rent_price_frequency'),
  };
}

// Mirrors components.js's ptBuildUnitPriceText(property, resolved, lang).
function buildUnitPriceText(row, resolved, lang) {
  const isSorUnit = row.transaction_type === 'sale_or_rent';
  if (isSorUnit) {
    const parts = [];
    if (resolved.priceAmount != null || resolved.rentPriceAmount != null) {
      if (resolved.priceAmount != null) parts.push(formatMoneyEdge(resolved.priceAmount, resolved.priceCurrency));
      if (resolved.rentPriceAmount != null) {
        const suffix = FREQUENCY_SUFFIX[resolved.rentPriceFrequency] || FREQUENCY_SUFFIX.monthly;
        parts.push(formatMoneyEdge(resolved.rentPriceAmount, resolved.rentPriceCurrency) + ' ' + (suffix[lang] || suffix.en));
      }
    } else if (resolved.salePrice || resolved.rentPrice) {
      const period = resolved.rentPeriod || 'month';
      const periodLabel = {
        month: FREQUENCY_SUFFIX.monthly,
        year: { lo: '/ ປີ', en: '/ year', zh: '/ 年' },
        day: { lo: '/ ວັນ', en: '/ day', zh: '/ 天' },
      };
      if (resolved.salePrice) parts.push(resolved.salePrice);
      if (resolved.rentPrice) {
        const label = periodLabel[period] || FREQUENCY_SUFFIX.monthly;
        parts.push(resolved.rentPrice + (label[lang] || label.en));
      }
    }
    return parts.length ? parts.join(' · ') : null;
  }
  if (resolved.priceAmount != null) {
    const text = formatMoneyEdge(resolved.priceAmount, resolved.priceCurrency);
    if (row.transaction_type !== 'for_rent') return text;
    const suffix = FREQUENCY_SUFFIX[resolved.priceFrequency] || FREQUENCY_SUFFIX.monthly;
    return text + ' ' + (suffix[lang] || suffix.en);
  }
  return resolved.priceDisplay || null;
}

// Mirrors components.js's ptResolveUnitTypesPriceEntry()/
// ptResolveUnitTypesPrice(): the CHEAPEST resolvable unit's own price text
// (no "from" prefix is added by the canonical implementation either -- this
// intentionally does not invent one). property-level price is nulled out
// on save for e.g. a fully-occupied multi-unit building, so this is the
// fallback the crawler-visible description needs whenever there is no
// property-level price to show but real unit_types pricing exists.
function resolveUnitTypesPrice(row, lang) {
  const units = Array.isArray(row.unit_types) ? row.unit_types : [];
  if (!units.length) return null;
  let best = null;
  for (const unit of units) {
    const resolved = resolveUnitPriceFields(row, unit);
    const text = buildUnitPriceText(row, resolved, lang);
    if (!text) continue;
    let amt = null;
    if (resolved.priceAmount != null) amt = resolved.priceAmount;
    else if (resolved.rentPriceAmount != null) amt = resolved.rentPriceAmount;
    if (best === null || (amt != null && (best.amount == null || amt < best.amount))) {
      best = { amount: amt, text };
    }
  }
  return best ? best.text : null;
}

// Mirrors components.js's formatPropertyPrice() precedence exactly:
// structured single price -> structured/legacy sale-or-rent dual price ->
// legacy price_display text -> unit_types fallback -> "Price on request".
function formatPriceLine(row, lang) {
  const kind = transactionKind(row.transaction_type);

  if (kind === 'sor') {
    const hasStructuredSor = row.price_amount != null || row.rent_price_amount != null;
    if (hasStructuredSor) {
      const saleText = row.price_amount != null ? formatMoneyEdge(row.price_amount, row.price_currency) : row.sale_price || null;
      const rentText =
        row.rent_price_amount != null
          ? (() => {
              const suffix = FREQUENCY_SUFFIX[row.rent_price_frequency] || FREQUENCY_SUFFIX.monthly;
              return formatMoneyEdge(row.rent_price_amount, row.rent_price_currency) + ' ' + (suffix[lang] || suffix.en);
            })()
          : legacyRentText(row, lang);
      const parts = [saleText, rentText].filter(Boolean);
      if (parts.length) return parts.join(' · ');
    } else if (row.sale_price || row.rent_price) {
      const parts = [row.sale_price || null, legacyRentText(row, lang)].filter(Boolean);
      if (parts.length) return parts.join(' · ');
    }
    // Neither leg has any data at all (structured or legacy) -- fall
    // through to the single-price path below, matching
    // formatPropertyPrice()'s own documented behavior for this case.
  }

  if (row.price_amount != null) {
    const moneyText = formatMoneyEdge(row.price_amount, row.price_currency);
    if (kind !== 'rent') return moneyText;
    const suffix = FREQUENCY_SUFFIX[row.price_frequency] || FREQUENCY_SUFFIX.monthly;
    return moneyText + ' ' + (suffix[lang] || suffix.en);
  }

  const raw = (row.price_display || '').replace(/\s*\/\s*(ເດືອນ|month|mo|月)\s*/i, '').trim();
  if (raw) {
    if (kind !== 'rent') return raw;
    const suffix = FREQUENCY_SUFFIX.monthly;
    return raw + ' ' + (suffix[lang] || suffix.en);
  }

  const unitText = resolveUnitTypesPrice(row, lang);
  if (unitText) return unitText;

  return PRICE_ON_REQUEST[lang] || PRICE_ON_REQUEST.en;
}

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
//
// HOME_META_I18N is currently unused by the live fetch() routing below (see
// the isHome branch: "/" and /index.html now redirect to /listings.html
// instead of being rewritten) — kept, and still covered by its own direct
// unit test, so index.html's OG rewriting is ready to reinstate the moment
// the product revisits homepage strategy, without re-deriving this copy.
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

// Pricing columns mirror exactly what components.js's formatPropertyPrice()/
// ptResolveUnitTypesPriceEntry()/resolveUnitType() (terminology.js) read, at
// both the property level and the unit_types level -- see resolvePriceLine()
// below, which ports that same precedence. Nothing here is invented: every
// column exists because one of those functions reads it.
const LISTING_COLUMNS = [
  'slug', 'title_en', 'title_lo', 'title_zh',
  'description_en', 'description_lo', 'description_zh',
  'property_highlight', 'property_highlight_en', 'property_highlight_zh',
  'images', 'market_status', 'transaction_type',
  'price_amount', 'price_currency', 'price_frequency', 'price_display',
  'rent_price_amount', 'rent_price_currency', 'rent_price_frequency',
  'sale_price', 'rent_price', 'rent_period',
  'district_en', 'district_lo', 'district_zh',
  'unit_types(price_display,sale_price,rent_price,rent_period,price_amount,price_currency,price_frequency,rent_price_amount,rent_price_currency,rent_price_frequency)',
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

// ── OG image: an existing rendition, not the full-resolution original ───────
// Mirrors image-renditions.js's renditionPublicUrl()/objectNameFromPublicUrl()
// for the single profile this Worker needs ('hero', 1200px -- matches
// components.js's PT_IMAGE_PROFILES.hero, the largest existing rendition and
// the closest to social platforms' recommended OG image width). Hand-ported
// rather than imported, same "separate Cloudflare deploy, can't import a
// browser file" convention as the rest of this file's duplicated vocabulary
// (image-renditions.js also carries browser-only canvas/Image generation
// code this Worker has no use for) -- keep in sync by hand if that file's
// path scheme ever changes.
//
// Falls back to the original URL whenever it isn't one of this project's own
// public property-images objects (agent-hosted photos, already a rendition,
// anything unrecognized) -- same "delivery always degrades to the original"
// rule image-renditions.js documents. Unlike components.js's ptImageUrl(),
// a crawler has no <img onerror> to recover on a 404 -- renditionExists()
// below is this Worker's own equivalent: a one-shot existence check before
// a constructed rendition URL is ever handed to og:image.
const OG_IMAGE_PROFILE = 'hero';
const RENDITION_PREFIX = 'renditions/';
const RENDITION_BUCKET = 'property-images';
function ogRenditionUrl(originalUrl, supabaseUrl) {
  if (!originalUrl || typeof originalUrl !== 'string' || !supabaseUrl) return originalUrl;
  const base = `${supabaseUrl}/storage/v1/object/public/${RENDITION_BUCKET}/`;
  if (!originalUrl.startsWith(base)) return originalUrl; // not our Storage object -- leave untouched
  const name = originalUrl.slice(base.length).split('?')[0];
  if (!name || name.startsWith(RENDITION_PREFIX)) return originalUrl; // already a rendition
  const stem = name.replace(/\.[A-Za-z0-9]+$/, '');
  return stem ? `${base}${RENDITION_PREFIX}${stem}/${OG_IMAGE_PROFILE}.webp` : originalUrl;
}

// Renditions are generated best-effort at UPLOAD TIME (image-renditions.js's
// own header: "a missing rendition must show the photo, never a broken
// image") and the only backfill for anything that slipped through is a
// manual, infrequently-run workflow -- so a just-uploaded or just-reordered
// listing photo can genuinely have no rendition object yet. This checks,
// once, before a constructed rendition URL is ever used as og:image.
//
// HEAD, not GET: the smallest request that answers "does this exist"
// without downloading the image bytes. This deployment's public Storage
// endpoint returns 400 (not 404) for a missing object on both GET and HEAD
// (see scripts/backfill-renditions.mjs's own documented finding) -- res.ok
// (2xx-only) already treats any non-2xx as "missing" without needing to
// special-case which status that turns out to be.
//
// Bounded and single-shot: exactly one HEAD request, a short timeout, no
// retries, and the fallback path (the original photo) is never itself
// existence-checked -- a crawler request can never turn into more than one
// extra round trip. A network error/timeout is treated the same as a
// non-2xx response: the safe default is always "fall back to the original."
async function renditionExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch (_err) {
    return false;
  }
}

// Same fallback order as listing.html's updateOGTags(): the requested
// language's own value, then English, then Lao — "fall back to English if a
// translation is missing," per the product spec, with Lao as the ultimate
// catch-all since every listing is guaranteed to have Lao content.
function buildOgFields(row, lang, supabaseUrl = DEFAULT_SUPABASE_URL) {
  const titleBase = pick(row, `title_${lang}`, 'title_en', 'title_lo') || 'Pintag Property';
  const highlight =
    pick(row, `property_highlight_${lang}`, 'property_highlight_en', 'property_highlight') ||
    pick(row, `description_${lang}`, 'description_en') ||
    OG_GENERIC_DESC[lang] || OG_GENERIC_DESC.en;
  // Share Strategy: lead the crawler-visible description with price +
  // neighborhood -- "the ideal preview contains price and neighborhood" --
  // this IS the WhatsApp/Messenger/Facebook link-preview text (native share
  // sheet text is a separate, client-side-only field -- see listing.html's
  // getListingSharePayload()).
  const priceLine = formatPriceLine(row, lang);
  const districtLine = pick(row, `district_${lang}`, 'district_en');
  const priceLocLine = [priceLine, districtLine].filter(Boolean).join(' · ');
  let desc = priceLocLine ? `${priceLocLine} — ${highlight}` : highlight;
  const images = Array.isArray(row.images) ? row.images.filter((u) => typeof u === 'string' && u) : [];
  const rawImage = images[0] || null;
  const image = rawImage ? ogRenditionUrl(rawImage, supabaseUrl) : DEFAULT_OG_IMAGE;
  // True only when ogRenditionUrl() actually rewrote a real listing image
  // into a rendition URL -- false for the no-image/DEFAULT_OG_IMAGE case, a
  // non-Supabase image, or a path that was already a rendition (in every one
  // of those, ogRenditionUrl() returns the input unchanged). This is exactly
  // the set of cases rewriteListingHead() below should -- and should only --
  // run renditionExists() against, and the ONLY case where `rawImage` (the
  // pre-rendition fallback) is both non-null and different from `image`.
  const isRendition = rawImage != null && image !== rawImage;
  // og:image:type must match whatever `image` actually resolved to -- a
  // WebP rendition (ogRenditionUrl() above) needs image/webp, while the
  // original photo, a non-Storage image, or DEFAULT_OG_IMAGE are all JPEG
  // (see admin.html's canvas.toBlob(..., 'image/jpeg') on the original
  // upload path, and DEFAULT_OG_IMAGE's own .jpg extension). Keyed off the
  // resolved URL's own extension rather than "did ogRenditionUrl rewrite
  // it" so this can never drift out of sync with what `image` really is.
  // (This is the OPTIMISTIC type, assuming the rendition exists;
  // rewriteListingHead() corrects it to image/jpeg if renditionExists()
  // says otherwise.)
  const imageContentType = image.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
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
  return { title: `${title} · Pintag`, desc, image, imageContentType, imageAlt, hasZh: !!row.title_zh, rawImage, isRendition };
}

function canonicalUrl(slug, lang) {
  return `https://pintag.io/listing.html?slug=${encodeURIComponent(slug)}&lang=${encodeURIComponent(lang)}`;
}

// Shared by fetchListing() (the REST call) and the OG image rendition URL, so
// both agree on the same Supabase origin, including if it's ever rotated via
// the SUPABASE_URL Worker secret.
function resolveSupabaseUrl(env) {
  return (env && env.SUPABASE_URL) || DEFAULT_SUPABASE_URL;
}

async function fetchListing(env, slug) {
  const supabaseUrl = resolveSupabaseUrl(env);
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

// Bypasses Cloudflare's edge cache for the Worker's OWN same-zone fetch to
// origin (GitHub Pages) -- a different cache surface from withNoStore()
// below. withNoStore() only governs whether a cache sitting in front of
// THIS RESPONSE (what this Worker hands back to the requester) may store
// it; it says nothing about whether Cloudflare's edge serves a stale,
// previously-cached copy of the origin's own response to this Worker's
// `fetch(request)` call in the first place -- and a Worker's fetch() to a
// URL matching its own zone participates in that zone's ordinary cache
// layer exactly like ordinary edge traffic does, unless told otherwise.
// `cacheTtl: 0` is the documented Workers mechanism for "do not cache this
// particular subrequest" -- the standard Fetch API's `cache` option (e.g.
// `{ cache: 'no-store' }`) is NOT implemented by the Workers runtime and is
// silently ignored wherever it's passed, `cf` or not. Found and reasoned
// through in the 2026-09-22 investigation into why a Cloudflare cache purge
// of https://pintag.io/listing.html did not change the HTML the production
// security workflow saw, even after confirming no Cache Rules exist on the
// zone and after both GitHub Pages and this Worker were freshly redeployed.
const BYPASS_ORIGIN_CACHE = { cf: { cacheTtl: 0 } };

async function rewriteListingHead(response, row, lang, slug, supabaseUrl = DEFAULT_SUPABASE_URL) {
  const fields = buildOgFields(row, lang, supabaseUrl);
  const { title, desc, imageAlt, hasZh } = fields;
  let image = fields.image;
  let imageContentType = fields.imageContentType;
  // Verify the rendition actually exists before ever advertising it as
  // og:image -- see renditionExists()'s own comment. Skipped entirely
  // (fields.isRendition is false) for a non-Supabase image, the
  // no-image/DEFAULT_OG_IMAGE fallback, or a path that was already a
  // rendition -- none of those are a rendition URL this Worker constructed,
  // so there is nothing new to verify. The fallback (the original photo,
  // always JPEG) is never itself existence-checked.
  if (fields.isRendition && !(await renditionExists(image))) {
    image = fields.rawImage;
    imageContentType = 'image/jpeg';
  }
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
    .on('meta[property="og:image:type"]', new AttrSetter('content', imageContentType))
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

// Forces every rewritten response to bypass caching entirely (browser,
// Cloudflare's own edge cache, or anything in between). Every step of this
// file's own language resolution — resolveLang() reading ?lang= off the
// full request URL, buildOgFields()/HOME_META_I18N/LISTINGS_META_I18N
// keying every field off that resolved language — is correct in isolation
// (see og-listing-preview.test.js), but a *cache* sitting in front of this
// Worker's response doesn't know or care about that: if a Cache Rule on
// the zone treats the query string as irrelevant to the cache key (a
// common setup — "Cache Everything" for .html paths, ignoring query
// params, to reduce cache fragmentation from unrelated params like UTM
// tags), every ?lang= variant of the same path collapses onto ONE cached
// response, and every crawler after the first one gets served whichever
// language happened to be cached first — indistinguishable, from the
// outside, from "the Worker always returns Lao." This header makes that
// impossible regardless of how the zone's Cache Rules are configured,
// without depending on Cloudflare dashboard access to verify or fix them.
function withNoStore(response) {
  const out = new Response(response.body, response);
  out.headers.set('Cache-Control', 'no-store');
  return out;
}


// ── SECURITY HEADERS ────────────────────────────────────────────────────────
// GitHub Pages cannot set response headers, so the pages carry their CSP in a
// <meta> tag (scripts/csp-policy.mjs is the source of truth; scripts/apply-csp.mjs
// stamps it). Two useful controls have NO meta equivalent and can only arrive
// as real headers:
//
//   * frame-ancestors / X-Frame-Options — clickjacking. `frame-ancestors` is
//     explicitly ignored inside a meta tag by every browser.
//   * HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy — all
//     header-only by specification.
//
// This Worker already sits in front of "/", /index.html, /listings.html and
// /listing.html, so it can supply them for the pages that matter most to a
// public visitor. It CANNOT cover admin.html or the other tools — those are on
// routes this Worker does not front, and they need a Cloudflare Transform Rule
// for full coverage. See docs/CSP.md for that rule; it is the one piece of this
// that must be configured in the Cloudflare dashboard.
//
// Deliberately NOT set here: Content-Security-Policy. The pages already carry
// their own via meta, and emitting a second policy would mean the browser
// enforces the INTERSECTION of the two — so any future drift between this file
// and scripts/csp-policy.mjs would silently start blocking legitimate content.
// One source of truth; this Worker only adds what meta cannot express.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
};

// Apply to any response this Worker returns. Header-only, never touches the
// body, and safe on a pass-through response (it re-wraps rather than mutating a
// possibly-immutable header set).
function withSecurityHeaders(response) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

// ── MAINTENANCE MODE ────────────────────────────────────────────────────────
// While MAINTENANCE_MODE is true, the public browsing surface this Worker
// fronts — home ("/", /index.html), search (/listings.html), and listing
// detail (/listing.html) — returns a clean HTTP 503 with a Retry-After hint,
// so search engines treat the downtime as temporary and never index the
// placeholder. Every other path (admin.html, the agent portal, all JS/CSS/
// image assets) passes straight through untouched, so administration and
// listing recovery are unaffected. Fully reversible: set MAINTENANCE_MODE to
// false (or `git revert` the commit that introduced this block) and redeploy.
const MAINTENANCE_MODE = false;
const MAINTENANCE_HTML = '<!doctype html><html lang="lo"><head>' +
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="robots" content="noindex,nofollow"><title>Pintag — ບຳລຸງຮັກສາລະບົບ / Under Maintenance</title>' +
  '<style>' +
  ':root{--teal:#2D8C8C;--ink:#1A2428;--warm:#F7F3EC;--muted:#5A6670}' +
  '*{box-sizing:border-box}html,body{margin:0;height:100%}' +
  'body{background:var(--warm);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
  'display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.6}' +
  '.card{max-width:30rem;text-align:center}' +
  '.logo{font-weight:800;font-size:1.5rem;letter-spacing:-.02em;color:var(--teal);margin-bottom:1.25rem}' +
  '.mark{width:56px;height:56px;border-radius:14px;background:var(--teal);margin:0 auto 1.25rem;' +
  'display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.6rem}' +
  'h1{font-size:1.3rem;margin:.25rem 0 .5rem;letter-spacing:-.01em}' +
  'p{margin:.4rem 0;color:var(--muted);font-size:.98rem}' +
  '.en{margin-top:1rem;padding-top:1rem;border-top:1px solid rgba(26,36,40,.12)}' +
  '</style></head><body><div class="card">' +
  '<div class="mark">\u{1F3E1}</div>' +
  '<div class="logo">Pintag</div>' +
  '<h1>ກຳລັງບຳລຸງຮັກສາລະບົບ</h1>' +
  '<p>ເວັບໄຊຕ໌ປິດຊົ່ວຄາວເພື່ອປັບປຸງລະບົບ. ພວກເຮົາຈະກັບມາໃນໄວໆນີ້.</p>' +
  '<div class="en"><p><strong>Pintag is temporarily offline for scheduled maintenance.</strong></p>' +
  '<p>We’re making improvements and will be back shortly. Thank you for your patience.</p></div>' +
  '</div></body></html>';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Maintenance short-circuit: 503 the public browsing pages only; leave
    // admin.html, the agent portal, and every static asset reachable so
    // recovery and administration continue. See MAINTENANCE_MODE above.
    if (MAINTENANCE_MODE) {
      const isPublicBrowsing =
        path === '/' ||
        path === '/index.html' || path.endsWith('/index.html') ||
        path === '/listings.html' || path.endsWith('/listings.html') ||
        path === '/listing.html' || path.endsWith('/listing.html');
      if (isPublicBrowsing) {
        return withSecurityHeaders(new Response(MAINTENANCE_HTML, {
          status: 503,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Retry-After': '3600',
          },
        }));
      }
    }

    // /listing.html: per-property page, needs a Supabase lookup for its
    // title/description/image — the original, most involved case.
    if (path === '/listing.html' || path.endsWith('/listing.html')) {
      const slug = url.searchParams.get('slug');
      const origin = await fetch(request, BYPASS_ORIGIN_CACHE);
      // Every response this branch can return — rewritten or a fallback to
      // the unmodified origin — must carry the same Cache-Control: no-store
      // as the rewrite path below. A cache in front of this Worker cannot
      // tell a fallback apart from a rewrite, so leaving any of these
      // uncovered lets that one path get cached indefinitely (observed in
      // production: a bare /listing.html request with no ?slug, served
      // stale HTML long after the origin had already updated) — see
      // withNoStore()'s own comment for why a cache can't be trusted to
      // treat these consistently on its own.
      if (!slug) return withSecurityHeaders(withNoStore(origin));

      const lang = resolveLang(url.searchParams.get('lang'));

      let row;
      try {
        row = await fetchListing(env, slug);
      } catch (err) {
        // Network/parse failure talking to Supabase — degrade to the
        // unmodified origin response rather than showing a broken preview.
        return withSecurityHeaders(withNoStore(origin));
      }
      if (!row) return withSecurityHeaders(withNoStore(origin));

      try {
        return withSecurityHeaders(
          withNoStore(await rewriteListingHead(origin, row, lang, slug, resolveSupabaseUrl(env)))
        );
      } catch (err) {
        // HTMLRewriter failure of any kind — never let a preview-generation
        // bug break the actual page for a real visitor.
        return withSecurityHeaders(withNoStore(origin));
      }
    }

    // Customer-first homepage strategy: "/" and "/index.html" now redirect
    // straight to "/listings.html", preserving the full query string
    // (?lang=, filters, anything else a visitor arrived with) untouched. A
    // real HTTP 301 — not a client-side redirect — gives crawlers, social
    // previewers, and browsers all correct, link-equity-preserving
    // semantics, and this branch never needs to fetch origin at all.
    // index.html itself is left completely unchanged in the repo (dormant,
    // not deleted, not rewritten) for whenever the product revisits giving
    // agents/sellers homepage prominence, e.g. once agent login ships.
    // MAINTENANCE_MODE is checked above this block, so a maintenance
    // window still returns the 503 here rather than redirecting into a
    // (also 503'd) listings page — this branch is unreached in that case.
    const isHome = path === '/' || path === '/index.html' || path.endsWith('/index.html');
    if (isHome) {
      return withSecurityHeaders(Response.redirect(`https://pintag.io/listings.html${url.search}`, 301));
    }

    // listings.html: no per-property data needed, just the resolved
    // language's static trilingual copy — but still worth guarding with the
    // same never-break-the-real-page try/catch as the listing.html path.
    const isListings = path === '/listings.html' || path.endsWith('/listings.html');
    if (isListings) {
      const origin = await fetch(request, BYPASS_ORIGIN_CACHE);
      const lang = resolveLang(url.searchParams.get('lang'));
      try {
        return withSecurityHeaders(withNoStore(await rewriteGenericHead(origin, lang, LISTINGS_META_I18N)));
      } catch (err) {
        return withSecurityHeaders(origin);
      }
    }

    // Everything else (static assets, other pages) passes straight through
    // with no Supabase call and no rewriting — but still gets the security
    // headers, so an asset on a fronted route is covered too. Only ever
    // reached for a request matching one of this Worker's own routes
    // (wrangler.toml) that isn't "/", /index.html, /listing.html, or
    // /listings.html -- i.e. still a same-zone fetch that could return an
    // HTML page, so it gets the same origin-cache bypass as the branches
    // above rather than being assumed to be a cacheable static asset.
    return withSecurityHeaders(await fetch(request, BYPASS_ORIGIN_CACHE));
  },
};

// Named exports purely so this logic can be unit-tested with plain Node —
// unused by the Worker runtime itself, which only ever imports the default
// export. resolveLang/buildOgFields/canonicalUrl need nothing beyond plain
// Node. rewriteListingHead/rewriteGenericHead use the `HTMLRewriter` global
// that only exists inside the Cloudflare Workers runtime — see
// cloudflare-worker/test/html-rewriter-polyfill.js and
// og-listing-preview.test.js for how they're exercised end-to-end (against
// real fixture HTML from listing.html/index.html/listings.html) from Node.
export {
  resolveLang,
  buildOgFields,
  canonicalUrl,
  HOME_META_I18N,
  LISTINGS_META_I18N,
  rewriteListingHead,
  rewriteGenericHead,
  withNoStore,
  withSecurityHeaders,
  SECURITY_HEADERS,
  ogRenditionUrl,
  renditionExists,
};
