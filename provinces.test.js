// Laos-wide province coverage with a LISTING-DRIVEN customer filter.
//   node --test provinces.test.js
//
// THE RULE THIS DEFENDS: a customer must never be able to select a province
// and land on "No listings found" when that province had zero listings to
// begin with. The registry supplies labels and order; real inventory supplies
// membership.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const {
  LAO_PROVINCES, DEFAULT_PROVINCE, provinceByKey, isValidProvince,
  getAllProvinces, provinceLabel, resolveListingProvince, resolveAvailableProvinces
} = await import('./provinces.js');

const VC_DISTRICTS = ['Sisattanak','Saysettha','Chanthabouly','Sikhottabong',
                      'Xaythany','Hadxaifong','Naxaithong'];
const L = (o) => Object.assign({ transaction_type: 'for_rent', property_type: 'apartment' }, o);
const avail = (rows, matches) =>
  resolveAvailableProvinces(rows, { vientianeDistricts: VC_DISTRICTS, matches });
const keysOf = (rows, matches) => avail(rows, matches).map(a => a.key);

// ── 10. The data model accepts all 18 top-level locations ─────────────────
test('10. all 18 Laos top-level locations exist, with no duplicates or blanks', () => {
  assert.equal(LAO_PROVINCES.length, 18);
  const keys = LAO_PROVINCES.map(p => p.key);
  assert.equal(new Set(keys).size, 18, 'duplicate province key: ' +
    keys.filter((k, i) => keys.indexOf(k) !== i));
  for (const p of LAO_PROVINCES) {
    assert.ok(p.key && p.lo && p.zh, 'incomplete entry: ' + p.key);
    assert.equal(p.key.trim(), p.key, 'untrimmed key: ' + JSON.stringify(p.key));
  }
  // Every province the brief named must be present.
  for (const need of ['Vientiane Capital','Vientiane Province','Phongsaly','Luang Namtha',
    'Oudomxay','Bokeo','Luang Prabang','Houaphanh','Xayabouly','Xiangkhouang',
    'Bolikhamxay','Khammouane','Savannakhet','Salavan','Sekong','Champasak','Attapeu']) {
    assert.ok(isValidProvince(need), 'missing: ' + need);
  }
  // Laos has 17 provinces + the capital. Xaisomboun (created 2013) completes
  // the set; the brief's list reached 18 only by naming Bokeo twice.
  assert.ok(isValidProvince('Xaisomboun'), 'Xaisomboun is a real province and completes the 18');
});

test('10b. admin offers the FULL registry regardless of inventory', () => {
  // An agent must be able to create the first listing in an empty province.
  assert.equal(getAllProvinces().length, 18);
  assert.deepEqual(keysOf([]), [], 'but the customer filter shows none of them with no inventory');
});

// ── 8. Vientiane Capital vs Vientiane Province ────────────────────────────
test('8. Vientiane Capital and Vientiane Province stay distinct everywhere', () => {
  const cap = provinceByKey('Vientiane Capital'), prov = provinceByKey('Vientiane Province');
  assert.notEqual(cap.key, prov.key);
  assert.notEqual(cap.lo, prov.lo);
  assert.notEqual(cap.zh, prov.zh);
  const rows = [L({ province_en: 'Vientiane Capital' }), L({ province_en: 'Vientiane Province' })];
  assert.deepEqual(keysOf(rows), ['Vientiane Capital', 'Vientiane Province']);
  assert.equal(avail(rows).find(a => a.key === 'Vientiane Capital').count, 1);
});

// ── 1 + 2. Present when populated, absent when empty ──────────────────────
test('1. a province with visible listings appears, with its count', () => {
  const rows = [
    ...Array(120).fill(0).map(() => L({ province_en: 'Vientiane Capital' })),
    ...Array(8).fill(0).map(() => L({ province_en: 'Luang Prabang' })),
    ...Array(3).fill(0).map(() => L({ province_en: 'Champasak' })),
    L({ province_en: 'Savannakhet' })
  ];
  assert.deepEqual(avail(rows).map(a => a.key + ' (' + a.count + ')'), [
    'Vientiane Capital (120)', 'Luang Prabang (8)', 'Champasak (3)', 'Savannakhet (1)'
  ]);
});

