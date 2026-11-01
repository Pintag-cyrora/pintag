// Starting price vs exact price vs price range -- the label must say what the pricing data actually says.
//
//   "From $350 / month"   a STARTING price: the number shown is the minimum across unit types whose prices genuinely
//                         differ (same currency + frequency), or the cheapest comparable lease term
//   "$350 / month"        an EXACT price: a plain listing, or units that all cost the same -- existing listings are
//                         never converted into starting prices
//   "$350–500 / month"    a RANGE: the unit prices' span (rangeText) or a range already typed as text ("$280-300")
//
// The reported defect: the listing DETAIL page, the share text, the link-preview metadata and the compact preview tile
// dropped the "From" that formatPropertyPrice() already computed, so "$350 / month" read as the exact rent of the unit
// on screen. These tests pin the single formatter (components.js ptFormatPriceLine / formatPropertyPrice), its three
// languages (Lao, English, Chinese -- Chinese puts 起 AFTER the price), LAK / USD / THB formatting, missing and invalid
// prices, and that every public surface goes through it (and fetches the unit_types price columns it needs).
// Run with: node --test listing-price-qualifier.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['currency.js', 'terminology.js', 'lease-pricing.js', 'unit-availability.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const { formatPropertyPrice, ptFormatPriceLine } = globalThis;
const read = (f) => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');

const unit = (id, amount, o) => Object.assign({ id, name_en: id, is_available: true, available_count: 1,
  price_amount: amount, price_currency: 'USD', price_frequency: 'monthly' }, o || {});
const rental = (o) => Object.assign({ id: 'p', slug: 's', transaction_type: 'for_rent', property_type: 'apartment',
  price_amount: 350, price_currency: 'USD', price_frequency: 'monthly', price_display: null, unit_types: [] }, o || {});
const multi = (o) => rental(Object.assign({ unit_types: [unit('studio', 350), unit('two-br', 500)] }, o || {}));
const line = (p, lang) => ptFormatPriceLine(formatPropertyPrice(p, lang || 'en'), lang || 'en');

// ── Exact price ──────────────────────────────────────────────────────────────────────────────────────────────────
test('EXACT: a plain listing keeps its exact price in all three languages, priceKind "exact", no qualifier', () => {
  for (const [lang, want] of [['en', '$350 / month'], ['lo', '$350 / ເດືອນ'], ['zh', '$350 / 月']]) {
    const info = formatPropertyPrice(rental(), lang);
    assert.equal(info.priceKind, 'exact');
    assert.equal(info.fromLabel, null);
    assert.equal(info.fromPlacement, null);
    assert.equal(ptFormatPriceLine(info, lang), want);
  }
});

test('EXACT: existing listings are NOT converted -- one unit type, units with the same price, units without a price of their own', () => {
  assert.equal(line(rental({ unit_types: [unit('only', 350)] })), '$350 / month');                              // a single unit type
  assert.equal(line(rental({ unit_types: [unit('a', 350), unit('b', 350)] })), '$350 / month');                 // identical prices: nothing to qualify
  assert.equal(line(rental({ unit_types: [unit('a', null), unit('b', null)] })), '$350 / month');              // units inherit the building price
  assert.equal(line(rental({ unit_types: [unit('a', 350), unit('b', null)] })), '$350 / month');               // only one priced unit
  assert.equal(formatPropertyPrice(rental({ unit_types: [unit('a', 350), unit('b', 350)] }), 'en').rangeText, null);
});

test('EXACT: a sale listing and a sale_or_rent listing never get a "from" qualifier from this logic', () => {
  const sale = rental({ transaction_type: 'for_sale', price_amount: 250000, price_frequency: null });
  assert.equal(line(sale), '$250,000');
  assert.equal(formatPropertyPrice(sale, 'en').priceKind, 'exact');
  const sor = rental({ transaction_type: 'sale_or_rent', price_amount: 250000, rent_price_amount: 1200, rent_price_currency: 'USD', rent_price_frequency: 'monthly',
    unit_types: [unit('a', 1), unit('b', 2)] });
  const info = formatPropertyPrice(sor, 'en');
  assert.equal(info.isSor, true);
  assert.equal(info.fromLabel, undefined, 'the sale_or_rent branch never carries a fromLabel');
  assert.equal(ptFormatPriceLine(info, 'en'), '$250,000 · $1,200 / month');
});

