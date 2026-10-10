// Contact Intent model (PR A) -- contact-intent.js, plus ptTrackContactIntent (components.js).
//   node --test contact-intent.test.js
//
// Pins: the availability summary for every state in the agreed table (and where it
// intentionally differs from the existing _ptIsUnavailableNow()), the intent
// registry/visibility rules, the localised availability text, historical
// 'contact-whatsapp' compatibility, and the tracking payload. The existing availability
// resolvers are NOT changed by this feature; the parity block proves that.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'property-availability.js', 'components.js', 'contact-intent.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const G = globalThis;
const {
  resolveContactIntentAvailability: avail, resolveContactIntents: intents, contactIntentAvailabilityText: text,
  contactIntentEventId, contactIntentFromElementId, isContactIntent, isContactIntentAnswer, contactIntentLabel,
  CONTACT_INTENTS, CONTACT_INTENT_ORDER, _ptIsUnavailableNow,
} = G;

const prop = (o) => Object.assign({ market_status: 'available', workflow_status: 'active', unit_types: [] }, o);
const U = (id, o) => Object.assign({ id, name_en: id, is_available: true, available_count: 1, total_units: null }, o);
const OPEN = (id) => U(id);
const FULL = (id) => U(id, { is_available: true, available_count: 0, next_available_date: '2999-01-01' });    // fully_occupied
const TEMP = (id) => U(id, { is_available: true, available_count: 0, next_available_date: null });             // temporarily_unavailable
const SOON = (id) => U(id, { is_available: false, total_units: 10, available_count: 0 });                      // coming_soon

// ═══ The agreed availability table ═══════════════════════════════════════════
test('Available, no unit rows → ON, property-wide', () => {
  const s = avail(prop({}));
  assert.equal(s.available, true); assert.equal(s.reason, null);
  assert.equal(s.scope, 'property'); assert.equal(s.multiUnit, false);
  assert.equal(s.requiresUnitSelection, false); assert.equal(s.waitingListApplies, false);
});

test('Available, one open unit row → ON, still a single-unit property', () => {
  const s = avail(prop({ unit_types: [OPEN('a')] }));
  assert.equal(s.available, true); assert.equal(s.multiUnit, false); assert.equal(s.scope, 'property');
  assert.equal(s.requiresUnitSelection, false);
});

test('Multi-unit, available → ON but unit-specific, and viewing/contact will need a unit', () => {
  const s = avail(prop({ unit_types: [OPEN('a'), FULL('b')] }));
  assert.equal(s.available, true); assert.equal(s.multiUnit, true);
  assert.equal(s.scope, 'unit_specific');                 // never "the whole building"
  assert.equal(s.requiresUnitSelection, true);
  assert.deepEqual(s.openUnitIds, ['a']); assert.equal(s.openUnitCount, 1); assert.equal(s.totalUnits, 2);
  assert.equal(s.unitOverride, false);
});

test('Multi-unit with EVERY unit open is still reported per unit', () => {
  const s = avail(prop({ unit_types: [OPEN('a'), OPEN('b')] }));
  assert.equal(s.scope, 'unit_specific'); assert.equal(s.requiresUnitSelection, true);
});

test('Temporarily unavailable (single unit row) → OFF; waiting-list path applies, no high-intent contact', () => {
  const s = avail(prop({ unit_types: [TEMP('a')] }));
  assert.equal(s.available, false); assert.equal(s.reason, 'temporarily_unavailable');
  assert.equal(s.waitingListApplies, true); assert.equal(s.requiresUnitSelection, false);
  assert.ok(intents(s).filter((i) => i.kind === 'whatsapp').every((i) => !i.visible));
});

test('Multi-unit, no unit open: fully occupied / all coming soon / otherwise temporarily unavailable', () => {
  assert.equal(avail(prop({ unit_types: [FULL('a'), FULL('b')] })).reason, 'fully_occupied');
  assert.equal(avail(prop({ unit_types: [FULL('a'), TEMP('b')] })).reason, 'fully_occupied');
  assert.equal(avail(prop({ unit_types: [SOON('a'), SOON('b')] })).reason, 'coming_soon');
  assert.equal(avail(prop({ unit_types: [TEMP('a'), TEMP('b')] })).reason, 'temporarily_unavailable');
  for (const units of [[FULL('a'), FULL('b')], [TEMP('a'), TEMP('b')]]) assert.equal(avail(prop({ unit_types: units })).available, false);
});

for (const market of ['rented', 'reserved']) {
  test(`${market}, single-unit (no rows): property-level status wins → OFF`, () => {
    const s = avail(prop({ market_status: market }));
    assert.equal(s.available, false); assert.equal(s.reason, market); assert.equal(s.source, 'market_status');
  });
  test(`${market}, single-unit WITH one open unit row: still OFF (the lone unit does not override)`, () => {
    const s = avail(prop({ market_status: market, unit_types: [OPEN('a')] }));
    assert.equal(s.available, false); assert.equal(s.reason, market);
  });
  test(`${market}, multi-unit + an open unit → ON, unit-specific, flagged as an override`, () => {
    const s = avail(prop({ market_status: market, unit_types: [OPEN('a'), FULL('b')] }));
    assert.equal(s.available, true); assert.equal(s.unitOverride, true);
    assert.equal(s.scope, 'unit_specific'); assert.equal(s.requiresUnitSelection, true);
    assert.deepEqual(s.openUnitIds, ['a']); assert.equal(s.market, market);
  });
  test(`${market}, multi-unit with NO open unit → OFF`, () => {
    const s = avail(prop({ market_status: market, unit_types: [FULL('a'), FULL('b')] }));
    assert.equal(s.available, false); assert.equal(s.reason, market); assert.equal(s.unitOverride, false);
  });
}

test('fully_occupied (market_status) behaves like rented/reserved: single → OFF, multi + open unit → unit-specific ON', () => {
  assert.equal(avail(prop({ market_status: 'fully_occupied' })).available, false);
  const s = avail(prop({ market_status: 'fully_occupied', unit_types: [OPEN('a'), OPEN('b')] }));
  assert.equal(s.available, true); assert.equal(s.unitOverride, true);
});

for (const market of ['sold', 'off_market', 'coming_soon']) {
  test(`${market} → OFF, and no unit row can override it (even a multi-unit listing with open units)`, () => {
    for (const units of [[], [OPEN('a')], [OPEN('a'), OPEN('b')]]) {
      const s = avail(prop({ market_status: market, unit_types: units }));
      assert.equal(s.available, false, `${market} + ${units.length} units`);
      assert.equal(s.reason, market); assert.equal(s.source, 'market_status');
      assert.equal(s.waitingListApplies, true);
    }
  });
}

