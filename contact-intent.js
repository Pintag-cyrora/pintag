// contact-intent.js — the Contact Intent model: WHICH questions a listing visitor
// can ask from the contact area, which of them Pintag answers itself, and when
// the high-intent ones (book a viewing / contact the agent) may reach WhatsApp.
// Same loading convention as terminology.js / unit-availability.js /
// listing-status.js: a plain global-var <script> tag, no build step.
//
// PRODUCT PRINCIPLE: answer low-intent questions on the page, escalate high-intent
// actions to WhatsApp. Optimise for qualified conversations, not WhatsApp clicks.
//
//   📍 location       "Where is it?"            answer  -> scroll to the map
//   💰 price          "What's the price?"       answer  -> scroll to the price
//   🏠 availability   "Is it available?"        answer  -> show the current state
//   📷 gallery        "View photos"             answer  -> scroll to the photos
//   📅 book_tour      "Book a viewing"          WhatsApp (high intent)   [PR B]
//   💬 contact_agent  "Contact agent"           WhatsApp (normal message) [PR B]
//   ⋯  open           the intent menu itself was opened / interacted with
//
// THIS FILE holds only pure data and pure functions -- no document/window
// reference anywhere -- so the rules are unit-testable and portable:
//   * CONTACT_INTENTS / helpers   the registry (ids, event ids, labels, gating)
//   * resolveContactIntentAvailability(property)   the availability state the
//     intents surface (the ON/OFF business state; see below)
//   * resolveContactIntents(summary, ctx)          which intents are visible/enabled
//   * contactIntentAvailabilityText(summary, lang) the localised "current state"
//   * resolveContactIntentMenu(summary, ctx)       the visible menu rows, in menu order
//   * buildTourWhatsAppMessage(vars, lang)         the "Book a viewing" WhatsApp text
//   * contactIntentUiText(key, lang)               the menu's own strings
// Tracking lives in components.js (ptTrackContactIntent) and the page wiring in
// listing.html. Nothing here reads a date to decide availability.
//
// AVAILABILITY IS A DELIBERATE BUSINESS STATE, not an inference:
//   Inputs are exactly the two things staff set in admin -- properties.market_status
//   and the unit_types availability rows (read ONLY through resolveUnitAvailability(),
//   as unit-availability.js requires). Dates (next_available_date / available_from)
//   are never consulted here: a date can label a state, it cannot create one.
//
//   market_status            single-unit / no units   multi-unit (>= 2 unit types)
//   ---------------------    ----------------------   ---------------------------------
//   sold, off_market         OFF                      OFF   (units never override)
//   coming_soon              OFF (coming soon)        OFF   (units never override)
//   reserved/rented/         OFF (property wins)      an explicitly open unit makes
//     fully_occupied                                  THAT UNIT available (unit-specific)
//   available                ON, or OFF when its      ON when >= 1 unit is open, and
//                            unit row is closed       always reported unit-by-unit
//
// This is a NEW, separate read of the same inputs. It deliberately does not replace
// or alter _ptIsUnavailableNow() (components.js), which the card, the badge, the
// price block and the FOMO overlay keep using unchanged. Where the two differ is
// intentional and pinned in contact-intent.test.js: coming_soon is OFF here, and a
// lone unit row no longer overrides a rented/reserved property.
//
// COMPATIBILITY WITH HISTORY: before this model every tracked WhatsApp inquiry was
// recorded in ui_events as element_id 'contact-whatsapp'. Those rows are NOT
// rewritten and the id is not renamed; contactIntentFromElementId() reads both
// vocabularies so a funnel can count 'contact-whatsapp' (legacy) together with
// 'contact_intent_contact_agent' (new) as the same intent.

var CONTACT_INTENT_ELEMENT_TYPE = 'contact_intent';