test('2. a province with zero visible listings does not appear', () => {
  const rows = [L({ province_en: 'Champasak' })];
  const keys = keysOf(rows);
  assert.deepEqual(keys, ['Champasak']);
  assert.ok(!keys.includes('Sekong'));
  assert.ok(!keys.includes('Attapeu'));
  assert.equal(keys.length, 1, 'the other 17 must be absent, not zero-counted');
});

// ── 3 + 4. Visibility is inherited, never redefined ───────────────────────
// The page hands resolveAvailableProvinces() the rows it fetched. The REST
// query already excludes drafts and RLS excludes everything else non-public,
// so a draft/archived/hidden listing is simply not in the array.
test('3. a draft-only province does not appear', () => {
  const visible = [L({ province_en: 'Vientiane Capital' })];
  assert.deepEqual(keysOf(visible), ['Vientiane Capital'], 'Sekong draft never reached the page');
  // And if a draft somehow WERE passed, it is the caller's filter that must
  // exclude it — proven by running the page's own predicate shape.
  const withDraft = [...visible, L({ province_en: 'Sekong', status: 'draft' })];
  const published = (p) => p.status !== 'draft';
  assert.deepEqual(keysOf(withDraft, published), ['Vientiane Capital']);
});

test('4. hidden/archived-only provinces do not appear', () => {
  const rows = [
    L({ province_en: 'Vientiane Capital', market_status: 'available' }),
    L({ province_en: 'Sekong', workflow_status: 'archived' }),
    L({ province_en: 'Attapeu', status: 'hidden' })
  ];
  const visible = (p) => p.workflow_status !== 'archived' && p.status !== 'hidden';
  assert.deepEqual(keysOf(rows, visible), ['Vientiane Capital']);
});

// ── 5 + 6. Automatic, with no developer action ────────────────────────────
test('5. a province appears automatically after its first visible listing', () => {
  const before = [L({ province_en: 'Vientiane Capital' })];
  assert.ok(!keysOf(before).includes('Sekong'));
  const after = [...before, L({ province_en: 'Sekong' })];
  assert.deepEqual(keysOf(after), ['Vientiane Capital', 'Sekong'], 'no code change needed');
});

test('6. a province disappears when its last visible listing goes', () => {
  const withSekong = [L({ province_en: 'Vientiane Capital' }), L({ province_en: 'Sekong' })];
  assert.ok(keysOf(withSekong).includes('Sekong'));
  const removed = withSekong.filter(p => p.province_en !== 'Sekong');
  assert.ok(!keysOf(removed).includes('Sekong'));
});

// ── 7. Contextual — respects the other active filters ─────────────────────
test('7. other active filters change which provinces are offered', () => {
  const rows = [
    L({ province_en: 'Vientiane Capital', transaction_type: 'for_rent', property_type: 'apartment' }),
    L({ province_en: 'Luang Prabang',     transaction_type: 'for_sale', property_type: 'land' }),
    L({ province_en: 'Champasak',         transaction_type: 'for_rent', property_type: 'house' })
  ];
  const rentApartment = (p) => p.transaction_type === 'for_rent' && p.property_type === 'apartment';
  assert.deepEqual(keysOf(rows, rentApartment), ['Vientiane Capital'],
    'Rent+Apartment must not offer provinces whose inventory would vanish');
  const saleLand = (p) => p.transaction_type === 'for_sale' && p.property_type === 'land';
  assert.deepEqual(keysOf(rows, saleLand), ['Luang Prabang']);
  const rent = (p) => p.transaction_type === 'for_rent';
  assert.deepEqual(keysOf(rows, rent), ['Vientiane Capital', 'Champasak']);
});

test('7b. counts reflect the filtered set, not the whole inventory', () => {
  const rows = [
    L({ province_en: 'Vientiane Capital', transaction_type: 'for_rent' }),
    L({ province_en: 'Vientiane Capital', transaction_type: 'for_sale' })
  ];
  assert.equal(avail(rows).find(a => a.key === 'Vientiane Capital').count, 2);
  assert.equal(avail(rows, p => p.transaction_type === 'for_rent')
    .find(a => a.key === 'Vientiane Capital').count, 1, 'a promised count must survive the click');
});

// ── 9. Existing Vientiane listings keep working ───────────────────────────
test('9. legacy rows with no province column resolve to Vientiane Capital', () => {
  for (const d of VC_DISTRICTS) {
    assert.equal(resolveListingProvince(L({ district_en: d }), VC_DISTRICTS), DEFAULT_PROVINCE, d);
  }
  const legacy = VC_DISTRICTS.map(d => L({ district_en: d }));
  assert.deepEqual(avail(legacy).map(a => a.key + ':' + a.count), ['Vientiane Capital:7']);
});