test('coming_soon is OFF everywhere the canonical resolver is loaded (the listing-status.js flag is the browse-PR follow-up)', () => {
  const p = prop({ market_status: 'coming_soon' });
  assert.equal(G.resolveListingStatus(p).isPubliclyAvailable, true);          // listing-status.js itself is not changed in this PR
  assert.equal(_ptIsUnavailableNow(p).unavailable, true);                     // _ptIsUnavailableNow now delegates to the canonical resolver
  assert.equal(avail(p).available, false);
  assert.equal(avail(p).reason, 'coming_soon');
  assert.equal(avail(p).presentation, 'upcoming');
});

test('dates never decide availability: a past, future or missing date changes nothing', () => {
  for (const d of ['2000-01-01', '2999-12-31', null]) {
    const open = avail(prop({ available_from: d, unit_types: [U('a', { next_available_date: d })] }));
    assert.equal(open.available, true, 'open unit stays ON regardless of ' + d);
    const rented = avail(prop({ market_status: 'rented', available_from: d }));
    assert.equal(rented.available, false, 'rented stays OFF regardless of ' + d);
  }
});

test('an unset or unknown market_status is treated as available (matches resolveListingStatus)', () => {
  assert.equal(avail({}).available, true);
  assert.equal(avail({ market_status: null }).market, 'available');
  assert.equal(avail(prop({ market_status: 'mystery' })).available, true);
});

test('pure: the property is never mutated', () => {
  const p = prop({ market_status: 'rented', unit_types: [OPEN('a'), FULL('b')] });
  const before = JSON.stringify(p);
  avail(p); text(avail(p), 'en'); intents(avail(p));
  assert.equal(JSON.stringify(p), before);
});

// ═══ One resolver: the contact-intent summary and _ptIsUnavailableNow are the same answer ═══════════════
test('parity: for EVERY market x unit-set state, _ptIsUnavailableNow() equals the contact-intent summary (both delegate to resolvePropertyAvailability)', () => {
  const markets = ['available', 'reserved', 'rented', 'fully_occupied', 'sold', 'off_market', 'coming_soon'];
  const unitSets = { none: [], oneOpen: [OPEN('a')], oneFull: [FULL('a')], twoOpen: [OPEN('a'), OPEN('b')], openAndFull: [OPEN('a'), FULL('b')], twoFull: [FULL('a'), FULL('b')], twoTemp: [TEMP('a'), TEMP('b')] };
  let compared = 0;
  for (const m of markets) for (const [name, units] of Object.entries(unitSets)) {
    const p = prop({ market_status: m, unit_types: units });
    const e = _ptIsUnavailableNow(p), s = avail(p), c = G.resolvePropertyAvailability(p);
    compared++;
    assert.equal(e.unavailable, !s.available, `${m}/${name}`);
    assert.equal(e.market, s.effectiveMarket, `${m}/${name} market`);
    assert.equal(e.source, s.source, `${m}/${name} source`);
    assert.deepEqual(s, c, `${m}/${name}: the wrapper returns the canonical summary unchanged`);
  }
  assert.equal(compared, 49);
});

test('the deliberate behaviour changes of the Availability State Integration are pinned', () => {
  // a lone open unit no longer overrides the property's own occupancy status (property status wins)
  for (const m of ['rented', 'reserved', 'fully_occupied']) assert.equal(_ptIsUnavailableNow(prop({ market_status: m, unit_types: [OPEN('a')] })).unavailable, true, m);
  assert.equal(_ptIsUnavailableNow(prop({ market_status: 'sold', unit_types: [OPEN('a')] })).unavailable, true);
  // a multi-unit property with an open unit stays available at unit level, and shows as available (not 'rented')
  const multi = _ptIsUnavailableNow(prop({ market_status: 'rented', unit_types: [OPEN('a'), FULL('b')] }));
  assert.deepEqual(multi, { unavailable: false, market: 'available', source: 'unit_types', presentation: 'live' });
  // listing-status.js is untouched in this PR
  assert.deepEqual(G.resolveListingStatus(prop({ market_status: 'rented' })), { workflow: 'active', market: 'rented', isPubliclyAvailable: false });
});

// ═══ Intent registry ═════════════════════════════════════════════════════════
test('registry: every contact intent has a stable event id, an English label and lo/en/zh labels', () => {
  const ids = Object.keys(CONTACT_INTENTS);
  assert.deepEqual(ids.sort(), ['availability', 'book_tour', 'contact_agent', 'gallery', 'location', 'open', 'price', 'terms', 'unit_select']);
  for (const id of ids) {
    const d = CONTACT_INTENTS[id];
    assert.equal(d.eventId, 'contact_intent_' + id);
    assert.equal(contactIntentEventId(id), 'contact_intent_' + id);
    assert.ok(d.labelEn);
    for (const l of ['lo', 'en', 'zh']) assert.ok(contactIntentLabel(id, l), id + ' ' + l);
  }
  assert.equal(contactIntentLabel('book_tour', 'en'), 'Book a viewing');
  assert.equal(contactIntentLabel('contact_agent', 'zh').length > 0, true);
});

test('registry: kinds, order, and which intents are answers', () => {
  assert.deepEqual(CONTACT_INTENT_ORDER, ['location', 'price', 'terms', 'availability', 'gallery', 'book_tour', 'contact_agent']);
  for (const id of ['location', 'price', 'terms', 'availability', 'gallery']) assert.equal(isContactIntentAnswer(id), true, id);
  for (const id of ['book_tour', 'contact_agent', 'open']) assert.equal(isContactIntentAnswer(id), false, id);
  assert.equal(CONTACT_INTENTS.book_tour.kind, 'whatsapp'); assert.equal(CONTACT_INTENTS.contact_agent.kind, 'whatsapp');
});

test('unit_select: a tracked intent (contact_intent_unit_select) that is NOT a menu row, an answer or a WhatsApp action', () => {
  assert.equal(contactIntentEventId('unit_select'), 'contact_intent_unit_select');
  assert.equal(CONTACT_INTENTS.unit_select.kind, 'unit');
  assert.equal(isContactIntentAnswer('unit_select'), false);
  assert.equal(CONTACT_INTENT_ORDER.includes('unit_select'), false);
  assert.equal(G.CONTACT_INTENT_SHEET_ORDER.includes('unit_select'), false);
  assert.equal(G.CONTACT_INTENT_MENU_ORDER.includes('unit_select'), false);
  const rows = G.resolveContactIntentMenu(G.resolveContactIntentAvailability ? { availability: { available: true, reason: null, scope: 'property' } } : {}, { hasPhone: true, hasPhotos: true });
  assert.equal(rows.some((r) => r.id === 'unit_select'), false, 'never offered as a menu row');
});

