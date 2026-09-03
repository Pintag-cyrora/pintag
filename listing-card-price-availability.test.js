// Public listing card: PRICE, AVAILABILITY and FOMO are three independent axes.
//   node --test listing-card-price-availability.test.js
//
// THE BUG. A multi-unit building priced only under its unit types showed
// "Price on request" on the public card. Two independent causes, both fixed:
//
//   1. admin derives properties.price_amount from AVAILABLE unit types only
//      (syncPricingMode -> _utActiveAmounts filters the Available checkbox), so
//      marking a building fully occupied and saving NULLS OUT the property-level
//      price. The price never stopped existing — it lives on every unit_types
//      row — but the column the card reads went empty.
//   2. listings.html's query did not embed unit_types, so the card had nothing
//      to fall back to. The detail page did embed them and had its own
//      fallback, which is why the same listing showed a price there and not here.
//
// The invariant these tests defend: AVAILABILITY MUST NEVER SUPPRESS PRICE.
// Hiding the price of a rented listing destroys the market history that is the
// entire reason unavailable listings stay visible.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const { formatPropertyPrice, ptResolveListingFomo, ptResolveUnitTypesPrice } = globalThis;

const priceOf = (p, lang) => {
  const i = formatPropertyPrice(p, lang || 'en');
  if (i.isSor) return [i.saleText, i.rentText].filter(Boolean).join(' · ');
  if (i.isPriceOnRequest) return null;
  return i.singleText + (i.unitText ? ' ' + i.unitText : '');
};

const unit = (o) => Object.assign(
  { id: 'u1', name_en: 'Studio', is_available: true, available_count: 3, total_units: null }, o);

// ═══ The five required scenarios ═══════════════════════════════════════════

test('1. AVAILABLE + property-level price → price shown', () => {
  const p = { transaction_type: 'for_rent', market_status: 'available',
              price_amount: 450, price_currency: 'USD', price_frequency: 'monthly' };
  assert.equal(priceOf(p), '$450 / month');
});

test('2. UNAVAILABLE + property-level price → price still shown, unchanged', () => {
  const avail = { transaction_type: 'for_rent', market_status: 'available',
                  price_amount: 450, price_currency: 'USD', price_frequency: 'monthly' };
  const rented = Object.assign({}, avail, { market_status: 'rented' });
  assert.equal(priceOf(rented), '$450 / month');
  assert.equal(priceOf(rented), priceOf(avail), 'market_status must not change the price at all');
});

test('3. AVAILABLE + unit-type price only → cheapest unit price shown', () => {
  const p = {
    transaction_type: 'for_rent', market_status: 'available',
    price_amount: null, price_display: null,
    unit_types: [
      unit({ id: 'u1', name_en: 'Studio',    price_amount: 300, price_currency: 'USD', price_frequency: 'monthly' }),
      unit({ id: 'u2', name_en: '2 Bedroom', price_amount: 700, price_currency: 'USD', price_frequency: 'monthly' })
    ]
  };
  assert.equal(priceOf(p), '$300 / month', 'starting-from = cheapest unit');
});

test('4. UNAVAILABLE + unit-type price only → price STILL shown (the reported bug)', () => {
  // The exact production shape: fully occupied, so admin nulled the
  // property-level price, and every unit is is_available:false.
  const p = {
    transaction_type: 'for_rent', market_status: 'fully_occupied',
    price_amount: null, price_display: null,
    unit_types: [
      unit({ id: 'u1', name_en: 'Studio', price_amount: 300, price_currency: 'USD',
             price_frequency: 'monthly', is_available: false, available_count: 0 })
    ]
  };
  assert.equal(priceOf(p), '$300 / month',
    'an unavailable unit still has a price; availability must not suppress it');
});

test('5. No valid price anywhere → "Price on request", not a fabricated number', () => {
  const p = { transaction_type: 'for_rent', market_status: 'available', unit_types: [] };
  const info = formatPropertyPrice(p, 'en');
  assert.equal(info.isPriceOnRequest, true);
  assert.equal(info.requestText, 'Price on request');
});

// ═══ Price is structurally independent of availability ════════════════════

