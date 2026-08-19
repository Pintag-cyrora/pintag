// Unit tests for lease-pricing.js -- run with `node --test lease-pricing.test.js`.
//
// lease-pricing.js is a plain-global-var browser script (same convention as
// currency.js/rental-terms.js, no module exports), so it's loaded into the
// real global context here rather than via `import`. Using vm.runInThisContext
// (not vm.createContext) matters for the same reason rental-terms.test.js
// documents: a separate V8 realm gives sandbox objects different prototypes
// and makes assert.deepEqual fail on identical data.
//
// What these tests are actually protecting:
//   * NO ARITHMETIC (rule 7). Every figure a visitor sees must be a figure a
//     human typed. The tests below pin that a total is never derived from a
//     monthly rate, a monthly rate is never derived from a total, a missing
//     tier is never interpolated between its neighbours, and a daily rate is
//     never computed from a monthly one.
//   * TIERS DO NOT INHERIT PER COLUMN (rule 8). A tier is a discount quoted
//     against a specific base rent, so attaching the building's "3 months:
//     $420/month" to a 2BR whose base is $700 would publish a price nobody
//     agreed to. That is a correctness rule, not a preference, and it has a
//     test per direction.
//   * DAILY IS NEVER GOVERNED BY basis (rule 9), including when basis='total'.
//   * Existing listings are untouched: a row with no tier columns at all must
//     resolve to exactly its base rent and report hasTiers === false.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'lease-pricing.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}

const {
  LEASE_TERMS, LEASE_TIER_COLUMNS, LEASE_BASIS_OPTIONS, LEASE_DEFAULT_BASIS,
  LEASE_PRICING_SCHEMA_VERSION, leaseTermByKey,
  resolveLeasePricing, formatLeaseTermAmount, formatLeaseTermLine,
  buildLeasePricingLines, hasLeaseTermPricing, buildLeasePricingPayload
} = globalThis;

// The worked example from the product request itself:
//   3-month = $420/month, 6-month = $400/month, 1-year = $350/month
const RENTAL = {
  transaction_type: 'for_rent',
  price_amount: 450, price_currency: 'USD', price_frequency: 'monthly',
  rent_price_daily: 45,
  rent_price_3mo: 420, rent_price_6mo: 400, rent_price_12mo: 350,
  lease_price_basis: 'monthly'
};
const lines = (p, u, lang) => buildLeasePricingLines(resolveLeasePricing(p, u), lang);

// ── Registry ────────────────────────────────────────────────────────────
test('LEASE_TERMS covers exactly the five requested terms, shortest first', () => {
  assert.deepEqual(LEASE_TERMS.map(t => t.key), ['daily', 'monthly', '3mo', '6mo', '12mo']);
});

test('LEASE_TERMS: monthly is the existing base price, so it owns no column', () => {
  assert.equal(leaseTermByKey('monthly').column, null);
  assert.deepEqual(LEASE_TIER_COLUMNS,
    ['rent_price_daily', 'rent_price_3mo', 'rent_price_6mo', 'rent_price_12mo']);
});

test('LEASE_TERMS: every term has all three language labels', () => {
  for (const t of LEASE_TERMS) {
    for (const lang of ['en', 'lo', 'zh']) {
      assert.equal(typeof t.label[lang], 'string', t.key + '.' + lang);
      assert.ok(t.label[lang].length, t.key + '.' + lang + ' is empty');
    }
  }
});

test('LEASE_TERMS: only daily is perDay, and basis governs only 3/6/12', () => {
  assert.deepEqual(LEASE_TERMS.filter(t => t.perDay).map(t => t.key), ['daily']);
  assert.deepEqual(LEASE_TERMS.filter(t => t.basisApplies).map(t => t.key), ['3mo', '6mo', '12mo']);
});

test('LEASE_BASIS_OPTIONS: exactly monthly + total, monthly is the default', () => {
  assert.deepEqual(LEASE_BASIS_OPTIONS.map(o => o.value), ['monthly', 'total']);
  assert.equal(LEASE_DEFAULT_BASIS, 'monthly');
});