// Display order. `kind`: 'menu' (the menu itself), 'answer' (Pintag answers on the
// page), 'whatsapp' (hands off to WhatsApp). `labels` are the DRAFT visitor-facing
// wording in lo/en/zh, built from existing Pintag terminology (listing.html's L
// dictionary and listing-status.js); the Lao and Chinese copy is pending final
// approval. `labelEn` is the stable English label stored on the tracking row.
// `surfaces` lists where an intent can be raised from, so the per-unit "Inquire"
// button is part of contact_agent (it stays a data-attribute of the same intent).
var CONTACT_INTENTS = {
  open: {
    id: 'open', kind: 'menu', eventId: 'contact_intent_open', labelEn: 'Contact options opened',
    labels: { lo: 'ສອບຖາມກ່ຽວກັບຊັບສິນນີ້', en: 'Ask about this property', zh: '咨询此房源' }
  },
  location: {
    id: 'location', kind: 'answer', eventId: 'contact_intent_location', labelEn: 'Where is it?', icon: '📍',
    labels: { lo: 'ຢູ່ບ່ອນໃດ?', en: 'Where is it?', zh: '在哪里？' }
  },
  price: {
    id: 'price', kind: 'answer', eventId: 'contact_intent_price', labelEn: "What's the price?", icon: '💰',
    labels: { lo: 'ລາຄາເທົ່າໃດ?', en: "What's the price?", zh: '价格多少？' }
  },
  // Rentals only (the row is hidden on sale listings): deposit, utilities, lease length, policies. Answered on the
  // page from the listing's own Rental Terms when it has any; otherwise it points the visitor at the agent
  // (resolution escalate_to_agent). See resolveContactIntentResolution().
  terms: {
    id: 'terms', kind: 'answer', eventId: 'contact_intent_terms', labelEn: 'Terms & utilities', icon: '🧾',
    labels: { lo: 'ເງື່ອນໄຂ, ຄ່າໄຟ ແລະ ຄ່ານ້ຳ', en: 'Terms & utilities', zh: '条款与水电杂费' }
  },
  availability: {
    id: 'availability', kind: 'answer', eventId: 'contact_intent_availability', labelEn: 'Is it available?', icon: '🏠',
    labels: { lo: 'ຍັງວ່າງຢູ່ບໍ?', en: 'Is it available?', zh: '还有吗？' }
  },
  gallery: {
    id: 'gallery', kind: 'answer', eventId: 'contact_intent_gallery', labelEn: 'View photos', icon: '📷',
    labels: { lo: 'ເບິ່ງຮູບພາບ', en: 'View photos', zh: '查看照片' }
  },
  // Multi-unit listings only: the visitor actually chose a unit in the unit picker (a card click, never a
  // render or a deep link). Not a menu row and not an answer: it only records that the visitor moved from
  // "which unit?" to a specific one, so the funnel can show the step that unlocks Book a viewing / Contact agent.
  unit_select: {
    id: 'unit_select', kind: 'unit', eventId: 'contact_intent_unit_select', labelEn: 'Selected a unit', icon: '🏢',
    labels: { lo: 'ເລືອກຫ້ອງ', en: 'Select a unit', zh: '选择户型' }
  },
  book_tour: {
    id: 'book_tour', kind: 'whatsapp', highIntent: true, eventId: 'contact_intent_book_tour', labelEn: 'Book a viewing', icon: '📅',
    labels: { lo: 'ນັດເບິ່ງຊັບສິນ', en: 'Book a viewing', zh: '预约看房' },
    surfaces: ['band', 'mobile_bar', 'unit_card']
  },
  contact_agent: {
    id: 'contact_agent', kind: 'whatsapp', highIntent: true, eventId: 'contact_intent_contact_agent', labelEn: 'Contact agent', icon: '💬',
    labels: { lo: 'ຕິດຕໍ່ນາຍໜ້າ', en: 'Contact agent', zh: '联系经纪人' },
    surfaces: ['band', 'mobile_bar', 'unit_card'],
    // Every element_id a WhatsApp inquiry was recorded under before this model: the
    // desktop band, the mobile sticky bar and the per-unit Inquire button.
    legacyElementIds: ['contact-whatsapp', 'mcta-whatsapp', 'unit-inquire-whatsapp']
  }
};

var CONTACT_INTENT_ORDER = ['location', 'price', 'terms', 'availability', 'gallery', 'book_tour', 'contact_agent'];

// legacy ui_events.element_id -> intent id (see "COMPATIBILITY WITH HISTORY" above).
var CONTACT_INTENT_LEGACY_ELEMENT_IDS = {
  'contact-whatsapp': 'contact_agent',
  'mcta-whatsapp': 'contact_agent',
  'unit-inquire-whatsapp': 'contact_agent'
};
// The surface each legacy id came from (new rows carry it in metadata.surface instead).
var CONTACT_INTENT_LEGACY_SURFACES = {
  'contact-whatsapp': 'band',
  'mcta-whatsapp': 'mobile_bar',
  'unit-inquire-whatsapp': 'unit_card'
};

function contactIntentDef(intent) {
  return Object.prototype.hasOwnProperty.call(CONTACT_INTENTS, intent) ? CONTACT_INTENTS[intent] : null;
}
function isContactIntent(intent) { return contactIntentDef(intent) !== null; }
function isContactIntentAnswer(intent) { var d = contactIntentDef(intent); return !!d && d.kind === 'answer'; }

