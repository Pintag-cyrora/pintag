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

// Collaborators the extracted functions read. _resolvedPrice/_numericPrice are
// the REAL ones now rather than a stub, because they resolve through
// components.js' ptResolveSortPrice() -- a stub would hide exactly the
// fully-occupied-building regression the suite below exists to catch.
for (const f of ['currency.js', 'terminology.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
globalThis.window = globalThis;
vm.runInThisContext("var currentTxFilter='all', currentTypeFilter='all', currentAvailOnly=false, currentDistrictFilter='all', currentPriceBand='all';");
vm.runInThisContext("var matchesRentalFilters=function(){return true;};");
vm.runInThisContext("var isAvailableStatus=function(){return true;};");
vm.runInThisContext(extractVar('PRICE_BANDS'));
['_resolvedPrice', '_numericPrice', 'currentPriceBands', 'currentPriceBandDef', 'matchesPriceBand', 'matchesActiveFilters']
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
