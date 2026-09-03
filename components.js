// components.js — the single shared rendering system for property cards,
// property previews, agent cards, agent previews, and the transaction
// badge. Same loading convention as terminology.js/amenities.js: plain
// global functions, no build step, <script src="components.js"> (after
// terminology.js/amenities.js, which supply getCardFacts()/topAmenities()/
// resolveAmenityData() -- this file calls those, it doesn't duplicate them).
//
// ============================================================================
// OWNERSHIP (read before adding a page or a new card/preview variant)
// ============================================================================
// components.js owns ALL shared rendering logic. shared-components.css owns
// ALL shared styling. No page may define its own copy of a property card,
// property preview, agent card, agent preview, or transaction badge --
// every page composes these via the functions below, with page-specific
// behavior controlled ONLY through each function's documented `opts`, never
// by a page keeping its own parallel implementation "just for this one
// case." If a page's need doesn't fit an existing opt, add the opt here --
// don't fork.
//
// The five public entry points:
//   renderPropertyCard(property, opts)    -> DOM node (<a>)
//   renderPropertyPreview(property, opts) -> DOM node (<a>)
//   renderAgentCard(party, opts)          -> DOM node (<a>)
//   renderAgentPreview(party, opts)       -> DOM node (<div>)
//   renderTransactionBadge(transactionType, lang) -> DOM node (<span>)
// Plus the shared data-shaping / formatting helpers:
//   resolvePartyDisplay(party, listingCount, lang) -> plain object
//   formatPropertyPrice(property, lang)            -> plain object
//
// Visual note: the canonical property card structure is listings.html's
// pre-existing body-below-image layout (richer, already on real design
// tokens) -- NOT index.html's pre-existing dark-gradient-overlay layout.
// The two were incompatible structures sharing the same class name before
// this file existed (see the UI audit). Consolidating to one is a real,
// disclosed visual change on index.html specifically, not a silent one.
// ============================================================================

// ---------------------------------------------------------------------------
// Shared saved-listing (heart/favorite) storage -- was duplicated (and, on
// index.html, entirely dead: onclick="event.preventDefault()") per page.
// One localStorage-backed implementation now, reused by every card; this
// is also the exact substrate a future Favorites page reads from "from
// day one" per this migration's own goal, with zero new infrastructure.
// ---------------------------------------------------------------------------
function ptGetSavedSet() {
  try { return new Set(JSON.parse(localStorage.getItem('pintag_saved') || '[]')); }
  catch (e) { return new Set(); }
}
function ptToggleSave(slug, e, propertyId) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  var saved = ptGetSavedSet();
  var nowSaved = !saved.has(slug);
  if (nowSaved) saved.add(slug); else saved.delete(slug);
  try { localStorage.setItem('pintag_saved', JSON.stringify([...saved])); } catch (e2) {}
  // Server-side save tracking -- was localStorage-only until now (the
  // listing_events schema has always had 'save' in its event_type CHECK,
  // but nothing ever wrote one). Only fires on an actual save, not an
  // unsave, matching how 'share'/'contact' are one-directional actions too.
  // propertyId is optional -- callers that only have a slug (no id in
  // scope) simply skip server-side tracking rather than posting a
  // property_id-less row that couldn't answer "which listing."
  if (nowSaved && propertyId && typeof postEvent === 'function') {
    postEvent('listing_events', {
      property_id: propertyId,
      event_type: 'save',
      session_id: (typeof getOrCreateSessionId === 'function') ? getOrCreateSessionId() : null
    });
  }
  return nowSaved; // caller uses this to update the clicked button's visible state
}

// ---------------------------------------------------------------------------
// Phone numbers for wa.me / tel: links -- the ONE normaliser (QA 2026-09-02).
// Contacts are stored the way staff typed them ("020 5551 2345",
// "+856 20 5551 2345", "0020..."). WhatsApp only accepts E.164 digits, so a
// locally-formatted number produced an invalid wa.me link. Every CTA builder
// (listing.html, agent.html, agents.html, admin.html) calls this instead of
// stripping non-digits itself. Stored values are NOT rewritten.
//   "020 5551 2345"      -> "8562055512345"
//   "+856 20 5551 2345"  -> "8562055512345"
//   "00856 20 5551 2345" -> "8562055512345"
//   "2055512345"         -> "8562055512345"   (Lao mobile without the 0)
//   "+66 81 234 5678"    -> "66812345678"     (other country codes pass through)
// ---------------------------------------------------------------------------
function ptNormalizePhoneDigits(raw) {
  var d = String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.indexOf('00') === 0) d = d.slice(2);                 // international 00 prefix
  if (d.indexOf('856') === 0 && d.length >= 11) return d;    // already Lao E.164
  if (d.charAt(0) === '0') return '856' + d.slice(1);        // 020… / 030… / 021… local format
  if (/^(20|30)[0-9]{8}$/.test(d)) return '856' + d;         // local mobile without the leading 0
  return d;                                                  // another country's code, as typed
}
function ptTelHref(raw) {
  var d = ptNormalizePhoneDigits(raw);
  return d ? 'tel:+' + d : '#';
}

function _ptEsc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// escJs(s) -- for a value interpolated into a JS string literal that lives
// inside an HTML event attribute (onclick="f('VALUE')" / onerror="...'VALUE'").
// The HTML parser decodes entities BEFORE the JS parser reads the attribute, so
// the HTML escaper above is unsafe there: its &#39; decodes back into a live
// apostrophe that closes the JS string. Escape for both parsers, in the order
// they run. See the 2026-08-17 audit and xss-inline-handlers.test.js.
function _ptEscJs(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


// ---------------------------------------------------------------------------
// ptImageUrl(url, profile) -- THE ONE PLACE a public property-image URL is
// sized. Every card, thumbnail, slide and hero asks for a PROFILE rather than
// building a URL itself, so the day a transformation backend exists we change
// one function instead of a dozen call sites.
//
// WHY IT IS CURRENTLY A PASS-THROUGH. The plan was to call Supabase Storage's
// render endpoint. It does not work on this project:
//
//   GET /storage/v1/render/image/public/property-images/<obj>?width=400
//   -> HTTP 403 {"error":"FeatureNotEnabled",
//                "message":"feature not enabled for this tenant"}
//
// Image Transformations are a paid Supabase feature and this project is on
// Free. Verified against production at every width (200/400/1200) with and
// without an Accept: image/webp header -- all 403. The original object
// endpoint answers 200 with cache-control: public, max-age=31536000, immutable.
//
// smart-listing-importer builds the same render URLs and has been silently
// falling back to originals since it shipped (fetchImageBytes returns null on
// !res.ok), which is why the capability looked proven but never was.
//
// So PT_IMAGE_PROFILES is the vocabulary and PINTAG.renditionsEnabled is the
// switch. With the switch off this returns the URL untouched -- byte-for-byte
// today's behaviour, so wiring it in cannot regress anything. Turning it on
// requires only that renditions exist, which upload-time generation and the
// backfill runner provide; no paid transformation backend is involved.
//
// Originals are never modified or deleted. Renditions are additional objects
// under renditions/, and the original stays the source of truth.
// ---------------------------------------------------------------------------
// ptImageUrl(url, profile) -- THE single delivery abstraction for a public
// property image. Every card, thumbnail, slide and hero asks for a PROFILE;
// nothing builds an image URL itself.
//
// It resolves to a WebP RENDITION generated at upload time (image-renditions.js)
// -- NOT to Supabase's render endpoint, which answers 403 FeatureNotEnabled on
// this Free project. No transformation URL is ever emitted.
//
// Renditions are best-effort and the backfill is incremental, so a rendition
// may not exist. That is handled at the <img> level rather than here: callers
// pair this with ptImageFallbackAttrs(), which carries the original in
// data-pt-original and swaps it in on the first error. A missing rendition
// therefore costs one 404 and shows the real photo -- never a broken image.
var PT_IMAGE_PROFILES = {
  thumbnail: { width: 200 },
  card:      { width: 400 },
  gallery:   { width: 800 },
  hero:      { width: 1200 }
};

function ptImageUrl(url, profile) {
  if (!url || typeof url !== 'string') return url;
  var P = (typeof window !== 'undefined') ? window.PINTAG : null;
  if (!P || !P.renditionsEnabled || !P.supabaseUrl) return url;   // flag off -> original
  if (!PT_IMAGE_PROFILES[profile]) return url;
  if (typeof renditionPublicUrl !== 'function') return url;       // module not loaded
  return renditionPublicUrl(url, profile, P.supabaseUrl) || url;
}

// Attributes that make a rendition safe to serve before the backfill has run.
// Emitted next to src so a 404/decode failure falls back to the original ONCE
// (the marker stops any loop) and the visitor still sees the photo.
function ptImageFallbackAttrs(originalUrl) {
  if (!originalUrl || typeof originalUrl !== 'string') return '';
  return ' data-pt-original="' + _ptEsc(originalUrl) + '" onerror="ptImageFallback(this)"';
}

function ptImageFallback(el) {
  if (!el || el.tagName !== 'IMG') return false;
  if (el.dataset && el.dataset.ptFellBack) return false;   // once only
  var original = el.getAttribute && el.getAttribute('data-pt-original');
  if (!original) return false;
  var current = el.getAttribute('src') || '';
  if (current === original) return false;                  // already the original
  if (el.dataset) el.dataset.ptFellBack = '1';
  el.setAttribute('src', original);
  if (typeof window !== 'undefined') {
    window.__ptRenditionFallbacks = (window.__ptRenditionFallbacks || 0) + 1;
  }
  return true;
}

// ptCdnImage(url) -- render-time ONLY rewrite of a PUBLIC property-images URL to
// the Cloudflare image CDN (img.pintag.io), so repeat views are served from
// Cloudflare cache instead of Supabase egress (P1). It NEVER mutates a database
// value: callers pass the stored URL and use the returned string solely for an
// <img src>. Pure and side-effect-free.
//
// Gated by window.PINTAG.imageCdn (default true in production, false in dev; set
// false for an instant, deploy-free rollback -> images fall back to the direct
// Supabase URL). It rewrites ONLY the current project's public property-images
// objects. Everything else is returned UNCHANGED:
//   * agent-photos (different bucket/path)
//   * external / Facebook CDN URLs
//   * data: URIs
//   * other Supabase paths (rest/auth/authenticated storage)
//   * anything already pointing at the CDN, or any non-string
// The query string is stripped so the CDN cache key stays stable (public
// property images never carry a meaningful query today).
var PT_IMAGE_CDN_ORIGIN = 'https://img.pintag.io';
var PT_PROPERTY_IMAGES_PATH = '/storage/v1/object/public/property-images/';
function ptCdnImage(url) {
  if (!url || typeof url !== 'string') return url;
  var P = (typeof window !== 'undefined') ? window.PINTAG : null;
  if (!P || !P.imageCdn || !P.supabaseUrl) return url;   // flag off / dev / no config
  var base = P.supabaseUrl + PT_PROPERTY_IMAGES_PATH;
  if (url.indexOf(base) !== 0) return url;                // only THIS project's public property-images
  return PT_IMAGE_CDN_ORIGIN + PT_PROPERTY_IMAGES_PATH + url.slice(base.length).split('?')[0];
}

// ptCdnImageFallback(el) -- belt-and-suspenders for the new CDN dependency. If
// an <img> we routed through img.pintag.io FAILS to load, retry it ONCE from
// its original direct Supabase URL, then stop. Returns true iff it performed a
// fallback (used by the tests + the installer).
//
// Guarantees the requirements: acts ONLY on our CDN property-images URLs (agent
// photos, external/Facebook, data:, already-direct Supabase, and non-images are
// ignored); marks the element (dataset.cdnFallback) so it can NEVER loop; only
// runs from an actual 'error' (never mid-load); never changes the stored DB URL
// (only the live el.src); preserves every other attribute (dimensions, lazy,
// lightbox). Observable so a broken Worker can't hide: it warns, increments
// window.__ptCdnFallbacks, and dispatches a 'pintag:cdn-fallback' event (wire it
// to analytics for fleet-wide visibility). window.PINTAG.imageCdn = false
// remains the immediate global rollback (then nothing renders CDN URLs at all).
function ptCdnImageFallback(el) {
  if (!el || el.tagName !== 'IMG') return false;
  var src = el.currentSrc || (el.getAttribute && el.getAttribute('src')) || el.src || '';
  var cdnBase = PT_IMAGE_CDN_ORIGIN + PT_PROPERTY_IMAGES_PATH;
  if (src.indexOf(cdnBase) !== 0) return false;               // only OUR CDN property-images
  if (el.dataset && el.dataset.cdnFallback) return false;     // already retried once -> never loop
  var P = (typeof window !== 'undefined') ? window.PINTAG : null;
  if (!P || !P.supabaseUrl) return false;
  if (el.dataset) el.dataset.cdnFallback = '1';
  var direct = P.supabaseUrl + PT_PROPERTY_IMAGES_PATH + src.slice(cdnBase.length);
  if (typeof window !== 'undefined') {
    window.__ptCdnFallbacks = (window.__ptCdnFallbacks || 0) + 1;
    try { console.warn('[pintag] image CDN fallback -> direct Supabase (#' + window.__ptCdnFallbacks + '): ' + src); } catch (_e) {}
    try { window.dispatchEvent(new CustomEvent('pintag:cdn-fallback', { detail: { cdn: src, direct: direct, count: window.__ptCdnFallbacks } })); } catch (_e2) {}
  }
  el.src = direct;   // retry once from origin; all other attributes untouched
  return true;
}

// Install ONE global, capturing 'error' listener (image error events do not
// bubble, so capture=true is required to catch them at the document). No
// per-<img> wiring -> every current and future property image is covered
// without changing any render markup. It runs before an element's own inline
// onerror (capture precedes target), and defers to it for non-CDN images.
(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (window.__ptCdnFallbackInstalled) return;
  window.__ptCdnFallbackInstalled = true;
  document.addEventListener('error', function (e) { ptCdnImageFallback(e.target); }, true);
})();

