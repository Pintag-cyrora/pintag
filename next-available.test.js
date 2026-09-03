// "Next Available" beside the price — listing cards and the detail page.
//   node --test next-available.test.js
//
// SOURCE OF TRUTH — two columns that already existed; no new field:
//   unit_types.next_available_date   per unit type, read only through
//                                    resolveUnitAvailability() as that column's
//                                    own comment requires
//   properties.available_from        per listing; the plain-listing complement
//                                    for a property with no unit_types
// Both are documented as never fabricated or estimated. NULL means "no date on
// file", and the resolver returns null for that rather than guessing.
//
// INDEPENDENCE is the property most worth defending. Price, availability, FOMO
// and next-available are four separate axes:
//   * ptResolveNextAvailable() reads no price field and cannot suppress a price
//   * a date is a FACT, not scarcity persuasion — it is not FOMO
//   * an occupied listing shows its price AND its next-available date

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const { ptResolveNextAvailable, formatPropertyPrice } = globalThis;

const TODAY = '2026-08-19';
const unit = (o) => Object.assign(
  { id: 'u', sort_order: 0, name_en: 'Studio', is_available: true, available_count: 3, total_units: null }, o);
const priceOf = (p) => {
  const i = formatPropertyPrice(p, 'en');
  if (i.isPriceOnRequest) return null;
  return i.singleText + (i.unitText ? ' ' + i.unitText : '');
};

// ═══ 1. Currently available property ══════════════════════════════════════
test('1. a currently AVAILABLE property shows no future date', () => {
  const p = {
    transaction_type: 'for_rent', market_status: 'available',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly',
    available_from: '2026-09-15',            // set, but irrelevant while available
    unit_types: [unit({ next_available_date: '2026-09-15' })]
  };
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY), null,
    'a listing you can rent today must not advertise a future date');
  assert.equal(priceOf(p), '$450 / month', 'and the price is untouched');
});

// ═══ 2. Unavailable property with a future date ══════════════════════════
test('2. an UNAVAILABLE property with a future date shows it beside the price', () => {
  const p = {
    transaction_type: 'for_rent', market_status: 'rented',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly',
    available_from: '2026-09-15'
  };
  const r = ptResolveNextAvailable(p, 'en', TODAY);
  assert.equal(r.isoDate, '2026-09-15');
  assert.equal(r.text, 'Available 15 Sep 2026', 'existing Pintag date convention, not a new one');
  assert.equal(priceOf(p), '$450 / month', 'price shows normally first');
});

test('2b. the unit-level column works the same way for a single unit type', () => {
  const p = {
    transaction_type: 'for_rent', market_status: 'fully_occupied',
    price_amount: 380, price_currency: 'USD', price_frequency: 'monthly',
    unit_types: [unit({ is_available: false, available_count: 0, next_available_date: '2026-10-01' })]
  };
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY).text, 'Available 1 Oct 2026');
});

// ═══ 3. Multiple units → EARLIEST genuine future date ════════════════════
test('3. multiple units with different dates → the EARLIEST is used', () => {
  const p = {
    transaction_type: 'for_rent', market_status: 'fully_occupied',
    price_amount: 300, price_currency: 'USD', price_frequency: 'monthly',
    unit_types: [
      unit({ id: 'a', is_available: false, available_count: 0, next_available_date: '2026-12-01' }),
      unit({ id: 'b', is_available: false, available_count: 0, next_available_date: '2026-09-15' }),  // earliest
      unit({ id: 'c', is_available: false, available_count: 0, next_available_date: '2026-10-20' })
    ]
  };
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY).isoDate, '2026-09-15');
});

test('3b. order in the array does not matter', () => {
  const mk = (dates) => ({
    market_status: 'fully_occupied',
    unit_types: dates.map((d, i) => unit({ id: 'u' + i, is_available: false, available_count: 0, next_available_date: d }))
  });
  const asc  = ptResolveNextAvailable(mk(['2026-09-15', '2026-10-20', '2026-12-01']), 'en', TODAY);
  const desc = ptResolveNextAvailable(mk(['2026-12-01', '2026-10-20', '2026-09-15']), 'en', TODAY);
  assert.equal(asc.isoDate, desc.isoDate);
  assert.equal(asc.isoDate, '2026-09-15');
});

test('3c. the property-level date competes with the unit dates, earliest wins', () => {
  const p = {
    market_status: 'fully_occupied',
    available_from: '2026-09-01',                                            // earlier than any unit
    unit_types: [unit({ is_available: false, available_count: 0, next_available_date: '2026-10-01' })]
  };
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY).isoDate, '2026-09-01');
});

