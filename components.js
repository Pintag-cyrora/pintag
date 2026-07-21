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
//   resolvePartyDisplay(party, listingCount) -> plain object
//   formatPropertyPrice(property, lang)      -> plain object
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
function ptToggleSave(slug, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  var saved = ptGetSavedSet();
  if (saved.has(slug)) saved.delete(slug); else saved.add(slug);
  try { localStorage.setItem('pintag_saved', JSON.stringify([...saved])); } catch (e2) {}
  return saved.has(slug); // caller uses this to update the clicked button's visible state
}

function _ptEsc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

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
// including the "Price on request" fallback. Strips a pre-existing "/
// month"-style suffix from price_display before re-appending the localized
// unit, so callers never risk double-suffixing.
var PT_PER_MONTH = { lo:'/ ເດືອນ', en:'/ month', zh:'/ 月' };
var PT_PRICE_ON_REQUEST = { lo:'ສອບຖາມລາຄາ', en:'Price on request', zh:'价格面议' };
function formatPropertyPrice(property, lang) {
  lang = lang || 'en';
  var kind = _ptTransactionKind(property.transaction_type);
  var isSor = kind === 'sor';
  if (isSor && (property.sale_price || property.rent_price)) {
    return {
      isSor: true,
      saleText: property.sale_price || null,
      rentText: property.rent_price ? (property.rent_price + ' ' + PT_PER_MONTH[lang]) : null,
      isPriceOnRequest: false
    };
  }
  // "month" must be tried before "mo" in the alternation -- otherwise the
  // shorter alternative matches first and leaves a stray "nth" behind
  // (a real, pre-existing bug this consolidation fixes once, here, instead
  // of leaving it duplicated across every page that used to have its own
  // copy of this regex).
  var raw = (property.price_display || '').replace(/\s*\/\s*(ເດືອນ|month|mo|月)\s*/i, '').trim();
  if (!raw) return { isSor: false, singleText: null, isPriceOnRequest: true, requestText: PT_PRICE_ON_REQUEST[lang] };
  var showUnit = kind === 'rent';
  return { isSor: false, singleText: raw, unitText: showUnit ? PT_PER_MONTH[lang] : null, isPriceOnRequest: false };
}