// ── Contract shape ──────────────────────────────────────────────────────
test('resolveLeasePricing: frozen contract shape', () => {
  const r = resolveLeasePricing(RENTAL, null);
  assert.deepEqual(Object.keys(r).sort(),
    ['baseAmount', 'basis', 'currency', 'hasTiers', 'source', 'terms', 'version']);
  assert.equal(r.version, LEASE_PRICING_SCHEMA_VERSION);
  assert.equal(r.source, 'property');
});

test('resolveLeasePricing: never mutates its inputs', () => {
  const p = JSON.parse(JSON.stringify(RENTAL));
  const u = { rent_price_3mo: 300 };
  const pBefore = JSON.stringify(p), uBefore = JSON.stringify(u);
  resolveLeasePricing(p, u);
  assert.equal(JSON.stringify(p), pBefore);
  assert.equal(JSON.stringify(u), uBefore);
});

// ── The product's own worked example ────────────────────────────────────
test('the requested example renders exactly as specified', () => {
  assert.deepEqual(lines(RENTAL, null, 'en'), [
    'Daily — $45 / day',
    '1 month — $450 / month',
    '3 months — $420 / month',
    '6 months — $400 / month',
    '1 year — $350 / month'
  ]);
});

test('a daily rate displays as "$X / day" in every language', () => {
  const daily = resolveLeasePricing({ transaction_type: 'for_rent', price_currency: 'USD', rent_price_daily: 45 }, null).terms[0];
  assert.equal(formatLeaseTermAmount(daily, 'USD', 'en'), '$45 / day');
  assert.equal(formatLeaseTermAmount(daily, 'USD', 'lo'), '$45 / ມື້');
  assert.equal(formatLeaseTermAmount(daily, 'USD', 'zh'), '$45 / 天');
});

test('terms come back in registry order regardless of column order on the row', () => {
  const scrambled = {
    transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD',
    rent_price_12mo: 350, rent_price_daily: 45, rent_price_6mo: 400, rent_price_3mo: 420
  };
  assert.deepEqual(resolveLeasePricing(scrambled, null).terms.map(t => t.key),
    ['daily', 'monthly', '3mo', '6mo', '12mo']);
});

// ── Existing listings must be completely unaffected ─────────────────────
test('a plain single-price rental resolves to just its rent and reports no tiers', () => {
  const plain = { transaction_type: 'for_rent', price_amount: 500, price_currency: 'USD' };
  const r = resolveLeasePricing(plain, null);
  assert.equal(r.hasTiers, false);
  assert.equal(hasLeaseTermPricing(plain, null), false);
  assert.deepEqual(buildLeasePricingLines(r, 'en'), ['1 month — $500 / month']);
});

test('a row with no price data at all resolves to no terms, not a zero', () => {
  const r = resolveLeasePricing({ transaction_type: 'for_rent' }, null);
  assert.deepEqual(r.terms, []);
  assert.equal(r.hasTiers, false);
  assert.deepEqual(buildLeasePricingLines(r, 'en'), []);
});

test('a sale listing has no lease terms even when stale tier columns exist', () => {
  // price_amount on a for_sale row is the SALE price, never a monthly rent, so
  // it must not surface as "1 month — $250,000 / month". The stale tier columns
  // model a listing that was switched from rent to sale after being priced --
  // the sale listing must not publish the leftover rental rates.
  const sale = {
    transaction_type: 'for_sale', price_amount: 250000, price_currency: 'USD',
    rent_price_daily: 45, rent_price_12mo: 350, lease_price_basis: 'monthly'
  };
  assert.equal(hasLeaseTermPricing(sale, null), false);
  assert.deepEqual(resolveLeasePricing(sale, null).terms, []);
  assert.deepEqual(buildLeasePricingLines(resolveLeasePricing(sale, null), 'en'), []);
  assert.equal(resolveLeasePricing(sale, null).baseAmount, null);
});

test('a unit type under a sale listing likewise publishes no rental terms', () => {
  const sale = { transaction_type: 'for_sale', price_amount: 250000, price_currency: 'USD' };
  const unit = { id: 'u1', price_amount: 240000, price_currency: 'USD', rent_price_12mo: 350 };
  assert.deepEqual(resolveLeasePricing(sale, unit).terms, []);
});

