// OG Worker availability parity.
//   node --test og-availability-parity.test.js
//
// cloudflare-worker/og-listing-preview.js cannot import browser files, so it carries a hand port of the canonical
// availability rules (property-availability.js + unit-availability.js). This test PINS the port to the browser
// resolver over every market_status x unit-configuration state: same `available`, `presentation`, `reason`, and
// effective market. If the browser rules change, this fails until the Worker port is updated.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { resolveAvailability, buildOgFields } from './cloudflare-worker/og-listing-preview.js';

for (const f of ['unit-availability.js', 'listing-status.js', 'property-availability.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const { resolvePropertyAvailability: R } = globalThis;

const U = (id, o) => Object.assign({ id, is_available: true, available_count: 1, total_units: null, next_available_date: null }, o);
const OPEN = (id) => U(id);
const FULL = (id) => U(id, { available_count: 0, next_available_date: '2999-01-01' });
const TEMP = (id) => U(id, { available_count: 0 });
const SOON = (id) => U(id, { is_available: false, total_units: 10, available_count: 0 });
const OPEN_DATED = (id) => U(id, { next_available_date: '2999-01-01' });                 // a date on an open unit
const FLAG_OFF_COUNT = (id) => U(id, { is_available: false, available_count: 3 });        // flag wins over the count
const UNIT_SETS = {
  none: [], oneOpen: [OPEN('a')], oneFull: [FULL('a')], oneTemp: [TEMP('a')], oneSoon: [SOON('a')],
  oneOpenDated: [OPEN_DATED('a')], oneFlagOff: [FLAG_OFF_COUNT('a')],
  twoOpen: [OPEN('a'), OPEN('b')], openAndFull: [OPEN('a'), FULL('b')], openAndSoon: [OPEN('a'), SOON('b')],
  twoFull: [FULL('a'), FULL('b')], twoTemp: [TEMP('a'), TEMP('b')], twoSoon: [SOON('a'), SOON('b')], fullAndTemp: [FULL('a'), TEMP('b')],
  soonAndTemp: [SOON('a'), TEMP('b')],
};
const MARKETS = ['available', 'reserved', 'rented', 'fully_occupied', 'sold', 'off_market', 'coming_soon', null, undefined];

test('the Worker port equals the browser resolver for every market x unit-configuration state', () => {
  let n = 0;
  for (const m of MARKETS) for (const [name, units] of Object.entries(UNIT_SETS)) {
    const row = { market_status: m, unit_types: units };
    const b = R(row), w = resolveAvailability(row);
    const tag = `${m}/${name}`;
    assert.equal(w.available, b.available, tag + ' available');
    assert.equal(w.presentation, b.presentation, tag + ' presentation');
    assert.equal(w.reason, b.reason, tag + ' reason');
    assert.equal(w.effectiveMarket, b.effectiveMarket, tag + ' effectiveMarket');
    n++;
  }
  assert.equal(n, MARKETS.length * Object.keys(UNIT_SETS).length);
});

test('a missing / non-array unit_types behaves as no unit rows in both', () => {
  for (const unit_types of [undefined, null, 'x']) {
    for (const m of ['available', 'rented']) {
      const row = { market_status: m, unit_types };
      assert.equal(resolveAvailability(row).available, R(row).available, m + '/' + String(unit_types));
    }
  }
});

// ── what the Worker writes into the crawler-visible head ──────────────────────────────────────────────────────────
const ROW = {
  slug: 'x', title_en: 'Riverside Villa', title_lo: 'ວິນລ່າ', title_zh: '别墅',
  description_en: 'A spacious villa by the Mekong.', description_lo: 'ລາຍລະອຽດ', description_zh: '',
  property_highlight_en: '', property_highlight_zh: '', property_highlight: '', images: [],
  price_amount: 1200, price_currency: 'USD', price_frequency: 'monthly', transaction_type: 'for_rent',
  district_en: 'Sisattanak', district_lo: 'ສີສະຫວາດ', district_zh: '西萨塔纳',
};
const og = (o, lang = 'en') => buildOgFields(Object.assign({}, ROW, o), lang);

test('coming_soon: "Coming Soon" in the title in en/lo/zh, but the normal description (no sold/rented wording)', () => {
  for (const [lang, word] of [['en', /Coming Soon/], ['lo', /ກຳລັງຈະມາ/], ['zh', /即将推出/]]) {
    const f = og({ market_status: 'coming_soon', unit_types: [OPEN('a'), OPEN('b')] }, lang);
    assert.match(f.title, word, lang);
    assert.doesNotMatch(f.desc, /browse similar|has been|fully occupied/i, lang);
  }
  assert.match(og({ market_status: 'coming_soon' }).desc, /^\$1,200 \/ month/);       // the advertised price still leads the preview
});

test('sold / rented / off_market keep the status suffix and the "browse similar" description', () => {
  for (const [m, label, lead] of [['sold', /Sold/, /has been sold/], ['rented', /Rented/, /has been rented/], ['off_market', /Off Market/, /off market/]]) {
    const f = og({ market_status: m, unit_types: [OPEN('a'), OPEN('b')].slice(0, m === 'rented' ? 0 : 2) });
    assert.match(f.title, label, m); assert.match(f.desc, lead, m); assert.match(f.desc, /Browse similar available properties/, m);
  }
});

test('a property with no open unit reads Fully Occupied even though market_status says available', () => {
  const f = og({ market_status: 'available', unit_types: [FULL('a'), TEMP('b')] });
  assert.match(f.title, /Fully Occupied/); assert.match(f.desc, /fully occupied/i);
});

test('single-unit rented with a lone open unit row is Rented; multi-unit rented with an open unit is NOT labelled rented', () => {
  assert.match(og({ market_status: 'rented', unit_types: [OPEN('a')] }).title, /Rented/);
  const multi = og({ market_status: 'rented', unit_types: [OPEN('a'), FULL('b')] });
  assert.doesNotMatch(multi.title, /Rented|Fully/); assert.match(multi.desc, /^\$1,200 \/ month/);
});

test('a date never makes a closed property look available, and never closes an open one', () => {
  assert.match(og({ market_status: 'available', unit_types: [FULL('a')] }).title, /Fully Occupied/);
  assert.doesNotMatch(og({ market_status: 'available', unit_types: [OPEN_DATED('a')] }).title, /Fully|Rented|Sold/);
});

test('draft handling is unchanged: an available property with no units has no suffix', () => {
  const f = og({ market_status: 'available', unit_types: [] });
  assert.doesNotMatch(f.title, /—/);
});
