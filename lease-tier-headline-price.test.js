// Regression tests for the missing multi-term rental pricing bug: a rental
// priced ONLY via its 3/6/12-month lease terms (lease-pricing.js) -- no
// property-level price_amount, no unit_types price -- showed "Price on
// request" everywhere (listing.html's .price-block, the listing card,
// price sorting/filtering) even though real prices were configured, because
// formatPropertyPrice()/ptResolveSortPrice() (components.js) never consulted
// lease-pricing.js at all.
//
//   node --test lease-tier-headline-price.test.js
//
// Customer-first fix: the HEADLINE price (card, price-block fallback, sort
// key) now shows the CHEAPEST comparable lease term ("From $500 / month" for
// 3mo=$700/6mo=$600/12mo=$500), while the full 3/6/12-month breakdown -- a
// separate, pre-existing block on listing.html -- is completely untouched
// and keeps showing every tier in duration order.
//
// Same loading convention as listing-price-resolution.test.js/
// lease-pricing.test.js: the REAL shipped components.js/lease-pricing.js,
// loaded via vm into the real global context (plain-global-var browser
// scripts, no module exports).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'terminology.js', 'lease-pricing.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}

const {
  formatPropertyPrice, ptResolveSortPrice, resolveLeasePricing,
  buildLeasePricingLines, resolveCheapestComparableTerm,
} = globalThis;

// The exact worked example from the bug report.
const LEASE_TIER_ONLY = {
  transaction_type: 'for_rent',
  price_amount: null, price_currency: null, price_frequency: null, price_display: null,
  rent_price_daily: null, rent_price_3mo: 700, rent_price_6mo: 600, rent_price_12mo: 500,
  lease_price_basis: 'monthly',
  unit_types: [],
};

function displayedPrice(property, lang) {
  const info = formatPropertyPrice(property, lang || 'en');
  if (info.isSor) return { source: 'sor', text: [info.saleText, info.rentText].filter(Boolean).join(' · ') || null, fromLabel: null };
  if (info.isPriceOnRequest) return { source: 'inquire', text: null, fromLabel: null };
  return { source: info.priceSource || 'property', text: info.singleText, fromLabel: info.fromLabel || null };
}

// ── THE BUG, reproduced and fixed ───────────────────────────────────────
test('THE BUG: a listing priced only via 3/6/12-month lease tiers no longer shows "Price on request" -- it shows the cheapest tier', () => {
  const d = displayedPrice(LEASE_TIER_ONLY, 'en');
  assert.notEqual(d.source, 'inquire', 'must not fall back to Price on request when real tier prices exist');
  assert.equal(d.text, '$500 / month');
  assert.equal(d.source, 'lease_tier');
});

test('the headline is qualified "From $X" (PT_FROM_PRICE_PREFIX) when the tiers actually differ, matching the existing multi-unit-variance convention', () => {
  const d = displayedPrice(LEASE_TIER_ONLY, 'en');
  assert.equal(d.fromLabel, 'From');
  const lo = displayedPrice(LEASE_TIER_ONLY, 'lo');
  assert.equal(lo.fromLabel, 'ເລີ່ມຕົ້ນ');
});

test('a single configured tier (no variance) shows plainly, with NO "From" prefix', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, unit_types: [], rent_price_12mo: 500, lease_price_basis: 'monthly' };
  const d = displayedPrice(p, 'en');
  assert.equal(d.text, '$500 / month');
  assert.equal(d.fromLabel, null);
});

test('a daily-only rate is never treated as comparable to the monthly tiers -- still "Price on request" (rule 9: daily is categorically different)', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, unit_types: [], rent_price_daily: 45 };
  assert.deepEqual(displayedPrice(p, 'en'), { source: 'inquire', text: null, fromLabel: null });
});

test('lease_price_basis="total" shows the cheapest tier with its correct "total" suffix, never relabeled as "/ month" (no arithmetic, rule 7)', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, unit_types: [],
    rent_price_3mo: 2100, rent_price_6mo: 3600, rent_price_12mo: 6000, lease_price_basis: 'total' };
  const d = displayedPrice(p, 'en');
  assert.equal(d.text, '$2,100 total');
  assert.equal(d.source, 'lease_tier');
});

