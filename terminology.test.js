// Unit tests for terminology.js's parseUnitTypeTitle() -- run with
// `node --test terminology.test.js`.
// terminology.js is a plain-global-var browser script (same convention as
// currency.js/rental-terms.js, no module exports), so it's loaded into a
// vm sandbox here rather than via `import` -- same approach as
// rental-terms.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const terminologySrc = fs.readFileSync(new URL('./terminology.js', import.meta.url), 'utf8');
vm.runInThisContext(terminologySrc, { filename: 'terminology.js' });

const {
  parseUnitTypeTitle, PROPERTY_TYPES, PROPERTY_TYPE_FIELDS, PROPERTY_TYPE_DISPLAY,
  resolveUnitTypesFieldRange, formatBedBathCount, getCardFacts,
} = globalThis;

// The exact bug report this suite covers: a unit type named "2 Bedroom 1
// Bath" was rejected by the publish validator because the structured
// Bedrooms/Bathrooms fields were empty, even though the title plainly
// states both numbers.
test('parseUnitTypeTitle: "2 Bedroom 1 Bath" (the reported bug)', () => {
  assert.deepEqual(parseUnitTypeTitle('2 Bedroom 1 Bath'), { bedrooms: 2, bathrooms: 1 });
});

test('parseUnitTypeTitle: Studio implies zero bedrooms, no bathroom count stated', () => {
  assert.deepEqual(parseUnitTypeTitle('Studio'), { bedrooms: 0, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle('studio'), { bedrooms: 0, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle('Studio Deluxe'), { bedrooms: 0, bathrooms: null });
});

test('parseUnitTypeTitle: "1 Bedroom 1 Bath"', () => {
  assert.deepEqual(parseUnitTypeTitle('1 Bedroom 1 Bath'), { bedrooms: 1, bathrooms: 1 });
});

test('parseUnitTypeTitle: "3 Bed 2 Bath" (abbreviated wording)', () => {
  assert.deepEqual(parseUnitTypeTitle('3 Bed 2 Bath'), { bedrooms: 3, bathrooms: 2 });
});

test('parseUnitTypeTitle: titles that cannot be parsed confidently require manual input', () => {
  assert.deepEqual(parseUnitTypeTitle('Deluxe Suite'), { bedrooms: null, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle('Penthouse A'), { bedrooms: null, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle('Riverside View'), { bedrooms: null, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle(''), { bedrooms: null, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle(null), { bedrooms: null, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle(undefined), { bedrooms: null, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle('   '), { bedrooms: null, bathrooms: null });
});

test('parseUnitTypeTitle: a title stating only one of the two fields infers just that one', () => {
  assert.deepEqual(parseUnitTypeTitle('2 Bedroom Unit'), { bedrooms: 2, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle('Unit with 2 Bathrooms'), { bedrooms: null, bathrooms: 2 });
});

test('parseUnitTypeTitle: compact "BR"/"BA" abbreviations, with and without separators', () => {
  assert.deepEqual(parseUnitTypeTitle('2BR/1BA'), { bedrooms: 2, bathrooms: 1 });
  assert.deepEqual(parseUnitTypeTitle('2BR 1BA'), { bedrooms: 2, bathrooms: 1 });
  assert.deepEqual(parseUnitTypeTitle('2-BR 1-BA'), { bedrooms: 2, bathrooms: 1 });
});

test('parseUnitTypeTitle: does not false-positive on words that merely start with bed/bath', () => {
  // "Bedside" / "Bathrobe" share a prefix with "bed"/"bath" but are not a
  // bedroom/bathroom count -- must not be misread as "0 bedrooms" etc.
  assert.deepEqual(parseUnitTypeTitle('Bedside Deluxe'), { bedrooms: null, bathrooms: null });
  assert.deepEqual(parseUnitTypeTitle('Bathrobe Suite'), { bedrooms: null, bathrooms: null });
});

test('parseUnitTypeTitle: plural and singular wording both parse', () => {
  assert.deepEqual(parseUnitTypeTitle('1 Bedroom 1 Bathroom'), { bedrooms: 1, bathrooms: 1 });
  assert.deepEqual(parseUnitTypeTitle('4 Bedrooms 3 Bathrooms'), { bedrooms: 4, bathrooms: 3 });
});

// ── row_rooms (ຫ້ອງແຖວ) property type — added alongside villa; villa is
// migrated to house separately, later, as its own explicit step. These
// guard the one real risk the naming audit found: row_rooms must never be
// interpreted as (or collide with) townhouse/rowhouse, commercial/shophouse,
// or villa — each is a genuinely different property type in this taxonomy.
test('PROPERTY_TYPES.row_rooms exists with its own distinct machine key and labels', () => {
  assert.ok(PROPERTY_TYPES.row_rooms, 'row_rooms must be a registered property type');
  assert.equal(PROPERTY_TYPES.row_rooms.en, 'Row Rooms');
  assert.equal(PROPERTY_TYPES.row_rooms.lo, 'ຫ້ອງແຖວ');
});

test('row_rooms is never conflated with townhouse, commercial, or villa', () => {
  assert.notEqual(PROPERTY_TYPES.row_rooms.en, PROPERTY_TYPES.townhouse.en);
  assert.notEqual(PROPERTY_TYPES.row_rooms.en, PROPERTY_TYPES.commercial.en);
  assert.notEqual(PROPERTY_TYPES.row_rooms.en, PROPERTY_TYPES.villa.en);
  assert.notEqual(PROPERTY_TYPES.row_rooms.lo, PROPERTY_TYPES.townhouse.lo);
  assert.notEqual(PROPERTY_TYPES.row_rooms.lo, PROPERTY_TYPES.commercial.lo);
  assert.notEqual(PROPERTY_TYPES.row_rooms.lo, PROPERTY_TYPES.villa.lo);
  // "row_rooms" as a machine value must not be mistakable for the
  // pre-existing, unrelated unit_types (per-listing floor-plan/pricing)
  // concept -- confirmed distinct by construction, asserted here so a
  // future rename can't accidentally reintroduce the collision.
  assert.notEqual(PROPERTY_TYPES.row_rooms, 'unit_types');
  assert.ok(!('unit_types' in PROPERTY_TYPES), 'unit_types must never be registered as a property type value');
});

test('row_rooms has a form field schema and a customer-facing display schema, same shape as its siblings', () => {
  assert.ok(Array.isArray(PROPERTY_TYPE_FIELDS.row_rooms) && PROPERTY_TYPE_FIELDS.row_rooms.length > 0);
  assert.ok(Array.isArray(PROPERTY_TYPE_DISPLAY.row_rooms) && PROPERTY_TYPE_DISPLAY.row_rooms.length > 0);
});

// ── Multi-Unit Buildings: card bedroom/bathroom fallback ────────────────────
// Production audit: 17 active/available multi-unit listings, 4 with null
// building-level bedrooms/bathrooms -- and real unit-type configurations
// genuinely vary (Studio-2BR, Studio-1BR, 1BR-2BR), so the card must never
// collapse a varied building to one representative unit (cheapest/first/
// etc.) -- only a true min-max range, or a single value when they agree.
function unit(bedrooms, bathrooms) {
  return { id: 'u-' + bedrooms + '-' + bathrooms + '-' + Math.random(), name_en: 'Unit', bedrooms: bedrooms, bathrooms: bathrooms };
}
function multiUnitProperty(overrides) {
  return Object.assign({ property_type: 'apartment', bedrooms: null, bathrooms: null, unit_types: [] }, overrides);
}
function bedroomFact(facts) { return facts.filter(function(f) { return f.icon === '🛏️'; })[0] || null; }
function bathroomFact(facts) { return facts.filter(function(f) { return f.icon === '🛁'; })[0] || null; }

test('resolveUnitTypesFieldRange: unit type inheritance through resolveUnitType() -- a null unit-type value inherits the BUILDING\'s own value, not "no data"', () => {
  var property = multiUnitProperty({
    bedrooms: 2, // the building has its own default
    unit_types: [unit(null, 1), unit(3, 2)], // first unit inherits bedrooms:2 from the building
  });
  var range = resolveUnitTypesFieldRange(property, 'bedrooms');
  assert.deepEqual(range, { hasValue: true, min: 2, max: 3 });
});

test('formatBedBathCount: Lao/English/Chinese formatting, uniform value, range, and Studio', () => {
  assert.equal(formatBedBathCount(1, 1, 'en', 'bed'), '1 bed');
  assert.equal(formatBedBathCount(2, 2, 'en', 'bed'), '2 beds');
  assert.equal(formatBedBathCount(1, 2, 'en', 'bed'), '1–2 beds');
  assert.equal(formatBedBathCount(0, 0, 'en', 'bed'), 'Studio');
  assert.equal(formatBedBathCount(0, 2, 'en', 'bed'), 'Studio–2 beds');
  assert.equal(formatBedBathCount(1, 2, 'en', 'bath'), '1–2 baths');

  assert.equal(formatBedBathCount(1, 1, 'lo', 'bed'), '1 ຫ້ອງນອນ');
  assert.equal(formatBedBathCount(1, 2, 'lo', 'bed'), '1–2 ຫ້ອງນອນ');
  assert.equal(formatBedBathCount(0, 0, 'lo', 'bed'), 'ສະຕູດິໂອ');
  assert.equal(formatBedBathCount(0, 2, 'lo', 'bed'), 'ສະຕູດິໂອ–2 ຫ້ອງນອນ');
  assert.equal(formatBedBathCount(1, 2, 'lo', 'bath'), '1–2 ຫ້ອງນ້ຳ');

  assert.equal(formatBedBathCount(1, 1, 'zh', 'bed'), '1 卧室');
  assert.equal(formatBedBathCount(1, 2, 'zh', 'bed'), '1–2 卧室');
  assert.equal(formatBedBathCount(0, 0, 'zh', 'bed'), '开间');
  assert.equal(formatBedBathCount(0, 2, 'zh', 'bed'), '开间–2 卧室');
  assert.equal(formatBedBathCount(1, 2, 'zh', 'bath'), '1–2 浴室');
});

test('getCardFacts: property-level bedrooms/bathrooms take precedence over unit_types, even when unit types vary', () => {
  var property = multiUnitProperty({
    bedrooms: 2, bathrooms: 1,
    unit_types: [unit(0, 1), unit(1, 1), unit(2, 2)], // varied -- must NOT override the building's own "2"/"1"
  });
  var facts = getCardFacts('apartment', property, 'en');
  assert.equal(bedroomFact(facts).value, 2);
  assert.equal(bathroomFact(facts).value, 1);
});

test('getCardFacts: a populated bedrooms:0 (a real single-listing Studio) is never treated as missing', () => {
  var property = multiUnitProperty({ bedrooms: 0, bathrooms: 1, unit_types: [unit(3, 2)] });
  var facts = getCardFacts('apartment', property, 'en');
  assert.equal(bedroomFact(facts).value, 0); // the building's own value, not the unit type's 3
});

test('getCardFacts: missing property bedrooms + uniform unit types -> "1 bed"', () => {
  var property = multiUnitProperty({ bathrooms: 1, unit_types: [unit(1, 1), unit(1, 1), unit(1, 1)] });
  assert.equal(bedroomFact(getCardFacts('apartment', property, 'en')).value, '1 bed');
});

test('getCardFacts: missing property bedrooms + varied unit types (1BR-2BR) -> "1-2 beds"', () => {
  var property = multiUnitProperty({ bathrooms: 1, unit_types: [unit(1, 1), unit(2, 2)] });
  assert.equal(bedroomFact(getCardFacts('apartment', property, 'en')).value, '1–2 beds');
});

test('getCardFacts: Studio-only unit types -> "Studio"', () => {
  var property = multiUnitProperty({ bathrooms: 1, unit_types: [unit(0, 1), unit(0, 1)] });
  assert.equal(bedroomFact(getCardFacts('apartment', property, 'en')).value, 'Studio');
});

test('getCardFacts: Studio-1BR unit types -> "Studio-1 bed"', () => {
  var property = multiUnitProperty({ bathrooms: 1, unit_types: [unit(0, 1), unit(1, 1)] });
  assert.equal(bedroomFact(getCardFacts('apartment', property, 'en')).value, 'Studio–1 bed');
});

test('getCardFacts: Studio-2BR unit types -> "Studio-2 beds"', () => {
  var property = multiUnitProperty({ bathrooms: 1, unit_types: [unit(0, 1), unit(1, 1), unit(2, 2)] });
  assert.equal(bedroomFact(getCardFacts('apartment', property, 'en')).value, 'Studio–2 beds');
});

test('getCardFacts: missing property bathrooms + uniform unit types -> "1 bath"', () => {
  var property = multiUnitProperty({ bedrooms: 1, unit_types: [unit(1, 1), unit(1, 1)] });
  assert.equal(bathroomFact(getCardFacts('apartment', property, 'en')).value, '1 bath');
});

test('getCardFacts: missing property bathrooms + varied unit types -> "1-2 baths"', () => {
  var property = multiUnitProperty({ bedrooms: 1, unit_types: [unit(1, 1), unit(1, 2)] });
  assert.equal(bathroomFact(getCardFacts('apartment', property, 'en')).value, '1–2 baths');
});

test('getCardFacts: no usable unit-type data -> the fact is omitted entirely, exactly like today', () => {
  assert.equal(bedroomFact(getCardFacts('apartment', multiUnitProperty({ unit_types: [] }), 'en')), null);
  assert.equal(bedroomFact(getCardFacts('apartment', multiUnitProperty({ unit_types: [unit(null, null)] }), 'en')), null);
  assert.equal(bedroomFact(getCardFacts('apartment', multiUnitProperty({}), 'en')), null); // no unit_types key at all
});

test('getCardFacts: a missing bedroom value never suppresses an available bathroom value, and vice versa', () => {
  var bedMissingOnly = multiUnitProperty({ bathrooms: 2, unit_types: [unit(1, 1), unit(2, 1)] });
  var bedFacts = getCardFacts('apartment', bedMissingOnly, 'en');
  assert.equal(bedroomFact(bedFacts).value, '1–2 beds');
  assert.equal(bathroomFact(bedFacts).value, 2); // untouched building value, independently present

  var bathMissingOnly = multiUnitProperty({ bedrooms: 3, unit_types: [unit(1, 1), unit(1, 2)] });
  var bathFacts = getCardFacts('apartment', bathMissingOnly, 'en');
  assert.equal(bedroomFact(bathFacts).value, 3); // untouched building value, independently present
  assert.equal(bathroomFact(bathFacts).value, '1–2 baths');
});

test('getCardFacts: no regression -- a normal single-unit listing (no unit_types at all) is completely unaffected', () => {
  var property = { property_type: 'apartment', bedrooms: 3, bathrooms: 2, sqm: 85 };
  var facts = getCardFacts('apartment', property, 'en');
  assert.equal(bedroomFact(facts).value, 3);
  assert.equal(bathroomFact(facts).value, 2);
  assert.equal(facts.filter(function(f) { return f.icon === '📐'; })[0].value, 85);
});

test('getCardFacts: no regression -- a property type with no bedrooms/bathrooms fields (e.g. land) is unaffected', () => {
  var facts = getCardFacts('land', { property_type: 'land', sqm_land: 500, unit_types: [unit(2, 1)] }, 'en');
  assert.equal(bedroomFact(facts), null);
  assert.equal(bathroomFact(facts), null);
});