// The ui_events.element_id for an intent, or null for anything that is not an intent
// (so a typo or a hostile caller can never write an arbitrary element_id).
function contactIntentEventId(intent) {
  var d = contactIntentDef(intent);
  return d ? d.eventId : null;
}

// ui_events.element_id -> { intent, legacy } | null. Reads the new vocabulary
// ('contact_intent_*') and the pre-existing 'contact-whatsapp'.
function contactIntentFromElementId(elementId) {
  if (typeof elementId !== 'string') return null;
  for (var k in CONTACT_INTENTS) {
    if (Object.prototype.hasOwnProperty.call(CONTACT_INTENTS, k) && CONTACT_INTENTS[k].eventId === elementId) {
      return { intent: k, legacy: false };
    }
  }
  if (Object.prototype.hasOwnProperty.call(CONTACT_INTENT_LEGACY_ELEMENT_IDS, elementId)) {
    return { intent: CONTACT_INTENT_LEGACY_ELEMENT_IDS[elementId], legacy: true, surface: CONTACT_INTENT_LEGACY_SURFACES[elementId] };
  }
  return null;
}

function contactIntentLabel(intent, lang) {
  var d = contactIntentDef(intent);
  if (!d) return '';
  return d.labels[lang] || d.labels.en;
}

// ── Availability ─────────────────────────────────────────────────────────────

var _CI_ALWAYS_OFF = { sold: true, off_market: true, coming_soon: true };            // units never override
var _CI_OCCUPANCY = { reserved: true, rented: true, fully_occupied: true };          // an open unit can override on a multi-unit listing

// Reason a listing with unit rows and NO open unit is off. A closed unit that is
// fully occupied reads as such; all-coming-soon reads as coming soon; anything else
// is the generic "temporarily unavailable" (no date is consulted to pick between them
// beyond what resolveUnitAvailability() already decided).
function _ciUnitsOffReason(units) {
  var allComing = units.length > 0, anyFull = false;
  for (var i = 0; i < units.length; i++) {
    if (units[i].status !== 'coming_soon') allComing = false;
    if (units[i].status === 'fully_occupied') anyFull = true;
  }
  if (allComing) return 'coming_soon';
  if (anyFull) return 'fully_occupied';
  return 'temporarily_unavailable';
}

// resolveContactIntentAvailability(property) -> summary
//   available             ON/OFF for the contact-intent system
//   reason                null when ON; else 'sold' | 'off_market' | 'coming_soon' |
//                         'reserved' | 'rented' | 'fully_occupied' | 'temporarily_unavailable'
//   market                the property's market_status ('available' when unset)
//   source                'market_status' | 'unit_types' | null (what decided it)
//   scope                 'property' | 'unit_specific'  -- 'unit_specific' for EVERY
//                         multi-unit listing: availability is per unit, never "the
//                         whole building is available"
//   multiUnit             >= 2 unit_types (same threshold as ptIsMultiUnit())
//   unitOverride          true when market_status says reserved/rented/fully_occupied
//                         but an explicitly open unit keeps that unit available
//   requiresUnitSelection true when ON and multiUnit: the high-intent intents will
//                         need the visitor to name a unit (enforced in PR B)
//   units                 [{ id, status, available }] in the property's own order
//   openUnitIds / openUnitCount / totalUnits
//   waitingListApplies    true when OFF: the existing waiting-list / status CTA is the
//                         only contact path (that behaviour is unchanged)
// Pure; never mutates the property.
function resolveContactIntentAvailability(property) {
  var market = (property && property.market_status) || 'available';
  var rows = (property && Array.isArray(property.unit_types)) ? property.unit_types : [];
  var multi = (typeof ptIsMultiUnit === 'function') ? ptIsMultiUnit(property) : rows.length >= 2;

  var units = rows.map(function (u) {
    var r = resolveUnitAvailability(u);
    return { id: (u && u.id != null) ? u.id : null, status: r.status, available: r.status === 'available' };
  });
  var open = units.filter(function (u) { return u.available; });
  var openIds = open.map(function (u) { return u.id; });

  function out(available, reason, source, unitOverride) {
    return {
      available: available,
      reason: available ? null : reason,
      market: market,
      source: source,
      scope: multi ? 'unit_specific' : 'property',
      multiUnit: multi,
      unitOverride: !!unitOverride,
      requiresUnitSelection: !!(available && multi),
      units: units,
      openUnitIds: openIds,
      openUnitCount: open.length,
      totalUnits: units.length,
      waitingListApplies: !available
    };
  }

  // sold / off_market / coming_soon: the PROPERTY is off the market (or not on it
  // yet); no unit row can turn that back on.
  if (_CI_ALWAYS_OFF[market]) return out(false, market, 'market_status', false);

  // reserved / rented / fully_occupied: the property-level status wins, EXCEPT that on
  // a multi-unit listing an explicitly open unit keeps that unit available.
  if (_CI_OCCUPANCY[market]) {
    if (multi && open.length) return out(true, null, 'unit_types', true);
    return out(false, market, 'market_status', false);
  }

  // market_status 'available' (or unset / any value that is not an off-market state).
  if (!units.length) return out(true, null, null, false);
  if (open.length) return out(true, null, 'unit_types', false);
  return out(false, _ciUnitsOffReason(units), 'unit_types', false);
}