// Canonical listing-detail URL for a property. Prefers the human-readable
// ?slug= (the shareable, OG-friendly form), but falls back to ?id=<uuid>
// when a listing has no slug yet -- some listings finished via the admin
// edit path were saved without a slug, and a bare "listing.html?slug="
// lands on the "No property selected" error. listing.html accepts either.
function _ptListingHref(p) {
  if (p && p.slug) return 'listing.html?slug=' + encodeURIComponent(p.slug);
  if (p && p.id) return 'listing.html?id=' + encodeURIComponent(p.id);
  return 'listing.html';
}

// Card-chrome a11y strings (heart button / no-photo placeholder) -- were
// hardcoded English regardless of `lang`, invisible to sighted users but
// still part of "the site's language" for a screen-reader visitor.
var PT_SAVE_LABEL = { lo:'ບັນທຶກລາຍການ', en:'Save listing', zh:'收藏房源' };
var PT_UNSAVE_LABEL = { lo:'ເອົາອອກຈາກທີ່ບັນທຶກ', en:'Remove from saved', zh:'取消收藏' };
var PT_NO_PHOTO_LABEL = { lo:'ບໍ່ມີຮູບພາບ', en:'No photo available', zh:'暂无照片' };

function _ptApplyDataTrack(el, dataTrack) {
  if (!dataTrack) return;
  Object.keys(dataTrack).forEach(function(key) {
    if (dataTrack[key] != null) el.setAttribute('data-track' + (key === 'track' ? '' : '-' + key), String(dataTrack[key]));
  });
}

// ---------------------------------------------------------------------------
// Shared formatters -- so price/transaction-label logic exists exactly once,
// not once per page (Rule E: "formatting logic should never be duplicated").
// ---------------------------------------------------------------------------

var PT_TRANSACTION_LABELS = {
  rent: { lo:'ໃຫ້ເຊົ່າ', en:'For Rent', zh:'租房' },
  sale: { lo:'ຂາຍ',      en:'For Sale', zh:'出售' },
  sor:  { lo:'ຊື້ / ເຊົ່າ', en:'Sale or Rent', zh:'售/租' }
};
function _ptTransactionKind(transactionType) {
  if (transactionType === 'sale_or_rent') return 'sor';
  if (transactionType === 'for_sale' || transactionType === 'sale') return 'sale';
  return 'rent';
}
function transactionLabel(transactionType, lang) {
  lang = lang || 'en';
  var kind = _ptTransactionKind(transactionType);
  return PT_TRANSACTION_LABELS[kind][lang] || PT_TRANSACTION_LABELS[kind].en;
}

// formatPropertyPrice(property, lang) -- single source of truth for how a
// listing's price renders, whether single-price or sale_or_rent dual-price,
// including the "Price on request" fallback.
//
// Reads the structured price_amount/price_currency/price_frequency columns
// (20260731000000_structured_pricing.sql) when present -- the source of
// truth. Falls back to the legacy price_display/sale_price/rent_price text
// only for a row that predates that migration's backfill (should be zero
// once the backfill has run, but costs nothing to keep as a safety net
// during rollout). Never mixes the two per property: a listing either has
// structured data or it doesn't.
//
// PT_PER_MONTH is kept as the legacy-path suffix (that text path never had
// any other frequency to express). The structured path uses
// _ptFrequencySuffix(), which is what actually fixes the pre-existing bug
// where every rental rendered "/ month" regardless of its real
// price_frequency (yearly/weekly/daily/negotiable were silently ignored).
var PT_PER_MONTH = { lo:'/ ເດືອນ', en:'/ month', zh:'/ 月' };
var PT_PRICE_ON_REQUEST = { lo:'ສອບຖາມລາຄາ', en:'Price on request', zh:'价格面议' };
var PT_FREQUENCY_SUFFIX = {
  monthly:    { lo:'/ ເດືອນ',      en:'/ month', zh:'/ 月' },
  yearly:     { lo:'/ ປີ',         en:'/ year',  zh:'/ 年' },
  weekly:     { lo:'/ ອາທິດ',      en:'/ week',  zh:'/ 周' },
  daily:      { lo:'/ ມື້',        en:'/ day',   zh:'/ 天' },
  negotiable: { lo:'(ເຈລະຈາໄດ້)',  en:'(negotiable)', zh:'(可议价)' }
};
function _ptFrequencySuffix(frequency, lang) {
  var entry = PT_FREQUENCY_SUFFIX[frequency] || PT_FREQUENCY_SUFFIX.monthly;
  return entry[lang] || entry.en;
}
// _ptHasOpenUnit(property) -> true | false | null
//
// "Is any unit type rentable TODAY?", resolved through
// unit-availability.js' resolveUnitAvailability() -- that module's only
// sanctioned read API (see its rule 3). This is the UNIT-LEVEL source of
// truth for current availability, and for a listing that has unit types it
// outranks properties.market_status.
//
// WHY IT EXISTS. properties.market_status is a standalone manual dropdown in
// admin (f-market-status); nothing derives it from unit occupancy -- no
// trigger, no save-path logic. resolveListingStatus() defaults a NULL
// market_status to 'available'. So the ordinary production shape is: staff
// switch off each unit type's Available checkbox and type a
// next_available_date, and never touch the separate Market Status dropdown.
// Both availability gates below used to read market_status ALONE, so they
// went silent on exactly the listings that had something to say. Staff must
// not have to restate in a second field what the unit rows already record.
//
// RETURNS NULL, NOT FALSE, when unit data cannot answer the question -- no
// unit types, or a version-mismatched cache without unit-availability.js.
// Callers must treat null as "ask market_status instead"; reading it as false
// would mark every single-unit listing unavailable.
//
// DELIBERATELY NOT MERGED with ptResolveListingFomo's counting loop. That loop
// answers a different question -- "how many units, exactly?" -- and needs a
// trustworthy numeric available_count before it will claim "Only 1 left". This
// one is a boolean: a unit that is open but tracks no count is still open.
// Folding them together would either loosen FOMO's numeric rule or wrongly
// treat a countless-but-open unit as closed.
function _ptHasOpenUnit(property) {
  var units = (property && Array.isArray(property.unit_types)) ? property.unit_types : [];
  if (!units.length || typeof resolveUnitAvailability !== 'function') return null;
  for (var i = 0; i < units.length; i++) {
    if (resolveUnitAvailability(units[i]).status === 'available') return true;
  }
  return false;
}