test('registry: unknown / hostile ids are not intents and have no event id', () => {
  for (const bad of ['', 'nope', '__proto__', 'constructor', 'toString', null, undefined, 5]) {
    assert.equal(isContactIntent(bad), false, String(bad));
    assert.equal(contactIntentEventId(bad), null, String(bad));
  }
});

test('per-unit "Inquire" buttons are a surface of contact_agent (wired in the WhatsApp PR)', () => {
  assert.ok(CONTACT_INTENTS.contact_agent.surfaces.includes('unit_card'));
  assert.ok(CONTACT_INTENTS.book_tour.surfaces.includes('unit_card'));
});

test('history: legacy "contact-whatsapp" rows read as contact_agent next to the new vocabulary, no rename', () => {
  assert.deepEqual(contactIntentFromElementId('contact-whatsapp'), { intent: 'contact_agent', legacy: true, surface: 'band' });
  assert.deepEqual(contactIntentFromElementId('mcta-whatsapp'), { intent: 'contact_agent', legacy: true, surface: 'mobile_bar' });
  assert.deepEqual(contactIntentFromElementId('unit-inquire-whatsapp'), { intent: 'contact_agent', legacy: true, surface: 'unit_card' });
  assert.equal(contactIntentFromElementId('contact-whatsapp-status-cta'), null);   // the waiting-list / status CTAs are not inquiries
  assert.equal(contactIntentFromElementId('mcta-whatsapp-status'), null);
  assert.deepEqual(contactIntentFromElementId('contact_intent_contact_agent'), { intent: 'contact_agent', legacy: false });
  assert.deepEqual(contactIntentFromElementId('contact_intent_location'), { intent: 'location', legacy: false });
  assert.equal(contactIntentFromElementId('contact-call'), null);       // calls are not WhatsApp intents
  assert.equal(contactIntentFromElementId('favorite-property'), null);
  assert.equal(contactIntentFromElementId(null), null);
  assert.deepEqual(CONTACT_INTENTS.contact_agent.legacyElementIds, ['contact-whatsapp', 'mcta-whatsapp', 'unit-inquire-whatsapp']);
  assert.notEqual(contactIntentEventId('contact_agent'), 'contact-whatsapp');     // the legacy id is not reused for the new rows
});

// ═══ Visibility rules ════════════════════════════════════════════════════════
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test('answer intents are visible and enabled in EVERY state, including OFF', () => {
  for (const p of [prop({}), prop({ market_status: 'sold' }), prop({ market_status: 'coming_soon' }), prop({ unit_types: [TEMP('a')] }), prop({ unit_types: [OPEN('a'), OPEN('b')] })]) {
    const r = byId(intents(avail(p)));
    for (const id of ['location', 'price', 'availability', 'gallery']) { assert.equal(r[id].visible, true, id); assert.equal(r[id].enabled, true, id); }
  }
});

test('ON, single-unit: both WhatsApp intents visible and enabled', () => {
  const r = byId(intents(avail(prop({}))));
  for (const id of ['book_tour', 'contact_agent']) { assert.equal(r[id].visible, true); assert.equal(r[id].enabled, true); assert.equal(r[id].requiresUnitSelection, false); }
});

test('OFF (every reason): the WhatsApp intents are hidden', () => {
  const offs = [prop({ market_status: 'sold' }), prop({ market_status: 'off_market' }), prop({ market_status: 'coming_soon' }), prop({ market_status: 'rented' }), prop({ market_status: 'reserved' }),
    prop({ unit_types: [FULL('a'), FULL('b')] }), prop({ unit_types: [TEMP('a')] })];
  for (const p of offs) {
    const r = byId(intents(avail(p)));
    for (const id of ['book_tour', 'contact_agent']) { assert.equal(r[id].visible, false); assert.equal(r[id].enabled, false); assert.equal(r[id].disabledReason, 'unavailable'); }
  }
});

test('multi-unit ON: WhatsApp intents are visible but need an OPEN selected unit', () => {
  const s = avail(prop({ unit_types: [OPEN('a'), FULL('b')] }));
  let r = byId(intents(s, {}));
  for (const id of ['book_tour', 'contact_agent']) { assert.equal(r[id].visible, true); assert.equal(r[id].enabled, false); assert.equal(r[id].disabledReason, 'select_unit'); assert.equal(r[id].requiresUnitSelection, true); }
  r = byId(intents(s, { selectedUnitTypeId: 'a' }));
  for (const id of ['book_tour', 'contact_agent']) { assert.equal(r[id].enabled, true); assert.equal(r[id].disabledReason, null); }
  r = byId(intents(s, { selectedUnitTypeId: 'b' }));                              // a closed unit is selected
  for (const id of ['book_tour', 'contact_agent']) { assert.equal(r[id].enabled, false); assert.equal(r[id].disabledReason, 'unit_unavailable'); }
  r = byId(intents(s, { selectedUnitTypeId: 'zzz' }));
  assert.equal(r.contact_agent.enabled, false);
});

test('rented multi-unit with an open unit: unit-specific ON, WhatsApp intents need that unit', () => {
  const s = avail(prop({ market_status: 'rented', unit_types: [OPEN('a'), FULL('b')] }));
  const none = byId(intents(s, {}));
  assert.equal(none.contact_agent.enabled, false); assert.equal(none.contact_agent.disabledReason, 'select_unit');
  assert.equal(byId(intents(s, { selectedUnitTypeId: 'a' })).book_tour.enabled, true);
});

test('no contact number: WhatsApp intents are hidden, answers still work', () => {
  const r = byId(intents(avail(prop({})), { hasPhone: false }));
  for (const id of ['book_tour', 'contact_agent']) { assert.equal(r[id].visible, false); assert.equal(r[id].disabledReason, 'no_contact'); }
  assert.equal(r.price.enabled, true);
});

test('no photos: the gallery answer is hidden, the others stay', () => {
  const r = byId(intents(avail(prop({})), { hasPhotos: false }));
  assert.equal(r.gallery.visible, false); assert.equal(r.gallery.disabledReason, 'no_photos');
  assert.equal(r.location.visible, true);
});

// ═══ Localised availability text ═════════════════════════════════════════════
test('ON property-wide reads "Available Now" in lo/en/zh', () => {
  const s = avail(prop({}));
  assert.deepEqual(text(s, 'en'), { state: 'on', scope: 'property', headline: 'Available Now', detail: '' });
  assert.equal(text(s, 'lo').headline, 'ວ່າງດຽວນີ້');
  assert.equal(text(s, 'zh').headline, '目前可预订');      // not the rental-only "可租": a property for sale is answered here too
});

