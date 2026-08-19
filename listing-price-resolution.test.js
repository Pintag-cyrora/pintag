// Regression tests for the unavailable-rental price bug: a rental priced only
// under its unit type showed "Inquire for price" once fully occupied, because
// admin derives properties.price_amount from AVAILABLE unit types only
// (syncPricingMode -> _utActiveAmounts), so an occupied listing has no
// property-level price. The fix reuses the canonical unit resolver
// (resolveUnitType + buildUnitPriceText) as a display-time fallback.
//
// These tests model the listing.html price-block DECISION end-to-end using the
// real formatPropertyPrice (components.js), resolveUnitType (terminology.js),
// and the two helpers extracted from listing.html, loaded into a vm sandbox
// (same convention as rental-terms.test.js / unit-availability.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'components.js', 'terminology.js', 'unit-availability.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}

// Pull the two helpers straight out of listing.html so the test exercises the
// SHIPPING code, not a copy.
function extractFn(file, name) {
  const s = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const st = s.indexOf('function ' + name + '(');
  if (st < 0) throw new Error(name + ' not found in ' + file);
  let i = s.indexOf('{', st), d = 0;
  for (; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}') { d--; if (d === 0) { i++; break; } } }
  return s.slice(st, i);
}
vm.runInThisContext(extractFn('listing.html', 'buildUnitPriceText'));
vm.runInThisContext(extractFn('listing.html', 'resolveUnitTypesPriceText'));

const { formatPropertyPrice, resolveUnitTypesPriceText, formatAvailableFromLine } = globalThis;

// Faithful mirror of the price-block decision. The unit-type fallback now lives
// INSIDE formatPropertyPrice() (components.js) rather than being re-applied by
// each caller, so that both the listing card and the detail page recover the
// price identically -- the card previously could not, and showed "Price on
// request" for any listing priced only under its unit types.
//
// The observable behaviour these tests assert (which TEXT is displayed) is
// unchanged; only where the resolution happens moved, which `priceSource`
// reports.
function displayedPrice(property, lang) {
  lang = lang || 'en';
  const info = formatPropertyPrice(property, lang);
  if (info.isSor) return { source: 'sor', text: [info.saleText, info.rentText].filter(Boolean).join(' · ') || null };
  if (info.isPriceOnRequest) return { source: 'inquire', text: null };
  return {
    source: info.priceSource === 'unit_type' ? 'unit_type' : 'property',
    text: info.singleText + (info.unitText ? ' ' + info.unitText : '')
  };
}

const OCCUPIED_UNIT = { id: 'u1', name_en: '1BR', price_amount: 450, price_currency: 'USD', price_frequency: 'month', is_available: false, available_count: 0 };

// 1 ── unavailable plain rental with property-level price
test('unavailable plain rental with property-level price shows that price', () => {
  const p = { transaction_type: 'for_rent', price_amount: 500, price_currency: 'USD', price_frequency: 'month', market_status: 'rented', unit_types: [] };
  assert.deepEqual(displayedPrice(p, 'en'), { source: 'property', text: '$500 / month' });
});

// 2 ── unavailable rental whose price exists ONLY under a unit type (the bug)
test('unavailable rental priced only under a unit type shows the unit-type price, not Inquire', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, price_display: null, market_status: 'fully_occupied', unit_types: [OCCUPIED_UNIT] };
  const d = displayedPrice(p, 'en');
  assert.equal(d.source, 'unit_type');
  assert.equal(d.text, '$450 / month');
});

test('unavailable rental with multiple occupied unit types shows the cheapest unit price', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, market_status: 'fully_occupied', unit_types: [
    { id: 'a', name_en: '2BR', price_amount: 800, price_currency: 'USD', price_frequency: 'month', is_available: false, available_count: 0 },
    OCCUPIED_UNIT
  ] };
  assert.equal(displayedPrice(p, 'en').text, '$450 / month');
});

// 3 ── unavailable rental with no price anywhere -> Inquire
test('unavailable rental with no price anywhere falls back to Inquire', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, price_display: null, market_status: 'rented', unit_types: [] };
  assert.deepEqual(displayedPrice(p, 'en'), { source: 'inquire', text: null });
});

test('unavailable rental whose unit type also has no price -> Inquire (never fabricated)', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, market_status: 'rented', unit_types: [{ id: 'x', name_en: 'Studio', price_amount: null, is_available: false, available_count: 0 }] };
  assert.equal(displayedPrice(p, 'en').source, 'inquire');
});

// 4 ── available rental behavior unchanged (fallback never overrides a real price)
test('available rental with a property-level price is unchanged, with OR without unit types', () => {
  const base = { transaction_type: 'for_rent', price_amount: 600, price_currency: 'USD', price_frequency: 'month', market_status: 'available' };
  const withUnits = Object.assign({}, base, { unit_types: [{ id: 'u', name_en: '1BR', price_amount: 999, price_currency: 'USD', price_frequency: 'month', is_available: true, available_count: 2 }] });
  assert.deepEqual(displayedPrice(base, 'en'), { source: 'property', text: '$600 / month' });
  // Same output even though a unit type carries a different price -> the
  // fallback is only ever consulted when there is NO property-level price.
  assert.deepEqual(displayedPrice(withUnits, 'en'), { source: 'property', text: '$600 / month' });
});

// 5 ── Available From set/unset behavior unchanged and independent of the price fix
test('available_from set/unset is independent of the unit-type price fallback', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, market_status: 'fully_occupied', available_from: '2026-08-22', unit_types: [OCCUPIED_UNIT] };
  // Price still resolves from the unit type regardless of available_from.
  assert.equal(displayedPrice(p, 'en').text, '$450 / month');
  // available_from formats when set, null when unset — unchanged by the fix.
  assert.equal(formatAvailableFromLine(p.available_from, 'en'), 'Available from 22 Aug 2026');
  assert.equal(formatAvailableFromLine(null, 'en'), null);
});
