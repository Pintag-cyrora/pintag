// Unit tests for the new listings.html search dimensions (District + Price).
// Extracts the REAL PRICE_BANDS + matchesPriceBand + matchesActiveFilters from
// listings.html into a vm with stubbed module state, same convention as the
// other node --test suites.  node --test listings-search.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function extractFn(name) {
  const src = fs.readFileSync(new URL('./listings.html', import.meta.url), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}
function extractVar(name) {
  const src = fs.readFileSync(new URL('./listings.html', import.meta.url), 'utf8');
  const start = src.indexOf('var ' + name + ' = {');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i) + ';';
}
// Same as extractVar() but for an array literal (`var NAME = [...]`) --
// BEDROOM_BANDS is a flat list, not the {key: {...}} shape PRICE_BANDS uses
// (bedroom bands are not transaction-aware, so there's only ever one set).
function extractArrayVar(name) {
  const src = fs.readFileSync(new URL('./listings.html', import.meta.url), 'utf8');
  const start = src.indexOf('var ' + name + ' = [');
  let i = src.indexOf('[', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '[') depth++; else if (src[i] === ']') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i) + ';';
}

// Collaborators the extracted functions read. _resolvedPrice/_numericPrice are
// the REAL ones now rather than a stub, because they resolve through
// components.js' ptResolveSortPrice() -- a stub would hide exactly the
// fully-occupied-building regression the suite below exists to catch.
for (const f of ['currency.js', 'terminology.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
globalThis.window = globalThis;
vm.runInThisContext("var currentTxFilter='all', currentTypeFilter='all', currentAvailOnly=false, currentDistrictFilter='all', currentPriceBand='all', currentProvinceFilter='all', currentBedroomFilter='all';");
// The province axis joined matchesActiveFilters(). Load the REAL registry and
// the REAL _listingProvince() rather than stubbing them, so these tests keep
// exercising the shipped predicate.
vm.runInThisContext(fs.readFileSync(new URL('./provinces.js', import.meta.url), 'utf8'), { filename: 'provinces.js' });
vm.runInThisContext("var VIENTIANE_CAPITAL_DISTRICTS=['Sisattanak','Saysettha','Chanthabouly','Sikhottabong','Xaythany','Hadxaifong','Naxaithong'];");
vm.runInThisContext("var matchesRentalFilters=function(){return true;};");
vm.runInThisContext("var isAvailableStatus=function(){return true;};");
vm.runInThisContext(extractVar('PRICE_BANDS'));
vm.runInThisContext(extractArrayVar('BEDROOM_BANDS'));
['_resolvedPrice', '_resolvedPriceForCurrentTx', '_numericPrice', '_listingProvince', 'currentPriceBands', 'currentPriceBandDef', 'currentBedroomBandDef', 'matchesPriceBand', 'matchesBedroomFilter', 'matchesActiveFilters']
  .forEach((n) => vm.runInThisContext(extractFn(n)));

function setState(s) { Object.assign(globalThis, s); }
const usd = (amt, extra) => Object.assign({ price_amount: amt, price_currency: 'USD', transaction_type: 'for_rent', property_type: 'apartment', district_en: 'Sisattanak' }, extra);

// ── Price bands ───────────────────────────────────────────────────────────
test('rent band $300–600 includes $450, excludes $700 and $250', () => {
  setState({ currentTxFilter: 'for_rent', currentPriceBand: 'r2' });
  assert.equal(globalThis.matchesPriceBand(usd(450)), true);
  assert.equal(globalThis.matchesPriceBand(usd(700)), false);
  assert.equal(globalThis.matchesPriceBand(usd(250)), false);
});

test('bands are half-open [min, max): an edge amount belongs to exactly one band', () => {
  // $300 ends "Under $300" and starts "$300-600"; an inclusive max put it in both.
  setState({ currentTxFilter: 'for_rent', currentPriceBand: 'r1' });
  assert.equal(globalThis.matchesPriceBand(usd(299)), true);
  assert.equal(globalThis.matchesPriceBand(usd(300)), false);
  setState({ currentTxFilter: 'for_rent', currentPriceBand: 'r2' });
  assert.equal(globalThis.matchesPriceBand(usd(300)), true);
  assert.equal(globalThis.matchesPriceBand(usd(600)), false);
  setState({ currentTxFilter: 'for_rent', currentPriceBand: 'r4' });
  assert.equal(globalThis.matchesPriceBand(usd(1000)), true);
  setState({ currentTxFilter: 'for_sale', currentPriceBand: 's1' });
  assert.equal(globalThis.matchesPriceBand(usd(50000, { transaction_type: 'for_sale' })), false);
  setState({ currentTxFilter: 'for_sale', currentPriceBand: 's2' });
  assert.equal(globalThis.matchesPriceBand(usd(50000, { transaction_type: 'for_sale' })), true);
});

test('a sale_or_rent listing under For Rent is banded on its rent leg', () => {
  const villa = { transaction_type: 'sale_or_rent', price_amount: 250000, price_currency: 'USD', rent_price_amount: 1200, rent_price_currency: 'USD', property_type: 'villa', district_en: 'Sisattanak' };
  setState({ currentTxFilter: 'for_rent', currentPriceBand: 'r4' });
  assert.equal(globalThis.matchesPriceBand(villa), true);
  setState({ currentTxFilter: 'for_rent', currentPriceBand: 'r2' });
  assert.equal(globalThis.matchesPriceBand(villa), false);
  setState({ currentTxFilter: 'for_sale', currentPriceBand: 's3' });
  assert.equal(globalThis.matchesPriceBand(villa), true);
});

test('"Any price" matches every listing', () => {
  setState({ currentTxFilter: 'for_rent', currentPriceBand: 'all' });
  assert.equal(globalThis.matchesPriceBand(usd(50)), true);
  assert.equal(globalThis.matchesPriceBand(usd(99999)), true);
});

test('sale bands use totals (Under $50k)', () => {
  setState({ currentTxFilter: 'for_sale', currentPriceBand: 's1' });
  assert.equal(globalThis.matchesPriceBand(usd(40000, { transaction_type: 'for_sale' })), true);
  assert.equal(globalThis.matchesPriceBand(usd(120000, { transaction_type: 'for_sale' })), false);
});

test('non-USD listings are never dropped by a price band (no conversion)', () => {
  setState({ currentTxFilter: 'for_rent', currentPriceBand: 'r1' }); // Under $300
  assert.equal(globalThis.matchesPriceBand({ price_amount: 3000000, price_currency: 'LAK' }), true);
});

test('a listing with no price is not hidden by a band', () => {
  setState({ currentTxFilter: 'for_rent', currentPriceBand: 'r1' });
  assert.equal(globalThis.matchesPriceBand({ price_amount: null, price_currency: 'USD' }), true);
});

// ── District + combined predicate ─────────────────────────────────────────
test('district filter narrows to the chosen district', () => {
  setState({ currentTxFilter: 'all', currentTypeFilter: 'all', currentPriceBand: 'all', currentDistrictFilter: 'Sisattanak', currentAvailOnly: false });
  assert.equal(globalThis.matchesActiveFilters(usd(500, { district_en: 'Sisattanak' })), true);
  assert.equal(globalThis.matchesActiveFilters(usd(500, { district_en: 'Chanthabouly' })), false);
});

test('district="all" keeps every district', () => {
  setState({ currentDistrictFilter: 'all', currentTxFilter: 'all', currentTypeFilter: 'all', currentPriceBand: 'all' });
  assert.equal(globalThis.matchesActiveFilters(usd(500, { district_en: 'Xaythany' })), true);
});

test('district + price + type compose (AND)', () => {
  setState({ currentTxFilter: 'for_rent', currentTypeFilter: 'apartment', currentDistrictFilter: 'Sisattanak', currentPriceBand: 'r2', currentAvailOnly: false });
  assert.equal(globalThis.matchesActiveFilters(usd(450, { district_en: 'Sisattanak', property_type: 'apartment', transaction_type: 'for_rent' })), true);
  // right district/price but wrong type -> excluded
  assert.equal(globalThis.matchesActiveFilters(usd(450, { district_en: 'Sisattanak', property_type: 'house', transaction_type: 'for_rent' })), false);
  // right district/type but out-of-band price -> excluded
  assert.equal(globalThis.matchesActiveFilters(usd(900, { district_en: 'Sisattanak', property_type: 'apartment', transaction_type: 'for_rent' })), false);
});

// ── Bedroom Count filter ──────────────────────────────────────────────────
test('"Any" matches every bedroom count, including null (Land)', () => {
  setState({ currentBedroomFilter: 'all' });
  assert.equal(globalThis.matchesBedroomFilter(usd(500, { bedrooms: 1 })), true);
  assert.equal(globalThis.matchesBedroomFilter(usd(500, { bedrooms: 5 })), true);
  assert.equal(globalThis.matchesBedroomFilter({ bedrooms: null }), true);
});

test('each exact band (1-4) matches only that count', () => {
  for (const n of [1, 2, 3, 4]) {
    setState({ currentBedroomFilter: String(n) });
    assert.equal(globalThis.matchesBedroomFilter({ bedrooms: n }), true, n + ' should match its own band');
    assert.equal(globalThis.matchesBedroomFilter({ bedrooms: n - 1 }), false, (n - 1) + ' should not match the ' + n + ' band');
    assert.equal(globalThis.matchesBedroomFilter({ bedrooms: n + 1 }), false, (n + 1) + ' should not match the ' + n + ' band');
  }
});

test('"5plus" catches exactly 5 and everything above, never 4', () => {
  setState({ currentBedroomFilter: '5plus' });
  assert.equal(globalThis.matchesBedroomFilter({ bedrooms: 5 }), true);
  assert.equal(globalThis.matchesBedroomFilter({ bedrooms: 6 }), true);
  assert.equal(globalThis.matchesBedroomFilter({ bedrooms: 12 }), true, 'an unusually large building must still match, not just 5-6');
  assert.equal(globalThis.matchesBedroomFilter({ bedrooms: 4 }), false);
});

test('bedrooms:null (Land, per terminology.js PHASE 1 scope) never matches a SPECIFIC band, only "Any"', () => {
  for (const key of ['1', '2', '3', '4', '5plus']) {
    setState({ currentBedroomFilter: key });
    assert.equal(globalThis.matchesBedroomFilter({ bedrooms: null }), false, 'band ' + key + ' must exclude a bedrooms:null listing');
  }
  setState({ currentBedroomFilter: 'all' });
  assert.equal(globalThis.matchesBedroomFilter({ bedrooms: null }), true, '"Any" must still include it');
});

test('currentBedroomBandDef() falls back to "all" for an unrecognised/crafted key', () => {
  setState({ currentBedroomFilter: 'not-a-real-key' });
  const def = globalThis.currentBedroomBandDef();
  assert.equal(def.key, 'all');
  assert.equal(globalThis.matchesBedroomFilter({ bedrooms: null }), true);
});

test('bedroom filter composes (AND) with district + price + type in matchesActiveFilters()', () => {
  setState({ currentTxFilter: 'for_rent', currentTypeFilter: 'apartment', currentDistrictFilter: 'Sisattanak', currentPriceBand: 'r2', currentBedroomFilter: '2', currentAvailOnly: false });
  const base = { district_en: 'Sisattanak', property_type: 'apartment', transaction_type: 'for_rent' };
  assert.equal(globalThis.matchesActiveFilters(usd(450, Object.assign({}, base, { bedrooms: 2 }))), true);
  // everything else right, but wrong bedroom count -> excluded
  assert.equal(globalThis.matchesActiveFilters(usd(450, Object.assign({}, base, { bedrooms: 3 }))), false);
  // a Land listing (bedrooms: null) with a specific bedroom filter active -> excluded
  assert.equal(globalThis.matchesActiveFilters(usd(450, Object.assign({}, base, { bedrooms: null }))), false);
  setState({ currentBedroomFilter: 'all' });
  assert.equal(globalThis.matchesActiveFilters(usd(450, Object.assign({}, base, { bedrooms: null }))), true, '"Any" must let the same Land-shaped row back in');
});
