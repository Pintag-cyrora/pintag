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

const { CURRENCIES, DEFAULT_CURRENCY, formatMoney, currencySymbol, currencyCode } = globalThis;

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