test('lease pricing applies to exactly the transaction types rental-terms.js calls rentals', () => {
  // _lpIsRental() duplicates isRentalTransactionType() on purpose (rule 10
  // forbids these modules from referencing each other). Pin the agreement so
  // the duplication cannot drift.
  vm.runInThisContext(fs.readFileSync(new URL('./rental-terms.js', import.meta.url), 'utf8'), { filename: 'rental-terms.js' });
  const { isRentalTransactionType } = globalThis;
  const priced = { price_amount: 450, price_currency: 'USD' };
  for (const tx of ['for_rent', 'sale_or_rent', 'for_sale', 'sale', null, undefined, 'nonsense']) {
    const row = Object.assign({ transaction_type: tx }, tx === 'sale_or_rent'
      ? { rent_price_amount: 450, rent_price_currency: 'USD' } : priced);
    const resolvesTerms = resolveLeasePricing(row, null).terms.length > 0;
    assert.equal(resolvesTerms, !!isRentalTransactionType(tx), 'transaction_type=' + tx);
  }
});

// ── No arithmetic, ever (rule 7) ────────────────────────────────────────
test('a missing tier is never interpolated from its neighbours', () => {
  const gap = { transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD',
                rent_price_3mo: 420, rent_price_12mo: 350, lease_price_basis: 'monthly' };
  assert.deepEqual(resolveLeasePricing(gap, null).terms.map(t => t.key), ['monthly', '3mo', '12mo']);
  assert.equal(lines(gap, null, 'en').some(l => l.startsWith('6 months')), false);
});

test('a total is never converted into a monthly rate, or vice versa', () => {
  const totals = Object.assign({}, RENTAL, { lease_price_basis: 'total' });
  const out = lines(totals, null, 'en');
  assert.ok(out.includes('3 months — $420 total'), out.join(' | '));
  assert.ok(out.includes('1 year — $350 total'), out.join(' | '));
  // $420 as a 3-month TOTAL is $140/month -- that number must appear nowhere.
  assert.equal(out.join(' ').includes('140'), false);
});