// Which intents show, and whether each can be used right now.
//   ctx: { hasPhone (default true), hasPhotos (default true), selectedUnitTypeId,
//          rental: { isRental, termsKnown } }   (rental is optional; without it the Terms row is hidden)
// Answer intents are always visible and enabled: Pintag answers them itself, they
// never open WhatsApp, and they stay available when the listing is OFF (an
// unavailable listing still has a location, a price and photos, and "is it
// available?" is answered with the honest no). The two WhatsApp intents appear only
// when the listing is ON and there is a number to contact; on a multi-unit listing
// they are visible but only ENABLED once an open unit is selected.
// Returns [{ id, eventId, kind, visible, enabled, requiresUnitSelection, disabledReason }]
// where disabledReason is one of null | 'unavailable' | 'no_contact' | 'select_unit' |
// 'unit_unavailable' | 'no_photos'.
function resolveContactIntents(summary, ctx) {
  ctx = ctx || {};
  var hasPhone = ctx.hasPhone !== false;
  var hasPhotos = ctx.hasPhotos !== false;
  var sel = (ctx.selectedUnitTypeId != null && ctx.selectedUnitTypeId !== '') ? ctx.selectedUnitTypeId : null;

  return CONTACT_INTENT_ORDER.map(function (id) {
    var d = CONTACT_INTENTS[id];
    var row = { id: id, eventId: d.eventId, kind: d.kind, visible: true, enabled: true, requiresUnitSelection: false, disabledReason: null };
    if (d.kind === 'answer') {
      if (id === 'gallery' && !hasPhotos) { row.visible = false; row.enabled = false; row.disabledReason = 'no_photos'; }
      if (id === 'terms') {
        // Rentals only. Shown when the listing has Rental Terms to answer with, or when there is an agent to
        // hand the question to (which needs a number AND an ON listing: an OFF listing has no WhatsApp path).
        var rf = ctx.rental || {};
        var canAsk = hasPhone && !!summary.available;
        if (!rf.isRental) { row.visible = false; row.enabled = false; row.disabledReason = 'not_rental'; }
        else if (!(rf.termsKnown > 0) && !canAsk) { row.visible = false; row.enabled = false; row.disabledReason = 'no_terms'; }
      }
      return row;
    }
    // whatsapp intents
    if (!summary.available) { row.visible = false; row.enabled = false; row.disabledReason = 'unavailable'; return row; }
    if (!hasPhone) { row.visible = false; row.enabled = false; row.disabledReason = 'no_contact'; return row; }
    if (summary.requiresUnitSelection) {
      row.requiresUnitSelection = true;
      if (sel == null) { row.enabled = false; row.disabledReason = 'select_unit'; }
      else if (summary.openUnitIds.indexOf(sel) === -1) { row.enabled = false; row.disabledReason = 'unit_unavailable'; }
    }
    return row;
  });
}

// ── Localised availability text (the 🏠 answer) ──────────────────────────────