test('unit-specific text is per unit (never universal) and tells the visitor what to do, in every language', () => {
  const s = avail(prop({ unit_types: [OPEN('a'), FULL('b'), FULL('c')] }));
  const en = text(s, 'en');
  assert.equal(en.state, 'on'); assert.equal(en.scope, 'unit_specific');
  assert.equal(en.headline, '1 of 3 unit types are available. Check each unit below.');
  assert.match(text(s, 'zh').headline, /3种户型中有1种可订/);
  assert.match(text(s, 'lo').headline, /ມີ 1 ຈາກ 3/);
  for (const l of ['lo', 'en', 'zh']) assert.doesNotMatch(text(s, l).headline, /\{|\}/);
});

test('an override names the property status and says the listed units are open', () => {
  const s = avail(prop({ market_status: 'rented', unit_types: [OPEN('a'), FULL('b')] }));
  assert.equal(text(s, 'en').detail, 'The listing is marked Rented, but some units are still open.');
  assert.match(text(s, 'zh').detail, /已出租/);
  assert.match(text(s, 'lo').detail, /ເຊົ່າແລ້ວ/);
});

test('OFF text: the honest reason in each language, never "available"', () => {
  const cases = { sold: 'Sold', off_market: 'Off Market', coming_soon: 'Coming Soon', reserved: 'Reserved', rented: 'Rented' };
  for (const [m, en] of Object.entries(cases)) {
    const t = text(avail(prop({ market_status: m })), 'en');
    assert.equal(t.state, 'off'); assert.equal(t.headline, en); assert.equal(t.detail, "This property isn't available right now.");
  }
  assert.equal(text(avail(prop({ unit_types: [TEMP('a')] })), 'en').headline, 'Currently Unavailable');
  assert.doesNotMatch(text(avail(prop({ market_status: 'coming_soon' })), 'en').headline, /available now/i);
});

test('the OFF/ON wording matches the existing status vocabulary (parity with listing-status.js / unit-availability.js)', () => {
  for (const m of ['sold', 'off_market', 'coming_soon', 'reserved', 'rented', 'fully_occupied']) {
    for (const l of ['lo', 'en', 'zh']) {
      const reason = m;
      const s = avail(prop({ market_status: m }));
      assert.equal(text(s, l).headline, G.MARKET_STATUS_LABELS[reason][l], `${m}/${l}`);
    }
  }
  // property-wide ON: en/lo are the unit-availability words; zh deliberately says 可预订 (works for sale too)
  for (const l of ['lo', 'en']) assert.equal(text(avail(prop({})), l).headline, G.formatAvailabilityDisplay({ status: 'available' }, l));
  assert.equal(text(avail(prop({})), 'zh').headline, '目前可预订');
  for (const l of ['lo', 'en', 'zh']) assert.equal(text(avail(prop({ unit_types: [TEMP('a')] })), l).headline, G.formatAvailabilityDisplay({ status: 'temporarily_unavailable' }, l));
});

test('an unsupported language falls back to English', () => {
  assert.equal(text(avail(prop({})), 'vi').headline, 'Available Now');
});

// ═══ ptTrackContactIntent (components.js) ════════════════════════════════════
function withBrowser(fn) {
  const saved = { window: G.window, location: G.location, fetch: G.fetch, getOrCreateSessionId: G.getOrCreateSessionId, getCurrentLang: G.getCurrentLang };
  const calls = [];
  G.window = { PINTAG: { supabaseUrl: 'https://x.supabase.co', anonKey: 'anon' }, PINTAG_CURRENT_PROPERTY_ID: 'prop-1' };
  G.location = { pathname: '/listing.html' };
  G.getOrCreateSessionId = () => 'sess-1';
  G.getCurrentLang = () => 'en';
  G.fetch = (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return Promise.resolve({}); };
  try { return fn(calls); } finally { Object.assign(G, saved); }
}

test('tracking: one ui_events row per intent with the agreed shape (existing columns + metadata)', () => {
  withBrowser((calls) => {
    const summary = avail(prop({ unit_types: [OPEN('a'), FULL('b')] }));
    for (const id of ['location', 'price', 'availability', 'gallery', 'open']) {
      assert.equal(G.ptTrackContactIntent(id, { lang: 'zh', surface: 'test', unitTypeId: 'a', availability: summary }), true, id);
    }
    assert.equal(calls.length, 5);
    for (const c of calls) {
      assert.equal(c.url, 'https://x.supabase.co/rest/v1/ui_events');
      assert.equal(c.init.method, 'POST'); assert.equal(c.init.keepalive, true);
      assert.equal(c.init.headers.apikey, 'anon');
      const b = c.body;
      assert.deepEqual(Object.keys(b).sort(), ['element_id', 'element_type', 'label', 'metadata', 'page', 'property_id', 'session_id']);
      assert.equal(b.element_type, 'contact_intent');
      assert.equal(b.session_id, 'sess-1'); assert.equal(b.property_id, 'prop-1'); assert.equal(b.page, 'listing.html');
      assert.ok(!('event_type' in b), 'no new event_type: the table default (click) applies');
      assert.deepEqual(Object.keys(b.metadata).sort(), ['availability', 'contact_id', 'intent', 'lang', 'surface', 'unit_type_id']);
      assert.equal(b.metadata.lang, 'zh'); assert.equal(b.metadata.unit_type_id, 'a'); assert.equal(b.metadata.surface, 'test');
      assert.deepEqual(b.metadata.availability, { available: true, reason: null, scope: 'unit_specific' });
    }
    assert.deepEqual(calls.map((c) => c.body.element_id), ['contact_intent_location', 'contact_intent_price', 'contact_intent_availability', 'contact_intent_gallery', 'contact_intent_open']);
    assert.deepEqual(calls.map((c) => c.body.metadata.intent), ['location', 'price', 'availability', 'gallery', 'open']);
  });
});

test('tracking: language defaults to the page language, listing id to PINTAG_CURRENT_PROPERTY_ID, optional fields to null', () => {
  withBrowser((calls) => {
    G.window.PINTAG_CURRENT_PROPERTY_ID = 'prop-defaults';      // its own id, clear of the 300ms guard used by the other tests
    G.ptTrackContactIntent('price');
    const m = calls[0].body.metadata;
    assert.equal(m.lang, 'en'); assert.equal(m.surface, null); assert.equal(m.unit_type_id, null); assert.equal(m.contact_id, null); assert.equal(m.availability, null);
    assert.equal(calls[0].body.property_id, 'prop-defaults');
    G.ptTrackContactIntent('location', { listingId: 'prop-9' });
    assert.equal(calls[1].body.property_id, 'prop-9');
  });
});

test('tracking: unknown or hostile intents write nothing', () => {
  withBrowser((calls) => {
    for (const bad of ['nope', '', '__proto__', 'constructor', null, undefined]) assert.equal(G.ptTrackContactIntent(bad), false, String(bad));
    assert.equal(calls.length, 0);
  });
});

