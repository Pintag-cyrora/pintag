// Property availability — the canonical resolver (property-availability.js).
//   node --test property-availability.test.js
//
// Pins the Availability State Integration decisions:
//   * coming_soon is unavailable regardless of units, and is the 'upcoming' presentation (normal price / badge,
//     no contact path), not the sold/rented 'history' treatment
//   * sold / off_market are unavailable regardless of units
//   * a single-unit property's own rented / reserved / fully_occupied status WINS over a lone open unit row
//   * a multi-unit property with at least one open unit stays available, at UNIT level
//   * a date (next_available_date / available_from) never creates availability
//   * a closed unit is never contactable
//   * the existing readers (contact-intent wrapper, _ptIsUnavailableNow) return the same answer
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'property-availability.js', 'components.js', 'contact-intent.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const G = globalThis;
const { resolvePropertyAvailability: R, isPropertyUnitContactable: contactable } = G;

const prop = (o) => Object.assign({ market_status: 'available', workflow_status: 'active', unit_types: [] }, o);
const U = (id, o) => Object.assign({ id, name_en: id, is_available: true, available_count: 1, total_units: null, next_available_date: null }, o);
const OPEN = (id) => U(id);
const FULL = (id) => U(id, { available_count: 0, next_available_date: '2999-01-01' });         // fully_occupied
const TEMP = (id) => U(id, { available_count: 0 });                                          // temporarily_unavailable
const SOON = (id) => U(id, { is_available: false, total_units: 10, available_count: 0 });     // coming_soon

const UNIT_SETS = {
  none: [], oneOpen: [OPEN('a')], oneFull: [FULL('a')], oneTemp: [TEMP('a')], oneSoon: [SOON('a')],
  twoOpen: [OPEN('a'), OPEN('b')], openAndFull: [OPEN('a'), FULL('b')], twoFull: [FULL('a'), FULL('b')],
  twoTemp: [TEMP('a'), TEMP('b')], twoSoon: [SOON('a'), SOON('b')],
};

// ═══ THE MATRIX: [available, presentation, reason, effectiveMarket, unitOverride] per unit set ═══════════════
const ON_LIVE = [true, 'live', null, 'available', false];
const ON_OVERRIDE = [true, 'live', null, 'available', true];
const off = (presentation, reason, eff) => [false, presentation, reason, eff || reason, false];
const MATRIX = {
  available: {
    none: ON_LIVE, oneOpen: ON_LIVE, twoOpen: ON_LIVE, openAndFull: ON_LIVE,
    oneFull: off('history', 'fully_occupied'), twoFull: off('history', 'fully_occupied'),
    oneTemp: off('history', 'temporarily_unavailable', 'fully_occupied'), twoTemp: off('history', 'temporarily_unavailable', 'fully_occupied'),
    oneSoon: off('upcoming', 'coming_soon'), twoSoon: off('upcoming', 'coming_soon'),
  },
  // reserved / rented / fully_occupied: the property wins unless it is multi-unit AND a unit is open
  OCCUPANCY: {
    none: 'P', oneOpen: 'P', oneFull: 'P', oneTemp: 'P', oneSoon: 'P',
    twoOpen: ON_OVERRIDE, openAndFull: ON_OVERRIDE, twoFull: 'P', twoTemp: 'P', twoSoon: 'P',
  },
  GONE: Object.fromEntries(Object.keys(UNIT_SETS).map((k) => [k, 'P'])),            // sold / off_market: units never override
  coming_soon: Object.fromEntries(Object.keys(UNIT_SETS).map((k) => [k, 'U'])),      // units never override
};
function expected(market, setName) {
  const group = market === 'available' ? 'available' : ['reserved', 'rented', 'fully_occupied'].includes(market) ? 'OCCUPANCY'
    : market === 'coming_soon' ? 'coming_soon' : 'GONE';
  const e = MATRIX[group][setName];
  if (e === 'P') return off('history', market);
  if (e === 'U') return off('upcoming', 'coming_soon');
  return e;
}

test('the availability matrix: every market x unit set (70 states)', () => {
  let n = 0;
  for (const m of ['available', 'reserved', 'rented', 'fully_occupied', 'sold', 'off_market', 'coming_soon']) {
    for (const [name, units] of Object.entries(UNIT_SETS)) {
      const s = R(prop({ market_status: m, unit_types: units }));
      const [available, presentation, reason, effectiveMarket, unitOverride] = expected(m, name);
      const tag = `${m}/${name}`;
      assert.equal(s.available, available, tag + ' available');
      assert.equal(s.presentation, presentation, tag + ' presentation');
      assert.equal(s.reason, reason, tag + ' reason');
      assert.equal(s.effectiveMarket, effectiveMarket, tag + ' effectiveMarket');
      assert.equal(s.unitOverride, unitOverride, tag + ' unitOverride');
      assert.equal(s.market, m, tag + ' market is the property\'s own');
      assert.equal(s.waitingListApplies, !available, tag);
      n++;
    }
  }
  assert.equal(n, 70);
});