// Same words listing-status.js's MARKET_STATUS_LABELS / unit-availability.js use;
// copied (not imported) so this module stays independent, and pinned to them by a
// parity test so they cannot drift.
var _CI_OFF_LABEL = {
  sold:           { en: 'Sold',           lo: 'ຂາຍແລ້ວ',         zh: '已售出' },
  off_market:     { en: 'Off Market',     lo: 'ຖອນອອກຈາກຕະຫຼາດ', zh: '已下架' },
  coming_soon:    { en: 'Coming Soon',    lo: 'ກຳລັງຈະມາ',       zh: '即将推出' },
  reserved:       { en: 'Reserved',       lo: 'ຖືກຈອງແລ້ວ',      zh: '已预订' },
  rented:         { en: 'Rented',         lo: 'ເຊົ່າແລ້ວ',       zh: '已出租' },
  fully_occupied: { en: 'Fully Occupied', lo: 'ເຕັມແລ້ວ',        zh: '已满租' },
  temporarily_unavailable: { en: 'Currently Unavailable', lo: 'ບໍ່ວ່າງໃນຕອນນີ້', zh: '暂不可用' }
};
// Property-wide ON. "Available Now" matches the unit wording on the page; the Chinese is
// "可预订" (the listing-status word) rather than the rental-only "可租", because a property
// for sale is also answered here.
var _CI_AVAILABLE_NOW = { en: 'Available Now', lo: 'ວ່າງດຽວນີ້', zh: '目前可预订' };
// {open}/{total} are unit-type counts. Says plainly that the answer is per unit and tells
// the visitor what to do next.
var _CI_UNIT_SPECIFIC = {
  en: '{open} of {total} unit types are available. Check each unit below.',
  lo: 'ມີ {open} ຈາກ {total} ແບບຫ້ອງທີ່ວ່າງ. ກະລຸນາເບິ່ງແຕ່ລະຫ້ອງຂ້າງລຸ່ມ.',
  zh: '{total}种户型中有{open}种可订，请查看下方各户型。'
};
var _CI_UNIT_OVERRIDE = {
  en: 'The listing is marked {status}, but some units are still open.',
  lo: 'ລາຍການນີ້ຖືກໝາຍວ່າ {status} ແຕ່ບາງຫ້ອງຍັງວ່າງຢູ່.',
  zh: '该房源标记为“{status}”，但部分户型仍可订。'
};
var _CI_NOT_AVAILABLE = {
  en: "This property isn't available right now.",
  lo: 'ຊັບສິນນີ້ບໍ່ວ່າງໃນຕອນນີ້.',
  zh: '该房源目前不可订。'
};

function _ciFill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? String(vars[k]) : m; });
}

// -> { state: 'on' | 'off', scope, headline, detail }
//   headline  one short line (the state)
//   detail    one supporting sentence or '' -- for a unit-specific listing it says
//             availability is per unit; for an override it names the property status
function contactIntentAvailabilityText(summary, lang) {
  lang = (lang === 'lo' || lang === 'zh') ? lang : 'en';
  function pick(map, key) { var e = map[key]; return e[lang] || e.en; }
  if (!summary.available) {
    return {
      state: 'off', scope: summary.scope,
      headline: pick(_CI_OFF_LABEL, summary.reason),
      detail: _CI_NOT_AVAILABLE[lang]
    };
  }
  if (summary.scope === 'unit_specific') {
    var headline = _ciFill(_CI_UNIT_SPECIFIC[lang], { open: summary.openUnitCount, total: summary.totalUnits });
    var detail = summary.unitOverride
      ? _ciFill(_CI_UNIT_OVERRIDE[lang], { status: pick(_CI_OFF_LABEL, summary.market) })
      : '';
    return { state: 'on', scope: 'unit_specific', headline: headline, detail: detail };
  }
  return { state: 'on', scope: 'property', headline: _CI_AVAILABLE_NOW[lang], detail: '' };
}

// ── The menu (PR B) ──────────────────────────────────────────────────────────

// Menu order: the two high-intent actions first (one tap, obvious), then the quick
// answers. Same list on desktop (the panel) and mobile (the bottom sheet).
var CONTACT_INTENT_MENU_ORDER = ['contact_agent', 'book_tour', 'location', 'price', 'terms', 'availability', 'gallery'];
// The mobile Ask sheet reads in the order a visitor would browse: the property questions first, then
// Book a viewing, and the direct-contact option (Call / WhatsApp, both the contact_agent intent) last.
var CONTACT_INTENT_SHEET_ORDER = ['location', 'price', 'terms', 'availability', 'gallery', 'book_tour', 'contact_agent'];

// resolveContactIntentMenu(summary, ctx[, order]) -> the VISIBLE rows of resolveContactIntents(),
// in menu order (the desktop order unless `order` is given). Nothing new is decided here:
// visibility and enabled-ness are exactly resolveContactIntents()'s, this only filters and orders.
function resolveContactIntentMenu(summary, ctx, order) {
  var rows = resolveContactIntents(summary, ctx);
  var byId = {};
  rows.forEach(function (r) { byId[r.id] = r; });
  return (order || CONTACT_INTENT_MENU_ORDER).map(function (id) { return byId[id]; }).filter(function (r) { return r && r.visible; });
}

