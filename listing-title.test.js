// Does every title actually say WHERE the property is?
//
// The failure this guards is not a crash — it is a plausible-looking title
// that quietly omits the location, or one that says it twice. Both survive
// review, so the assertions below are about the produced STRING, not about
// whether a function ran.
const { test } = require('node:test');
const assert = require('node:assert');

require('./provinces.js');                 // publishes globalThis.PintagProvinces
const T = require('./listing-title.js');

// Shaped exactly as admin.html's saveListing() stores a listing: the district
// is denormalized into all three languages from DISTRICT_MAP, the province into
// all three from the registry, and the village is English-only by design.
const FULL    = { village_en: 'Ban Phonxay', district_en: 'Sisattanak',
                  district_lo: 'ສີສັດຕະນາກ', district_zh: '西沙塔纳克',
                  province_en: 'Vientiane Capital' };
const NO_VILL = { district_en: 'Sisattanak', district_lo: 'ສີສັດຕະນາກ',
                  district_zh: '西沙塔纳克', province_en: 'Vientiane Capital' };
const CITY_ONLY = { province_en: 'Vientiane Capital' };
const NONE    = {};

test('village + district + city — all three appear, most specific first', () => {
  const out = T.ensureTitleLocation('Modern 2-Bedroom Condo', FULL, 'en');
  assert.strictEqual(out, 'Modern 2-Bedroom Condo in Ban Phonxay, Sisattanak, Vientiane');
  for (const part of ['Ban Phonxay', 'Sisattanak', 'Vientiane']) assert.ok(out.includes(part), part);
});

test('no village — district and city, and NO invented village', () => {
  const out = T.ensureTitleLocation('Modern 2-Bedroom Condo', NO_VILL, 'en');
  assert.strictEqual(out, 'Modern 2-Bedroom Condo in Sisattanak, Vientiane');
  // The specific fabrication this rules out: turning the district into a
  // "Ban Sisattanak" that does not exist.
  assert.ok(!/Ban\s/i.test(out), 'no village was invented');
});

test('Sisattanak is a DISTRICT, never the village slot', () => {
  const parts = T.locationParts(NO_VILL, 'en');
  assert.strictEqual(parts.district, 'Sisattanak');
  assert.strictEqual(parts.village, '', 'district must not leak into the village slot');
  // And with a real village present, the two stay in their own slots.
  const full = T.locationParts(FULL, 'en');
  assert.strictEqual(full.village, 'Ban Phonxay');
  assert.strictEqual(full.district, 'Sisattanak');
});

test('city only — the city still appears', () => {
  assert.strictEqual(
    T.ensureTitleLocation('Commercial Property', CITY_ONLY, 'en'),
    'Commercial Property in Vientiane');
});

test('no usable location — the title is returned untouched', () => {
  assert.strictEqual(T.ensureTitleLocation('Modern Condo', NONE, 'en'), 'Modern Condo');
  assert.strictEqual(T.locationPhrase(NONE, 'en'), '');
});

test('a title that already names the location is NOT decorated again', () => {
  const already = 'Modern Condo in Sisattanak, Vientiane';
  assert.strictEqual(T.ensureTitleLocation(already, FULL, 'en'), already);
  // The exact duplication named in the requirement must be impossible.
  assert.ok(!T.ensureTitleLocation(already, FULL, 'en')
    .includes('Sisattanak, Vientiane, Sisattanak, Vientiane'));
});

test('applying twice changes nothing the second time (idempotent)', () => {
  const once  = T.ensureTitleLocation('Luxury Villa', FULL, 'en');
  const twice = T.ensureTitleLocation(once, FULL, 'en');
  assert.strictEqual(twice, once);
  assert.strictEqual(T.ensureTitleLocation(twice, FULL, 'en'), once);
});

test('a hand-written title mentioning only the village counts as located', () => {
  const t = '3-Bedroom House in Phonxay';        // no "Ban", operator shorthand
  assert.ok(T.titleHasLocation(t, FULL, 'en'));
  assert.strictEqual(T.ensureTitleLocation(t, FULL, 'en'), t);
});

test('matching ignores case and punctuation', () => {
  assert.ok(T.titleHasLocation('house for rent, sisattanak', NO_VILL, 'en'));
  assert.ok(T.titleHasLocation("Villa — Ban  Phonxay!", FULL, 'en'));
});