// ── Starting price ───────────────────────────────────────────────────────────────────────────────────────────────
test('STARTING PRICE: differing unit prices -> "From $350 / month" (en), "ເລີ່ມຕົ້ນ ..." (lo), "$350 / 月起" (zh)', () => {
  assert.equal(line(multi(), 'en'), 'From $350 / month');
  assert.equal(line(multi(), 'lo'), 'ເລີ່ມຕົ້ນ $350 / ເດືອນ');
  assert.equal(line(multi(), 'zh'), '$350 / 月起');
  const info = formatPropertyPrice(multi(), 'zh');
  assert.equal(info.priceKind, 'from');
  assert.equal(info.fromLabel, '起');           // the word itself (existing contract) ...
  assert.equal(info.fromPlacement, 'suffix');   // ... and where it goes: AFTER the price in Chinese
  assert.equal(formatPropertyPrice(multi(), 'en').fromPlacement, 'prefix');
  assert.equal(formatPropertyPrice(multi(), 'lo').fromPlacement, 'prefix');
});

test('STARTING PRICE: the acceptance case -- a listing advertised from $350/month never reads as exactly "$350 / month"', () => {
  for (const lang of ['en', 'lo', 'zh']) {
    const text = line(multi(), lang);
    assert.notEqual(text, '$350 / ' + { en: 'month', lo: 'ເດືອນ', zh: '月' }[lang], lang);
    assert.match(text, lang === 'en' ? /^From / : lang === 'lo' ? /^ເລີ່ມຕົ້ນ / : /起$/);
  }
});

test('STARTING PRICE: price only under the unit types (property price nulled) is still qualified, and a cheapest comparable lease tier is "From"', () => {
  const unitOnly = multi({ price_amount: null, price_display: null });
  const info = formatPropertyPrice(unitOnly, 'en');
  assert.equal(info.priceSource, 'unit_type');
  assert.equal(ptFormatPriceLine(info, 'en'), 'From $350 / month');
  assert.equal(ptFormatPriceLine(formatPropertyPrice(unitOnly, 'zh'), 'zh'), '$350 / 月起');
  const lease = rental({ price_amount: null, rent_price_3mo: 450, rent_price_6mo: 400, rent_price_12mo: 350, price_currency: 'USD' });
  const leaseInfo = formatPropertyPrice(lease, 'en');
  if (leaseInfo.priceSource === 'lease_tier') {
    assert.equal(leaseInfo.priceKind, 'from');
    assert.match(ptFormatPriceLine(leaseInfo, 'en'), /^From \$350/);
  }
});

test('STARTING PRICE: the qualifier works for LAK, USD and THB with their own symbols and grouping', () => {
  const mk = (cur, lo, hi) => multi({ price_amount: lo, price_currency: cur, unit_types: [unit('a', lo, { price_currency: cur }), unit('b', hi, { price_currency: cur })] });
  assert.equal(line(mk('LAK', 3000000, 4000000), 'en'), 'From ₭3,000,000 / month');
  assert.equal(line(mk('THB', 9000, 12000), 'lo'), 'ເລີ່ມຕົ້ນ ฿9,000 / ເດືອນ');
  assert.equal(line(mk('USD', 350, 500), 'zh'), '$350 / 月起');
  assert.equal(line(mk('LAK', 3000000, 3000000), 'en'), '₭3,000,000 / month');   // identical -> exact, LAK formatting intact
});

test('STARTING PRICE: a sale building with differing unit prices says "From $250,000" with no frequency; 起 closes the Chinese phrase', () => {
  const p = rental({ transaction_type: 'for_sale', price_amount: 250000, price_frequency: null, unit_types: [unit('a', 250000, { price_frequency: null }), unit('b', 300000, { price_frequency: null })] });
  assert.equal(line(p, 'en'), 'From $250,000');
  assert.equal(line(p, 'zh'), '$250,000起');
});