test('coming_soon is unavailable regardless of units, and is the upcoming presentation', () => {
  for (const [name, units] of Object.entries(UNIT_SETS)) {
    const s = R(prop({ market_status: 'coming_soon', unit_types: units }));
    assert.equal(s.available, false, name); assert.equal(s.presentation, 'upcoming', name); assert.equal(s.reason, 'coming_soon', name);
    assert.equal(s.requiresUnitSelection, false, name);
    for (const u of units) assert.equal(contactable(s, u.id), false, name + ': no unit of a coming_soon property is contactable');
  }
});

test('a property whose every unit is coming_soon is also upcoming (not history)', () => {
  const s = R(prop({ unit_types: [SOON('a'), SOON('b')] }));
  assert.equal(s.available, false); assert.equal(s.presentation, 'upcoming'); assert.equal(s.reason, 'coming_soon');
});

test('sold and off_market are unavailable regardless of units (history presentation)', () => {
  for (const m of ['sold', 'off_market']) for (const [name, units] of Object.entries(UNIT_SETS)) {
    const s = R(prop({ market_status: m, unit_types: units }));
    assert.equal(s.available, false, m + '/' + name); assert.equal(s.presentation, 'history'); assert.equal(s.source, 'market_status');
    for (const u of units) assert.equal(contactable(s, u.id), false, m + '/' + name);
  }
});

test('single-unit: the property\'s own rented / reserved / fully_occupied wins over a lone OPEN unit row', () => {
  for (const m of ['rented', 'reserved', 'fully_occupied']) {
    const lone = R(prop({ market_status: m, unit_types: [OPEN('a')] }));
    assert.equal(lone.available, false, m); assert.equal(lone.reason, m); assert.equal(lone.effectiveMarket, m);
    assert.equal(lone.presentation, 'history'); assert.equal(lone.multiUnit, false);
    assert.equal(contactable(lone, 'a'), false, m + ': the lone open unit is not contactable either');
    assert.equal(R(prop({ market_status: m })).available, false, m + ' with no unit rows');
  }
});

test('multi-unit: at least one open unit keeps the property available, resolved at unit level', () => {
  for (const m of ['available', 'reserved', 'rented', 'fully_occupied']) {
    const s = R(prop({ market_status: m, unit_types: [OPEN('a'), FULL('b'), TEMP('c')] }));
    assert.equal(s.available, true, m); assert.equal(s.scope, 'unit_specific'); assert.equal(s.multiUnit, true);
    assert.equal(s.requiresUnitSelection, true); assert.deepEqual(s.openUnitIds, ['a']); assert.equal(s.openUnitCount, 1); assert.equal(s.totalUnits, 3);
    assert.equal(s.presentation, 'live'); assert.equal(s.effectiveMarket, 'available', m + ': a stale occupancy status is not shown as the badge');
    assert.equal(s.unitOverride, m !== 'available');
    assert.deepEqual(s.units.map((u) => [u.id, u.available]), [['a', true], ['b', false], ['c', false]]);
  }
});

test('closed units are never contactable; open units of a multi-unit property are; a unit must be named', () => {
  const s = R(prop({ unit_types: [OPEN('a'), FULL('b'), TEMP('c'), SOON('d')] }));
  assert.equal(contactable(s, 'a'), true);
  for (const id of ['b', 'c', 'd', 'nope', '', null, undefined]) assert.equal(contactable(s, id), false, String(id));
  // an OFF property: nothing is contactable, open unit or not
  assert.equal(contactable(R(prop({ market_status: 'sold', unit_types: [OPEN('a'), OPEN('b')] })), 'a'), false);
  // single-unit ON: the property answers for itself
  assert.equal(contactable(R(prop()), undefined), true);
  assert.equal(contactable(R(prop({ unit_types: [OPEN('a')] })), null), true);
  assert.equal(contactable(null, 'a'), false);
});

test('a date never creates availability (next_available_date / available_from, past or future)', () => {
  for (const d of ['2000-01-01', '2999-12-31', null]) {
    // an open unit stays open and a closed unit stays closed, whatever date sits on them
    assert.equal(R(prop({ available_from: d, unit_types: [U('a', { next_available_date: d })] })).available, true, 'open + ' + d);
    assert.equal(R(prop({ available_from: d, unit_types: [U('a', { available_count: 0, next_available_date: d })] })).available, false, 'closed + ' + d);
    // an unavailable property is not rescued by a date
    for (const m of ['rented', 'sold', 'coming_soon', 'off_market']) assert.equal(R(prop({ market_status: m, available_from: d, unit_types: [U('a', { available_count: 0, next_available_date: d })] })).available, false, m + ' + ' + d);
    assert.equal(R(prop({ unit_types: [U('a', { is_available: false, available_count: 3, next_available_date: d })] })).available, false, 'is_available=false + ' + d);
  }
});