test('a daily rate is never derived from the monthly rent', () => {
  const noDaily = { transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD', rent_price_3mo: 420 };
  assert.equal(resolveLeasePricing(noDaily, null).terms.some(t => t.key === 'daily'), false);
});

// ── basis never reaches the daily rate (rule 9) ─────────────────────────
test('basis=total leaves the daily rate per-day and the base rent per-month', () => {
  const totals = Object.assign({}, RENTAL, { lease_price_basis: 'total' });
  const out = lines(totals, null, 'en');
  assert.ok(out.includes('Daily — $45 / day'), out.join(' | '));
  assert.ok(out.includes('1 month — $450 / month'), out.join(' | '));
});

test('an unrecognised basis falls back to monthly rather than to "total"', () => {
  const weird = Object.assign({}, RENTAL, { lease_price_basis: 'per_fortnight' });
  assert.equal(resolveLeasePricing(weird, null).basis, 'monthly');
  assert.ok(lines(weird, null, 'en').includes('6 months — $400 / month'));
});

// ── Unit-level pricing (the apartment/condo requirement) ────────────────
const BUILDING = {
  transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD',
  rent_price_3mo: 420, rent_price_6mo: 400, rent_price_12mo: 350, lease_price_basis: 'monthly'
};

test('a unit type carries its own five-term pricing, independent of the building', () => {
  const twoBr = {
    id: 'u2', name_en: '2 Bedroom',
    price_amount: 700, price_currency: 'USD',
    rent_price_daily: 70, rent_price_3mo: 660, rent_price_6mo: 640, rent_price_12mo: 600,
    lease_price_basis: 'monthly'
  };
  const r = resolveLeasePricing(BUILDING, twoBr);
  assert.equal(r.source, 'unit_type');
  assert.deepEqual(buildLeasePricingLines(r, 'en'), [
    'Daily — $70 / day',
    '1 month — $700 / month',
    '3 months — $660 / month',
    '6 months — $640 / month',
    '1 year — $600 / month'
  ]);
});

test('two unit types in one building resolve to genuinely different pricing', () => {
  const studio = { id: 'u1', price_amount: 300, price_currency: 'USD', rent_price_12mo: 260, lease_price_basis: 'monthly' };
  const twoBr  = { id: 'u2', price_amount: 700, price_currency: 'USD', rent_price_12mo: 620, lease_price_basis: 'monthly' };
  assert.ok(lines(BUILDING, studio, 'en').includes('1 year — $260 / month'));
  assert.ok(lines(BUILDING, twoBr,  'en').includes('1 year — $620 / month'));
});

test('unit pricing is attached to the unit, not to properties.price_amount', () => {
  // The building has NO price of its own (the fully-occupied multi-unit case
  // admin's min-across-available-units logic produces). The unit still prices.
  const priceless = { transaction_type: 'for_rent' };
  const unit = { id: 'u1', price_amount: 380, price_currency: 'USD', rent_price_6mo: 350, lease_price_basis: 'monthly' };
  assert.deepEqual(buildLeasePricingLines(resolveLeasePricing(priceless, unit), 'en'),
    ['1 month — $380 / month', '6 months — $350 / month']);
});

// ── Rule 8: tiers do not inherit per column ─────────────────────────────
test('a unit type with NO tiers of its own does not borrow the building\'s', () => {
  const bareUnit = { id: 'u1', price_amount: 700, price_currency: 'USD' };
  const r = resolveLeasePricing(BUILDING, bareUnit);
  assert.equal(r.hasTiers, false);
  // $420 was quoted against the building's $450 base -- pairing it with this
  // unit's $700 base would publish a rate nobody agreed to.
  assert.deepEqual(buildLeasePricingLines(r, 'en'), ['1 month — $700 / month']);
});

test('a unit type that sets ONE tier does not backfill the rest from the building', () => {
  const partial = { id: 'u1', price_amount: 700, price_currency: 'USD', rent_price_12mo: 620, lease_price_basis: 'monthly' };
  assert.deepEqual(resolveLeasePricing(BUILDING, partial).terms.map(t => t.key), ['monthly', '12mo']);
});

test('a unit type with tiers but no basis reads the building\'s basis, not its amounts', () => {
  const totalsBuilding = Object.assign({}, BUILDING, { lease_price_basis: 'total' });
  const unit = { id: 'u1', price_amount: 700, price_currency: 'USD', rent_price_6mo: 3600 };
  const r = resolveLeasePricing(totalsBuilding, unit);
  assert.equal(r.basis, 'total');
  assert.ok(buildLeasePricingLines(r, 'en').includes('6 months — $3,600 total'));
  // The building's own 6-month amount must not appear anywhere.
  assert.equal(buildLeasePricingLines(r, 'en').join(' ').includes('400'), false);
});

test('a unit type with no price of its own still inherits the building BASE rent', () => {
  // The base rent is a standalone price, not a discount quoted against another
  // number, so ordinary null-means-inherit applies to it (unlike the tiers).
  const bare = { id: 'u1', rent_price_6mo: 400, lease_price_basis: 'monthly' };
  const r = resolveLeasePricing(BUILDING, bare);
  assert.equal(r.baseAmount, 450);
});

// ── sale_or_rent: the rent leg, not the sale leg ────────────────────────
test('sale_or_rent reads the rent leg for the base month, never the sale price', () => {
  const sor = {
    transaction_type: 'sale_or_rent',
    price_amount: 250000, price_currency: 'USD',       // the SALE leg
    rent_price_amount: 900, rent_price_currency: 'USD', // the RENT leg
    rent_price_daily: 80, rent_price_12mo: 800, lease_price_basis: 'monthly'
  };
  const out = lines(sor, null, 'en');
  assert.ok(out.includes('1 month — $900 / month'), out.join(' | '));
  assert.equal(out.join(' ').includes('250,000'), false);
});

// ── Currency ────────────────────────────────────────────────────────────
test('tiers inherit the listing\'s rent currency rather than each carrying one', () => {
  const lak = { transaction_type: 'for_rent', price_amount: 4000000, price_currency: 'LAK',
                rent_price_12mo: 3500000, lease_price_basis: 'monthly' };
  assert.deepEqual(lines(lak, null, 'en'),
    ['1 month — ₭4,000,000 / month', '1 year — ₭3,500,000 / month']);
});

// ── Amount hygiene ──────────────────────────────────────────────────────
test('empty string, null and NaN all mean "not offered", never 0', () => {
  const messy = { transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD',
                  rent_price_daily: '', rent_price_3mo: null, rent_price_6mo: 'abc' };
  assert.deepEqual(resolveLeasePricing(messy, null).terms.map(t => t.key), ['monthly']);
});

test('a genuine 0 is preserved rather than silently dropped', () => {
  // 0 is a real (if unusual) figure -- e.g. a promotional free first month.
  // The "not offered" cases above are '' / null / NaN, never a typed zero.
  const zero = { transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD', rent_price_daily: 0 };
  const r = resolveLeasePricing(zero, null);
  assert.equal(r.terms[0].key, 'daily');
  assert.equal(r.terms[0].amount, 0);
});

// ── Write path ──────────────────────────────────────────────────────────
test('buildLeasePricingPayload writes every tier column, nulling the blanks', () => {
  assert.deepEqual(buildLeasePricingPayload({ daily: 45, '3mo': 420 }, 'monthly'), {
    rent_price_daily: 45, rent_price_3mo: 420, rent_price_6mo: null, rent_price_12mo: null,
    lease_price_basis: 'monthly'
  });
});

test('buildLeasePricingPayload: no tiers at all stores a NULL basis', () => {
  // This is what keeps an untouched listing byte-for-byte what it was before
  // this feature existed.
  assert.deepEqual(buildLeasePricingPayload({}, 'monthly'), {
    rent_price_daily: null, rent_price_3mo: null, rent_price_6mo: null, rent_price_12mo: null,
    lease_price_basis: null
  });
});

test('buildLeasePricingPayload: a daily rate alone does not store a basis', () => {
  // basis governs 3/6/12 only, so a listing that offers only a daily rate has
  // nothing for it to describe.
  const out = buildLeasePricingPayload({ daily: 45 }, 'total');
  assert.equal(out.rent_price_daily, 45);
  assert.equal(out.lease_price_basis, null);
});

test('buildLeasePricingPayload round-trips through the resolver unchanged', () => {
  const payload = buildLeasePricingPayload({ daily: 45, '3mo': 420, '6mo': 400, '12mo': 350 }, 'monthly');
  const row = Object.assign({ transaction_type: 'for_rent', price_amount: 450, price_currency: 'USD' }, payload);
  assert.deepEqual(buildLeasePricingLines(resolveLeasePricing(row, null), 'en'), [
    'Daily — $45 / day', '1 month — $450 / month',
    '3 months — $420 / month', '6 months — $400 / month', '1 year — $350 / month'
  ]);
});

test('clearing a tier in the UI genuinely clears the column', () => {
  const cleared = buildLeasePricingPayload({ daily: 45, '3mo': '' }, 'monthly');
  assert.equal(cleared.rent_price_3mo, null);
});

// ── Cross-module agreement ──────────────────────────────────────────────
// lease-pricing.js keeps its own suffix table so it stays importable from a
// Deno edge function (components.js is browser-only page furniture). That is a
// deliberate duplication, so it gets a test rather than a comment: the two
// tables must say the same thing in all three languages.
test('per-day and per-month suffixes agree with components.js\'s own table', () => {
  vm.runInThisContext(fs.readFileSync(new URL('./components.js', import.meta.url), 'utf8'), { filename: 'components.js' });
  const { PT_FREQUENCY_SUFFIX, LEASE_SUFFIX_PER_DAY, LEASE_SUFFIX_PER_MONTH } = globalThis;
  for (const lang of ['en', 'lo', 'zh']) {
    assert.equal(LEASE_SUFFIX_PER_DAY[lang], PT_FREQUENCY_SUFFIX.daily[lang], 'daily/' + lang);
    assert.equal(LEASE_SUFFIX_PER_MONTH[lang], PT_FREQUENCY_SUFFIX.monthly[lang], 'monthly/' + lang);
  }
});