test('STARTING PRICE: a negotiable frequency keeps its parenthesised note after the amount, in every language', () => {
  const p = multi({ price_frequency: 'negotiable', unit_types: [unit('a', 350, { price_frequency: 'negotiable' }), unit('b', 500, { price_frequency: 'negotiable' })] });
  assert.equal(line(p, 'en'), 'From $350 (negotiable)');
  assert.equal(line(p, 'zh'), '$350起 (可议价)');
});

test('NOT COMPARABLE: units in different currencies or frequencies are never compared into a "from" claim (documented, unchanged)', () => {
  assert.equal(line(multi({ unit_types: [unit('a', 350), unit('b', 9000000, { price_currency: 'LAK' })] })), '$350 / month');
  assert.equal(line(multi({ unit_types: [unit('a', 350), unit('b', 500, { price_frequency: 'daily' })] })), '$350 / month');
});

// ── Minimum and maximum price ────────────────────────────────────────────────────────────────────────────────────
test('MIN / MAX: differing unit prices expose the span as rangeText ("$350–500 / month") in all languages; the headline stays the minimum', () => {
  assert.equal(formatPropertyPrice(multi(), 'en').rangeText, '$350–500 / month');
  assert.equal(formatPropertyPrice(multi(), 'lo').rangeText, '$350–500 / ເດືອນ');
  assert.equal(formatPropertyPrice(multi(), 'zh').rangeText, '$350–500 / 月');
  assert.equal(formatPropertyPrice(multi({ unit_types: [unit('a', 3000000, { price_currency: 'LAK' }), unit('b', 4500000, { price_currency: 'LAK' })], price_currency: 'LAK', price_amount: 3000000 }), 'en').rangeText, '₭3,000,000–4,500,000 / month');
  assert.equal(formatPropertyPrice(multi(), 'en').singleText, '$350');
});

test('RANGE: a range already typed as text is an explicit range -- kept as written, kind "range", never turned into "From"', () => {
  const p = rental({ price_amount: null, price_display: '$280-300 / month' });
  const info = formatPropertyPrice(p, 'en');
  assert.equal(info.priceKind, 'range');
  assert.equal(info.fromLabel, undefined);
  assert.equal(ptFormatPriceLine(info, 'en'), '$280-300 / month');
  assert.equal(formatPropertyPrice(rental({ price_amount: null, price_display: '$300' }), 'en').priceKind, 'exact');
});

// ── Missing or invalid pricing ───────────────────────────────────────────────────────────────────────────────────
test('MISSING / INVALID: null, empty, NaN, text, zero, negative and boolean amounts become "Price on request" -- never "null", "NaN" or "$0"', () => {
  for (const bad of [null, undefined, '', 'abc', NaN, Infinity, 0, -5, true]) {
    for (const [lang, want] of [['en', 'Price on request'], ['lo', 'ສອບຖາມລາຄາ'], ['zh', '价格面议']]) {
      const p = rental({ price_amount: bad, price_display: null, unit_types: [] });
      const info = formatPropertyPrice(p, lang);
      assert.equal(info.isPriceOnRequest, true, String(bad));
      assert.equal(info.priceKind, 'none');
      assert.equal(ptFormatPriceLine(info, lang), want);
      assert.doesNotMatch([info.singleText, ptFormatPriceLine(info, lang)].filter(Boolean).join(' '), /null|NaN|Infinity|\$0\b/);
    }
  }
});

test('MISSING / INVALID: an invalid property amount falls back to a valid unit-type price, qualified; a numeric string amount still works', () => {
  assert.equal(line(multi({ price_amount: 'abc' })), 'From $350 / month');
  assert.equal(line(rental({ price_amount: '350' })), '$350 / month');
  assert.equal(ptFormatPriceLine(null, 'en'), null);
  assert.equal(ptFormatPriceLine({ isSor: false, singleText: null }, 'en'), null);
});