test('market_status unset or unknown is treated as available (matches resolveListingStatus); pure; never mutates', () => {
  assert.equal(R({}).available, true);
  assert.equal(R({ market_status: null }).market, 'available');
  assert.equal(R(prop({ market_status: 'mystery' })).available, true);
  const p = prop({ market_status: 'rented', unit_types: [OPEN('a'), FULL('b')] });
  const before = JSON.stringify(p);
  R(p); assert.equal(JSON.stringify(p), before);
});

test('every unavailable "history" state has a status CTA key (so the contact area always has a replacement, never a live button)', () => {
  const seen = new Set();
  for (const m of ['available', 'reserved', 'rented', 'fully_occupied', 'sold', 'off_market', 'coming_soon']) {
    for (const units of Object.values(UNIT_SETS)) {
      const s = R(prop({ market_status: m, unit_types: units }));
      if (!s.available) {
        seen.add(s.effectiveMarket);
        // coming_soon ('upcoming') deliberately has NO replacement CTA: listing.html renders no contact path at all for it
        if (s.presentation === 'upcoming') assert.equal(s.effectiveMarket, 'coming_soon');
        else assert.ok(G.getListingStatusCTA(s.effectiveMarket, 'en'), 'no status CTA for ' + s.effectiveMarket);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['coming_soon', 'fully_occupied', 'off_market', 'rented', 'reserved', 'sold']);
});

// ═══ Parity with the existing readers ═══════════════════════════════════════════════════════════════════════════
test('parity: _ptIsUnavailableNow() and resolveContactIntentAvailability() are the canonical resolver', () => {
  for (const m of ['available', 'reserved', 'rented', 'fully_occupied', 'sold', 'off_market', 'coming_soon']) {
    for (const [name, units] of Object.entries(UNIT_SETS)) {
      const p = prop({ market_status: m, unit_types: units });
      const s = R(p);
      assert.deepEqual(G.resolveContactIntentAvailability(p), s, `${m}/${name}: wrapper`);
      assert.deepEqual(G._ptIsUnavailableNow(p), { unavailable: !s.available, market: s.effectiveMarket, source: s.source, presentation: s.presentation }, `${m}/${name}: _ptIsUnavailableNow`);
    }
  }
});

test('downstream of _ptIsUnavailableNow: coming_soon makes no scarcity claim and no unavailable overlay; a stale-rented multi-unit shows no "Rented"', () => {
  const soon = prop({ market_status: 'coming_soon', unit_types: [OPEN('a')] });
  assert.equal(G.ptResolveListingFomo(soon, 'en'), null);            // no "Only 1 left" on a coming-soon property
  assert.equal(G.ptResolveFomoOverlay(soon, 'en'), null);
  const loneRented = prop({ market_status: 'rented', unit_types: [OPEN('a')] });
  assert.equal(G.ptResolveListingFomo(loneRented, 'en').tone, 'unavailable');   // property wins: "Just rented", not "Only 1 left"
  assert.match(G.ptResolveListingFomo(loneRented, 'en').text, /rented/i);
  const staleMulti = prop({ market_status: 'rented', unit_types: [U('a', { available_count: 1 }), FULL('b')] });
  const f = G.ptResolveListingFomo(staleMulti, 'en');
  assert.ok(!f || f.tone !== 'unavailable', 'an available multi-unit property is not labelled rented');
});

test('no transitional fallback: without property-availability.js, _ptIsUnavailableNow answers null (never a guessed state)', () => {
  const ctx = vm.createContext({});
  for (const f of ['currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'components.js']) {
    vm.runInContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), ctx, { filename: f });
  }
  assert.equal(vm.runInContext("typeof resolvePropertyAvailability", ctx), 'undefined');
  assert.equal(vm.runInContext("_ptIsUnavailableNow({market_status:'sold',unit_types:[]})", ctx), null);
  assert.equal(vm.runInContext("typeof _ptIsUnavailableNowLegacy", ctx), 'undefined');
  assert.equal(vm.runInContext("typeof _ptHasOpenUnit", ctx), 'undefined');
  // and the callers degrade to "nothing availability-specific", not to a wrong claim
  assert.equal(vm.runInContext("ptResolveListingFomo({market_status:'sold',unit_types:[]},'en')", ctx), null);
});