test('tracking: nothing is sent without the Supabase config', () => {
  withBrowser((calls) => {
    G.window.PINTAG = null;
    assert.equal(G.ptTrackContactIntent('price'), false);
    assert.equal(calls.length, 0);
  });
});

test('tracking: an immediate repeat of the same intent on the same listing is dropped (300ms double-tap guard)', () => {
  withBrowser((calls) => {
    assert.equal(G.ptTrackContactIntent('gallery', { listingId: 'dedupe-prop' }), true);
    assert.equal(G.ptTrackContactIntent('gallery', { listingId: 'dedupe-prop' }), false);
    assert.equal(G.ptTrackContactIntent('gallery', { listingId: 'other-prop' }), true);        // different listing
    assert.equal(G.ptTrackContactIntent('price', { listingId: 'dedupe-prop' }), true);          // different intent
    assert.equal(calls.length, 3);
  });
});

test('tracking: answer intents never touch lead_events', () => {
  withBrowser((calls) => {
    for (const id of ['location', 'price', 'availability', 'gallery']) G.ptTrackContactIntent(id, { listingId: 'no-lead-' + id });
    assert.ok(calls.every((c) => c.url.endsWith('/ui_events')));
  });
});

test('tracking: a network failure never throws', () => {
  withBrowser(() => {
    G.fetch = () => Promise.reject(new Error('offline'));
    assert.doesNotThrow(() => G.ptTrackContactIntent('price', { listingId: 'net-fail' }));
  });
});