test('the worked examples from the requirement', () => {
  const cases = [
    [{ village_en: 'Ban Nongbone', district_en: 'Sisattanak', province_en: 'Vientiane Capital' },
      '3-Bedroom House', '3-Bedroom House in Ban Nongbone, Sisattanak, Vientiane'],
    [FULL, 'Luxury Villa', 'Luxury Villa in Ban Phonxay, Sisattanak, Vientiane'],
    [NO_VILL, '1-Bedroom Apartment', '1-Bedroom Apartment in Sisattanak, Vientiane'],
    [{ district_en: 'Chanthabouly', province_en: 'Vientiane Capital' },
      'Commercial Property', 'Commercial Property in Chanthabouly, Vientiane'],
  ];
  for (const [listing, title, expected] of cases) {
    assert.strictEqual(T.ensureTitleLocation(title, listing, 'en'), expected);
  }
});

test('Vientiane Capital renders as the CITY, not the province key', () => {
  assert.ok(T.ensureTitleLocation('Condo', NO_VILL, 'en').endsWith('Vientiane'));
  assert.ok(!T.ensureTitleLocation('Condo', NO_VILL, 'en').includes('Vientiane Capital'));
});

test('Vientiane PROVINCE is never collapsed into the capital', () => {
  const out = T.ensureTitleLocation('Farmhouse',
    { district_en: 'Phonhong', province_en: 'Vientiane Province' }, 'en');
  assert.ok(out.includes('Vientiane Province'), out);
  // A listing in the province must not read as if it were in the capital.
  assert.ok(!/,\s*Vientiane$/.test(out), out);
});

test('a province outside the capital uses its own name', () => {
  assert.strictEqual(
    T.ensureTitleLocation('Riverside Villa',
      { district_en: 'Chomphet', province_en: 'Luang Prabang' }, 'en'),
    'Riverside Villa in Chomphet, Luang Prabang');
});

test('Lao uses Lao labels and the Lao connector', () => {
  const out = T.ensureTitleLocation('ບ້ານພັກ 3 ຫ້ອງນອນ', FULL, 'lo');
  assert.ok(out.includes('ສີສັດຕະນາກ'), 'Lao district label: ' + out);
  assert.ok(out.includes('ວຽງຈັນ'), 'Lao city label: ' + out);
  assert.ok(out.includes('ຢູ່'), 'Lao connector: ' + out);
  // village_en is used verbatim in every language — there is no village_lo.
  assert.ok(out.includes('Ban Phonxay'), out);
});

test('Chinese runs large→small, as a Chinese address does', () => {
  const out = T.ensureTitleLocation('现代两居室公寓', FULL, 'zh');
  assert.ok(out.includes('万象'), out);
  assert.ok(out.includes('西沙塔纳克'), out);
  assert.ok(out.indexOf('万象') < out.indexOf('西沙塔纳克'), 'city precedes district in zh: ' + out);
});

test('a language falls back to district_en when it has no translated label', () => {
  const out = T.ensureTitleLocation('Title', { district_en: 'Sisattanak' }, 'lo');
  assert.ok(out.includes('Sisattanak'), out);
});

test('ensureAllTitleLocations handles the {title, title_lo, title_zh} record', () => {
  const out = T.ensureAllTitleLocations(
    { title: 'Modern Condo', title_lo: 'ຫ້ອງແຖວ', title_zh: '现代公寓' }, FULL);
  assert.ok(out.title.includes('Sisattanak'));
  assert.ok(out.title_lo.includes('ສີສັດຕະນາກ'));
  assert.ok(out.title_zh.includes('万象'));
});

test('ensureAllTitleLocations also handles the title_en shape, and never mutates', () => {
  const input = { title_en: 'Modern Condo', title_lo: null, title_zh: '' };
  const out = T.ensureAllTitleLocations(input, FULL);
  assert.ok(out.title_en.includes('Sisattanak'));
  assert.strictEqual(input.title_en, 'Modern Condo', 'input was mutated');
  // Null/empty translations stay exactly as they were — no invented title.
  assert.strictEqual(out.title_lo, null);
  assert.strictEqual(out.title_zh, '');
});

test('empty, null and non-string titles are returned unchanged', () => {
  for (const v of ['', null, undefined]) {
    assert.strictEqual(T.ensureTitleLocation(v, FULL, 'en'), v);
  }
});