// _ptIsUnavailableNow(property) -- the ONE availability gate both
// ptResolveNextAvailable() and ptResolveListingFomo() ask. Unit rows win when
// they exist; market_status answers for everything else. Returns the reason so
// a caller can label a unit-derived closure correctly ('fully_occupied') rather
// than reaching for market_status, which in that case still says 'available'.
function _ptIsUnavailableNow(property) {
  var status = (typeof resolveListingStatus === 'function') ? resolveListingStatus(property) : null;
  if (!status) return null;
  if (!status.isPubliclyAvailable) return { unavailable: true, market: status.market, source: 'market_status' };
  if (_ptHasOpenUnit(property) === false) return { unavailable: true, market: 'fully_occupied', source: 'unit_types' };
  return { unavailable: false, market: status.market, source: null };
}

// ptResolveNextAvailable(property, lang, nowIso) -- the FOURTH axis: when an
// unavailable listing frees up. Shared by the listing card and the detail page
// so there is exactly one implementation of "which date, and is it real".
//
// SOURCE OF TRUTH -- two existing columns, no new field:
//   unit_types.next_available_date   per unit type. Read ONLY through
//                                    resolveUnitAvailability(), as that
//                                    column's own comment requires.
//   properties.available_from        per listing; the plain-listing complement
//                                    for a property with no unit_types rows.
// Both are documented as never fabricated or estimated: NULL means "no date on
// file", and this function returns null for that rather than guessing.
//
// INDEPENDENT OF PRICE AND FOMO. It reads no price field, and nothing here can
// suppress a price -- an occupied listing shows its price AND its next-available
// date. It is also not scarcity messaging: a date is a fact, not persuasion.
//
// GATED ON THE LISTING BEING UNAVAILABLE. A listing you can rent today does not
// need a future date; resolveListingStatus().isPubliclyAvailable is the single
// gate, the same one every other consumer branches on.
//
// MULTI-UNIT: takes the EARLIEST qualifying date across all unit types, so a
// building where one unit frees up sooner advertises that unit's date. The
// property-level available_from is considered alongside them, so a building
// that also carries a listing-level date cannot be missed.
//
// "Genuine future" is >= today, compared as ISO date strings (both are `date`
// columns, so this is timezone-robust and needs no Date arithmetic). A date in
// the PAST is stale data and is discarded -- "Available 3 Jan 2020" would be
// worse than showing nothing.
function ptResolveNextAvailable(property, lang, nowIso) {
  lang = lang || 'en';
  if (!property) return null;

  var avail = _ptIsUnavailableNow(property);
  if (!avail || !avail.unavailable) return null;            // rentable now -> no future date

  var today = nowIso || new Date().toISOString().slice(0, 10);
  var candidates = [];

  var units = Array.isArray(property.unit_types) ? property.unit_types : [];
  if (units.length && typeof resolveUnitAvailability === 'function') {
    for (var i = 0; i < units.length; i++) {
      var d = resolveUnitAvailability(units[i]).nextAvailableDate;
      if (d) candidates.push(d);
    }
  }
  if (property.available_from) candidates.push(property.available_from);

  var earliest = null;
  for (var j = 0; j < candidates.length; j++) {
    var c = candidates[j];
    if (typeof c !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c)) continue;  // malformed -> ignore
    if (c < today) continue;                                                 // stale -> ignore
    if (earliest === null || c < earliest) earliest = c;
  }
  if (!earliest) return null;

  // Existing trilingual date convention (unit-availability.js), not a new one.
  var dateText = (typeof _formatAvailabilityDate === 'function')
    ? _formatAvailabilityDate(earliest, lang) : earliest;
  if (!dateText) return null;

  var label = { en: 'Available', lo: 'ວ່າງ', zh: '可入住' };
  return { isoDate: earliest, dateText: dateText, text: (label[lang] || label.en) + ' ' + dateText };
}

// ptResolveListingFomo(property, lang) -- the THIRD axis, kept strictly apart
// from price and from raw availability.
//
// The three concepts this card renders are independent and must stay that way:
//
//   PRICE        what it costs                 -> formatPropertyPrice()
//   AVAILABILITY inventory/market state        -> resolveListingStatus() /
//                                                 resolveUnitAvailability()
//   FOMO         derived persuasion messaging  -> here
//
// Collapsing any two of them is what produced the reported bug: an unavailable
// listing lost its price, because "unavailable" was allowed to suppress
// pricing. Nothing in this function is consulted when deciding whether to show
// a price, and nothing here invents inventory.
//
// NEVER FABRICATE SCARCITY. Every claim below is backed by a column:
//   * "Only N left" requires unit_types rows with a real available_count.
//     Absent unit data, no scarcity claim is made AT ALL -- not a softened one.
//   * "N of M available" additionally requires total_units to be tracked.
//   * The unavailable/"missed it" line is backed by market_status, which is a
//     statement of fact rather than persuasion, so it is always safe to show.
// A listing with no inventory data gets no FOMO line, which is the correct and
// honest outcome, not a gap to fill.
function ptResolveListingFomo(property, lang) {
  lang = lang || 'en';
  // Same gate as ptResolveNextAvailable (_ptIsUnavailableNow): unit rows win
  // when they exist, market_status answers otherwise. A building whose every
  // unit type is occupied reads as 'fully_occupied' even while its untouched
  // market_status column still says 'available'.
  var avail = _ptIsUnavailableNow(property);

  // ── Unavailable: state it plainly. Factual, never scarcity bait. ──────────
  if (avail && avail.unavailable) {
    var missed = {
      rented:         { en: 'Just rented — see similar', lo: 'ຫາກໍ່ຖືກເຊົ່າ — ເບິ່ງແບບຄ້າຍກັນ', zh: '刚被租出 — 查看类似房源' },
      sold:           { en: 'Just sold — see similar',   lo: 'ຫາກໍ່ຖືກຂາຍ — ເບິ່ງແບບຄ້າຍກັນ',  zh: '刚售出 — 查看类似房源' },
      reserved:       { en: 'Reserved',                  lo: 'ຖືກຈອງແລ້ວ',                    zh: '已预订' },
      fully_occupied: { en: 'Fully occupied',            lo: 'ເຕັມແລ້ວ',                       zh: '已住满' },
      off_market:     { en: 'Off market',                lo: 'ບໍ່ຢູ່ໃນຕະຫຼາດ',                 zh: '已下架' }
    }[avail.market];
    if (!missed) return null;
    return { kind: 'missed', tone: 'unavailable', text: missed[lang] || missed.en };
  }

  // ── Available: scarcity ONLY from real unit inventory. ───────────────────
  var units = (property && Array.isArray(property.unit_types)) ? property.unit_types : [];
  if (!units.length || typeof resolveUnitAvailability !== 'function') return null;

  var open = 0, total = 0, haveTotals = true, sawCount = false;
  for (var i = 0; i < units.length; i++) {
    var a = resolveUnitAvailability(units[i]);
    if (a.status !== 'available') continue;
    if (typeof a.availableCount !== 'number') continue;
    sawCount = true;
    open += a.availableCount;
    if (a.totalUnits == null) haveTotals = false; else total += a.totalUnits;
  }
  if (!sawCount || open <= 0) return null;   // nothing truthful to say

  if (open === 1) {
    var one = { en: 'Only 1 left', lo: 'ເຫຼືອພຽງ 1 ຫ້ອງ', zh: '仅剩 1 间' };
    return { kind: 'last_one', tone: 'urgent', text: one[lang] || one.en, count: 1 };
  }
  // "N of M" needs M genuinely tracked, and is only interesting while scarce.
  if (haveTotals && total > 0 && open / total <= 0.25) {
    var few = {
      en: open + ' of ' + total + ' available',
      lo: 'ວ່າງ ' + open + ' ຈາກ ' + total,
      zh: total + ' 间中仅剩 ' + open + ' 间'
    };
    return { kind: 'scarce', tone: 'urgent', text: few[lang] || few.en, count: open, total: total };
  }
  return null;
}