// ═══ Source guards ═══════════════════════════════════════════════════════════
test('contact-intent.js is pure: no document/window/fetch reference, no date logic', () => {
  const src = fs.readFileSync(new URL('./contact-intent.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\b(document|window|fetch|localStorage|sessionStorage)\b/);
  assert.doesNotMatch(src, /new Date|Date\.now|next_available_date|available_from/);
});

test('listing.html loads contact-intent.js and exposes the section anchors', () => {
  const html = fs.readFileSync(new URL('./listing.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="contact-intent\.js\?v=__ASSET_VERSION__"><\/script>/);
  for (const id of ['section-price', 'section-map', 'section-gallery-desktop', 'section-gallery-mobile', 'contact-intent-answer']) {
    assert.match(html, new RegExp('id=\\\\?"' + id + '\\\\?"'), id);
  }
});

// ═══ PR B: the menu, the viewing message, the UI strings ═════════════════════
const { resolveContactIntentMenu: menu, contactIntentUiText: ui, buildTourWhatsAppMessage: tour, WA_TOUR_MESSAGE_TEMPLATES, WA_TOUR_UNIT_MESSAGE_TEMPLATES, CONTACT_INTENT_MENU_ORDER } = G;

test('menu order: the two high-intent actions first, then the quick answers', () => {
  assert.deepEqual(CONTACT_INTENT_MENU_ORDER, ['contact_agent', 'book_tour', 'location', 'price', 'terms', 'availability', 'gallery']);
  // Terms & utilities is a rental-only row: without the rental facts it is simply not offered
  assert.deepEqual(menu(avail(prop({}))).map((r) => r.id), CONTACT_INTENT_MENU_ORDER.filter((i) => i !== 'terms'));
  assert.deepEqual(menu(avail(prop({})), { rental: { isRental: true, termsKnown: 1 } }).map((r) => r.id), CONTACT_INTENT_MENU_ORDER);
});

test('menu is exactly the visible rows of resolveContactIntents (nothing new is decided)', () => {
  const cases = [
    [prop({}), {}], [prop({ market_status: 'sold' }), {}], [prop({ market_status: 'coming_soon' }), {}],
    [prop({ unit_types: [OPEN('a'), FULL('b')] }), { selectedUnitTypeId: 'a' }], [prop({ unit_types: [OPEN('a'), FULL('b')] }), {}],
    [prop({}), { hasPhone: false }], [prop({}), { hasPhotos: false }],
  ];
  for (const [p, ctx] of cases) {
    const s = avail(p);
    const expected = intents(s, ctx).filter((r) => r.visible).map((r) => r.id).sort();
    assert.deepEqual(menu(s, ctx).map((r) => r.id).sort(), expected);
  }
});

test('menu, availability OFF: answers only (no Book a viewing, no Contact agent)', () => {
  for (const p of [prop({ market_status: 'sold' }), prop({ market_status: 'off_market' }), prop({ market_status: 'coming_soon' }), prop({ market_status: 'rented' }),
    prop({ market_status: 'reserved' }), prop({ unit_types: [FULL('a'), FULL('b')] }), prop({ unit_types: [TEMP('a')] })]) {
    assert.deepEqual(menu(avail(p)).map((r) => r.id), ['location', 'price', 'availability', 'gallery']);
  }
});

test('menu, multi-unit: both WhatsApp rows are present but gated until an open unit is selected', () => {
  const s = avail(prop({ unit_types: [OPEN('a'), FULL('b')] }));
  const none = menu(s, {});
  assert.deepEqual(none.slice(0, 2).map((r) => [r.id, r.enabled, r.disabledReason]), [['contact_agent', false, 'select_unit'], ['book_tour', false, 'select_unit']]);
  assert.ok(none.slice(2).every((r) => r.enabled));                                 // answers never need a unit
  const picked = menu(s, { selectedUnitTypeId: 'a' });
  assert.ok(picked.every((r) => r.enabled));
});

test('menu: no phone hides the WhatsApp rows, no photos hides View photos', () => {
  assert.deepEqual(menu(avail(prop({})), { hasPhone: false }).map((r) => r.id), ['location', 'price', 'availability', 'gallery']);
  assert.deepEqual(menu(avail(prop({})), { hasPhotos: false }).map((r) => r.id), ['contact_agent', 'book_tour', 'location', 'price', 'availability']);
});

test('UI strings exist in lo/en/zh and an unsupported language falls back to English', () => {
  for (const key of ['menuTitle', 'contactGroup', 'callAgent', 'chatWhatsApp', 'close', 'unitUnavailable']) {
    for (const l of ['lo', 'en', 'zh']) assert.ok(ui(key, l).length > 0, key + '/' + l);
    assert.equal(ui(key, 'vi'), ui(key, 'en'));
  }
  assert.equal(ui('nope', 'en'), '');
  assert.equal(ui('menuTitle', 'en'), 'Ask about this property');
  assert.equal(ui('contactGroup', 'en'), 'Contact an agent');
  assert.equal(ui('callAgent', 'en'), 'Call agent');
  assert.equal(ui('chatWhatsApp', 'en'), 'Chat with agent on WhatsApp');
});

test('mobile sheet order: answers, Book a viewing, then Contact agent last (Call + WhatsApp share it)', () => {
  assert.deepEqual(G.CONTACT_INTENT_SHEET_ORDER, ['location', 'price', 'terms', 'availability', 'gallery', 'book_tour', 'contact_agent']);
  const rows = menu(avail(prop({})), { hasPhone: true, hasPhotos: true, rental: { isRental: true, termsKnown: 0 } }, G.CONTACT_INTENT_SHEET_ORDER);
  assert.deepEqual(rows.map((r) => r.id), G.CONTACT_INTENT_SHEET_ORDER);
});

test('labels: the four answers, Book a viewing and Contact agent are short enough for a chip', () => {
  for (const id of Object.keys(CONTACT_INTENTS)) for (const l of ['lo', 'en', 'zh']) {
    assert.ok(contactIntentLabel(id, l).length <= 30, id + '/' + l + ': ' + contactIntentLabel(id, l));
  }
  assert.equal(contactIntentLabel('book_tour', 'en'), 'Book a viewing');
  assert.equal(contactIntentLabel('book_tour', 'zh'), '预约看房');
});

// ── Book a viewing message ───────────────────────────────────────────────────
const URL1 = 'https://pintag.io/listing.html?slug=nice-apt&lang=en';

test('viewing message, property level: greeting asking for a viewing, property name, link', () => {
  assert.equal(tour({ propertyName: 'Nice Apartment', canonicalUrl: URL1 }, 'en'),
    "Hello,\n\nI'd like to book a viewing of this property. What days and times are available?\n\nProperty: Nice Apartment\n" + URL1);
  assert.equal(tour({ propertyName: 'ອາພາດເມັນ', canonicalUrl: URL1 }, 'lo'),
    'ສະບາຍດີ,\n\nຂ້ອຍຢາກນັດເບິ່ງຊັບສິນນີ້. ສາມາດເບິ່ງໄດ້ມື້ໃດ ແລະ ເວລາໃດແດ່?\n\nຊັບສິນ: ອາພາດເມັນ\n' + URL1);
  assert.equal(tour({ propertyName: '公寓', canonicalUrl: URL1 }, 'zh'),
    '您好，\n\n我想预约看房。请问什么时间方便参观？\n\n房源: 公寓\n' + URL1);
});

test('viewing message is a viewing request, not the "interested / more details" message', () => {
  for (const l of ['lo', 'en', 'zh']) {
    const t = tour({ propertyName: 'X', canonicalUrl: URL1 }, l);
    assert.ok(t.includes(WA_TOUR_MESSAGE_TEMPLATES[l].split('{{')[0]));
  }
  assert.match(tour({ propertyName: 'X' }, 'en'), /book a viewing/i);
  assert.match(tour({ propertyName: 'X' }, 'zh'), /预约/);
  assert.match(tour({ propertyName: 'X' }, 'lo'), /ນັດເບິ່ງ/);
});

test('viewing message, multi-unit: names the selected unit, its beds and price, and repeats them in the breadcrumb', () => {
  const unit = { name: 'Studio', bedrooms: 1, bedroomsLabel: 'Beds', priceText: '$300/month' };
  const en = tour({ propertyName: 'Nice Apartment', canonicalUrl: URL1, unit }, 'en');
  assert.equal(en, "Hello,\n\nI'd like to book a viewing of the Studio (1 Beds) unit at Nice Apartment ($300/month). What days and times are available?\n\nNice Apartment — Studio\n1 Beds — $300/month\n" + URL1);
  const zh = tour({ propertyName: '公寓', canonicalUrl: URL1, unit }, 'zh');
  assert.match(zh, /我想预约参观公寓的Studio \(1 Beds\)户型（\$300\/month）。请问什么时间方便？/);
  const lo = tour({ propertyName: 'ອາພາດເມັນ', canonicalUrl: URL1, unit }, 'lo');
  assert.match(lo, /ຂ້ອຍຢາກນັດເບິ່ງຫ້ອງ Studio \(1 Beds\) ທີ່ ອາພາດເມັນ \(\$300\/month\)\./);
  for (const m of [en, zh, lo]) assert.ok(m.includes('Studio') && m.includes('$300/month') && m.endsWith(URL1));
});

test('viewing message omits what is unknown instead of faking it', () => {
  assert.equal(tour({ propertyName: 'Nice Apartment' }, 'en'), "Hello,\n\nI'd like to book a viewing of this property. What days and times are available?\n\nProperty: Nice Apartment");
  const noPrice = tour({ propertyName: 'N', canonicalUrl: URL1, unit: { name: 'Studio' } }, 'en');
  assert.doesNotMatch(noPrice, /\(\)/); assert.doesNotMatch(noPrice, /undefined|null|\{\{/);
  assert.equal(noPrice.split('\n').filter((l) => l.includes('—')).length, 1);          // only "Property — Unit"; no empty facts line
});

test('viewing message: unsupported language falls back to English; templates have no stray placeholders', () => {
  assert.match(tour({ propertyName: 'X' }, 'vi'), /book a viewing/i);
  for (const t of [tour({ propertyName: 'X', canonicalUrl: URL1 }, 'en'), tour({ propertyName: 'X', canonicalUrl: URL1, unit: { name: 'S', priceText: '$1' } }, 'zh')]) assert.doesNotMatch(t, /\{\{|\}\}/);
  assert.deepEqual(Object.keys(WA_TOUR_MESSAGE_TEMPLATES).sort(), ['en', 'lo', 'zh']);
  assert.deepEqual(Object.keys(WA_TOUR_UNIT_MESSAGE_TEMPLATES).sort(), ['en', 'lo', 'zh']);
});

test('the existing WhatsApp message templates are not part of this module and are untouched', () => {
  const html = fs.readFileSync(new URL('./listing.html', import.meta.url), 'utf8');
  assert.match(html, /var WA_MESSAGE_TEMPLATES=\{\n  lo:'ສະບາຍດີ,\\n\\nຂ້ອຍສົນໃຈຊັບສິນນີ້\. ຂໍລາຍລະອຽດເພີ່ມແນ່\.\\n\\nຊັບສິນ: \{\{PROPERTY_NAME\}\}\\n\{\{CANONICAL_LISTING_URL\}\}',/);
  assert.match(html, /en:'Hello,\\n\\nI\\'m interested in this property\. Could you provide more details\?\\n\\nProperty: \{\{PROPERTY_NAME\}\}\\n\{\{CANONICAL_LISTING_URL\}\}'/);
});

// ── tracking helper shared by all seven intents ──────────────────────────────
test('ptContactIntentMeta: one metadata shape for every intent, usable as ptContactClick trackMeta', () => {
  withBrowser(() => {
    const m = G.ptContactIntentMeta('book_tour', { surface: 'sheet', unitTypeId: 'u1', contactId: 'c1', lang: 'lo', availability: avail(prop({ unit_types: [OPEN('u1'), OPEN('u2')] })) });
    assert.deepEqual(m, { intent: 'book_tour', lang: 'lo', surface: 'sheet', unit_type_id: 'u1', contact_id: 'c1', availability: { available: true, reason: null, scope: 'unit_specific' } });
    assert.deepEqual(Object.keys(G.ptContactIntentMeta('open')).sort(), ['availability', 'contact_id', 'intent', 'lang', 'surface', 'unit_type_id']);
    assert.equal(G.ptContactIntentMeta('open').lang, 'en');                                 // page language default
  });
});

test('inspector: every contact-intent id has an icon and is property-scoped; legacy WhatsApp ids keep theirs', () => {
  const html = fs.readFileSync(new URL('./analytics-inspector.html', import.meta.url), 'utf8');
  const icons = vm.runInNewContext('(' + html.match(/var UI_ICON_MAP = (\{[\s\S]*?\n\});/)[1] + ')');
  const scoped = vm.runInNewContext(html.match(/var PROPERTY_SCOPED_UI_ELEMENTS = (\[[\s\S]*?\]);/)[1]);
  for (const id of Object.keys(CONTACT_INTENTS)) {
    const ev = CONTACT_INTENTS[id].eventId;
    assert.ok(icons[ev], 'icon for ' + ev);
    assert.ok(scoped.includes(ev), ev + ' is property-scoped');
  }
  for (const legacy of ['contact-whatsapp', 'mcta-whatsapp', 'unit-inquire-whatsapp']) assert.ok(icons[legacy], 'legacy icon ' + legacy);
});


// ═══ Terms & utilities / Price & deposit: visibility, resolution, message ═══════════════════════════
test('terms: a registered ANSWER intent with its own event id, placed directly after Price', () => {
  assert.equal(contactIntentEventId('terms'), 'contact_intent_terms');
  assert.equal(CONTACT_INTENTS.terms.kind, 'answer');
  assert.equal(isContactIntentAnswer('terms'), true);
  for (const o of [CONTACT_INTENT_ORDER, CONTACT_INTENT_MENU_ORDER, G.CONTACT_INTENT_SHEET_ORDER]) assert.equal(o.indexOf('terms'), o.indexOf('price') + 1);
  assert.equal(contactIntentLabel('terms', 'en'), 'Terms & utilities');
  for (const l of ['lo', 'en', 'zh']) assert.ok(contactIntentLabel('terms', l).length > 0 && contactIntentLabel('terms', l).length <= 30, l);
});

test('terms row visibility: rentals only; needs terms to show OR an agent that can be asked (a number and an ON listing)', () => {
  const rowFor = (summaryProp, ctx) => G.resolveContactIntents(avail(prop(summaryProp)), ctx).find((r) => r.id === 'terms');
  const vis = (p, ctx) => rowFor(p, ctx).visible;
  assert.equal(vis({}, {}), false, 'no rental facts');
  assert.equal(vis({}, { rental: { isRental: false, termsKnown: 3 } }), false, 'a sale listing');
  assert.equal(vis({}, { rental: { isRental: true, termsKnown: 2 }, hasPhone: false }), true, 'terms known, no number');
  assert.equal(vis({}, { rental: { isRental: true, termsKnown: 0 }, hasPhone: true }), true, 'nothing listed but the agent can be asked');
  assert.equal(vis({}, { rental: { isRental: true, termsKnown: 0 }, hasPhone: false }), false, 'nothing to answer with or hand to');
  assert.equal(vis({ market_status: 'sold' }, { rental: { isRental: true, termsKnown: 0 }, hasPhone: true }), false, 'an OFF listing has no WhatsApp path to hand it to');
  assert.equal(vis({ market_status: 'sold' }, { rental: { isRental: true, termsKnown: 2 }, hasPhone: true }), true, 'an OFF listing can still show the terms it has');
  assert.equal(rowFor({}, {}).disabledReason, 'not_rental');
  assert.equal(rowFor({}, { rental: { isRental: true, termsKnown: 0 }, hasPhone: false }).disabledReason, 'no_terms');
});

test('resolution: Terms is answered when the listing has any Rental Term, otherwise handed to the agent', () => {
  const r = G.resolveContactIntentResolution;
  assert.deepEqual(r('terms', { termsKnown: 3, canEscalate: true }), { resolution: 'answer_on_site', topic: 'terms', offerAgent: true });
  assert.deepEqual(r('terms', { termsKnown: 3, canEscalate: false }), { resolution: 'answer_on_site', topic: 'terms', offerAgent: false });
  assert.deepEqual(r('terms', { termsKnown: 0, canEscalate: true }), { resolution: 'escalate_to_agent', topic: 'terms', offerAgent: true });
  assert.deepEqual(r('terms', { termsKnown: 0, canEscalate: false }), { resolution: 'escalate_to_agent', topic: 'terms', offerAgent: false });
});

test('resolution: Price is answered by the price section; only a rental with no deposit (and an agent to ask) is escalated', () => {
  const r = G.resolveContactIntentResolution;
  assert.deepEqual(r('price', { isRental: true, hasDeposit: true, canEscalate: true }), { resolution: 'answer_on_site', topic: 'deposit', offerAgent: false });
  assert.deepEqual(r('price', { isRental: true, hasDeposit: false, canEscalate: true }), { resolution: 'escalate_to_agent', topic: 'deposit', offerAgent: true });
  assert.deepEqual(r('price', { isRental: true, hasDeposit: false, canEscalate: false }), { resolution: 'answer_on_site', topic: 'price', offerAgent: false }, 'nothing is offered, so nothing is "escalated"');
  assert.deepEqual(r('price', { isRental: false, hasDeposit: false, canEscalate: true }), { resolution: 'answer_on_site', topic: 'price', offerAgent: false });
  for (const other of ['location', 'availability', 'gallery', 'book_tour', 'contact_agent', 'open', 'nope', null]) assert.equal(r(other, { termsKnown: 1, canEscalate: true }), null, String(other));
  assert.deepEqual(G.CONTACT_INTENT_RESOLUTIONS, ['answer_on_site', 'escalate_to_agent']);
  assert.deepEqual(G.CONTACT_INTENT_TOPICS, ['price', 'deposit', 'terms']);
});

test('question message: topic, property, unit and link in the visitor\'s language; unknown lines omitted', () => {
  const q = G.buildQuestionWhatsAppMessage;
  const en = q({ topic: 'deposit', propertyName: 'Villa', unitName: 'Room A', canonicalUrl: 'https://x/l' }, 'en');
  assert.equal(en, 'Hello,\n\nI have a question about the deposit for this property (Room A).\n\nProperty: Villa\nhttps://x/l');
  assert.ok(!q({ topic: 'terms', propertyName: 'Villa' }, 'en').includes('http'), 'no link line when there is no link');
  assert.ok(!/for this property \(/.test(q({ topic: 'terms', propertyName: 'Villa' }, 'en')), 'no unit part when no unit');
  assert.match(q({ topic: 'terms', propertyName: 'V' }, 'zh'), /租赁条款和水电杂费/);
  assert.match(q({ topic: 'deposit', propertyName: 'V', unitName: 'A' }, 'zh'), /（A）/);
  assert.match(q({ topic: 'terms', propertyName: 'V' }, 'lo'), /ເງື່ອນໄຂການເຊົ່າ/);
  assert.equal(q({ topic: 'terms', propertyName: 'V' }, 'vi'), q({ topic: 'terms', propertyName: 'V' }, 'en'), 'an unsupported language falls back to English');
  assert.match(q({ topic: 'bogus', propertyName: 'V' }, 'en'), /rental terms and utilities/, 'an unknown topic never produces an empty question');
});

test('answer strings exist in lo/en/zh and fall back to English', () => {
  for (const k of ['termsNotListed', 'depositNotListed', 'askAgentTerms', 'askAgentDeposit', 'askAgentMore', 'selectUnitToAsk']) {
    for (const l of ['lo', 'en', 'zh']) assert.ok(G.contactIntentAnswerText(k, l).length > 0, k + '/' + l);
    assert.equal(G.contactIntentAnswerText(k, 'vi'), G.contactIntentAnswerText(k, 'en'));
  }
  assert.equal(G.contactIntentAnswerText('nope', 'en'), '');
});

test('no Thai-block characters slipped into the Lao strings (U+0E00-0E7F are Thai; Lao is U+0E80-0EFF)', () => {
  const src = fs.readFileSync(new URL('./contact-intent.js', import.meta.url), 'utf8');
  assert.deepEqual(src.match(/[\u0E00-\u0E7F]/g), null);
});

test('Lao / Chinese copy conventions for the NEW Terms & Price-deposit strings (reviewed wording)', () => {
  const A = G.contactIntentAnswerText, label = G.contactIntentLabel;
  const q = (topic, lang) => G.buildQuestionWhatsAppMessage({ topic, propertyName: 'P' }, lang);
  const laoNew = [A('termsNotListed', 'lo'), A('depositNotListed', 'lo'), A('askAgentTerms', 'lo'), A('askAgentDeposit', 'lo'), A('askAgentMore', 'lo'), A('selectUnitToAsk', 'lo'), label('terms', 'lo'), q('terms', 'lo'), q('deposit', 'lo')];
  for (const t of laoNew) {
    assert.ok(!t.includes('ຕົວແທນ'), 'agent is ນາຍໜ້າ in the new Lao copy: ' + t);
    assert.ok(!t.includes('ທາງ WhatsApp'), 'WhatsApp is reached ຜ່ານ, not ທາງ: ' + t);
    assert.ok(!t.includes('ຄ່າສາທາລະນູປະໂພກ'), 'electricity and water are ຄ່າໄຟ ແລະ ຄ່ານ້ຳ: ' + t);
  }
  for (const k of ['askAgentTerms', 'askAgentDeposit', 'askAgentMore', 'selectUnitToAsk']) assert.ok(A(k, 'lo').includes('ນາຍໜ້າ'), k);
  for (const k of ['askAgentTerms', 'askAgentDeposit']) assert.ok(A(k, 'lo').includes('ຜ່ານ WhatsApp'), k);
  for (const t of [label('terms', 'lo'), A('termsNotListed', 'lo'), q('terms', 'lo')]) assert.ok(t.includes('ຄ່າໄຟ ແລະ ຄ່ານ້ຳ'), t);
  // Chinese: 电费、水费、网络, and the site's own "通过WhatsApp咨询" form (no spaces around WhatsApp)
  assert.ok(q('terms', 'zh').includes('电费、水费、网络'));
  assert.equal(A('askAgentTerms', 'zh'), '通过WhatsApp向经纪人咨询租赁条款');
  assert.equal(A('askAgentDeposit', 'zh'), '通过WhatsApp向经纪人咨询押金');
  assert.equal(A('askAgentMore', 'zh'), '通过WhatsApp向经纪人咨询其他未列出的内容');
  for (const k of ['askAgentTerms', 'askAgentDeposit', 'askAgentMore']) {
    assert.ok(A(k, 'zh').startsWith('通过WhatsApp向经纪人咨询'), k + ': ' + A(k, 'zh'));
    assert.ok(!/ WhatsApp|WhatsApp /.test(A(k, 'zh')), k + ' has no spaces around WhatsApp');
  }
  // English is unchanged
  assert.equal(A('askAgentTerms', 'en'), 'Ask the agent about terms on WhatsApp');
  assert.equal(A('askAgentDeposit', 'en'), 'Ask the agent about the deposit on WhatsApp');
  assert.equal(A('askAgentMore', 'en'), 'Ask the agent about anything not listed');
  assert.equal(label('terms', 'en'), 'Terms & utilities');
  assert.match(q('terms', 'en'), /rental terms and utilities \(deposit, electricity, water, internet, lease length\)/);
});

test('Lao mobile-sheet contact group uses ນາຍໜ້າ and ຜ່ານ WhatsApp, consistent with the new strings', () => {
  const ui = G.contactIntentUiText;
  assert.equal(ui('contactGroup', 'lo'), 'ຕິດຕໍ່ນາຍໜ້າ');
  assert.equal(ui('callAgent', 'lo'), 'ໂທຫານາຍໜ້າ');
  assert.equal(ui('chatWhatsApp', 'lo'), 'ແຊັດກັບນາຍໜ້າຜ່ານ WhatsApp');
  assert.equal(G.contactIntentLabel('contact_agent', 'lo'), 'ຕິດຕໍ່ນາຍໜ້າ');
  for (const k of ['menuTitle', 'contactGroup', 'callAgent', 'chatWhatsApp', 'close', 'unitUnavailable']) {
    assert.ok(!ui(k, 'lo').includes('ຕົວແທນ'), k);
    assert.ok(!ui(k, 'lo').includes('ທາງ WhatsApp'), k);
  }
  // English and Chinese sheet strings are unchanged
  assert.equal(ui('contactGroup', 'en'), 'Contact an agent');
  assert.equal(ui('chatWhatsApp', 'en'), 'Chat with agent on WhatsApp');
  assert.equal(ui('chatWhatsApp', 'zh'), '通过 WhatsApp 联系经纪人');
});