test('9b. an unknown location is NOT silently filed under the capital', () => {
  assert.equal(resolveListingProvince(L({ district_en: 'Somewhere Else' }), VC_DISTRICTS), null);
  assert.equal(resolveListingProvince(L({ province_en: 'Atlantis' }), VC_DISTRICTS), null);
  assert.deepEqual(keysOf([L({ district_en: 'Somewhere Else' })]), [],
    'an unknown location must not become a wrong one');
});

test('9c. an explicit province always wins over district inference', () => {
  // A Luang Prabang listing that happens to carry a capital-sounding district.
  assert.equal(resolveListingProvince(
    L({ province_en: 'Luang Prabang', district_en: 'Sisattanak' }), VC_DISTRICTS), 'Luang Prabang');
});

// ── Ordering and labels ───────────────────────────────────────────────────
test('the filter is ordered by COUNT, with registry order breaking ties', () => {
  // Equal counts fall back to registry order (VC, Bokeo, Attapeu) — never
  // alphabetical, which would put Attapeu first.
  const tied = [L({ province_en: 'Attapeu' }), L({ province_en: 'Vientiane Capital' }),
                L({ province_en: 'Bokeo' })];
  assert.deepEqual(keysOf(tied), ['Vientiane Capital', 'Bokeo', 'Attapeu']);
  // Unequal counts: most inventory first, regardless of registry position.
  const weighted = [L({ province_en: 'Vientiane Capital' }),
                    L({ province_en: 'Attapeu' }), L({ province_en: 'Attapeu' })];
  assert.deepEqual(keysOf(weighted), ['Attapeu', 'Vientiane Capital']);
  // Deterministic across runs.
  assert.deepEqual(keysOf(tied), keysOf(tied.slice().reverse()));
});

test('labels localize; an unknown key degrades to itself rather than throwing', () => {
  assert.equal(provinceLabel('Luang Prabang', 'en'), 'Luang Prabang');
  assert.equal(provinceLabel('Luang Prabang', 'lo'), 'ຫຼວງພະບາງ');
  assert.equal(provinceLabel('Luang Prabang', 'zh'), '琅勃拉邦');
  assert.equal(provinceLabel('Atlantis', 'en'), 'Atlantis');
});

