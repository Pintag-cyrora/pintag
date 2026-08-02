// Unit tests for currency.js -- run with `node currency.test.js`.
// Same vm-sandbox convention as rental-terms.test.js: currency.js is a
// plain-global-var browser script, loaded into the real global context so
// `var` declarations land on globalThis.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./currency.js', import.meta.url), 'utf8');
vm.runInThisContext(src, { filename: 'currency.js' });

const { CURRENCIES, DEFAULT_CURRENCY, formatMoney, formatMoneyRange, parseLegacyPriceAmount, currencySymbol, currencyCode } = globalThis;

test('CURRENCIES has exactly USD, LAK, THB with symbol+code', () => {
  assert.deepEqual(Object.keys(CURRENCIES).sort(), ['LAK', 'THB', 'USD']);
  assert.equal(CURRENCIES.USD.symbol, '$');
  assert.equal(CURRENCIES.USD.code, 'USD');
  assert.equal(CURRENCIES.LAK.symbol, '₭');
  assert.equal(CURRENCIES.THB.symbol, '฿');
});

test('DEFAULT_CURRENCY is USD', () => {
  assert.equal(DEFAULT_CURRENCY, 'USD');
});

test('formatMoney formats with the correct symbol and thousands separators', () => {
  assert.equal(formatMoney(550000, 'USD'), '$550,000');
  assert.equal(formatMoney(2500000, 'LAK'), '₭2,500,000');
  assert.equal(formatMoney(5000, 'THB'), '฿5,000');
});

test('formatMoney rounds to whole numbers', () => {
  assert.equal(formatMoney(100.6, 'USD'), '$101');
});

test('formatMoney falls back to DEFAULT_CURRENCY for an unknown currency', () => {
  assert.equal(formatMoney(100, 'EUR'), '$100');
});

test('formatMoney returns null for null/undefined/NaN amounts', () => {
  assert.equal(formatMoney(null, 'USD'), null);
  assert.equal(formatMoney(undefined, 'USD'), null);
  assert.equal(formatMoney('not a number', 'USD'), null);
});

test('currencySymbol / currencyCode accessors', () => {
  assert.equal(currencySymbol('LAK'), '₭');
  assert.equal(currencyCode('LAK'), 'LAK');
  assert.equal(currencySymbol(null), '$');
  assert.equal(currencyCode('unknown'), 'USD');
});

// formatMoneyRange() / parseLegacyPriceAmount() -- added alongside the
// rental price hierarchy + range-formatting bug fix. Both functions are
// referenced live from admin.html's Smart Import price parser
// (_parseImportPriceText()) and listings.html's sort-price fallback
// (_numericPrice()) -- this suite exists specifically so a load-order or
// naming regression in either call site is caught here, in CI, rather
// than surfacing as a "Can't find variable" error discovered by staff
// clicking through Smart Import.
test('formatMoneyRange formats a genuine range with one symbol and an en dash', () => {
  assert.equal(formatMoneyRange(280, 300, 'USD'), '$280–300');
  assert.equal(formatMoneyRange(1200, 1500, 'USD'), '$1,200–1,500');
  assert.equal(formatMoneyRange(3000000, 3500000, 'LAK'), '₭3,000,000–3,500,000');
});

test('formatMoneyRange collapses to a single formatMoney() value when min === max', () => {
  assert.equal(formatMoneyRange(500, 500, 'USD'), '$500');
});

test('formatMoneyRange falls back to a single value when one side is missing', () => {
  assert.equal(formatMoneyRange(null, 500, 'USD'), '$500');
  assert.equal(formatMoneyRange(500, null, 'USD'), '$500');
});

test('parseLegacyPriceAmount takes a range\'s lower bound instead of concatenating it', () => {
  // The exact bug this function exists to prevent: naive digit-stripping
  // turns "280-300" into "280300", which formatMoney() then renders as
  // "$280,300" -- indistinguishable from a real ~280K price.
  assert.equal(parseLegacyPriceAmount('$280-300 / month'), 280);
  assert.equal(parseLegacyPriceAmount('$1,200 to $1,500 / month'), 1200);
  assert.equal(parseLegacyPriceAmount('₭3,000,000-3,500,000'), 3000000);
});

test('parseLegacyPriceAmount parses a genuine single price unaffected', () => {
  assert.equal(parseLegacyPriceAmount('$550,000'), 550000);
  assert.equal(parseLegacyPriceAmount('$1,200 / month'), 1200);
});

test('parseLegacyPriceAmount returns null for empty/missing text', () => {
  assert.equal(parseLegacyPriceAmount(''), null);
  assert.equal(parseLegacyPriceAmount(null), null);
  assert.equal(parseLegacyPriceAmount(undefined), null);
});
