// A FULLY OCCUPIED PROPERTY KEEPS ITS PRICE — end to end.
//   node --test occupied-property-price.test.js
//
// THE DATA-MODEL BUG THIS DEFENDS AGAINST
// ---------------------------------------
// admin's syncPricingMode() derived properties.price_amount from AVAILABLE unit
// types only (_utActiveAmounts filters the Available checkbox). The moment a
// multi-unit building was marked fully occupied and saved, that column was
// written back as NULL. The price had not become unknown — every unit_types row
// still carried it — but four separate surfaces read the nulled column:
//
//   * the public card                -> "Price on request"
//   * price_asc / price_desc sorting -> sorted as if the listing cost 0
//   * price-band filtering           -> unplaceable in any band
//   * the map price bubble           -> "?"
//
// So a listing's price silently depended on whether anyone happened to be
// living in it. PRICE AND AVAILABILITY ARE INDEPENDENT AXES. A rented listing
// has a price; showing it (next to "Available <date>", per ptResolveNextAvailable)
// is the entire reason unavailable listings stay browsable.
//
// The fix has two halves and this suite covers both:
//   WRITE side — admin._utPriceEntries() widens the basis to ALL unit types when
//                no unit is available, so price_amount is preserved on save.
//   READ  side — components.ptResolveSortPrice() falls back to the cheapest unit
//                type, so rows ALREADY saved as NULL by the old admin build
//                still display, sort and filter correctly without a backfill.
//
// NOTHING IS EVER FABRICATED. Both halves return null when no unit and no
// property carries a real price.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// ── Load the real public-side modules ─────────────────────────────────────
for (const f of ['currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
globalThis.window = globalThis;
const { formatPropertyPrice, ptResolveSortPrice, ptResolveUnitTypesPrice,
        ptResolveUnitTypesPriceEntry, ptResolveNextAvailable, ptResolveListingFomo } = globalThis;

// ── Extract the real search-page price/sort/filter functions ──────────────
function extractFn(file, name) {
  const src = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}
function extractVar(file, name) {
  const src = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const start = src.indexOf('var ' + name + ' = {');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i) + ';';
}
vm.runInThisContext("var currentTxFilter='all', currentPriceBand='all', currentSort='featured';");
vm.runInThisContext(extractVar('listings.html', 'PRICE_BANDS'));
['_resolvedPrice', '_numericPrice', 'formatPriceBubble', 'currentPriceBands', 'currentPriceBandDef', 'matchesPriceBand']
  .forEach((n) => vm.runInThisContext(extractFn('listings.html', n)));
vm.runInThisContext("var _availabilityRank=function(p){return 0;};");
vm.runInThisContext(extractFn('listings.html', 'sortProperties'));

// ── Extract the real admin write-side functions, over a tiny DOM stub ──────
// Only the four things _utActiveAmounts touches are modelled: querySelectorAll
// ('.ut-card'), each card's querySelector(sel).value and .checked. Running the
// REAL function over that is what makes this a regression test rather than a
// restatement of the fix.
function adminDom(cards) {
  const mk = (c) => ({
    querySelector(sel) {
      if (sel === '.ut-is-available') return { checked: !!c.available };
      const key = sel.replace('.ut-', '').replace(/-/g, '_');
      return { value: c[key] === undefined || c[key] === null ? '' : String(c[key]) };
    }
  });
  return { querySelectorAll: (sel) => (sel === '.ut-card' ? cards.map(mk) : []) };
}
const adminCtx = vm.createContext({
  DEFAULT_CURRENCY: 'USD',
  LEGACY_FREQUENCY_SUFFIX: { monthly: ' / month', yearly: ' / year', daily: ' / day' },
  formatMoneyRange: globalThis.formatMoneyRange,
  document: null
});
['_utActiveAmounts', '_utPriceEntries', '_utComputeRange', '_utRangeHint']
  .forEach((n) => vm.runInContext(extractFn('admin.html', n), adminCtx));

// Runs the REAL _utPriceEntries + _utComputeRange over `cards`, returning what
// syncPricingMode() would write into f-price-amount (i.e. properties.price_amount).
function adminComputedPrice(cards) {
  adminCtx.document = adminDom(cards);
  const basis = vm.runInContext("_utPriceEntries('.ut-price-amount', '.ut-price-currency', '.ut-price-frequency')", adminCtx);
  const range = vm.runInContext('_utComputeRange', adminCtx)(basis.entries);
  const hint  = vm.runInContext('_utRangeHint', adminCtx)(range, basis.basis);
  return {
    basis: basis.basis,
    // syncPricingMode() writes `range.min != null ? range.min : ''` — '' is what
    // becomes NULL in the database.
    price_amount: range.min != null ? range.min : null,
    price_currency: range.currency,
    price_frequency: range.frequency,
    rangeText: range.text,
    hint
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const unitCard = (o) => Object.assign(
  { available: true, price_amount: null, price_currency: 'USD', price_frequency: 'monthly' }, o);
const unitRow = (o) => Object.assign(
  { id: 'u', name_en: 'Unit', is_available: true, available_count: 2, total_units: 4,
    price_amount: null, price_currency: 'USD', price_frequency: 'monthly' }, o);

const priceText = (p, lang) => {
  const i = formatPropertyPrice(p, lang || 'en');
  if (i.isSor) return [i.saleText, i.rentText].filter(Boolean).join(' · ');
  if (i.isPriceOnRequest) return null;
  return i.singleText + (i.unitText ? ' ' + i.unitText : '');
};

// ══════════════════════════════════════════════════════════════════════════
// A. WRITE SIDE — admin must no longer null the price
// ══════════════════════════════════════════════════════════════════════════

test('A1. all units OCCUPIED but priced → price_amount preserved as the min across all units', () => {
  const r = adminComputedPrice([
    unitCard({ available: false, price_amount: 800 }),
    unitCard({ available: false, price_amount: 450 }),
    unitCard({ available: false, price_amount: 620 })
  ]);
  assert.equal(r.price_amount, 450, 'must be the cheapest unit, NOT null');
  assert.equal(r.basis, 'all');
  assert.equal(r.price_currency, 'USD');
  assert.equal(r.price_frequency, 'monthly');
});

test('A2. this is exactly the case that used to write NULL (the old filter would see 0 entries)', () => {
  const cards = [unitCard({ available: false, price_amount: 450 })];
  adminCtx.document = adminDom(cards);
  const oldBehaviour = vm.runInContext("_utActiveAmounts('.ut-price-amount', '.ut-price-currency', '.ut-price-frequency', false)", adminCtx);
  assert.equal(oldBehaviour.length, 0, 'available-only basis is genuinely empty — this is the failing input');
  assert.equal(adminComputedPrice(cards).price_amount, 450, 'and the fix still produces a price from it');
});

test('A3. SOME units available → basis is unchanged: min across AVAILABLE units only', () => {
  // The cheapest unit ($300) is occupied. The actionable "starting from" price
  // is the cheapest one a visitor can actually rent today ($500). Widening the
  // basis here would be a behaviour change, and would understate the price.
  const r = adminComputedPrice([
    unitCard({ available: false, price_amount: 300 }),
    unitCard({ available: true,  price_amount: 500 }),
    unitCard({ available: true,  price_amount: 900 })
  ]);
  assert.equal(r.price_amount, 500);
  assert.equal(r.basis, 'available');
});

test('A4. NO unit carries a price → still NULL. Nothing is fabricated.', () => {
  const r = adminComputedPrice([
    unitCard({ available: false, price_amount: null }),
    unitCard({ available: false, price_amount: '' })
  ]);
  assert.equal(r.price_amount, null);
  assert.equal(r.basis, 'none');
  assert.equal(r.rangeText, null);
});

test('A5. occupied units with unparseable prices contribute nothing', () => {
  const r = adminComputedPrice([unitCard({ available: false, price_amount: 'ask us' })]);
  assert.equal(r.price_amount, null, 'NaN must not become a price');
  assert.equal(r.basis, 'none');
});

test('A6. mixed: available units unpriced, occupied units priced → occupied basis is used', () => {
  const r = adminComputedPrice([
    unitCard({ available: true,  price_amount: null }),
    unitCard({ available: false, price_amount: 750 })
  ]);
  assert.equal(r.price_amount, 750, 'an available-but-unpriced unit must not blank the building price');
  assert.equal(r.basis, 'all');
});

test('A7. the admin hint explains a fully-occupied basis rather than showing a bare number', () => {
  const occupied  = adminComputedPrice([unitCard({ available: false, price_amount: 450 }), unitCard({ available: false, price_amount: 800 })]);
  const available = adminComputedPrice([unitCard({ available: true,  price_amount: 450 }), unitCard({ available: true,  price_amount: 800 })]);
  assert.match(occupied.hint, /none are currently available/);
  assert.match(occupied.hint, /sorts and filters/);
  assert.match(available.hint, /from active Unit Types/);
  assert.doesNotMatch(available.hint, /none are currently available/);
});

test('A8. the range TEXT (legacy price_display) is preserved for an occupied building too', () => {
  const r = adminComputedPrice([
    unitCard({ available: false, price_amount: 450 }),
    unitCard({ available: false, price_amount: 800 })
  ]);
  assert.ok(r.rangeText && r.rangeText.includes('450') && r.rangeText.includes('800'), r.rangeText);
});

test('A9. price is decoupled from availability: flipping every checkbox does not change price_amount', () => {
  const priced = [{ price_amount: 450 }, { price_amount: 800 }];
  const allOn  = adminComputedPrice(priced.map((u) => unitCard(Object.assign({ available: true  }, u))));
  const allOff = adminComputedPrice(priced.map((u) => unitCard(Object.assign({ available: false }, u))));
  assert.equal(allOff.price_amount, allOn.price_amount, 'availability must not move the price');
  assert.equal(allOff.price_currency, allOn.price_currency);
  assert.equal(allOff.rangeText, allOn.rangeText);
});

// ══════════════════════════════════════════════════════════════════════════
// B. READ SIDE — rows already saved as NULL by the old build still work
// ══════════════════════════════════════════════════════════════════════════

// The legacy production row: fully occupied, property price nulled by the old
// admin, price surviving only on unit_types. No backfill has run.
const legacyOccupied = () => ({
  id: 'p1', slug: 'riverside', transaction_type: 'for_rent',
  market_status: 'fully_occupied',
  price_amount: null, price_currency: null, price_frequency: null, price_display: null,
  unit_types: [
    unitRow({ id: 'a', name_en: '1BR', is_available: false, available_count: 0, price_amount: 620, next_available_date: '2026-11-01' }),
    unitRow({ id: 'b', name_en: 'Studio', is_available: false, available_count: 0, price_amount: 450, next_available_date: '2026-09-15' })
  ]
});

test('B1. CARD: fully occupied legacy row still displays its price', () => {
  assert.equal(priceText(legacyOccupied()), '$450 / month');
});

test('B2. CARD: price is byte-identical to the same listing marked available', () => {
  const occupied = legacyOccupied();
  const available = Object.assign(legacyOccupied(), { market_status: 'available' });
  available.unit_types = available.unit_types.map((u) => Object.assign({}, u, { is_available: true, available_count: 2 }));
  assert.equal(priceText(occupied), priceText(available), 'availability must not alter the price string');
});

test('B3. SORT: occupied listing sorts on its real price, not 0', () => {
  const occupied = legacyOccupied();                       // resolves to 450
  const cheap  = { id: 'c', price_amount: 200, price_currency: 'USD', transaction_type: 'for_rent' };
  const dear   = { id: 'd', price_amount: 900, price_currency: 'USD', transaction_type: 'for_rent' };
  globalThis.currentSort = 'price_asc';
  assert.deepEqual(sortProperties([dear, occupied, cheap]).map((p) => p.id), ['c', 'p1', 'd'],
    'the old behaviour put p1 first with a sort key of 0');
  globalThis.currentSort = 'price_desc';
  assert.deepEqual(sortProperties([cheap, occupied, dear]).map((p) => p.id), ['d', 'p1', 'c'],
    'and dead last on price_desc');
  globalThis.currentSort = 'featured';
});

test('B4. SORT: a genuinely unpriced listing still sorts as 0 (unchanged)', () => {
  assert.equal(_numericPrice({ price_amount: null, price_display: null }), 0);
});

test('B5. FILTER: occupied listing lands in the correct price band', () => {
  globalThis.currentTxFilter = 'for_rent';
  const p = legacyOccupied();                              // $450
  globalThis.currentPriceBand = 'r2';                      // $300–600
  assert.equal(matchesPriceBand(p), true);
  globalThis.currentPriceBand = 'r1';                      // under $300
  assert.equal(matchesPriceBand(p), false, 'must be excluded, not waved through as "no price on file"');
  globalThis.currentPriceBand = 'r4';                      // over $1,000
  assert.equal(matchesPriceBand(p), false);
  globalThis.currentPriceBand = 'all';
  assert.equal(matchesPriceBand(p), true);
});

test('B6. FILTER: band membership is identical whether the listing is occupied or available', () => {
  globalThis.currentTxFilter = 'for_rent';
  globalThis.currentPriceBand = 'r2';
  const occupied = legacyOccupied();
  const available = Object.assign(legacyOccupied(), { market_status: 'available' });
  assert.equal(matchesPriceBand(occupied), matchesPriceBand(available));
  globalThis.currentPriceBand = 'all';
});

test('B7. FILTER: a non-USD unit-type price is still recognised as non-USD', () => {
  // properties.price_currency is null on these rows alongside the amount, so
  // reading it directly defaulted a LAK building to USD and banded 5,000,000
  // LAK as "over $1,000".
  const lak = legacyOccupied();
  lak.unit_types = lak.unit_types.map((u) => Object.assign({}, u, { price_currency: 'LAK', price_amount: 5000000 }));
  assert.equal(ptResolveSortPrice(lak).currency, 'LAK');
  globalThis.currentTxFilter = 'for_rent';
  globalThis.currentPriceBand = 'r1';                      // under $300
  assert.equal(matchesPriceBand(lak), true, 'non-USD is never dropped (no conversion)');
  globalThis.currentPriceBand = 'all';
});

test('B8. FILTER: a genuinely unpriced listing is never hidden by a band (unchanged)', () => {
  globalThis.currentTxFilter = 'for_rent';
  globalThis.currentPriceBand = 'r1';
  assert.equal(matchesPriceBand({ price_amount: null, price_display: null, price_currency: 'USD' }), true);
  globalThis.currentPriceBand = 'all';
});

test('B9. MAP: the price bubble resolves instead of showing "?"', () => {
  assert.equal(formatPriceBubble(legacyOccupied()), '$450');
  assert.equal(formatPriceBubble({ price_amount: null, price_display: null }), '?', 'genuinely unpriced still shows ?');
});

test('B10. ptResolveSortPrice never fabricates', () => {
  assert.deepEqual(ptResolveSortPrice({ price_amount: null, price_display: null }), { amount: null, currency: null });
  assert.deepEqual(ptResolveSortPrice({ price_amount: null, price_display: null, unit_types: [] }), { amount: null, currency: null });
  assert.deepEqual(ptResolveSortPrice(null), { amount: null, currency: null });
  // Unit priced only as legacy TEXT: there is no trustworthy number.
  const textOnly = { transaction_type: 'for_rent', price_amount: null,
                     unit_types: [unitRow({ price_amount: null, price_display: 'Ask' })] };
  assert.equal(ptResolveSortPrice(textOnly).amount, null);
});

test('B11. property-level price always wins over the unit-type fallback', () => {
  const p = legacyOccupied();
  p.price_amount = 999; p.price_currency = 'USD';
  assert.equal(ptResolveSortPrice(p).amount, 999, 'the fallback must not override a real column value');
});

test('B12. ptResolveUnitTypesPrice() still returns the same TEXT it always did', () => {
  assert.equal(ptResolveUnitTypesPrice(legacyOccupied(), 'en'), '$450 / month');
  const entry = ptResolveUnitTypesPriceEntry(legacyOccupied(), 'en');
  assert.deepEqual({ amount: entry.amount, currency: entry.currency, text: entry.text },
                   { amount: 450, currency: 'USD', text: '$450 / month' });
});

// ══════════════════════════════════════════════════════════════════════════
// C. THE AXES STAY INDEPENDENT
// ══════════════════════════════════════════════════════════════════════════

test('C1. price resolution reads no availability field', () => {
  const src = fs.readFileSync(new URL('./components.js', import.meta.url), 'utf8');
  const start = src.indexOf('function ptResolveUnitTypesPriceEntry(');
  const end = src.indexOf('function ptResolveNextAvailable(');
  const priceBlock = src.slice(start, src.indexOf('function formatPropertyPrice(', start));
  assert.ok(start !== -1 && end !== -1);
  for (const forbidden of ['is_available', 'available_count', 'market_status', 'isAvailable', 'availableCount']) {
    assert.ok(!priceBlock.includes(forbidden), 'price resolution must not read ' + forbidden);
  }
});

test('C2. the full occupied card renders price AND next-available AND no fake scarcity', () => {
  const p = legacyOccupied();
  assert.equal(priceText(p), '$450 / month', 'price');
  const next = ptResolveNextAvailable(p, 'en', '2026-08-19');
  assert.equal(next.isoDate, '2026-09-15', 'earliest genuine future date across units');
  // The FOMO axis states the fact ("Fully occupied") and makes NO scarcity
  // claim -- zero units are open, so "Only N left" would be a fabrication.
  const fomo = ptResolveListingFomo(p, 'en');
  assert.equal(fomo.kind, 'missed');
  assert.equal(fomo.tone, 'unavailable');
  assert.equal(fomo.text, 'Fully occupied');
  assert.equal(fomo.count, undefined, 'no scarcity count on a listing with nothing open');
});

test('C2b. "no future availability" still shows the price beside the plain unavailable line', () => {
  // The $X/month · Currently-unavailable surface: price from the unit types,
  // status text from market_status, and no invented date.
  const p = legacyOccupied();
  p.market_status = 'rented';
  p.unit_types = p.unit_types.map((u) => Object.assign({}, u, { next_available_date: null }));
  assert.equal(priceText(p), '$450 / month');
  assert.equal(ptResolveNextAvailable(p, 'en', '2026-08-19'), null);
  assert.equal(ptResolveListingFomo(p, 'en').text, 'Just rented — see similar');
});

test('C3. an occupied building with no future date still shows its price', () => {
  const p = legacyOccupied();
  p.unit_types = p.unit_types.map((u) => Object.assign({}, u, { next_available_date: null }));
  assert.equal(priceText(p), '$450 / month');
  assert.equal(ptResolveNextAvailable(p, 'en', '2026-08-19'), null);
});

test('C4. write side and read side agree on the same building', () => {
  // Same three occupied units, once through admin's save path and once through
  // the public read path. A drift between them is the whole class of bug here.
  const cards = [unitCard({ available: false, price_amount: 620 }), unitCard({ available: false, price_amount: 450 })];
  const written = adminComputedPrice(cards);
  const read = ptResolveSortPrice(legacyOccupied());
  assert.equal(written.price_amount, read.amount);
  assert.equal(written.price_currency, read.currency);
});