test('3d. a unit with no date does not block a sibling that has one', () => {
  const p = {
    market_status: 'fully_occupied',
    unit_types: [
      unit({ id: 'a', is_available: false, available_count: 0, next_available_date: null }),
      unit({ id: 'b', is_available: false, available_count: 0, next_available_date: '2026-09-15' })
    ]
  };
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY).isoDate, '2026-09-15');
});

// ═══ 4. No date → nothing fabricated ═════════════════════════════════════
test('4. no availability date anywhere → NO date is invented', () => {
  const p = {
    transaction_type: 'for_rent', market_status: 'rented',
    price_amount: 500, price_currency: 'USD', price_frequency: 'monthly',
    available_from: null, unit_types: [unit({ is_available: false, available_count: 0, next_available_date: null })]
  };
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY), null);
  assert.equal(priceOf(p), '$500 / month', 'the price still shows on its own');
});

test('4b. a PAST date is stale data and is discarded, not shown', () => {
  const p = { market_status: 'rented', available_from: '2020-01-03' };
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY), null,
    '"Available 3 Jan 2020" would be worse than showing nothing');
});

test('4c. a malformed date is ignored rather than rendered', () => {
  for (const bad of ['soon', '15/09/2026', '2026-13-45x', '', 0, {}, []]) {
    assert.equal(ptResolveNextAvailable({ market_status: 'rented', available_from: bad }, 'en', TODAY), null,
      JSON.stringify(bad));
  }
});

test('4d. today counts as available; yesterday does not', () => {
  assert.ok(ptResolveNextAvailable({ market_status: 'rented', available_from: TODAY }, 'en', TODAY));
  assert.equal(ptResolveNextAvailable({ market_status: 'rented', available_from: '2026-08-18' }, 'en', TODAY), null);
});

// ═══ 5. Price survives when every unit is occupied ═══════════════════════
test('5. price remains visible when ALL units are occupied', () => {
  // The exact shape from the earlier card bug: admin nulls the property-level
  // price when every unit is unavailable, so the price lives only on the units.
  const p = {
    transaction_type: 'for_rent', market_status: 'fully_occupied',
    price_amount: null, price_display: null,
    unit_types: [
      unit({ id: 'a', is_available: false, available_count: 0, next_available_date: '2026-09-15',
             price_amount: 380, price_currency: 'USD', price_frequency: 'monthly' }),
      unit({ id: 'b', is_available: false, available_count: 0, next_available_date: '2026-11-01',
             price_amount: 700, price_currency: 'USD', price_frequency: 'monthly' })
    ]
  };
  assert.equal(priceOf(p), '$380 / month', 'price must survive full occupancy');
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY).text, 'Available 15 Sep 2026');
});

// ═══ Independence from the other three axes ══════════════════════════════
test('the next-available resolver reads no price field and cannot suppress a price', () => {
  const src = fs.readFileSync(new URL('./components.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function ptResolveNextAvailable('),
                       src.indexOf('// ptResolveListingFomo(property, lang)'));
  for (const forbidden of ['price_amount', 'price_display', 'price_currency', 'formatPropertyPrice']) {
    assert.equal(fn.includes(forbidden), false, `must not read ${forbidden}`);
  }
});

test('the date is not scarcity messaging — FOMO is unaffected by it', () => {
  const { ptResolveListingFomo } = globalThis;
  const p = { market_status: 'fully_occupied', available_from: '2026-09-15',
              unit_types: [unit({ is_available: false, available_count: 0 })] };
  const fomo = ptResolveListingFomo(p, 'en');
  assert.equal(fomo.kind, 'missed', 'unavailable stays factual');
  assert.equal(/Available|Sep|2026/.test(fomo.text), false, 'the date must not leak into FOMO text');
});

test('localized in all three languages, using the shared date formatter', () => {
  const p = { market_status: 'rented', available_from: '2026-09-15' };
  assert.equal(ptResolveNextAvailable(p, 'en', TODAY).text, 'Available 15 Sep 2026');
  assert.equal(ptResolveNextAvailable(p, 'lo', TODAY).text, 'ວ່າງ 15 ກ.ຍ 2026');
  assert.equal(ptResolveNextAvailable(p, 'zh', TODAY).text, '可入住 15 9月 2026');
});

