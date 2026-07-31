// Unit tests for budget-bands.js -- run with `node budget-bands.test.js`.
// Same vm-sandbox convention as currency.test.js/rental-terms.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const currencySrc = fs.readFileSync(new URL('./currency.js', import.meta.url), 'utf8');
vm.runInThisContext(currencySrc, { filename: 'currency.js' });
const src = fs.readFileSync(new URL('./budget-bands.js', import.meta.url), 'utf8');
vm.runInThisContext(src, { filename: 'budget-bands.js' });

const {
  BUDGET_BANDS, BUDGET_ANY_ID, BUDGET_ANY_LABEL,
  getBudgetBands, bandContains, formatBudgetLabel
} = globalThis;

test('BUDGET_BANDS covers rent+sale x USD/LAK/THB, each band ordered and contiguous', () => {
  ['rent', 'sale'].forEach((kind) => {
    ['USD', 'LAK', 'THB'].forEach((cur) => {
      const bands = BUDGET_BANDS[kind][cur];
      assert.ok(Array.isArray(bands) && bands.length >= 3, `${kind}.${cur} should have several bands`);
      assert.equal(bands[0].min, null, `${kind}.${cur} first band should have no floor`);
      assert.equal(bands[bands.length - 1].max, null, `${kind}.${cur} last band should have no ceiling`);
      for (let i = 1; i < bands.length; i++) {
        assert.equal(bands[i].min, bands[i - 1].max, `${kind}.${cur} band ${i} should start where band ${i - 1} ends`);
      }
    });
  });
});

test('getBudgetBands: for_rent maps to rent bands, everything else maps to sale bands', () => {
  assert.equal(getBudgetBands('for_rent', 'USD'), BUDGET_BANDS.rent.USD);
  assert.equal(getBudgetBands('for_sale', 'USD'), BUDGET_BANDS.sale.USD);
  assert.equal(getBudgetBands('sale_or_rent', 'USD'), BUDGET_BANDS.sale.USD);
  assert.equal(getBudgetBands('all', 'USD'), BUDGET_BANDS.sale.USD);
  assert.equal(getBudgetBands(undefined, 'USD'), BUDGET_BANDS.sale.USD);
});

test('getBudgetBands: falls back to USD for an unsupported currency', () => {
  assert.equal(getBudgetBands('for_rent', 'EUR'), BUDGET_BANDS.rent.USD);
});

test('bandContains: under-band (no floor)', () => {
  const band = { min: null, max: 300 };
  assert.equal(bandContains(band, 0), true);
  assert.equal(bandContains(band, 299), true);
  assert.equal(bandContains(band, 300), false); // exclusive upper bound
});

test('bandContains: mid-band', () => {
  const band = { min: 300, max: 600 };
  assert.equal(bandContains(band, 300), true);  // inclusive lower bound
  assert.equal(bandContains(band, 599), true);
  assert.equal(bandContains(band, 600), false);
  assert.equal(bandContains(band, 100), false);
});

test('bandContains: plus-band (no ceiling)', () => {
  const band = { min: 2000, max: null };
  assert.equal(bandContains(band, 2000), true);
  assert.equal(bandContains(band, 999999), true);
  assert.equal(bandContains(band, 1999), false);
});

test('bandContains: null/NaN amounts never match any band', () => {
  const band = { min: null, max: 300 };
  assert.equal(bandContains(band, null), false);
  assert.equal(bandContains(band, undefined), false);
  assert.equal(bandContains(band, 'not a number'), false);
});

test('formatBudgetLabel: under/range/plus phrasing in English', () => {
  assert.equal(formatBudgetLabel({ min: null, max: 300 }, 'USD', 'en'), 'Under $300');
  assert.equal(formatBudgetLabel({ min: 300, max: 600 }, 'USD', 'en'), '$300 – $600');
  assert.equal(formatBudgetLabel({ min: 2000, max: null }, 'USD', 'en'), '$2,000+');
});

test('formatBudgetLabel: respects currency symbol', () => {
  assert.equal(formatBudgetLabel({ min: null, max: 3000000 }, 'LAK', 'en'), 'Under ₭3,000,000');
});

test('formatBudgetLabel: falls back to English for an unsupported language', () => {
  assert.equal(formatBudgetLabel({ min: null, max: 300 }, 'USD', 'fr'), 'Under $300');
});

test('BUDGET_ANY_ID / BUDGET_ANY_LABEL are exported and trilingual', () => {
  assert.equal(BUDGET_ANY_ID, 'any');
  assert.equal(BUDGET_ANY_LABEL.en, 'Any Budget');
  assert.ok(BUDGET_ANY_LABEL.lo && BUDGET_ANY_LABEL.zh);
});
