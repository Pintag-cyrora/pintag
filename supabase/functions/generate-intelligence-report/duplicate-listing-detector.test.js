// Unit tests for the Duplicate Listing detector -- run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateListingDetector, normalizeTitle, groupByTitle } from './duplicate-listing-detector.js';
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