// ptBuildUnitPriceText(property, resolvedUnit, lang) / ptResolveUnitTypesPrice()
// -- the unit-type price fallback, shared by the CARD and the DETAIL page.
//
// WHY THIS EXISTS AT ALL (the bug it fixes)
// -----------------------------------------
// admin derives properties.price_amount from AVAILABLE unit types only
// (syncPricingMode -> _utActiveAmounts filters on the Available checkbox). So
// the moment a multi-unit building is marked fully occupied and saved, its
// property-level price is written back as NULL. The price did not become
// unknown -- it still exists on every unit_types row -- but the column the card
// reads is now empty, and the card fell through to "Price on request".
//
// The detail page already worked around this (listing.html's
// resolveUnitTypesPriceText). The CARD never did, because listings.html's query
// did not embed unit_types at all, so there was nothing to fall back TO. Both
// halves are fixed: the query now embeds them, and this is the one shared
// implementation both surfaces call, rather than a second copy on the card.
//
// PRICE IS NEVER GATED ON AVAILABILITY. Nothing in here reads is_available,
// available_count or market_status. An unavailable listing has a price and must
// show it; "unavailable" is a separate axis rendered separately (see
// ptResolveListingFomo below). This is deliberate and load-bearing: hiding the
// price of a rented listing destroys the market history that is the whole point
// of keeping unavailable listings visible.
//
// Picks the CHEAPEST resolvable unit -- the same "starting from min" convention
// admin uses for the building-level price. Returns null when nothing resolves.
function ptBuildUnitPriceText(property, resolved, lang) {
  var isSorUnit = property.transaction_type === 'sale_or_rent';
  if (isSorUnit) {
    var parts = [];
    if (resolved.priceAmount != null || resolved.rentPriceAmount != null) {
      if (resolved.priceAmount != null) parts.push(formatMoney(resolved.priceAmount, resolved.priceCurrency));
      if (resolved.rentPriceAmount != null) {
        parts.push(formatMoney(resolved.rentPriceAmount, resolved.rentPriceCurrency) + ' ' + _ptFrequencySuffix(resolved.rentPriceFrequency, lang));
      }
    } else if (resolved.salePrice || resolved.rentPrice) {
      var period = resolved.rentPeriod || 'month';
      var periodLabel = { month: PT_PER_MONTH, year: { lo: '/ ປີ', en: '/ year', zh: '/ 年' }, day: { lo: '/ ວັນ', en: '/ day', zh: '/ 天' } };
      if (resolved.salePrice) parts.push(resolved.salePrice);
      if (resolved.rentPrice) parts.push(resolved.rentPrice + (periodLabel[period] || PT_PER_MONTH)[lang]);
    }
    return parts.length ? parts.join(' · ') : null;
  }
  if (resolved.priceAmount != null) {
    var text = formatMoney(resolved.priceAmount, resolved.priceCurrency);
    return property.transaction_type === 'for_rent'
      ? (text + ' ' + _ptFrequencySuffix(resolved.priceFrequency, lang))
      : text;
  }
  return resolved.priceDisplay || null;
}

// ptResolveUnitTypesPriceEntry() -- the one implementation. Returns the
// CHEAPEST resolvable unit as { amount, currency, text }, or null when nothing
// resolves. `amount` is null for a unit priced only as legacy display text
// (there is no trustworthy number to sort or band-filter on in that case; the
// callers below treat that exactly like "no numeric price on file", which is
// what they already did for an unbackfilled property row).
//
// Separated from ptResolveUnitTypesPrice() because sorting and price-band
// filtering on the search page need the NUMBER and the CURRENCY, not the
// rendered string -- and must agree, row for row, with what the card displays.
// Two independent notions of "this listing's price" is how the card and the
// sort key drift apart.
function ptResolveUnitTypesPriceEntry(property, lang) {
  lang = lang || 'en';
  var units = (property && Array.isArray(property.unit_types)) ? property.unit_types : [];
  // resolveUnitType() lives in terminology.js. Feature-detected because
  // components.js also runs on pages that do not load it; there the card simply
  // behaves as it did before this fallback existed.
  if (!units.length || typeof resolveUnitType !== 'function') return null;
  var best = null;
  for (var i = 0; i < units.length; i++) {
    var resolvedUnit = resolveUnitType(property, units[i]);
    var text = ptBuildUnitPriceText(property, resolvedUnit, lang);
    if (!text) continue;
    var amt = null, cur = null;
    if (resolvedUnit.priceAmount != null) {
      amt = resolvedUnit.priceAmount; cur = resolvedUnit.priceCurrency;
    } else if (resolvedUnit.rentPriceAmount != null) {
      amt = resolvedUnit.rentPriceAmount; cur = resolvedUnit.rentPriceCurrency;
    }
    if (best === null || (amt != null && (best.amount == null || amt < best.amount))) {
      best = { amount: amt, currency: cur, text: text };
    }
  }
  return best;
}

function ptResolveUnitTypesPrice(property, lang) {
  var best = ptResolveUnitTypesPriceEntry(property, lang);
  return best ? best.text : null;
}

// ptResolveSortPrice(property) -- the numeric price key for SORTING and
// PRICE-BAND FILTERING, resolved through the same precedence the card uses:
// structured property column -> cheapest unit type -> legacy display text.
//
// The unit-type step matters for rows saved by an admin build that predates
// the _utPriceEntries() fix, which nulled properties.price_amount whenever
// every unit was occupied. Without it those listings sort as if they cost 0
// (bottom of price_asc, and unplaceable in any band) purely because they are
// currently rented -- price silently coupled to availability again, on the
// read side this time. Returns { amount, currency } with amount null when
// there is genuinely no numeric price on file. Never fabricates a number.
function ptResolveSortPrice(property, parseLegacy) {
  if (!property) return { amount: null, currency: null };
  if (property.price_amount != null) {
    return { amount: property.price_amount, currency: property.price_currency || null };
  }
  var unit = ptResolveUnitTypesPriceEntry(property, 'en');
  if (unit && unit.amount != null) {
    return { amount: unit.amount, currency: unit.currency || null };
  }
  if (typeof parseLegacy === 'function') {
    var legacy = parseLegacy(property.price_display);
    if (legacy) return { amount: legacy, currency: property.price_currency || null };
  }
  return { amount: null, currency: property.price_currency || null };
}

function formatPropertyPrice(property, lang) {
  lang = lang || 'en';
  var kind = _ptTransactionKind(property.transaction_type);
  var isSor = kind === 'sor';

  if (isSor) {
    var hasStructuredSor = property.price_amount != null || property.rent_price_amount != null;
    if (hasStructuredSor) {
      var saleText = property.price_amount != null ? formatMoney(property.price_amount, property.price_currency) : (property.sale_price || null);
      var rentText = property.rent_price_amount != null
        ? (formatMoney(property.rent_price_amount, property.rent_price_currency) + ' ' + _ptFrequencySuffix(property.rent_price_frequency, lang))
        : (property.rent_price ? (property.rent_price + ' ' + PT_PER_MONTH[lang]) : null);
      return { isSor: true, saleText: saleText, rentText: rentText, isPriceOnRequest: false };
    }
    if (property.sale_price || property.rent_price) {
      return {
        isSor: true,
        saleText: property.sale_price || null,
        rentText: property.rent_price ? (property.rent_price + ' ' + PT_PER_MONTH[lang]) : null,
        isPriceOnRequest: false
      };
    }
    // Neither leg has any data at all (structured or legacy) -- fall
    // through to the single-price path below, matching the original
    // behavior of treating price_display as a plain price in this case.
  }

  if (property.price_amount != null) {
    var moneyText = formatMoney(property.price_amount, property.price_currency);
    var showUnit = kind === 'rent';
    return { isSor: false, singleText: moneyText, unitText: showUnit ? _ptFrequencySuffix(property.price_frequency, lang) : null, isPriceOnRequest: false };
  }

  // Legacy fallback -- unbackfilled row. "month" must be tried before "mo"
  // in the alternation, otherwise the shorter alternative matches first
  // and leaves a stray "nth" behind.
  var raw = (property.price_display || '').replace(/\s*\/\s*(ເດືອນ|month|mo|月)\s*/i, '').trim();
  if (!raw) {
    // LAST RESORT BEFORE GIVING UP: the listing may be priced only under its
    // unit types. That is the normal state for a fully-occupied multi-unit
    // building, whose property-level price admin nulls out on save. Falling
    // back here rather than at each call site means the card, the detail page
    // and any future surface all recover the price identically.
    var unitText = ptResolveUnitTypesPrice(property, lang);
    if (unitText) {
      return { isSor: false, singleText: unitText, unitText: null, isPriceOnRequest: false, priceSource: 'unit_type' };
    }
    return { isSor: false, singleText: null, isPriceOnRequest: true, requestText: PT_PRICE_ON_REQUEST[lang] };
  }
  var showUnitLegacy = kind === 'rent';
  return { isSor: false, singleText: raw, unitText: showUnitLegacy ? PT_PER_MONTH[lang] : null, isPriceOnRequest: false };
}

// resolvePartyDisplay(party, listingCount, lang) -- the shared data-shaping
// function both renderAgentCard() and renderAgentPreview() call, so
// "should I show the verified badge / agency / listing count" is decided
// once, not re-derived per renderer. `listingCount` is optional -- pages
// that don't have it available (no aggregation query on that page) pass
// null/undefined, and the count line is gracefully omitted, per the
// documented graceful-placeholder rule (an omitted stat reads as neutral,
// a "0 listings" stat reads as discouraging). `lang` controls display-name
// precedence (Lao-primary pages want name_lo first, matching for-agents.html's
// pre-existing behavior; English-primary contexts want name_en first).
function resolvePartyDisplay(party, listingCount, lang) {
  if (!party) return null;
  // lang==='lo' is the only case allowed to prefer name_lo/bio_lo -- every
  // other language falls back to English only, never Lao (party has no
  // name_zh/bio_zh source data today, so zh also resolves through the
  // English branch here, same "never leak Lao" rule as every other
  // localized field on the site).
  var name = (lang === 'lo')
    ? (party.name_lo || party.name_en || 'Agent')
    : (party.name_en || 'Agent');
  var bio = (lang === 'lo')
    ? (party.bio_lo || party.bio_en || null)
    : (party.bio_en || null);
  return {
    photo: party.photo_url || null,
    initial: (name.trim().charAt(0) || 'P').toUpperCase(),
    name: name,
    nameLo: party.name_lo || null,
    agency: party.agency_name || null,
    verified: !!party.is_verified,
    bio: bio,
    listingCount: (listingCount != null && listingCount > 0) ? listingCount : null,
    slug: party.slug || null,
    whatsapp: party.whatsapp || null
  };
}

