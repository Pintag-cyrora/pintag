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
