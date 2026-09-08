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

const { parseUnitTypeTitle, PROPERTY_TYPES, PROPERTY_TYPE_FIELDS, PROPERTY_TYPE_DISPLAY } = globalThis;

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