test('placeholder junk in a location field is not treated as a place', () => {
  for (const junk of ['null', 'undefined', 'not specified', '   ']) {
    const parts = T.locationParts({ village_en: junk, district_en: junk, province_en: junk }, 'en');
    assert.strictEqual(parts.village, '', junk);
    assert.strictEqual(parts.district, '', junk);
    assert.strictEqual(parts.city, '', junk);
  }
  assert.strictEqual(T.ensureTitleLocation('Condo',
    { village_en: 'null', district_en: 'not specified' }, 'en'), 'Condo');
});

test('a village with no district still contributes what it really has', () => {
  assert.strictEqual(
    T.ensureTitleLocation('Studio', { village_en: 'Ban Phonxay' }, 'en'),
    'Studio in Ban Phonxay');
});

test('the legacy `village` / `district` column names still resolve', () => {
  assert.strictEqual(
    T.ensureTitleLocation('Old Listing',
      { village: 'Ban Nongbone', district: 'Sisattanak' }, 'en'),
    'Old Listing in Ban Nongbone, Sisattanak');
});

test('a title is never lengthened without limit — location is added once only', () => {
  let t = 'Villa';
  for (let i = 0; i < 5; i++) t = T.ensureTitleLocation(t, FULL, 'en');
  assert.strictEqual((t.match(/Sisattanak/g) || []).length, 1, t);
});

