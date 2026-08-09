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

function _ptEsc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

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
  if (!raw) return { isSor: false, singleText: null, isPriceOnRequest: true, requestText: PT_PRICE_ON_REQUEST[lang] };
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
  var images = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
  var imgHtml = images.length
    ? '<img src="' + _ptEsc(images[0]) + '" alt="' + title + '" loading="lazy">'
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
  var images = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
  var imgHtml = images.length
    ? '<img src="' + _ptEsc(images[0]) + '" alt="' + title + '" loading="lazy" decoding="async">'
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
      ? '<img src="' + _ptEsc(d.photo) + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'' + _ptEsc(d.initial) + '\'">'
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
    ? '<img src="' + _ptEsc(d.photo) + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'' + _ptEsc(d.initial) + '\'">'
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
    ? '<img src="' + _ptEsc(d.photo) + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'' + _ptEsc(d.initial) + '\'">'
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