// ---------------------------------------------------------------------------
// renderTransactionBadge(transactionType, lang) -- ONE component, ONE CSS
// block (.pt-badge-transaction in shared-components.css). Only the color
// modifier class differs between Rent/Sale/Sale-or-Rent -- radius, padding,
// typography, shadow, position are identical by construction, not by
// convention, because they're all the same CSS rule.
// ---------------------------------------------------------------------------
function renderTransactionBadge(transactionType, lang) {
  lang = lang || 'en';
  var kind = _ptTransactionKind(transactionType);
  var el = document.createElement('span');
  el.className = 'pt-badge-transaction pt-tx-' + kind;
  el.textContent = transactionLabel(transactionType, lang);
  return el;
}

// ---------------------------------------------------------------------------
// renderPropertyCard(property, opts) -- the grid tile: Home, Listings/
// Search Results, an agent's own listing grid, future Favorites.
//
// opts (all optional):
//   lang               'en'|'lo'|'zh', default 'en'
//   isFeatured         bool -- editorial split-layout variant
//   showTransactionBadge bool, default false -- image-overlay pill via
//                       renderTransactionBadge(). Off by default because
//                       not every page shows transaction as a pill (some
//                       show it as body text via showCardTag instead).
//   statusBadgeHtml    raw HTML string for a top-left status pill (Sold/
//                       Available/Curated/...) -- status derivation is
//                       page-specific business logic, deliberately not
//                       centralized here (see shared-components.css's own
//                       note: status and transaction-type are separate,
//                       intentionally un-merged concerns).
//   extraOverlayHtml   raw HTML string appended into the top-left overlay
//                       (e.g. a "New This Week" badge) -- page-specific.
//   photoCountHtml     raw HTML string for the bottom-right photo-count
//                       chip -- page-specific (only listings.html has this).
//   aiHtml             raw HTML string for the bottom-left AI-walkthrough
//                       badge -- page-specific.
//   showCardTag        bool, default false -- plain-text transaction/type
//                       label in the body (listings.html's existing style).
//   activityBadgesHtml raw HTML string of FOMO/engagement badges (an
//                       already-consistent, separate system -- see note
//                       inline below), rendered just under the card tag.
//   showSpecs          bool, default true -- getCardFacts() icon row.
//   showAmenities      bool, default false -- top-priority amenity icons.
//   showAgentRow       bool, default true -- compact contact/agent row.
//   showHeart          bool, default true.
//   isSaved            bool.
//   onHeartToggle(slug, event) -- called on heart click; card does NOT
//                       manage saved-state storage itself (stays page-
//                       specific, e.g. localStorage vs. a future API).
//   footerHtml         raw HTML string appended after everything else in
//                       the body -- the documented escape hatch for
//                       genuinely page-specific trailing content (an
//                       activity line, or dashboard.html's stats+actions).
//   dataTrack          {type, propertyId, label, meta, ...} -> data-track-*
//                       attributes, page decides its own tracking scheme.
//   onClick(event)      click handler on the card itself.
//   tag                'a' (default) -- a real link to the public listing
//                       page. 'div' -- a non-navigating container instead,
//                       for a context like dashboard.html's own listing
//                       grid where the card hosts its own Edit/Delete
//                       buttons and must not also double as a link to the
//                       public site (nested-interactive-element UX/
//                       accessibility problem, not just a style one).
// ---------------------------------------------------------------------------
function renderPropertyCard(property, opts) {
  opts = opts || {};
  var lang = opts.lang || 'en';
  var p = property;

  var card = document.createElement(opts.tag === 'div' ? 'div' : 'a');
  if (opts.tag !== 'div') card.href = _ptListingHref(p);
  card.className = 'pt-card' + (opts.isFeatured ? ' pt-featured' : '');
  if (opts.dataTrack) _ptApplyDataTrack(card, opts.dataTrack);
  if (opts.onClick) card.addEventListener('click', opts.onClick);

  var title = _ptEsc(p['title_' + lang] || p.title_en || '');
  var district = _ptEsc(p['district_' + lang] || p.district_en || '');
  var images = (Array.isArray(p.images) ? p.images.filter(Boolean) : []).map(ptCdnImage);
  var imgHtml = images.length
    ? '<img src="' + _ptEsc(ptImageUrl(images[0], 'card')) + '" alt="' + title + '" loading="lazy"' + ptImageFallbackAttrs(images[0]) + '>'
    : '<div class="pt-card-no-img" role="img" aria-label="' + _ptEsc(PT_NO_PHOTO_LABEL[lang] || PT_NO_PHOTO_LABEL.en) + '"></div>';

  var overlayTl = (opts.statusBadgeHtml || '') + (opts.extraOverlayHtml || '');
  var badgeHtml = opts.showTransactionBadge ? renderTransactionBadge(p.transaction_type, lang).outerHTML : '';

  var heartHtml = opts.showHeart !== false
    ? '<button type="button" class="pt-heart-btn' + (opts.isSaved ? ' pt-saved' : '') + '" aria-label="' +
        _ptEsc((opts.isSaved ? PT_UNSAVE_LABEL : PT_SAVE_LABEL)[lang] || (opts.isSaved ? PT_UNSAVE_LABEL : PT_SAVE_LABEL).en) + '" aria-pressed="' + (!!opts.isSaved) + '">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1A2428" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>' +
      '</button>'
    : '';

  var cardTagHtml = opts.showCardTag
    ? '<p class="pt-card-tag">' + _ptEsc(transactionLabel(p.transaction_type, lang)) +
        (p.property_type ? ' · ' + _ptEsc(p.property_type.charAt(0).toUpperCase() + p.property_type.slice(1)) : '') + '</p>'
    : '';

  var specsHtml = '';
  if (opts.showSpecs !== false && typeof getCardFacts === 'function') {
    var facts = getCardFacts(p.property_type, p, lang) || [];
    if (facts.length) {
      specsHtml = '<div class="pt-card-specs">' + facts.map(function(f) {
        return '<span class="pt-card-spec">' + f.icon + ' <span>' + _ptEsc(String(f.value)) + '</span></span>';
      }).join('') + '</div>';
    }
  }

  var amenitiesHtml = '';
  if (opts.showAmenities && typeof topAmenities === 'function' && typeof resolveAmenityData === 'function') {
    var topAms = topAmenities(p.amenities, 4) || [];
    if (topAms.length) {
      amenitiesHtml = '<div class="pt-card-amenities" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">' + topAms.map(function(am) {
        var resAm = resolveAmenityData(am, lang);
        return '<span class="pt-card-amenity" title="' + _ptEsc(resAm.label) + '" aria-label="' + _ptEsc(resAm.label) + '" style="font-size:13px;line-height:1;opacity:.82;width:24px;height:24px;border-radius:50%;background:var(--pt-off);border:1px solid var(--pt-border);display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + resAm.icon + '</span>';
      }).join('') + '</div>';
    }
  }

  // Secondary daily-rate line. A short-stay daily rate is a headline
  // differentiator, so a listing that offers one says so on the CARD rather
  // than only on the detail page -- but never in place of the main rent, and
  // never duplicated when the listing's primary price IS already a daily one.
  //
  // resolveLeasePricing() (lease-pricing.js) is the only allowed reader of
  // those columns (rule 3). Feature-detected because components.js also runs
  // on pages that have no reason to load the pricing module; there the card
  // renders exactly as it did before.
  var dailyExtraHtml = '';
  if (typeof resolveLeasePricing === 'function' && p.price_frequency !== 'daily' && p.rent_price_frequency !== 'daily') {
    var _cardLease = resolveLeasePricing(p, null);
    for (var _li = 0; _li < _cardLease.terms.length; _li++) {
      if (_cardLease.terms[_li].key !== 'daily') continue;
      var _dailyText = formatLeaseTermAmount(_cardLease.terms[_li], _cardLease.currency, lang);
      if (_dailyText) dailyExtraHtml = '<p class="pt-card-price-daily">' + _ptEsc(_dailyText) + '</p>';
      break;
    }
  }

  var price = formatPropertyPrice(p, lang);
  var priceHtml;
  if (price.isSor) {
    priceHtml = (price.saleText ? '<p class="pt-card-price">' + _ptEsc(price.saleText) + '</p>' : '') +
                (price.rentText ? '<p class="pt-card-price">' + _ptEsc(price.rentText) + '</p>' : '');
  } else if (price.isPriceOnRequest) {
    priceHtml = '<p class="pt-card-price-req">' + _ptEsc(price.requestText) + '</p>';
  } else {
    priceHtml = '<p class="pt-card-price">' + _ptEsc(price.singleText) + (price.unitText ? ' <span class="pt-card-price-unit">' + _ptEsc(price.unitText) + '</span>' : '') + '</p>';
  }
  // "$450 / month · Available 15 Sep 2026" -- a compact inline suffix on the
  // PRICE paragraph itself, not another block, so the card does not grow a line.
  // Appended before dailyExtraHtml so it attaches to the price rather than to
  // the secondary daily-rate line.
  var nextAvail = (typeof ptResolveNextAvailable === 'function') ? ptResolveNextAvailable(p, lang) : null;
  if (nextAvail) {
    priceHtml = priceHtml.replace(/<\/p>\s*$/,
      ' <span class="pt-card-next-available">\u00b7 ' + _ptEsc(nextAvail.text) + '</span></p>');
  }

  priceHtml += dailyExtraHtml;

  // ── AVAILABILITY and FOMO — separate lines, rendered AFTER the price and
  // never in place of it. The price block above has already been decided
  // without consulting either, which is the fix for unavailable listings
  // losing their price entirely.
  var statusInfo = (typeof resolveListingStatus === 'function') ? resolveListingStatus(p) : null;
  var availabilityHtml = '';
  if (statusInfo && !statusInfo.isPubliclyAvailable && typeof getMarketStatusLabel === 'function') {
    var statusLabel = getMarketStatusLabel(statusInfo.market, lang);
    var statusEmoji = (typeof getMarketStatusEmoji === 'function') ? getMarketStatusEmoji(statusInfo.market) : '';
    if (statusLabel) {
      availabilityHtml = '<p class="pt-card-availability pt-card-availability-unavailable">'
        + (statusEmoji ? _ptEsc(statusEmoji) + ' ' : '') + _ptEsc(statusLabel) + '</p>';
    }
  }
  var fomo = (typeof ptResolveListingFomo === 'function') ? ptResolveListingFomo(p, lang) : null;
  var fomoHtml = fomo
    ? '<p class="pt-card-fomo pt-card-fomo-' + _ptEsc(fomo.tone) + '">' + _ptEsc(fomo.text) + '</p>'
    : '';
  // A "missed it" FOMO line already states the situation, so the plain status
  // label above would just repeat it. Prefer the richer one, never both.
  if (fomo && fomo.kind === 'missed') availabilityHtml = '';
  priceHtml += availabilityHtml + fomoHtml;

  var agentHtml = '';
  if (opts.showAgentRow !== false) {
    var contact = _ptResolveCardContact(p, lang);
    if (contact) {
      var initial = _ptEsc(contact.name.trim().charAt(0) || 'P');
      var avatarInner = contact.photo
        ? '<img src="' + _ptEsc(contact.photo) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
        : initial;
      agentHtml = '<div class="pt-card-divider"></div><div class="pt-agent-preview">' +
        '<div class="pt-agent-avatar">' + avatarInner + '</div>' +
        '<div><div class="pt-agent-name">' + _ptEsc(contact.name) + '</div><div class="pt-agent-role">' + _ptEsc(contact.roleLabel) + '</div></div>' +
      '</div>';
    }
  }

  var pinSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#2D8C8C" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>';

  card.innerHTML =
    '<div class="pt-card-img">' + imgHtml +
      '<div class="pt-ov-tl">' + badgeHtml + overlayTl + '</div>' +
      (heartHtml ? '<div class="pt-ov-tr">' + heartHtml + '</div>' : '') +
      (opts.photoCountHtml ? '<div class="pt-ov-br">' + opts.photoCountHtml + '</div>' : '') +
      (opts.aiHtml ? '<div class="pt-ov-bl">' + opts.aiHtml + '</div>' : '') +
    '</div>' +
    '<div class="pt-card-body">' +
      cardTagHtml +
      // act-badges (FOMO/engagement badges) is an existing, already-
      // consistent system (single function + single CSS block, shared by
      // this grid card and listings.html's Map Preview popup) -- left as
      // page-supplied HTML rather than absorbed into this component, since
      // it wasn't part of what the audit flagged as inconsistent.
      (opts.activityBadgesHtml ? '<div class="act-badges">' + opts.activityBadgesHtml + '</div>' : '') +
      '<p class="pt-card-title">' + title + '</p>' +
      '<p class="pt-card-loc">' + pinSvg + (district ? district : '') + '</p>' +
      specsHtml + amenitiesHtml + priceHtml + agentHtml +
      (opts.footerHtml || '') +
    '</div>';

  if (opts.showHeart !== false && opts.onHeartToggle) {
    var heartBtn = card.querySelector('.pt-heart-btn');
    heartBtn.addEventListener('click', function(e) {
      var isNowSaved = opts.onHeartToggle(p.slug, e);
      // Self-toggle the visible state immediately -- no full grid re-render
      // needed for a single heart click, matching the instant feedback the
      // old per-page implementations had (via a [data-save] DOM lookup this
      // shared component doesn't need, since it already has the element).
      if (isNowSaved != null) {
        heartBtn.classList.toggle('pt-saved', isNowSaved);
        heartBtn.setAttribute('aria-pressed', String(isNowSaved));
        heartBtn.setAttribute('aria-label', (isNowSaved ? PT_UNSAVE_LABEL : PT_SAVE_LABEL)[lang] || (isNowSaved ? PT_UNSAVE_LABEL : PT_SAVE_LABEL).en);
      }
    });
  }
  return card;
}