test('a location phrase can never carry markup', () => {
  // Defence in depth, not the primary control: titles are escaped at every
  // render site, and that is still what stops XSS. But the script-run
  // extraction that picks the Latin part of "Phonsinuan ໂພນສີນວນ" also means
  // angle brackets, quotes and parentheses cannot survive into the phrase at
  // all — so this asserts the stronger property the implementation now has.
  const dirty = { village_en: '<img src=x onerror=alert(1)>', district_en: 'Sisattanak' };
  for (const lang of ['en', 'lo', 'zh']) {
    const phrase = T.locationPhrase(dirty, lang);
    assert.ok(!/[<>"'()]/.test(phrase), `${lang}: ${phrase}`);
    assert.ok(!/onerror\s*=/.test(phrase), `${lang}: ${phrase}`);
  }
  const out = T.ensureTitleLocation('Condo', dirty, 'en');
  assert.ok(!/[<>]/.test(out), out);
  // A title the operator typed is still returned as typed — this module is
  // not a sanitiser for the title itself, and must not silently rewrite one.
  assert.strictEqual(T.ensureTitleLocation('<b>Condo</b>', {}, 'en'), '<b>Condo</b>');
});

// ── The active-listing audit rules ────────────────────────────────────────
// The bulk update touches live, customer-visible titles, so "which rows count
// as active" is asserted directly rather than trusted to a filter expression.

test('active listings are recognised, in every shape the column set allows', () => {
  for (const row of [
    { status: 'active', workflow_status: 'active' },
    { status: 'available', workflow_status: 'active' },
    { workflow_status: 'active' },                 // status unset
    { status: 'active' },                          // workflow_status unset -> defaults active
    {},                                            // both unset -> the legacy default
    { status: 'active', workflow_status: 'active', deleted_at: null },
  ]) assert.strictEqual(T.isActiveListing(row), true, JSON.stringify(row));
});

test('drafts, archived and soft-deleted rows are NOT active', () => {
  for (const row of [
    { workflow_status: 'draft' },
    { status: 'draft' },
    { status: 'DRAFT' },                           // casing must not smuggle one through
    { status: 'archived' },
    { status: 'active', deleted_at: '2026-08-01T00:00:00Z' },
    { workflow_status: 'active', status: 'active', deleted_at: '2026-08-01T00:00:00Z' },
  ]) assert.strictEqual(T.isActiveListing(row), false, JSON.stringify(row));
  assert.strictEqual(T.isActiveListing(null), false);
});

test('the audit patch locates every language present, and only those', () => {
  const { patch, changes, reason } = T.titleLocationPatch({
    ...FULL, title_en: 'Modern Condo', title_lo: 'ຫ້ອງແຖວ', title_zh: null });
  assert.strictEqual(reason, 'located');
  assert.ok(patch.title_en.includes('Sisattanak'));
  assert.ok(patch.title_lo.includes('ສີສັດຕະນາກ'));
  assert.ok(!('title_zh' in patch), 'a missing translation must not be invented');
  assert.strictEqual(changes.length, 2);
  for (const c of changes) assert.ok(c.from && c.to && c.to !== c.from);
});

test('an already-located row produces an EMPTY patch (a second run writes nothing)', () => {
  const r = T.titleLocationPatch({ ...FULL, title_en: 'Modern Condo in Sisattanak, Vientiane' });
  assert.deepStrictEqual(r.patch, {});
  assert.strictEqual(r.reason, 'already-located');
});

test('a row with no usable location is reported, not patched', () => {
  const r = T.titleLocationPatch({ title_en: 'Mystery Property' });
  assert.deepStrictEqual(r.patch, {});
  assert.strictEqual(r.reason, 'no-usable-location');
});

test('a row with no title at all is reported, not given one', () => {
  const r = T.titleLocationPatch({ ...FULL, title_en: '', title_lo: null });
  assert.deepStrictEqual(r.patch, {});
  assert.strictEqual(r.reason, 'no-title');
});

test('the audit is idempotent — patching a patched row yields nothing', () => {
  const row = { ...FULL, title_en: 'Modern Condo', title_lo: 'ຫ້ອງແຖວ' };
  const first = T.titleLocationPatch(row);
  const after = { ...row, ...first.patch };
  const second = T.titleLocationPatch(after);
  assert.deepStrictEqual(second.patch, {}, JSON.stringify(second));
  assert.strictEqual(second.reason, 'already-located');
});

test('the patch never touches a column that is not a title', () => {
  const row = { ...FULL, title_en: 'Condo', price_display: '$500/mo', slug: 'x', id: '1' };
  const { patch } = T.titleLocationPatch(row);
  assert.deepStrictEqual(Object.keys(patch), ['title_en']);
});

test('a REGENERATED title stays located across repeated generations', () => {
  // What Edit → Generate does: the AI returns a fresh title, the client locates
  // it, the operator regenerates, and so on. The location must survive each
  // round without accumulating.
  let record = { title: 'Modern Condo', title_lo: 'ຫ້ອງແຖວ', title_zh: '现代公寓' };
  for (let i = 0; i < 3; i++) {
    record = T.ensureAllTitleLocations(record, FULL);
    assert.ok(T.titleHasLocation(record.title, FULL, 'en'), record.title);
    assert.strictEqual((record.title.match(/Sisattanak/g) || []).length, 1, record.title);
  }
});

test('a Smart Import title with the location already written in is left alone', () => {
  // The updated prompt asks the AI to end the title with the location, so the
  // common case must be a no-op rather than a second append.
  const fromAi = { title: 'Modern 3-Bedroom Home with Garden in Ban Phonxay, Sisattanak',
                   title_lo: null, title_zh: null };
  const out = T.ensureAllTitleLocations(fromAi, FULL);
  assert.strictEqual(out.title, fromAi.title);
});

// ── Real production data, from the first dry-run audit ─────────────────────
// Every case below is a real active listing whose title the first version of
// this module got WRONG. Clean fixtures could not have caught any of them.

test('a village field holding BOTH scripts renders only the right one', () => {
  const row = { village_en: 'Phonsinuan ໂພນສີນວນ', district_en: 'Sisattanak',
                district_lo: 'ສີສັດຕະນາກ', district_zh: '西沙塔纳克',
                province_en: 'Vientiane Capital' };
  assert.strictEqual(T.locationParts(row, 'en').village, 'Phonsinuan');
  assert.strictEqual(T.locationParts(row, 'lo').village, 'ໂພນສີນວນ');
  // No Chinese village exists, so zh falls back to the Latin spelling rather
  // than dropping Lao script into a Chinese title.
  assert.strictEqual(T.locationParts(row, 'zh').village, 'Phonsinuan');
  assert.ok(!/[຀-໿]/.test(T.locationPhrase(row, 'en')), 'no Lao script in an English phrase');
});

test('THE DUPLICATION BUG: a title naming the village is not given it again', () => {
  const row = { village_en: 'Phonsinuan ໂພນສີນວນ', district_en: 'Sisattanak',
                province_en: 'Vientiane Capital' };
  const title = 'Service Townhouse for Rent in Phonsinuan with Security and Wi-Fi';
  // The first audit produced "...in Phonsinuan ... in Phonsinuan ໂພນສີນວນ,
  // Sisattanak, Vientiane" because the stored value is not a substring of the
  // title.
  assert.strictEqual(T.ensureTitleLocation(title, row, 'en'), title);
});

test('the Lao title is not re-located when it already says the village', () => {
  const row = { village_en: 'Phonthan ໂພນທັນ', district_en: 'Saysettha',
                district_lo: 'ໄຊເສດຖາ', province_en: 'Vientiane Capital' };
  const lo = 'ເຮືອນສອງຊັ້ນຫຼູຫຼາໃຫ້ເຊົ່າຢູ່ບ້ານໂພນທັນ';
  assert.strictEqual(T.ensureTitleLocation(lo, row, 'lo'), lo);
});

test('romanised spelling variants count as the same place', () => {
  for (const [title, village] of [
    ['Fully Furnished Apartment with Balcony in Sungjiang', 'Sungjieng ຊັງຈ່ຽງ'],
    ['Newly Opened Fully Furnished Apartment in Phakhaw Village', 'Phakhao ພະຂາວ'],
  ]) {
    const row = { village_en: village, district_en: 'Sikhottabong', province_en: 'Vientiane Capital' };
    assert.strictEqual(T.ensureTitleLocation(title, row, 'en'), title, title);
  }
});

test('but genuinely different villages sharing a prefix are NOT confused', () => {
  const row = { village_en: 'Phonsinuan', district_en: 'Sisattanak', province_en: 'Vientiane Capital' };
  // "Phonthan" and "Phonsinuan" share "Phon" but differ by the fifth letter.
  const out = T.ensureTitleLocation('House in Phonthan', row, 'en');
  assert.ok(out.includes('Phonsinuan'), out);
});

test('"Village" and "Ban" alone never count as naming a place', () => {
  const row = { village_en: 'Yapha Village ບ້ານ ຍະພາ', district_en: 'Sikhottabong',
                province_en: 'Vientiane Capital' };
  // The title says "Village" but names a different place — it still needs the
  // real location.
  const out = T.ensureTitleLocation('Newly Built 5-Bedroom Luxury Home in Sikhai', row, 'en');
  assert.ok(out.includes('Yapha Village'), out);
});

test('a second "in" becomes a continuation, not a stutter', () => {
  const row = { village_en: 'Yapha Village ບ້ານ ຍະພາ', district_en: 'Sikhottabong',
                province_en: 'Vientiane Capital' };
  const out = T.ensureTitleLocation('Newly Built 5-Bedroom Luxury Home in Sikhai', row, 'en');
  assert.strictEqual(out,
    'Newly Built 5-Bedroom Luxury Home in Sikhai, Yapha Village, Sikhottabong, Vientiane');
  assert.strictEqual((out.match(/\sin\s/g) || []).length, 1, 'only one "in": ' + out);
});

test('trailing punctuation is not stranded mid-sentence', () => {
  const row = { village_en: 'Donnokkhoum ດອນນົກຂຸ້ມ', district_en: 'Sisattanak',
                province_en: 'Vientiane Capital' };
  const out = T.ensureTitleLocation('Cozy 3-Bedroom House with Carport.', row, 'en');
  assert.strictEqual(out, 'Cozy 3-Bedroom House with Carport in Donnokkhoum, Sisattanak, Vientiane');
});

test('the real audit rows are still idempotent after all of the above', () => {
  const rows = [
    { village_en: 'Phonsinuan ໂພນສີນວນ', district_en: 'Sisattanak', province_en: 'Vientiane Capital',
      title_en: 'Service Townhouse for Rent with Wi-Fi' },
    { village_en: 'Yapha Village ບ້ານ ຍະພາ', district_en: 'Sikhottabong', province_en: 'Vientiane Capital',
      title_en: 'Newly Built 5-Bedroom Luxury Home in Sikhai' },
    { district_en: 'Sisattanak', province_en: 'Vientiane Capital',
      title_en: 'Prime Ground Floor Commercial Space for Rent' },
  ];
  for (const row of rows) {
    const once = { ...row, ...T.titleLocationPatch(row).patch };
    const second = T.titleLocationPatch(once);
    assert.deepStrictEqual(second.patch, {}, once.title_en);
  }
});