// ── Precedence: every existing, working price source is completely untouched ──
test('a listing with a real property-level price_amount is byte-for-byte unchanged, even with lease tiers also configured', () => {
  const p = Object.assign({}, LEASE_TIER_ONLY, { price_amount: 800, price_currency: 'USD', price_frequency: 'monthly' });
  const withoutTiers = { transaction_type: 'for_rent', price_amount: 800, price_currency: 'USD', price_frequency: 'monthly', unit_types: [] };
  assert.deepEqual(formatPropertyPrice(p, 'en'), formatPropertyPrice(withoutTiers, 'en'));
  assert.equal(formatPropertyPrice(p, 'en').singleText, '$800');
});

test('the existing occupied-unit-type price fallback still wins over the new lease-tier fallback (correct precedence order)', () => {
  const p = {
    transaction_type: 'for_rent', price_amount: null, market_status: 'fully_occupied',
    rent_price_3mo: 700, rent_price_6mo: 600, rent_price_12mo: 500, lease_price_basis: 'monthly',
    unit_types: [{ id: 'u1', name_en: '1BR', price_amount: 450, price_currency: 'USD', price_frequency: 'month', is_available: false, available_count: 0 }],
  };
  const d = displayedPrice(p, 'en');
  assert.equal(d.text, '$450 / month');
  assert.equal(d.source, 'unit_type');
});

test('a listing with genuinely no price anywhere (no price_amount, no unit_types price, no lease tiers) still falls back to Price on request -- never fabricated', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, price_display: null, unit_types: [] };
  assert.deepEqual(displayedPrice(p, 'en'), { source: 'inquire', text: null, fromLabel: null });
});

// ── The detail-page full breakdown stays completely separate and intact ──
test('the full 3/6/12-month breakdown (buildLeasePricingLines) is untouched and orders by duration regardless of the new headline fallback', () => {
  const resolved = resolveLeasePricing(LEASE_TIER_ONLY, null);
  const lines = buildLeasePricingLines(resolved, 'en');
  assert.deepEqual(lines, [
    '3 months — $700 / month',
    '6 months — $600 / month',
    '1 year — $500 / month',
  ]);
});

// ── Sort/filter price key ────────────────────────────────────────────────
test('ptResolveSortPrice() uses the same cheapest comparable lease-tier amount as the headline, instead of treating the listing as priceless', () => {
  assert.deepEqual(ptResolveSortPrice(LEASE_TIER_ONLY), { amount: 500, currency: 'USD' });
});

test('ptResolveSortPrice(): an existing price_amount still wins over lease tiers, unchanged', () => {
  const p = Object.assign({}, LEASE_TIER_ONLY, { price_amount: 800, price_currency: 'USD' });
  assert.deepEqual(ptResolveSortPrice(p), { amount: 800, currency: 'USD' });
});

test('ptResolveSortPrice(): a daily-only rate does not count as a sortable price', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, unit_types: [], rent_price_daily: 45 };
  assert.deepEqual(ptResolveSortPrice(p), { amount: null, currency: null });
});

// ── resolveCheapestComparableTerm() in isolation ─────────────────────────
test('resolveCheapestComparableTerm(): picks the lowest amount among non-daily terms and reports variance', () => {
  const resolved = resolveLeasePricing(LEASE_TIER_ONLY, null);
  const cheapest = resolveCheapestComparableTerm(resolved);
  assert.equal(cheapest.term.key, '12mo');
  assert.equal(cheapest.term.amount, 500);
  assert.equal(cheapest.hasVariance, true);
});

test('resolveCheapestComparableTerm(): excludes the daily term even when it is numerically the smallest', () => {
  const p = { transaction_type: 'for_rent', price_amount: null, unit_types: [],
    rent_price_daily: 10, rent_price_12mo: 500, lease_price_basis: 'monthly' };
  const resolved = resolveLeasePricing(p, null);
  const cheapest = resolveCheapestComparableTerm(resolved);
  assert.equal(cheapest.term.key, '12mo'); // never 'daily', despite 10 < 500
});

test('resolveCheapestComparableTerm(): returns null when there are no terms at all, or only a daily rate', () => {
  assert.equal(resolveCheapestComparableTerm(resolveLeasePricing({ transaction_type: 'for_rent', price_amount: null }, null)), null);
  assert.equal(resolveCheapestComparableTerm(resolveLeasePricing({ transaction_type: 'for_rent', price_amount: null, rent_price_daily: 45 }, null)), null);
});