// The menu's own strings. Wording is final for lo/en/zh: short, spoken-style, and built
// from words already on the page (listing.html's L dictionary, listing-status.js).
var _CI_UI_TEXT = {
  menuTitle: { en: 'Ask about this property', lo: 'ສອບຖາມກ່ຽວກັບຊັບສິນນີ້', zh: '咨询此房源' },
  // The mobile sheet's last group: both rows are the contact_agent intent (channel call / whatsapp).
  contactGroup: { en: 'Contact an agent',           lo: 'ຕິດຕໍ່ນາຍໜ້າ',               zh: '联系经纪人' },
  callAgent:    { en: 'Call agent',                 lo: 'ໂທຫານາຍໜ້າ',                zh: '致电经纪人' },
  chatWhatsApp: { en: 'Chat with agent on WhatsApp', lo: 'ແຊັດກັບນາຍໜ້າຜ່ານ WhatsApp', zh: '通过 WhatsApp 联系经纪人' },
  close:     { en: 'Close',                   lo: 'ປິດ',                    zh: '关闭' },
  unitUnavailable: { en: 'Unit not available', lo: 'ຫ້ອງນີ້ບໍ່ວ່າງ',        zh: '该户型暂不可订' }
};
function contactIntentUiText(key, lang) {
  var e = _CI_UI_TEXT[key];
  if (!e) return '';
  return e[lang] || e.en;
}

// ── Resolution: was the visitor's question answered on the page, or handed to the agent? ──────────────
// Recorded in ui_events.metadata (no schema change) on the Price and Terms intent rows and on the
// Contact agent click that an escalation produces:
//   resolution  'answer_on_site'    the page answered with the listing's own data
//               'escalate_to_agent' the data is not on the listing, so the visitor is offered the agent
//   topic       'price' | 'deposit' | 'terms'  what the question was about
// facts: { isRental, hasDeposit, termsKnown (count of Rental Terms with a value), canEscalate }
//   canEscalate = there is a number to message AND the listing is ON (an OFF listing has no WhatsApp path;
//   nothing is offered, so nothing is recorded as escalated).
// Price: a rental whose deposit is not listed offers the agent for the deposit; everything else is answered
//   by the price section already on the page.
// Terms: answered when the listing has any Rental Term; otherwise handed to the agent.
// -> { resolution, topic, offerAgent } or null for any other intent. Pure.
var CONTACT_INTENT_RESOLUTIONS = ['answer_on_site', 'escalate_to_agent'];
var CONTACT_INTENT_TOPICS = ['price', 'deposit', 'terms'];
function resolveContactIntentResolution(intent, facts) {
  facts = facts || {};
  var esc = !!facts.canEscalate;
  if (intent === 'price') {
    if (facts.isRental && !facts.hasDeposit && esc) return { resolution: 'escalate_to_agent', topic: 'deposit', offerAgent: true };
    return { resolution: 'answer_on_site', topic: (facts.isRental && facts.hasDeposit) ? 'deposit' : 'price', offerAgent: false };
  }
  if (intent === 'terms') {
    if (facts.termsKnown > 0) return { resolution: 'answer_on_site', topic: 'terms', offerAgent: esc };   // "ask about anything not listed"
    return { resolution: 'escalate_to_agent', topic: 'terms', offerAgent: esc };
  }
  return null;
}

// The Terms / deposit answer's own strings. DRAFT wording (lo/zh need native review before launch, like the
// rest of the menu's first-release copy).
var _CI_ANSWER_TEXT = {
  termsNotListed:   { en: "The terms and utilities for this property aren't listed yet.", lo: 'ເງື່ອນໄຂ, ຄ່າໄຟ ແລະ ຄ່ານ້ຳຂອງຊັບສິນນີ້ຍັງບໍ່ໄດ້ລະບຸ.', zh: '该房源的条款与水电杂费暂未列出。' },
  depositNotListed: { en: "The deposit for this property isn't listed.", lo: 'ເງິນມັດຈຳຂອງຊັບສິນນີ້ຍັງບໍ່ໄດ້ລະບຸ.', zh: '该房源的押金暂未列出。' },
  askAgentTerms:    { en: 'Ask the agent about terms on WhatsApp', lo: 'ສອບຖາມນາຍໜ້າກ່ຽວກັບເງື່ອນໄຂຜ່ານ WhatsApp', zh: '通过WhatsApp向经纪人咨询租赁条款' },
  askAgentDeposit:  { en: 'Ask the agent about the deposit on WhatsApp', lo: 'ສອບຖາມນາຍໜ້າກ່ຽວກັບເງິນມັດຈຳຜ່ານ WhatsApp', zh: '通过WhatsApp向经纪人咨询押金' },
  askAgentMore:     { en: 'Ask the agent about anything not listed', lo: 'ສອບຖາມນາຍໜ້າກ່ຽວກັບສິ່ງທີ່ບໍ່ໄດ້ລະບຸ', zh: '通过WhatsApp向经纪人咨询其他未列出的内容' },
  selectUnitToAsk:  { en: 'Select a unit above to ask the agent about it', lo: 'ເລືອກຫ້ອງກ່ອນ ແລ້ວຈຶ່ງສອບຖາມນາຍໜ້າ', zh: '请先选择户型，再向经纪人咨询' }
};
function contactIntentAnswerText(key, lang) {
  var e = _CI_ANSWER_TEXT[key];
  if (!e) return '';
  return e[lang] || e.en;
}