test('price is byte-identical across EVERY market_status', () => {
  const base = { transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD', price_frequency: 'monthly' };
  const statuses = ['available', 'reserved', 'rented', 'sold', 'fully_occupied', 'off_market', undefined];
  const rendered = statuses.map(m => priceOf(Object.assign({}, base, { market_status: m })));
  assert.equal(new Set(rendered).size, 1, 'price varied by availability: ' + JSON.stringify(rendered));
  assert.equal(rendered[0], '$450 / month');
});

test('the unit-type fallback never reads availability fields', () => {
  const priced = { price_amount: 300, price_currency: 'USD', price_frequency: 'monthly' };
  const open   = { transaction_type: 'for_rent', unit_types: [unit(Object.assign({ is_available: true,  available_count: 5 }, priced))] };
  const closed = { transaction_type: 'for_rent', unit_types: [unit(Object.assign({ is_available: false, available_count: 0 }, priced))] };
  assert.equal(ptResolveUnitTypesPrice(open, 'en'), ptResolveUnitTypesPrice(closed, 'en'));
});

test('property-level price wins when present; unit types are only a fallback', () => {
  const p = {
    transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD', price_frequency: 'monthly',
    unit_types: [unit({ price_amount: 300, price_currency: 'USD', price_frequency: 'monthly' })]
  };
  assert.equal(priceOf(p), '$450 / month');
  assert.equal(formatPropertyPrice(p, 'en').priceSource, undefined, 'should not have used the fallback');
});

test('sale_or_rent keeps both legs regardless of availability', () => {
  const p = { transaction_type: 'sale_or_rent', market_status: 'sold',
              price_amount: 250000, price_currency: 'USD',
              rent_price_amount: 900, rent_price_currency: 'USD', rent_price_frequency: 'monthly' };
  assert.equal(priceOf(p), '$250,000 · $900 / month');
});

// ═══ FOMO: derived from real data, never fabricated ═══════════════════════

test('FOMO: no unit inventory → NO scarcity claim at all', () => {
  const p = { transaction_type: 'for_rent', market_status: 'available', price_amount: 450 };
  assert.equal(ptResolveListingFomo(p, 'en'), null, 'must not invent scarcity from nothing');
});

test('FOMO: "Only 1 left" ONLY when available_count genuinely totals 1', () => {
  const one  = { market_status: 'available', unit_types: [unit({ available_count: 1 })] };
  const many = { market_status: 'available', unit_types: [unit({ available_count: 6 })] };
  assert.equal(ptResolveListingFomo(one, 'en').text, 'Only 1 left');
  assert.equal(ptResolveListingFomo(one, 'en').kind, 'last_one');
  assert.equal(ptResolveListingFomo(many, 'en'), null, '6 available is not scarcity');
});

test('FOMO: counts add up across unit types before claiming "1 left"', () => {
  const p = { market_status: 'available',
              unit_types: [unit({ id: 'a', available_count: 1 }), unit({ id: 'b', available_count: 1 })] };
  assert.equal(ptResolveListingFomo(p, 'en'), null, '1 + 1 = 2 is not "only 1 left"');
});

test('FOMO: "N of M" requires total_units to be genuinely tracked', () => {
  const tracked = { market_status: 'available', unit_types: [unit({ available_count: 3, total_units: 24 })] };
  assert.equal(ptResolveListingFomo(tracked, 'en').text, '3 of 24 available');
  const untracked = { market_status: 'available', unit_types: [unit({ available_count: 3, total_units: null })] };
  assert.equal(ptResolveListingFomo(untracked, 'en'), null, 'no denominator → no ratio claim');
});

test('FOMO: plentiful inventory produces no urgency', () => {
  const p = { market_status: 'available', unit_types: [unit({ available_count: 20, total_units: 24 })] };
  assert.equal(ptResolveListingFomo(p, 'en'), null);
});

test('FOMO: unavailable listings get factual "missed it" messaging', () => {
  for (const [market, expected] of [['rented', 'Just rented — see similar'],
                                    ['sold', 'Just sold — see similar'],
                                    ['reserved', 'Reserved'],
                                    ['fully_occupied', 'Fully occupied']]) {
    const f = ptResolveListingFomo({ market_status: market }, 'en');
    assert.equal(f.text, expected, market);
    assert.equal(f.tone, 'unavailable');
  }
});

test('FOMO: an unavailable listing is never given scarcity urgency', () => {
  const p = { market_status: 'rented', unit_types: [unit({ available_count: 1 })] };
  const f = ptResolveListingFomo(p, 'en');
  assert.equal(f.kind, 'missed');
  assert.notEqual(f.tone, 'urgent');
});

test('FOMO is localized in all three languages', () => {
  const p = { market_status: 'available', unit_types: [unit({ available_count: 1 })] };
  for (const lang of ['en', 'lo', 'zh']) {
    const f = ptResolveListingFomo(p, lang);
    assert.ok(f && f.text && f.text.length, lang);
  }
  assert.notEqual(ptResolveListingFomo(p, 'lo').text, ptResolveListingFomo(p, 'en').text);
});

// ═══ The three axes are independent ═══════════════════════════════════════

test('price, availability and FOMO are computed from disjoint inputs', () => {
  const src = fs.readFileSync(new URL('./components.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function ptResolveUnitTypesPrice('),
                       src.indexOf('function formatPropertyPrice('));
  for (const forbidden of ['is_available', 'available_count', 'market_status', 'isPubliclyAvailable']) {
    assert.equal(fn.includes(forbidden), false,
      `the price resolver must not read ${forbidden} — that coupling is the bug`);
  }
});

// ═══ Legacy sale_or_rent rent leg honours rent_period, never double-suffixes ═
// rent_price is produced by deriveLegacyPriceFields(), which already appends
// the period; the card appended "/ month" on top ("$1,200 / year / month").
test('legacy sale_or_rent: a rent text that already carries its period is left alone; a bare one gets the row\'s rent_period', () => {
  const yearly = { transaction_type: 'sale_or_rent', sale_price: '$250,000', rent_price: '$1,200 / year', rent_period: 'year' };
  assert.equal(formatPropertyPrice(yearly, 'en').rentText, '$1,200 / year');
  const bare = { transaction_type: 'sale_or_rent', sale_price: '$250,000', rent_price: '$1,200', rent_period: 'year' };
  assert.equal(formatPropertyPrice(bare, 'en').rentText, '$1,200 / year');
  assert.equal(formatPropertyPrice(bare, 'lo').rentText, '$1,200 / ປີ');
  const monthly = { transaction_type: 'sale_or_rent', sale_price: '$250,000', rent_price: '$1,200' };
  assert.equal(formatPropertyPrice(monthly, 'en').rentText, '$1,200 / month', 'no rent_period -> month, as before');
  // structured sale leg + legacy rent leg (mid-backfill row)
  const mixed = { transaction_type: 'sale_or_rent', price_amount: 250000, price_currency: 'USD', rent_price: '$1,200 / year', rent_period: 'year' };
  assert.equal(formatPropertyPrice(mixed, 'en').rentText, '$1,200 / year');
});