// Same role-appropriate contact resolution already proven in listings.html/
// listing.html: only a real linked Pintag Agent Profile (parties.type ===
// 'agent') gets the agent photo/role label; every other contact (owner,
// reception, sales office, ...) shows its own role, never implying it's a
// Pintag agent when it isn't.
var PT_CONTACT_ROLE_LABELS = {
  owner:{lo:'ເຈົ້າຂອງ',en:'Owner',zh:'业主'}, agent:{lo:'ຕົວແທນ Pintag',en:'Pintag Agent',zh:'Pintag经纪人'},
  property_manager:{lo:'ຜູ້ຈັດການອາຄານ',en:'Property Manager',zh:'物业经理'},
  reception:{lo:'ພະນັກງານຕ້ອນຮັບ',en:'Reception',zh:'前台'}, sales_office:{lo:'ຫ້ອງການຂາຍ',en:'Sales Office',zh:'销售处'},
  developer:{lo:'ຜູ້ພັດທະນາ',en:'Developer',zh:'开发商'}, family_representative:{lo:'ຕົວແທນຄອບຄົວ',en:'Family Representative',zh:'家庭代表'},
  other:{lo:'ຜູ້ຕິດຕໍ່',en:'Contact',zh:'联系人'}
};
function _ptResolveCardContact(p, lang) {
  var party = p.parties, contact = p.contacts;
  var isAgent = !!(party && party.type === 'agent');
  // party has no name_zh source data (see resolvePartyDisplay's own note) --
  // only lang==='lo' is allowed to prefer name_lo; every other language,
  // including zh, resolves through name_en only, never Lao.
  var partyName = party && ((lang === 'lo') ? (party.name_lo || party.name_en) : party.name_en);
  var name = isAgent ? (partyName || (contact && contact.name) || '') : ((contact && contact.name) || '');
  if (!name) return null;
  var roleKey = isAgent ? 'agent' : ((contact && contact.role) || 'other');
  var roleLabels = PT_CONTACT_ROLE_LABELS[roleKey] || PT_CONTACT_ROLE_LABELS.other;
  return { name: name, photo: isAgent ? party.photo_url : null, roleLabel: roleLabels[lang] || roleLabels.en };
}

// ---------------------------------------------------------------------------
// renderPropertyPreview(property, opts) -- the compact card: Similar
// Properties, and anywhere a property is referenced alongside other
// content rather than as a primary grid tile.
//
// opts: lang, showSpecs (default true), dataTrack, onClick.
// ---------------------------------------------------------------------------
function renderPropertyPreview(property, opts) {
  opts = opts || {};
  var lang = opts.lang || 'en';
  var p = property;

  var card = document.createElement('a');
  card.href = _ptListingHref(p);
  card.className = 'pt-preview';
  if (opts.dataTrack) _ptApplyDataTrack(card, opts.dataTrack);
  if (opts.onClick) card.addEventListener('click', opts.onClick);

  var title = _ptEsc(p['title_' + lang] || p.title_en || '');
  var district = _ptEsc(p['district_' + lang] || p.district_en || '');
  var images = (Array.isArray(p.images) ? p.images.filter(Boolean) : []).map(ptCdnImage);
  var imgHtml = images.length
    ? '<img src="' + _ptEsc(ptImageUrl(images[0], 'card')) + '" alt="' + title + '" loading="lazy" decoding="async"' + ptImageFallbackAttrs(images[0]) + '>'
    : '<div class="pt-preview-no-img" role="img" aria-label="' + _ptEsc(PT_NO_PHOTO_LABEL[lang] || PT_NO_PHOTO_LABEL.en) + '"></div>';

  var specsHtml = '';
  if (opts.showSpecs !== false && typeof getCardFacts === 'function') {
    var facts = getCardFacts(p.property_type, p, lang) || [];
    if (facts.length) {
      specsHtml = '<div class="pt-preview-specs">' + facts.map(function(f) {
        return '<span class="pt-preview-spec">' + f.icon + ' <span>' + _ptEsc(String(f.value)) + '</span></span>';
      }).join('') + '</div>';
    }
  }

  var price = formatPropertyPrice(p, lang);
  var priceHtml = price.isPriceOnRequest
    ? '<p class="pt-preview-price-req">' + _ptEsc(price.requestText) + '</p>'
    : '<p class="pt-preview-price">' + _ptEsc(price.isSor ? (price.saleText || price.rentText || '') : price.singleText) + '</p>';

  var pinSvg = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#2D8C8C" stroke-width="2.5"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>';

  card.innerHTML =
    '<div class="pt-preview-img">' + imgHtml + '</div>' +
    '<div class="pt-preview-body">' +
      '<p class="pt-preview-title">' + title + '</p>' +
      '<p class="pt-preview-loc">' + pinSvg + district + '</p>' +
      specsHtml + priceHtml +
    '</div>';
  return card;
}

