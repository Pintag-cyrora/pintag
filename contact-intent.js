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
// THIS FILE (PR A) holds only pure data and pure functions -- no document/window
// reference anywhere -- so the rules are unit-testable and portable:
//   * CONTACT_INTENTS / helpers   the registry (ids, event ids, labels, gating)
//   * resolveContactIntentAvailability(property)   the availability state the
//     intents surface (the ON/OFF business state; see below)
//   * resolveContactIntents(summary, ctx)          which intents are visible/enabled
//   * contactIntentAvailabilityText(summary, lang) the localised "current state"
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
    labels: { lo: 'ຕິດຕໍ່ / ສອບຖາມ', en: 'Ask about this property', zh: '咨询此房源' }
  },
  location: {
    id: 'location', kind: 'answer', eventId: 'contact_intent_location', labelEn: 'Where is it?', icon: '📍',
    labels: { lo: 'ຢູ່ບ່ອນໃດ?', en: 'Where is it?', zh: '位置在哪里？' }
  },
  price: {
    id: 'price', kind: 'answer', eventId: 'contact_intent_price', labelEn: "What's the price?", icon: '💰',
    labels: { lo: 'ລາຄາເທົ່າໃດ?', en: "What's the price?", zh: '价格是多少？' }
  },
  availability: {
    id: 'availability', kind: 'answer', eventId: 'contact_intent_availability', labelEn: 'Is it available?', icon: '🏠',
    labels: { lo: 'ຍັງວ່າງຢູ່ບໍ?', en: 'Is it available?', zh: '现在还可租吗？' }
  },
  gallery: {
    id: 'gallery', kind: 'answer', eventId: 'contact_intent_gallery', labelEn: 'View photos', icon: '📷',
    labels: { lo: 'ເບິ່ງຮູບພາບ', en: 'View photos', zh: '查看照片' }
  },
  book_tour: {
    id: 'book_tour', kind: 'whatsapp', highIntent: true, eventId: 'contact_intent_book_tour', labelEn: 'Book a viewing', icon: '📅',
    labels: { lo: 'ນັດໝາຍເບິ່ງຊັບສິນ', en: 'Book a viewing', zh: '预约看房' },
    surfaces: ['band', 'mobile_bar', 'unit_card']
  },
  contact_agent: {
    id: 'contact_agent', kind: 'whatsapp', highIntent: true, eventId: 'contact_intent_contact_agent', labelEn: 'Contact agent', icon: '💬',
    labels: { lo: 'ຕິດຕໍ່ຕົວແທນ', en: 'Contact agent', zh: '联系经纪人' },
    surfaces: ['band', 'mobile_bar', 'unit_card'],
    // The element_id every WhatsApp inquiry was recorded under before this model.
    legacyElementIds: ['contact-whatsapp']
  }
};

var CONTACT_INTENT_ORDER = ['location', 'price', 'availability', 'gallery', 'book_tour', 'contact_agent'];

// legacy ui_events.element_id -> intent id (see "COMPATIBILITY WITH HISTORY" above).
var CONTACT_INTENT_LEGACY_ELEMENT_IDS = { 'contact-whatsapp': 'contact_agent' };

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
    return { intent: CONTACT_INTENT_LEGACY_ELEMENT_IDS[elementId], legacy: true };
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
//   ctx: { hasPhone (default true), hasPhotos (default true), selectedUnitTypeId }
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
var _CI_AVAILABLE_NOW = { en: 'Available Now', lo: 'ວ່າງດຽວນີ້', zh: '现在可租' };
// DRAFT wording (pending approval). {open}/{total} are unit-type counts.
var _CI_UNIT_SPECIFIC = {
  en: '{open} of {total} unit types available. Availability depends on the unit.',
  lo: '{open} ຈາກ {total} ປະເພດຫ້ອງ ວ່າງ. ສະຖານະຂຶ້ນກັບແຕ່ລະຫ້ອງ.',
  zh: '{total}种户型中有{open}种可租，具体以所选户型为准。'
};
var _CI_UNIT_OVERRIDE = {
  en: 'The listing is marked {status}, but the units below are open.',
  lo: 'ລາຍການນີ້ຖືກໝາຍວ່າ {status} ແຕ່ມີຫ້ອງຂ້າງລຸ່ມທີ່ຍັງວ່າງ.',
  zh: '该房源标记为“{status}”，但下列户型仍可租。'
};
var _CI_NOT_AVAILABLE = {
  en: 'This property is not currently available.',
  lo: 'ຊັບສິນນີ້ບໍ່ວ່າງໃນຕອນນີ້.',
  zh: '该房源目前不可租。'
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONTACT_INTENTS: CONTACT_INTENTS,
    CONTACT_INTENT_ORDER: CONTACT_INTENT_ORDER,
    CONTACT_INTENT_ELEMENT_TYPE: CONTACT_INTENT_ELEMENT_TYPE,
    CONTACT_INTENT_LEGACY_ELEMENT_IDS: CONTACT_INTENT_LEGACY_ELEMENT_IDS,
    isContactIntent: isContactIntent,
    isContactIntentAnswer: isContactIntentAnswer,
    contactIntentEventId: contactIntentEventId,
    contactIntentFromElementId: contactIntentFromElementId,
    contactIntentLabel: contactIntentLabel,
    resolveContactIntentAvailability: resolveContactIntentAvailability,
    resolveContactIntents: resolveContactIntents,
    contactIntentAvailabilityText: contactIntentAvailabilityText
  };
}