// ── Wiring guards ─────────────────────────────────────────────────────────
test('MIGRATION: additive, backfills Vientiane, and constrains the key set', () => {
  const sql = fs.readFileSync(new URL('./supabase/migrations/20260822000000_province_coverage.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS province_en text/);
  assert.match(sql, /UPDATE properties[\s\S]*'Vientiane Capital'[\s\S]*district_en IN \(/,
    'existing listings must keep working without manual editing');
  assert.ok(!/DROP COLUMN|ALTER COLUMN .* TYPE/.test(sql), 'must be additive');
  // The CHECK must name exactly the registry keys — no typo, no duplicate.
  const chk = sql.slice(sql.indexOf('CHECK (province_en IS NULL'));
  const inSql = [...chk.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(v => v !== 'province_en');
  assert.deepEqual([...inSql].sort(), LAO_PROVINCES.map(p => p.key).sort());
});

test('WIRING: the customer filter is contextual and inventory-driven', () => {
  const src = fs.readFileSync(new URL('./listings.html', import.meta.url), 'utf8');
  assert.match(src, /resolveAvailableProvinces\(allProperties,/,
    'must build from the fetched (already visibility-filtered) listings');
  assert.match(src, /matches:\s*function \(p\) \{ return matchesActiveFilters\(p, \{ ignoreProvince: true \}\)/,
    'must respect the other active filters');
  // It must NOT render the raw registry.
  assert.ok(!/getAllProvinces\(\)/.test(src), 'listings.html must never render the full registry');
  const admin = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  assert.match(admin, /getAllProvinces\(\)/, 'admin MUST render the full registry');
});

// ── ADMIN FORM WIRING ─────────────────────────────────────────────────────
// Regression: 2026-08-24. The province <select> ships with ONLY its
// "Select province" placeholder; its 18 real options are built by JS.
// populateProvinceSelect() was wired into editListing() alone, so New Listing
// showed a required field with nothing in it and saved province_en = null.
// These tests run the REAL function extracted from admin.html (same
// extract-the-shipped-function convention as xss-inline-handlers.test.js), so
// they fail if the call is dropped again or pointed at the wrong resolver.
const ADMIN = fs.readFileSync('./admin.html', 'utf8');

function extractFn(src, startRe) {
  const m = startRe.exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  return null;
}

test('ADMIN: the province <select> ships empty, so the JS call is load-bearing', () => {
  const markup = /<select[^>]*id="f-province"[\s\S]*?<\/select>/.exec(ADMIN);
  assert.ok(markup, '#f-province select not found in admin.html');
  const options = markup[0].match(/<option/g) || [];
  assert.equal(options.length, 1,
    'the select carries only its placeholder — every real province comes from JS');
  assert.match(markup[0], /<option value="">/, 'the one static option is the empty placeholder');
});

test('ADMIN: populateProvinceSelect() renders all 18, from the full registry', () => {
  const src = extractFn(ADMIN, /function populateProvinceSelect\(/);
  assert.ok(src, 'populateProvinceSelect() not found in admin.html');

  // A stand-in for the one <select> the function touches.
  const select = { innerHTML: '', value: '' };
  const sandboxDocument = { getElementById: (id) => (id === 'f-province' ? select : null) };
  const run = new Function('document', 'getAllProvinces', 'esc',
    `${src}; return populateProvinceSelect;`)(
      sandboxDocument, getAllProvinces, (s) => String(s));

  run('');
  const values = [...select.innerHTML.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  assert.equal(values.length, 19, 'placeholder + 18 provinces');
  assert.equal(values[0], '', 'the placeholder stays first');
  assert.deepEqual(values.slice(1), LAO_PROVINCES.map(p => p.key),
    'every registry province, in registry order');
  assert.equal(select.value, '', 'no province is pre-selected for a blank form');

  run('Luang Prabang');
  assert.equal(select.value, 'Luang Prabang', 'an existing listing selects its saved province');
});

test('ADMIN: populateProvinceSelect() uses the registry, NOT the customer filter', () => {
  const src = extractFn(ADMIN, /function populateProvinceSelect\(/);
  assert.match(src, /getAllProvinces\(\)/, 'admin must render the full registry (rule 7)');
  assert.doesNotMatch(src, /resolveAvailableProvinces/,
    'the inventory-driven filter belongs to listings.html — in admin it would hide ' +
    'every province with no listings yet, which is exactly what an agent needs to create');
});

test('ADMIN: BOTH form entry points populate the province select', () => {
  // This is the bug itself: New Listing resets the form and must rebuild the
  // options, Edit fills the form and must select the saved one. Either call
  // going missing puts a required field back in the unselectable state.
  const reset = extractFn(ADMIN, /function resetListingForm\(/);
  assert.ok(reset, 'resetListingForm() not found');
  assert.match(reset, /populateProvinceSelect\(/,
    'NEW LISTING: resetListingForm() must repopulate the province options');

  const edit = extractFn(ADMIN, /async function editListing\(/);
  assert.ok(edit, 'editListing() not found');
  assert.match(edit, /populateProvinceSelect\(/,
    'EDIT LISTING: editListing() must populate and select the saved province');
});

test('ADMIN: district control follows the province (capital list vs free text)', () => {
  const src = extractFn(ADMIN, /function onProvinceChange\(/);
  assert.ok(src, 'onProvinceChange() not found');
  const made = {};
  const el = (id) => (made[id] ||= { id, style: {}, value: '',
    parentNode: { appendChild(c) { made[c.id] = c; } } });
  const doc = {
    getElementById: (id) => (id === 'f-district-free' ? (made[id] || null) : el(id)),
    createElement: () => ({ style: {}, set className(v) {}, id: '', type: '', placeholder: '' })
  };
  const run = new Function('document', `${src}; return onProvinceChange;`)(doc);

  el('f-province').value = 'Vientiane Capital';
  run();
  assert.notEqual(el('f-district').style.display, 'none', 'capital keeps the 7-district select');
  assert.equal(made['f-district-free'].style.display, 'none', 'and hides free text');

  el('f-province').value = 'Luang Prabang';
  run();
  assert.equal(el('f-district').style.display, 'none',
    'outside the capital the Vientiane district list must be hidden — a Luang Prabang ' +
    'listing must not be filed under "Sisattanak"');
  assert.notEqual(made['f-district-free'].style.display, 'none', 'free text takes over');
});