test('one shared implementation — the detail page calls it, not its own copy', () => {
  const listing = fs.readFileSync(new URL('./listing.html', import.meta.url), 'utf8');
  assert.match(listing, /ptResolveNextAvailable\(data,lang\)/,
    'the detail page must use the shared resolver');
  assert.equal(/formatAvailableFromLine\(data\.available_from/.test(listing), false,
    'the old property-only implementation must be gone, or the two surfaces can disagree');
});

test('the card renders it inline with the price, not as an extra block', () => {
  const src = fs.readFileSync(new URL('./components.js', import.meta.url), 'utf8');
  assert.match(src, /pt-card-next-available/);
  // A <span> spliced into the price <p>, never a sibling <p>.
  assert.match(src, /priceHtml = priceHtml\.replace\(\/<\\\/p>\\s\*\$\//);
  assert.equal(/<p class="pt-card-next-available"/.test(src), false, 'must not be its own paragraph');
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PRODUCTION SHAPE — market_status is NULL and unit rows carry the truth
// ═══════════════════════════════════════════════════════════════════════════
// Reported live: Next Available never appeared. The resolver was gating on
// properties.market_status ALONE, which is a standalone manual dropdown in
// admin (f-market-status) that nothing derives from unit occupancy -- no
// trigger, no save-path logic. resolveListingStatus() defaults NULL to
// 'available', so the gate closed before the date was ever read.
//
// The ordinary production shape is exactly this: staff switch off each unit
// type's Available checkbox and type a next_available_date, and never touch
// Market Status. Every fixture in the original suite set market_status
// explicitly, which is why none of them caught it -- see the blind-spot guard
// at the bottom of this file.

const prodShape = (over) => Object.assign({
  id: 'prod', slug: 'prod', transaction_type: 'for_rent',
  workflow_status: 'active', status: 'active',
  market_status: null,                 // <- never set by staff
  price_amount: null, price_currency: null, price_frequency: null, price_display: null,
  available_from: null,
  unit_types: [{
    id: 'pu1', name_en: '1BR', sort_order: 0,
    is_available: false, available_count: 0, total_units: null,
    next_available_date: '2026-09-15',
    price_amount: 350, price_currency: 'USD', price_frequency: 'monthly'
  }]
}, over);

test('PROD-1. market_status NULL + occupied unit + future date → suffix appears (en)', () => {
  const r = ptResolveNextAvailable(prodShape(), 'en', '2026-08-20');
  assert.ok(r, 'this returned null before the gate was widened');
  assert.equal(r.isoDate, '2026-09-15');
  assert.equal(r.text, 'Available 15 Sep 2026');
});

test('PROD-2. ...and in Lao', () => {
  assert.equal(ptResolveNextAvailable(prodShape(), 'lo', '2026-08-20').text, 'ວ່າງ 15 ກ.ຍ 2026');
});

test('PROD-3. the price stays visible and is unaffected by the gate', () => {
  const p = prodShape();
  assert.equal(formatPropertyPrice(p, 'en').singleText, '$350 / month');
  assert.equal(formatPropertyPrice(p, 'lo').singleText, '$350 / ເດືອນ');
  assert.equal(formatPropertyPrice(p, 'en').isPriceOnRequest, false);
});

test('PROD-4. factual unavailable treatment appears, derived from the units', () => {
  const f = ptResolveListingFomo(prodShape(), 'en');
  assert.equal(f.kind, 'missed');
  assert.equal(f.tone, 'unavailable');
  assert.equal(f.text, 'Fully occupied', 'market_status still says "available" — the label comes from the units');
  assert.equal(ptResolveListingFomo(prodShape(), 'lo').text, 'ເຕັມແລ້ວ');
  assert.equal(f.count, undefined, 'no scarcity count when nothing is open');
});

test('PROD-5. no future date → no suffix, but the factual line still shows', () => {
  const p = prodShape();
  p.unit_types[0].next_available_date = null;
  assert.equal(ptResolveNextAvailable(p, 'en', '2026-08-20'), null, 'no date must not be invented');
  assert.equal(ptResolveListingFomo(p, 'en').text, 'Fully occupied');
  assert.equal(formatPropertyPrice(p, 'en').singleText, '$350 / month', 'price survives');
});

test('PROD-6. ONE unit still open → no suffix, and no unavailable line', () => {
  const p = prodShape();
  p.unit_types.push({ id: 'pu2', name_en: '2BR', sort_order: 1,
                      is_available: true, available_count: 2, total_units: null,
                      next_available_date: null,
                      price_amount: 500, price_currency: 'USD', price_frequency: 'monthly' });
  assert.equal(ptResolveNextAvailable(p, 'en', '2026-08-20'), null, 'rentable today');
  const f = ptResolveListingFomo(p, 'en');
  assert.ok(!f || f.kind !== 'missed', 'must not claim unavailable while a unit is open');
});

test('PROD-7. an explicit market_status still wins when it says unavailable', () => {
  // Widening the gate must not weaken it: a listing marked rented stays rented
  // even if a unit row was left switched on.
  const p = prodShape({ market_status: 'rented' });
  p.unit_types[0].is_available = true;
  p.unit_types[0].available_count = 3;
  assert.equal(ptResolveListingFomo(p, 'en').text, 'Just rented — see similar');
});

test('PROD-8. no unit types → falls back to market_status exactly as before', () => {
  const avail = { transaction_type: 'for_rent', market_status: null,
                  available_from: '2026-09-15', price_amount: 350, price_currency: 'USD' };
  assert.equal(ptResolveNextAvailable(avail, 'en', '2026-08-20'), null,
    'null unit data must read as "ask market_status", never as "closed"');
  const rented = Object.assign({}, avail, { market_status: 'rented' });
  assert.equal(ptResolveNextAvailable(rented, 'en', '2026-08-20').isoDate, '2026-09-15');
});

test('PROD-9. multiple occupied units → earliest future date across them', () => {
  const p = prodShape();
  p.unit_types[0].next_available_date = '2026-12-01';
  p.unit_types.push({ id: 'pu2', name_en: '2BR', sort_order: 1, is_available: false,
                      available_count: 0, total_units: null, next_available_date: '2026-09-15',
                      price_amount: 500, price_currency: 'USD', price_frequency: 'monthly' });
  assert.equal(ptResolveNextAvailable(p, 'en', '2026-08-20').isoDate, '2026-09-15');
});

test('PROD-10. FOMO numeric scarcity is unchanged by the widened gate', () => {
  // One open unit with a real count still produces "Only 1 left"; the gate
  // only decides unavailable-vs-not, it never touches the counting rules.
  const p = prodShape({ market_status: null });
  p.unit_types = [{ id: 'a', name_en: 'Studio', sort_order: 0, is_available: true,
                    available_count: 1, total_units: null, next_available_date: null,
                    price_amount: 350, price_currency: 'USD', price_frequency: 'monthly' }];
  assert.equal(ptResolveListingFomo(p, 'en').text, 'Only 1 left');
  p.unit_types[0].available_count = 2;
  p.unit_types[0].total_units = 20;
  assert.equal(ptResolveListingFomo(p, 'en').text, '2 of 20 available');
  // is_available true but ZERO available_count is not "open" -- and both
  // columns are NOT NULL in the schema (20260720000000_unit_types.sql:55-56,
  // `is_available boolean NOT NULL DEFAULT true` / `available_count integer
  // NOT NULL DEFAULT 1`), so a null count is not a state production can reach.
  p.unit_types[0].available_count = 0;
  p.unit_types[0].total_units = null;
  const f = ptResolveListingFomo(p, 'en');
  assert.equal(f.kind, 'missed', 'zero open units is a factual closure, not a scarcity claim');
  assert.equal(f.count, undefined, 'and it carries no count');
});

// ── THE BLIND-SPOT GUARD ──────────────────────────────────────────────────
// Every fixture in the original suite set market_status explicitly, so the
// suite tested a shape admin does not actually produce. This asserts that at
// least one Next Available fixture leaves market_status unset, and fails if a
// future edit deletes the production-shape block above.
test('GUARD: the suite covers a fixture that never populates market_status', () => {
  const src = fs.readFileSync(new URL('./next-available.test.js', import.meta.url), 'utf8');
  assert.match(src, /market_status:\s*null/,
    'at least one fixture must leave market_status unset — that is the production shape');
  assert.match(src, /prodShape\(\)/, 'the production-shape block must still be exercised');
  // And the resolver must not have gone back to reading market_status alone.
  const comp = fs.readFileSync(new URL('./components.js', import.meta.url), 'utf8');
  const fn = comp.slice(comp.indexOf('function ptResolveNextAvailable('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/isPubliclyAvailable/.test(body),
    'ptResolveNextAvailable must gate through _ptIsUnavailableNow, not resolveListingStatus directly');
});

// ═══ Default "today" is the LOCAL calendar date ═══════════════════════════
// Every case above passes TODAY explicitly. Production never does, and the
// default used toISOString()'s UTC date: between 00:00 and 07:00 in Laos
// (UTC+7) that is still yesterday, so a date that had already passed was
// still advertised as "Available <yesterday>".
test('the default today is the visitor-local calendar date, not the UTC one', () => {
  const RealDate = Date;
  // 2026-08-19 23:30 UTC == 2026-08-20 06:30 in Vientiane (UTC+7)
  class FakeDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : ['2026-08-19T23:30:00Z'])); }
    getTimezoneOffset() { return -420; }
  }
  globalThis.Date = FakeDate;
  try {
    assert.equal(globalThis.ptLocalIsoDate(), '2026-08-20');
    const p = { transaction_type: 'for_rent', market_status: 'rented',
      price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', available_from: '2026-08-19' };
    assert.equal(ptResolveNextAvailable(p, 'en'), null,
      'a date that is already yesterday in Laos must not be advertised');
    const q = Object.assign({}, p, { available_from: '2026-08-21' });
    assert.equal(ptResolveNextAvailable(q, 'en').isoDate, '2026-08-21');
  } finally {
    globalThis.Date = RealDate;
  }
});