// ---------------------------------------------------------------------------
// renderAgentCard(party, opts) -- the full directory card (Agents
// Directory). Always includes, when available: photo, full name, agency,
// verified badge, active listing count, bio, View Profile + WhatsApp
// buttons. Graceful placeholders (never an empty-feeling preview):
//   no agency        -> line omitted entirely
//   not verified      -> badge omitted (never a "Not Verified" badge)
//   zero listings     -> count line omitted
//   no bio            -> falls back to a generic role-appropriate line
//
// opts: listingCount, lang, dataTrack, layout ('card' default -- stacked,
// for a grid directory; 'row' -- full-width horizontal list row, the
// layout for-agents.html's roster already used and is now the reference
// implementation for. Both are real, currently-needed layouts, not a
// default-vs-forced-redesign situation -- see shared-components.css's
// note above .pt-agent-row.
// ---------------------------------------------------------------------------
var PT_BIO_FALLBACK = { lo:'ຕົວແທນອະສັງຫາລິມະຊັບ · ວຽງຈັນ', en:'Real Estate Agent · Vientiane', zh:'房地产经纪人 · 万象' };
// Chrome around the agent card/preview -- was hardcoded English regardless
// of `lang`, so an English-language page rendered correctly but a Lao/zh
// page's Agent Profile card still said "VERIFIED AGENT"/"View Profile" in
// English. Same "no mixed languages" rule as every data field on the page.
var PT_VERIFIED_LABEL = { lo:'ຕົວແທນກວດສອບແລ້ວ', en:'VERIFIED AGENT', zh:'已认证经纪人' };
var PT_VIEW_PROFILE_LABEL = { lo:'ເບິ່ງໂປຣໄຟລ໌', en:'View Profile', zh:'查看资料' };
function _ptListingCountText(n, lang) {
  if (lang === 'lo') return n + ' ລາຍການທີ່ກຳລັງລົງຂາຍ';
  if (lang === 'zh') return n + ' 个在售房源';
  return n + ' active listing' + (n === 1 ? '' : 's');
}
function renderAgentCard(party, opts) {
  opts = opts || {};
  var lang = opts.lang || 'en';
  var d = resolvePartyDisplay(party, opts.listingCount, lang);
  if (!d) return document.createElement('div');

  var card = document.createElement('a');
  card.href = 'agent.html?slug=' + encodeURIComponent(d.slug || '');
  if (opts.dataTrack) _ptApplyDataTrack(card, opts.dataTrack);
  var bioText = d.bio || (PT_BIO_FALLBACK[lang] || PT_BIO_FALLBACK.en);

  var verifiedLabel = PT_VERIFIED_LABEL[lang] || PT_VERIFIED_LABEL.en;

  if (opts.layout === 'row') {
    card.className = 'pt-agent-row';
    var rowPortraitInner = d.photo
      ? '<img src="' + _ptEsc(d.photo) + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'' + _ptEscJs(d.initial) + '\'">'
      : _ptEsc(d.initial);
    var listingsLabel = { lo: 'ລາຍການ', en: 'listings', zh: '房源' };
    card.innerHTML =
      '<div class="pt-agent-row-portrait">' + rowPortraitInner + '</div>' +
      '<div class="pt-agent-row-info">' +
        (d.verified ? '<span class="pt-agent-row-verified">' + _ptEsc(verifiedLabel) + '</span>' : '') +
        '<p class="pt-agent-row-name">' + _ptEsc(d.name) + '</p>' +
        '<p class="pt-agent-row-bio">' + _ptEsc(bioText) + '</p>' +
      '</div>' +
      '<div class="pt-agent-row-meta">' +
        (d.listingCount ? '<span class="pt-agent-row-count">' + d.listingCount + ' ' + (listingsLabel[lang] || listingsLabel.en) + '</span>' : '') +
        '<span class="pt-agent-row-arrow">&#8594;</span>' +
      '</div>';
    return card;
  }

  card.className = 'pt-agent-card';
  var portraitInner = d.photo
    ? '<img src="' + _ptEsc(d.photo) + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'' + _ptEscJs(d.initial) + '\'">'
    : _ptEsc(d.initial);

  card.innerHTML =
    '<div class="pt-agent-card-head">' +
      '<div class="pt-agent-card-portrait">' + portraitInner + '</div>' +
      '<div>' +
        (d.verified ? '<span class="pt-agent-card-verified">' + _ptEsc(verifiedLabel) + '</span><br>' : '') +
        '<span class="pt-agent-card-name">' + _ptEsc(d.name) + '</span>' +
        (d.agency ? '<div class="pt-agent-card-agency">' + _ptEsc(d.agency) + '</div>' : '') +
      '</div>' +
    '</div>' +
    '<p class="pt-agent-card-bio">' + _ptEsc(bioText) + '</p>' +
    (d.listingCount ? '<p class="pt-agent-card-count">' + _ptEsc(_ptListingCountText(d.listingCount, lang)) + '</p>' : '');

  return card;
}

// ---------------------------------------------------------------------------
// renderAgentPreview(party, opts) -- the compact inline reference alongside
// a property (Property Details, search-result mini row). Same graceful-
// placeholder rules as renderAgentCard(); includes WhatsApp + View Profile
// buttons when opts.showButtons is true (some contexts, like a search
// card's mini row, intentionally omit buttons -- clicking the card is
// itself the action).
//
// opts: listingCount, lang, showButtons (default false), whatsappHref.
// ---------------------------------------------------------------------------
function renderAgentPreview(party, opts) {
  opts = opts || {};
  var lang = opts.lang || 'en';
  var d = resolvePartyDisplay(party, opts.listingCount, lang);
  if (!d) return document.createElement('div');

  var wrap = document.createElement('div');
  wrap.className = 'pt-agent-card'; // same visual language as the full card, compact via opts.showButtons=false contexts styling narrower via caller's own layout

  var portraitInner = d.photo
    ? '<img src="' + _ptEsc(d.photo) + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'' + _ptEscJs(d.initial) + '\'">'
    : _ptEsc(d.initial);
  var bioText = d.bio || (PT_BIO_FALLBACK[lang] || PT_BIO_FALLBACK.en);

  var buttonsHtml = '';
  if (opts.showButtons) {
    var viewProfileLabel = PT_VIEW_PROFILE_LABEL[lang] || PT_VIEW_PROFILE_LABEL.en;
    buttonsHtml = '<div class="pt-agent-card-ctas">' +
      (opts.whatsappHref ? '<a href="' + _ptEsc(opts.whatsappHref) + '" target="_blank" rel="noopener noreferrer" class="pt-btn pt-btn-primary">WhatsApp</a>' : '') +
      (d.slug ? '<a href="agent.html?slug=' + encodeURIComponent(d.slug) + '" class="pt-btn pt-btn-outline" data-track="agent-profile-link" data-track-type="cta" data-track-label="' + _ptEsc(d.name) + '">' + _ptEsc(viewProfileLabel) + '</a>' : '') +
    '</div>';
  }

  var verifiedLabel = PT_VERIFIED_LABEL[lang] || PT_VERIFIED_LABEL.en;
  wrap.innerHTML =
    '<div class="pt-agent-card-head">' +
      '<div class="pt-agent-card-portrait">' + portraitInner + '</div>' +
      '<div>' +
        (d.verified ? '<span class="pt-agent-card-verified">' + _ptEsc(verifiedLabel) + '</span><br>' : '') +
        '<span class="pt-agent-card-name">' + _ptEsc(d.name) + '</span>' +
        (d.agency ? '<div class="pt-agent-card-agency">' + _ptEsc(d.agency) + '</div>' : '') +
      '</div>' +
    '</div>' +
    '<p class="pt-agent-card-bio">' + _ptEsc(bioText) + '</p>' +
    (d.listingCount ? '<p class="pt-agent-card-count">' + _ptEsc(_ptListingCountText(d.listingCount, lang)) + '</p>' : '') +
    buttonsHtml;

  return wrap;
}

// ---------------------------------------------------------------------------
// Share UX Improvement — renderShareButton()/ptShareContent(): the ONE
// share affordance for the whole site, replacing whatever tiny/one-off
// share link a page used to keep locally (e.g. listing.html's old
// handleShare()). Deliberately generic: neither function reads a listing,
// an agent, or any other page-specific object directly -- every caller
// supplies its own {title, text, url} via getPayload(), so this same pair
// works unmodified for a property listing today and an agent profile,
// neighborhood page, or market report later (per the "Future
// Compatibility" requirement -- no listing-specific assumptions here).
//
// Always tries the native OS share sheet first (Web Share API — the same
// interaction pattern Facebook/TikTok's own share buttons trigger on
// mobile, without copying either platform's icon or branding), falling
// back to a clipboard copy + visible "Copied!" label swap only on
// platforms that don't support navigator.share (desktop Chrome/Firefox
// today). This mirrors listing.html's pre-existing handleShare() exactly
// (same two-path logic, same "only track on genuine success, not on a
// user-cancelled share sheet" rule) — centralized here instead of
// duplicated per page.
// ---------------------------------------------------------------------------
var PT_SHARE_ARROW_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>' +
  '<polyline points="16 6 12 2 8 6"/>' +
  '<line x1="12" y1="2" x2="12" y2="15"/>' +
  '</svg>';