// ── The escalation WhatsApp message ─────────────────────────────────────────
// Same shape as the other property messages (greeting, "Property: <name>", listing link; unknown
// lines omitted). topic: 'terms' | 'deposit'. A selected unit is named so the agent knows which one.
var WA_QUESTION_TOPIC = {
  terms:   { en: 'rental terms and utilities (deposit, electricity, water, internet, lease length)', lo: 'ເງື່ອນໄຂການເຊົ່າ, ຄ່າໄຟ ແລະ ຄ່ານ້ຳ', zh: '租赁条款和水电杂费（押金、电费、水费、网络、租期）' },
  deposit: { en: 'the deposit', lo: 'ເງິນມັດຈຳ', zh: '押金' }
};
var WA_QUESTION_MESSAGE_TEMPLATES = {
  lo: 'ສະບາຍດີ,\n\nຂ້ອຍຢາກສອບຖາມກ່ຽວກັບ {{TOPIC}} ຂອງຊັບສິນນີ້{{UNIT_PART}}.\n\nຊັບສິນ: {{PROPERTY_NAME}}',
  en: "Hello,\n\nI have a question about {{TOPIC}} for this property{{UNIT_PART}}.\n\nProperty: {{PROPERTY_NAME}}",
  zh: '您好，\n\n我想了解这套房源{{UNIT_PART}}的{{TOPIC}}。\n\n房源: {{PROPERTY_NAME}}'
};
// vars: { topic, propertyName, canonicalUrl, unitName }  -> plain text (the caller URL-encodes it)
function buildQuestionWhatsAppMessage(vars, lang) {
  lang = (lang === 'lo' || lang === 'zh') ? lang : 'en';
  vars = vars || {};
  var t = WA_QUESTION_TOPIC[vars.topic] || WA_QUESTION_TOPIC.terms;
  var unitPart = vars.unitName ? (lang === 'zh' ? '（' + vars.unitName + '）' : ' (' + vars.unitName + ')') : '';
  var base = _ciFillTemplate(WA_QUESTION_MESSAGE_TEMPLATES[lang], { TOPIC: t[lang] || t.en, PROPERTY_NAME: vars.propertyName || '', UNIT_PART: unitPart });
  return vars.canonicalUrl ? base + '\n' + vars.canonicalUrl : base;
}

// ── "Book a viewing" WhatsApp message ───────────────────────────────────────
// Same shape as the existing property message (a short greeting, then "Property: <name>"
// and the listing link) so whoever receives it can open the exact listing, with the
// request itself changed to a viewing. The unit variant names the selected unit and
// its price in the sentence, then repeats the structured "Property — Unit / Beds —
// Price / link" breadcrumb the per-unit Inquire message already uses.
// WA_MESSAGE_TEMPLATES (the Contact agent message) is untouched.
var WA_TOUR_MESSAGE_TEMPLATES = {
  lo: 'ສະບາຍດີ,\n\nຂ້ອຍຢາກນັດເບິ່ງຊັບສິນນີ້. ສາມາດເບິ່ງໄດ້ມື້ໃດ ແລະ ເວລາໃດແດ່?\n\nຊັບສິນ: {{PROPERTY_NAME}}',
  en: "Hello,\n\nI'd like to book a viewing of this property. What days and times are available?\n\nProperty: {{PROPERTY_NAME}}",
  zh: '您好，\n\n我想预约看房。请问什么时间方便参观？\n\n房源: {{PROPERTY_NAME}}'
};
var WA_TOUR_UNIT_MESSAGE_TEMPLATES = {
  lo: 'ສະບາຍດີ,\n\nຂ້ອຍຢາກນັດເບິ່ງຫ້ອງ {{UNIT_NAME}} ທີ່ {{PROPERTY_NAME}}{{PRICE_PART}}. ສາມາດເບິ່ງໄດ້ມື້ໃດ ແລະ ເວລາໃດແດ່?',
  en: "Hello,\n\nI'd like to book a viewing of the {{UNIT_NAME}} unit at {{PROPERTY_NAME}}{{PRICE_PART}}. What days and times are available?",
  zh: '您好，\n\n我想预约参观{{PROPERTY_NAME}}的{{UNIT_NAME}}户型{{PRICE_PART}}。请问什么时间方便？'
};