test('MISSING / INVALID: invalid unit-type prices never create a "from" claim or a range', () => {
  const p = rental({ unit_types: [unit('a', 350), unit('b', 0), unit('c', 'abc'), unit('d', null)] });
  const info = formatPropertyPrice(p, 'en');
  assert.equal(info.priceKind, 'exact', 'one valid price among invalid ones is nothing to compare');
  assert.equal(line(p), '$350 / month');
  assert.ok(info.rangeText == null || !/NaN|null/.test(info.rangeText), 'no NaN / null in the range');
  assert.ok(info.rangeText == null || /^\$350/.test(info.rangeText));
});

// ── Every surface goes through the one formatter ─────────────────────────────────────────────────────────────────
test('SURFACES: the detail page, share text and OG description render the qualified line; the unit_types price columns are fetched everywhere a card is built', () => {
  const listing = read('listing.html');
  assert.match(listing, /var priceLine=priceInfo\?ptFormatPriceLine\(priceInfo,lang\)/, 'share text');
  assert.match(listing, /var ogPriceLine=ogPriceInfo\?ptFormatPriceLine\(ogPriceInfo,lang\)/, 'og:description / twitter:description');
  assert.match(listing, /priceInfo\.fromLabel\?'<span class="price-from/, 'detail headline renders the qualifier');
  assert.match(listing, /priceInfo\.fromPlacement==='suffix'/, 'Chinese puts 起 after the price');
  assert.match(listing, /priceInfo\.priceKind==='from'&&priceInfo\.rangeText/, 'range line on the detail page');
  for (const f of ['agent.html', 'agents.html', 'for-agents.html', 'listings.html']) assert.match(read(f), /ptFormatPriceLine\(/, f);
  const priceCols = 'price_display,sale_price,rent_price,rent_period,price_amount,price_currency,price_frequency,rent_price_amount,rent_price_currency,rent_price_frequency';
  for (const f of ['listing.html', 'agent.html', 'agents.html']) assert.ok(read(f).includes('unit_types(id,is_available,available_count,total_units,next_available_date,' + priceCols + ')'), f + ' fetches unit price columns');
  assert.ok(read('for-agents.html').includes('unit_types(id,' + priceCols + ')'), 'for-agents.html fetches unit price columns');
  for (const f of ['index.html', 'listings.html']) assert.match(read(f), /unit_types\(id,sort_order,name_en,name_lo,name_zh,price_display,/, f);
});

test('SURFACES: no public page re-assembles "amount + unit" by hand any more (that is how the qualifier was lost) -- only the price-history comparison key does', () => {
  for (const f of ['listing.html', 'listings.html', 'agent.html', 'agents.html', 'for-agents.html', 'index.html']) {
    const hits = (read(f).match(/singleText\s*\+\s*\(\s*[a-zA-Z]*[Ii]nfo\.unitText/g) || []).length;
    assert.equal(hits, f === 'listing.html' ? 1 : 0, f);   // listing.html: buildPriceHistoryEvents() compares against price_previous
  }
});

test('SURFACES: pages that build cards load terminology.js (resolveUnitType) before components.js, or the unit comparison behind "From" cannot run', () => {
  for (const f of ['agent.html', 'agents.html', 'for-agents.html', 'index.html', 'listings.html', 'listing.html']) {
    const html = read(f);
    const t = html.indexOf('terminology.js'), c = html.indexOf('components.js?v=');
    assert.ok(t > -1 && c > -1 && t < c, f);
  }
});

test('SURFACES: the compact preview tile shows the qualified line (with its unit), the card keeps a separate "from" span placed by language', () => {
  const comp = read('components.js');
  assert.match(comp, /ptFormatPriceLine\(price, lang\)\) \+ '<\/p>'/, 'preview tile');
  assert.match(comp, /price\.fromPlacement !== 'suffix'\) \? fromSpan \+ ' '/, 'card: prefix for en/lo');
  assert.match(comp, /price\.fromPlacement === 'suffix'\) \? fromSpan/, 'card: suffix for zh');
});