var PT_SHARE_LABEL = { lo: 'ແບ່ງປັນ', en: 'Share', zh: '分享' };
var PT_SHARE_COPIED_LABEL = { lo: 'ຄັດລອກແລ້ວ', en: 'Copied!', zh: '已复制' };

// ptShareContent(payload, btn, opts) -- payload: {title, text, url}
// (text is optional -- passed through to navigator.share() when the
// caller has a short description available, per "Optionally include a
// short description if already supported"). opts.analytics, when given
// as {table, extra}, posts one row to `table` (via the PAGE's own global
// postEvent() -- gracefully skipped if that function doesn't exist on a
// page that hasn't defined one, same defensive pattern as
// ptToggleSave()'s save-tracking above) with event_type='share' plus
// whatever identifying fields the caller supplies in `extra` (e.g.
// {property_id: ...}). Only fires on a genuine successful share/copy,
// never on a cancelled share sheet.
function ptShareContent(payload, btn, opts) {
  opts = opts || {};
  if (!payload || !payload.url) return;
  var url = payload.url;
  var title = payload.title || 'Pintag';
  function trackSuccess() {
    if (!opts.analytics || typeof postEvent !== 'function') return;
    var body = Object.assign(
      { event_type: 'share', session_id: (typeof getOrCreateSessionId === 'function') ? getOrCreateSessionId() : null },
      opts.analytics.extra || {}
    );
    postEvent(opts.analytics.table || 'listing_events', body);
  }
  if (navigator.share) {
    var sharePayload = { title: title, url: url };
    if (payload.text) sharePayload.text = payload.text;
    navigator.share(sharePayload).then(trackSuccess).catch(function () {});
    return;
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function () {
      trackSuccess();
      if (!btn) return;
      var labelEl = btn.querySelector('.pt-share-label');
      if (!labelEl) return;
      var lang = btn.getAttribute('data-lang') || 'en';
      labelEl.textContent = PT_SHARE_COPIED_LABEL[lang] || PT_SHARE_COPIED_LABEL.en;
      setTimeout(function () {
        labelEl.textContent = PT_SHARE_LABEL[lang] || PT_SHARE_LABEL.en;
      }, 1800);
    }).catch(function () {});
  }
}

// renderShareButton(opts) -> DOM node (<button>)
// opts:
//   lang: 'en'|'lo'|'zh' (default 'en')
//   variant: 'prominent' (default; full-size, e.g. a page's action row)
//            | 'compact' (tighter, e.g. a mobile sticky CTA bar sitting
//              next to a primary Contact/Find-Similar button) -- both
//              variants meet the 44x44px minimum tap target and always
//              show the text label, never icon-only (per "Do not rely on
//              the icon alone").
//   getPayload: fn() -> {title, text, url} -- called at CLICK time, not
//     render time, so a caller can build a button before the data it
//     will share is even fetched yet (e.g. before a listing's async
//     fetch resolves).
//   analytics: { table, extra } -- see ptShareContent() above. Omit to
//     skip analytics entirely (e.g. a future page with no event table).
//   dataTrack: {...} -- same data-track-* convention as every other
//     components.js renderer (tracking.js's generic click instrumentation
//     picks these up automatically, independent of the analytics.share
//     event above -- one is "a share happened," the other is "this UI
//     element was interacted with," and both are useful).
function renderShareButton(opts) {
  opts = opts || {};
  var lang = opts.lang || 'en';
  var variant = opts.variant === 'compact' ? 'compact' : 'prominent';
  var label = PT_SHARE_LABEL[lang] || PT_SHARE_LABEL.en;
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pt-share-btn pt-share-btn--' + variant;
  btn.setAttribute('data-lang', lang);
  btn.setAttribute('aria-label', label);
  btn.innerHTML = PT_SHARE_ARROW_SVG + '<span class="pt-share-label">' + _ptEsc(label) + '</span>';
  _ptApplyDataTrack(btn, opts.dataTrack);
  btn.addEventListener('click', function () {
    if (typeof opts.getPayload !== 'function') return;
    ptShareContent(opts.getPayload(), btn, { analytics: opts.analytics });
  });
  return btn;
}

// ---------------------------------------------------------------------------
// ptContactClick(opts) -- the ONE tracking path for every WhatsApp/Call
// contact action site-wide.
//
// WHY THIS EXISTS: an audit (2026-08) found three real contact CTAs that
// completed a genuine WhatsApp/tel: contact while producing zero analytics
// rows anywhere -- listing.html's mobile sticky CTA bar (no data-track, no
// lead tracking call at all), agents.html's WhatsApp button (the page didn't
// even load tracking.js/session.js), and agent.html's WhatsApp button before
// it was patched (see git history). Every one of those gaps traces back to
// the same root cause: tracking was something a caller had to remember to
// wire up per button (a data-track attribute here, a trackLead()/postEvent()
// call there), so it was always possible to build a working contact button
// that silently tracked nothing. ptContactClick() removes that failure mode
// structurally -- it is the only way to build a tracked contact action, and
// posting both analytics events is not optional inside it.
//
// opts:
//   channel: 'whatsapp' | 'call'  (required)
//   listingId / partyId / contactId: same three FK fields trackLead() /
//     lead_events always carried -- omit any that don't apply (e.g. an
//     agent-profile contact has no listingId; see agent.html/agents.html).
//   recordLead: default true. Set false for a WhatsApp click that is NOT a
//     property inquiry in the "Total Leads" sense -- e.g. the Rented
//     Listings waiting-list/notify-me CTA for an unavailable listing, which
//     intentionally does not want to inflate the live-listing lead pipeline
//     (matches this page's own pre-existing statusCtaHtml behavior). The
//     ui_events half is unaffected by this flag -- a UI interaction still
//     happened either way.
//   trackId / trackType / trackLabel / trackMeta: same shape as the
//     data-track-* attribute convention used everywhere else in this file
//     (_ptApplyDataTrack) -- posted directly into ui_events here instead of
//     via tracking.js's generic delegate. Elements calling this helper must
//     NOT also carry a data-track attribute: tracking.js's global click
//     listener would fire a second, duplicate ui_events row for the same
//     click if they did. This helper is the single source for both events.
//
// Reliability: both posts use fetch(url, {keepalive:true}), not
// navigator.sendBeacon(). sendBeacon cannot carry custom headers, and
// Supabase's PostgREST endpoint requires an apikey/Authorization header on
// every request (RLS resolves the anon role from the JWT in that header) --
// a bare sendBeacon() call here would silently 401/403 (these are
// fire-and-forget, .catch()-swallowed posts, so a header-less call would
// just be a different, harder-to-notice version of the exact bug this
// helper exists to fix). fetch's keepalive flag is the standards mechanism
// built for exactly this "the current document may go away before the
// request finishes" case -- it explicitly decouples the request's lifetime
// from the document's -- and unlike sendBeacon it supports arbitrary
// headers, so it is the "another reliable mechanism" this design calls for.
//
// Navigation: deliberately does NOT preventDefault() or drive navigation
// itself. Both fetch calls are synchronous, non-blocking dispatches that
// complete (from the caller's point of view) before this function returns,
// so by the time the browser processes the anchor's own href/target
// (immediately after this onclick handler returns), both requests are
// already in flight and keepalive guarantees they survive whatever happens
// to the page next -- "records analytics, records the lead, then performs
// navigation" holds without needing to reimplement window.open()/tel:
// dispatch and risk breaking native middle-click/copy-link/keyboard
// behavior on the real <a href> already in the markup.
function ptContactClick(opts) {
  opts = opts || {};
  if (!opts.channel || !window.PINTAG || !window.PINTAG.supabaseUrl) return;

  function post(table, body) {
    fetch(window.PINTAG.supabaseUrl + '/rest/v1/' + table, {
      method: 'POST',
      headers: {
        apikey: window.PINTAG.anonKey,
        Authorization: 'Bearer ' + window.PINTAG.anonKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body),
      keepalive: true
    }).catch(function () {});
  }

  var sessionId = (typeof getOrCreateSessionId === 'function') ? getOrCreateSessionId() : null;
  var page = (function () {
    var seg = location.pathname.split('/').filter(Boolean).pop();
    return seg || 'index.html';
  })();
  var defaultLabel = opts.channel === 'whatsapp' ? 'WhatsApp' : 'Call';

  // 1. ui_events -- same shape tracking.js's data-track delegate would have
  // produced, posted explicitly since this element must not also carry
  // data-track (see header comment above).
  post('ui_events', {
    session_id: sessionId,
    page: page,
    element_id: opts.trackId || ('contact-' + opts.channel),
    element_type: opts.trackType || 'cta',
    label: opts.trackLabel || defaultLabel,
    property_id: opts.listingId || (typeof window.PINTAG_CURRENT_PROPERTY_ID !== 'undefined' ? window.PINTAG_CURRENT_PROPERTY_ID : null) || null,
    metadata: opts.trackMeta || null
  });

  // 2. lead_events -- feeds the leads CRM table via
  // create_lead_from_event() (20260722000000_leads_recipient_model.sql)
  // whenever listing_id is present. opts.recordLead:false (see header
  // comment) is honored simply by not posting this row at all -- a
  // waiting-list/notify-me click is a real UI interaction (ui_events above
  // still fires) but not a property inquiry.
  if (opts.recordLead !== false) {
    post('lead_events', {
      listing_id: opts.listingId || null,
      agent_id: opts.partyId || null,
      contact_id: opts.contactId || null,
      event_type: opts.channel === 'whatsapp' ? 'whatsapp_click' : 'call_click',
      user_agent: navigator.userAgent,
      referrer: document.referrer || null,
      session_id: sessionId
    });
  }
}