function _ciFillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, function (m, k) { return vars[k] != null ? String(vars[k]) : ''; });
}

// buildTourWhatsAppMessage(vars, lang) -> plain text (the caller encodes it into the wa.me URL)
//   vars.propertyName   resolved (language-aware) title
//   vars.canonicalUrl   the listing link, or null/'' (the line is then omitted, never faked)
//   vars.unit           null for a property-level request, or
//                       { name, bedrooms, bedroomsLabel, priceText, specificUnitLabel? }
// Every line whose value is unknown is omitted.
function buildTourWhatsAppMessage(vars, lang) {
  lang = (lang === 'lo' || lang === 'zh') ? lang : 'en';
  vars = vars || {};
  var unit = vars.unit || null;
  if (!unit) {
    var base = _ciFillTemplate(WA_TOUR_MESSAGE_TEMPLATES[lang], { PROPERTY_NAME: vars.propertyName || '' });
    return vars.canonicalUrl ? base + '\n' + vars.canonicalUrl : base;
  }
  var pricePart = unit.priceText ? (lang === 'zh' ? '（' + unit.priceText + '）' : ' (' + unit.priceText + ')') : '';
  var unitLabel = (unit.bedrooms != null && unit.bedroomsLabel) ? ((unit.name || '') + ' (' + unit.bedrooms + ' ' + unit.bedroomsLabel + ')') : (unit.name || '');
  var greeting = _ciFillTemplate(WA_TOUR_UNIT_MESSAGE_TEMPLATES[lang], { UNIT_NAME: unitLabel, PROPERTY_NAME: vars.propertyName || '', PRICE_PART: pricePart });
  var head = [vars.propertyName || '', unit.name || unitLabel];
  if (unit.specificUnitLabel) head.push(unit.specificUnitLabel);
  var lines = [head.join(' \u2014 ')];
  var facts = [];
  if (unit.bedrooms != null && unit.bedroomsLabel) facts.push(unit.bedrooms + ' ' + unit.bedroomsLabel);
  if (unit.priceText) facts.push(unit.priceText);
  if (facts.length) lines.push(facts.join(' \u2014 '));
  if (vars.canonicalUrl) lines.push(vars.canonicalUrl);
  return greeting + '\n\n' + lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONTACT_INTENTS: CONTACT_INTENTS,
    CONTACT_INTENT_ORDER: CONTACT_INTENT_ORDER,
    CONTACT_INTENT_ELEMENT_TYPE: CONTACT_INTENT_ELEMENT_TYPE,
    CONTACT_INTENT_LEGACY_ELEMENT_IDS: CONTACT_INTENT_LEGACY_ELEMENT_IDS,
    CONTACT_INTENT_LEGACY_SURFACES: CONTACT_INTENT_LEGACY_SURFACES,
    isContactIntent: isContactIntent,
    isContactIntentAnswer: isContactIntentAnswer,
    contactIntentEventId: contactIntentEventId,
    contactIntentFromElementId: contactIntentFromElementId,
    contactIntentLabel: contactIntentLabel,
    resolveContactIntentAvailability: resolveContactIntentAvailability,
    resolveContactIntents: resolveContactIntents,
    contactIntentAvailabilityText: contactIntentAvailabilityText,
    CONTACT_INTENT_MENU_ORDER: CONTACT_INTENT_MENU_ORDER,
    CONTACT_INTENT_SHEET_ORDER: CONTACT_INTENT_SHEET_ORDER,
    resolveContactIntentMenu: resolveContactIntentMenu,
    contactIntentUiText: contactIntentUiText,
    WA_TOUR_MESSAGE_TEMPLATES: WA_TOUR_MESSAGE_TEMPLATES,
    WA_TOUR_UNIT_MESSAGE_TEMPLATES: WA_TOUR_UNIT_MESSAGE_TEMPLATES,
    buildTourWhatsAppMessage: buildTourWhatsAppMessage,
    CONTACT_INTENT_RESOLUTIONS: CONTACT_INTENT_RESOLUTIONS,
    CONTACT_INTENT_TOPICS: CONTACT_INTENT_TOPICS,
    resolveContactIntentResolution: resolveContactIntentResolution,
    contactIntentAnswerText: contactIntentAnswerText,
    buildQuestionWhatsAppMessage: buildQuestionWhatsAppMessage
  };
}