// resolvePartyDisplay(party, listingCount) -- the shared data-shaping
// function both renderAgentCard() and renderAgentPreview() call, so
// "should I show the verified badge / agency / listing count" is decided
// once, not re-derived per renderer. `listingCount` is optional -- pages
// that don't have it available (no aggregation query on that page) pass
// null/undefined, and the count line is gracefully omitted, per the
// documented graceful-placeholder rule (an omitted stat reads as neutral,
// a "0 listings" stat reads as discouraging).
function resolvePartyDisplay(party, listingCount) {
  if (!party) return null;
  var name = party.name_en || party.name_lo || 'Agent';
  return {
    photo: party.photo_url || null,
    initial: (name.trim().charAt(0) || 'P').toUpperCase(),
    name: name,
    nameLo: party.name_lo || null,
    agency: party.agency_name || null,
    verified: !!party.is_verified,
    bio: party.bio_lo || party.bio_en || null,
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
// ---------------------------------------------------------------------------
function renderPropertyCard(property, opts) {
  opts = opts || {};
  var lang = opts.lang || 'en';
  var p = property;

  var card = document.createElement('a');
  card.href = 'listing.html?slug=' + encodeURIComponent(p.slug || '');
  card.className = 'pt-card' + (opts.isFeatured ? ' pt-featured' : '');
  if (opts.dataTrack) _ptApplyDataTrack(card, opts.dataTrack);
  if (opts.onClick) card.addEventListener('click', opts.onClick);

  var title = _ptEsc(p['title_' + lang] || p.title_en || '');
  var district = _ptEsc(p['district_' + lang] || p.district_en || '');
  var images = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
  var imgHtml = images.length
    ? '<img src="' + _ptEsc(images[0]) + '" alt="' + title + '" loading="lazy">'
    : '<div class="pt-card-no-img" role="img" aria-label="No photo available"></div>';

  var overlayTl = (opts.statusBadgeHtml || '') + (opts.extraOverlayHtml || '');
  var badgeHtml = opts.showTransactionBadge ? renderTransactionBadge(p.transaction_type, lang).outerHTML : '';

  var heartHtml = opts.showHeart !== false
    ? '<button type="button" class="pt-heart-btn' + (opts.isSaved ? ' pt-saved' : '') + '" aria-label="' +
        (opts.isSaved ? 'Remove from saved' : 'Save listing') + '" aria-pressed="' + (!!opts.isSaved) + '">' +
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
    var contact = _ptResolveCardContact(p);
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
        heartBtn.setAttribute('aria-label', isNowSaved ? 'Remove from saved' : 'Save listing');
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
function _ptResolveCardContact(p) {
  var party = p.parties, contact = p.contacts;
  var isAgent = !!(party && party.type === 'agent');
  var name = isAgent ? (party.name_en || (contact && contact.name) || '') : ((contact && contact.name) || '');
  if (!name) return null;
  var roleKey = isAgent ? 'agent' : ((contact && contact.role) || 'other');
  var roleLabels = PT_CONTACT_ROLE_LABELS[roleKey] || PT_CONTACT_ROLE_LABELS.other;
  return { name: name, photo: isAgent ? party.photo_url : null, roleLabel: roleLabels.en };
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
  card.href = 'listing.html?slug=' + encodeURIComponent(p.slug || '');
  card.className = 'pt-preview';
  if (opts.dataTrack) _ptApplyDataTrack(card, opts.dataTrack);
  if (opts.onClick) card.addEventListener('click', opts.onClick);

  var title = _ptEsc(p['title_' + lang] || p.title_en || '');
  var district = _ptEsc(p['district_' + lang] || p.district_en || '');
  var images = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
  var imgHtml = images.length
    ? '<img src="' + _ptEsc(images[0]) + '" alt="' + title + '" loading="lazy" decoding="async">'
    : '<div class="pt-preview-no-img" role="img" aria-label="No photo available"></div>';

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
// opts: listingCount, lang, dataTrack.
// ---------------------------------------------------------------------------
var PT_BIO_FALLBACK = { lo:'ຕົວແທນອະສັງຫາລິມະຊັບ · ວຽງຈັນ', en:'Real Estate Agent · Vientiane', zh:'房地产经纪人 · 万象' };
function renderAgentCard(party, opts) {
  opts = opts || {};
  var lang = opts.lang || 'en';
  var d = resolvePartyDisplay(party, opts.listingCount);
  if (!d) return document.createElement('div');

  var card = document.createElement('a');
  card.href = 'agent.html?slug=' + encodeURIComponent(d.slug || '');
  card.className = 'pt-agent-card';
  if (opts.dataTrack) _ptApplyDataTrack(card, opts.dataTrack);

  var portraitInner = d.photo
    ? '<img src="' + _ptEsc(d.photo) + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'' + _ptEsc(d.initial) + '\'">'
    : _ptEsc(d.initial);

  var bioText = d.bio || (PT_BIO_FALLBACK[lang] || PT_BIO_FALLBACK.en);

  card.innerHTML =
    '<div class="pt-agent-card-head">' +
      '<div class="pt-agent-card-portrait">' + portraitInner + '</div>' +
      '<div>' +
        (d.verified ? '<span class="pt-agent-card-verified">VERIFIED AGENT</span><br>' : '') +
        '<span class="pt-agent-card-name">' + _ptEsc(d.name) + '</span>' +
        (d.agency ? '<div class="pt-agent-card-agency">' + _ptEsc(d.agency) + '</div>' : '') +
      '</div>' +
    '</div>' +
    '<p class="pt-agent-card-bio">' + _ptEsc(bioText) + '</p>' +
    (d.listingCount ? '<p class="pt-agent-card-count">' + d.listingCount + ' active listing' + (d.listingCount === 1 ? '' : 's') + '</p>' : '');

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
  var d = resolvePartyDisplay(party, opts.listingCount);
  if (!d) return document.createElement('div');

  var wrap = document.createElement('div');
  wrap.className = 'pt-agent-card'; // same visual language as the full card, compact via opts.showButtons=false contexts styling narrower via caller's own layout

  var portraitInner = d.photo
    ? '<img src="' + _ptEsc(d.photo) + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'' + _ptEsc(d.initial) + '\'">'
    : _ptEsc(d.initial);
  var bioText = d.bio || (PT_BIO_FALLBACK[lang] || PT_BIO_FALLBACK.en);

  var buttonsHtml = '';
  if (opts.showButtons) {
    buttonsHtml = '<div class="pt-agent-card-ctas">' +
      (opts.whatsappHref ? '<a href="' + _ptEsc(opts.whatsappHref) + '" target="_blank" rel="noopener noreferrer" class="pt-btn pt-btn-primary">WhatsApp</a>' : '') +
      (d.slug ? '<a href="agent.html?slug=' + encodeURIComponent(d.slug) + '" class="pt-btn pt-btn-outline">View Profile</a>' : '') +
    '</div>';
  }

  wrap.innerHTML =
    '<div class="pt-agent-card-head">' +
      '<div class="pt-agent-card-portrait">' + portraitInner + '</div>' +
      '<div>' +
        (d.verified ? '<span class="pt-agent-card-verified">VERIFIED AGENT</span><br>' : '') +
        '<span class="pt-agent-card-name">' + _ptEsc(d.name) + '</span>' +
        (d.agency ? '<div class="pt-agent-card-agency">' + _ptEsc(d.agency) + '</div>' : '') +
      '</div>' +
    '</div>' +
    '<p class="pt-agent-card-bio">' + _ptEsc(bioText) + '</p>' +
    (d.listingCount ? '<p class="pt-agent-card-count">' + d.listingCount + ' active listing' + (d.listingCount === 1 ? '' : 's') + '</p>' : '') +
    buttonsHtml;

  return wrap;
}
