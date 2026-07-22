// Unit tests for the Duplicate Listing detector -- run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateListingDetector, normalizeTitle, groupByTitle, variantSignature, groupByTitleAndVariant } from './duplicate-listing-detector.js';
import { runInsightEngine } from './insight-engine.js';

const NOW = new Date('2026-07-18T00:00:00Z');

function property(overrides) {
  return {
    id: 'p-1', title_en: 'Riverside Villa', district_en: 'Sisattanak', property_type: 'villa',
    ...overrides,
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────
test('normalizeTitle: trims and lowercases', () => {
  assert.equal(normalizeTitle('  Riverside Villa  '), 'riverside villa');
  assert.equal(normalizeTitle('RIVERSIDE VILLA'), 'riverside villa');
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(undefined), '');
});
test('groupByTitle: groups by normalized title, ignores blank titles', () => {
  const a = property({ id: 'a', title_en: 'Riverside Villa' });
  const b = property({ id: 'b', title_en: '  riverside villa  ' });
  const c = property({ id: 'c', title_en: 'Different Listing' });
  const untitled = property({ id: 'd', title_en: '' });
  const groups = groupByTitle([a, b, c, untitled]);
  assert.equal(groups.get('riverside villa').length, 2);
  assert.equal(groups.get('different listing').length, 1);
  assert.equal(groups.has(''), false);
});

// ── duplicateListingDetector.detect ───────────────────────────────────────
test('detect finds nothing when every title is unique', () => {
  const a = property({ id: 'a', title_en: 'Riverside Villa' });
  const b = property({ id: 'b', title_en: 'Hillside Condo' });
  assert.deepEqual(duplicateListingDetector.detect({ properties: [a, b] }), []);
});
test('detect flags every property in a same-title group of 2+, referencing each other', () => {
  const a = property({ id: 'a', title_en: 'Riverside Villa' });
  const b = property({ id: 'b', title_en: 'riverside villa' }); // same title, different case
  const c = property({ id: 'c', title_en: 'Unrelated Listing' });
  const findings = duplicateListingDetector.detect({ properties: [a, b, c] });
  assert.equal(findings.length, 2);
  const byId = Object.fromEntries(findings.map((f) => [f.dimensionPropertyId, f]));
  assert.deepEqual(byId.a.evidence.duplicate_of, ['b']);
  assert.deepEqual(byId.b.evidence.duplicate_of, ['a']);
  findings.forEach((f) => {
    assert.equal(f.type, 'data_quality');
    assert.equal(f.metricKey, 'duplicate_listing');
    assert.equal(f.confidence, 1);
    assert.equal(f.severity, 'medium');
  });
});
test('detect ignores properties with no title at all', () => {
  const a = property({ id: 'a', title_en: '' });
  const b = property({ id: 'b', title_en: '' });
  assert.deepEqual(duplicateListingDetector.detect({ properties: [a, b] }), []);
});
test('detect returns nothing when properties list is empty or absent', () => {
  assert.deepEqual(duplicateListingDetector.detect({ properties: [] }), []);
  assert.deepEqual(duplicateListingDetector.detect({}), []);
});

// ── Multi-Unit Buildings false-positive fix ────────────────────────────────
test('variantSignature: missing fields normalize to empty string', () => {
  assert.equal(variantSignature(property({})), '||');
});
test('variantSignature: differs on bedrooms/bathrooms/price', () => {
  const studio = property({ bedrooms: 0, bathrooms: 1, sale_price: '$250/mo' });
  const oneBr = property({ bedrooms: 1, bathrooms: 1, sale_price: '$400/mo' });
  assert.notEqual(variantSignature(studio), variantSignature(oneBr));
});
test('variantSignature: falls back rent_price then price_display when sale_price absent', () => {
  const a = property({ rent_price: '$400/mo' });
  const b = property({ price_display: '$400/mo' });
  assert.equal(variantSignature(a), variantSignature(b));
});
test('detect does NOT flag distinct unit-type variants sharing a building title as duplicates', () => {
  const studio = property({ id: 'a', title_en: 'Riverside Apartments', bedrooms: 0, bathrooms: 1, sale_price: '$250/mo' });
  const oneBr  = property({ id: 'b', title_en: 'Riverside Apartments', bedrooms: 1, bathrooms: 1, sale_price: '$400/mo' });
  const twoBr  = property({ id: 'c', title_en: 'Riverside Apartments', bedrooms: 2, bathrooms: 2, sale_price: '$600/mo' });
  assert.deepEqual(duplicateListingDetector.detect({ properties: [studio, oneBr, twoBr] }), []);
});
test('detect still flags true duplicates: same title AND same bedrooms/bathrooms/price', () => {
  const a = property({ id: 'a', title_en: 'Riverside Villa', bedrooms: 3, bathrooms: 2, sale_price: '$550,000' });
  const b = property({ id: 'b', title_en: 'Riverside Villa', bedrooms: 3, bathrooms: 2, sale_price: '$550,000' });
  const c = property({ id: 'c', title_en: 'Riverside Villa', bedrooms: 4, bathrooms: 3, sale_price: '$700,000' }); // distinct variant, same title
  const findings = duplicateListingDetector.detect({ properties: [a, b, c] });
  assert.equal(findings.length, 2);
  const ids = findings.map((f) => f.dimensionPropertyId).sort();
  assert.deepEqual(ids, ['a', 'b']);
});
test('groupByTitleAndVariant: same title, differing variant signature, do not group together', () => {
  const a = property({ id: 'a', title_en: 'Riverside Apartments', bedrooms: 0 });
  const b = property({ id: 'b', title_en: 'Riverside Apartments', bedrooms: 1 });
  const groups = groupByTitleAndVariant([a, b]);
  assert.equal(groups.size, 2);
  groups.forEach((group) => assert.equal(group.length, 1));
});
test('reevaluate resolves once bedrooms/bathrooms/price are edited to no longer match the group (unit variants disambiguated)', () => {
  const a = property({ id: 'a', title_en: 'Riverside Apartments', bedrooms: 1, bathrooms: 1 });
  const b = property({ id: 'b', title_en: 'Riverside Apartments', bedrooms: 2, bathrooms: 2 }); // no longer matches a
  const result = duplicateListingDetector.reevaluate(
    { type: 'data_quality', metric_key: 'duplicate_listing', dimension_property_id: 'a' },
    { properties: [a, b] }
  );
  assert.deepEqual(result, { stillSignificant: false });
});

// ── duplicateListingDetector.reevaluate ───────────────────────────────────
test('reevaluate returns null for a non-matching insight (not mine)', () => {
  assert.equal(duplicateListingDetector.reevaluate({ type: 'demand_spike', metric_key: 'search.total' }, { properties: [] }), null);
  assert.equal(duplicateListingDetector.reevaluate({ type: 'data_quality', metric_key: 'missing_photos' }, { properties: [] }), null);
});
test('reevaluate resolves when the property is no longer in the tracked set', () => {
  const result = duplicateListingDetector.reevaluate(
    { type: 'data_quality', metric_key: 'duplicate_listing', dimension_property_id: 'gone-1' },
    { properties: [property({ id: 'still-here' })] }
  );
  assert.deepEqual(result, { stillSignificant: false });
});
test('reevaluate resolves once the group no longer has 2+ members (e.g. one was retitled)', () => {
  const a = property({ id: 'a', title_en: 'Renamed Listing' }); // no longer matches b's title
  const result = duplicateListingDetector.reevaluate(
    { type: 'data_quality', metric_key: 'duplicate_listing', dimension_property_id: 'a' },
    { properties: [a] }
  );
  assert.deepEqual(result, { stillSignificant: false });
});
test('reevaluate stays significant while the group still has 2+ members', () => {
  const a = property({ id: 'a', title_en: 'Riverside Villa' });
  const b = property({ id: 'b', title_en: 'Riverside Villa' });
  const result = duplicateListingDetector.reevaluate(
    { type: 'data_quality', metric_key: 'duplicate_listing', dimension_property_id: 'a' },
    { properties: [a, b] }
  );
  assert.deepEqual(result, { stillSignificant: true });
});

// ── Integration with the shared runInsightEngine lifecycle loop ──────────
test('runInsightEngine wires duplicateListingDetector via extraContext alongside dataQualityDetector', () => {
  const a = property({ id: 'a', title_en: 'Riverside Villa' });
  const b = property({ id: 'b', title_en: 'Riverside Villa' });
  const { toInsert } = runInsightEngine(
    { day: '2026-07-18', metrics: {} }, [], [], '2026-07-18',
    [duplicateListingDetector], { properties: [a, b], now: NOW }
  );
  assert.equal(toInsert.length, 2);
  assert.ok(toInsert.every((i) => i.metric_key === 'duplicate_listing'));
});
