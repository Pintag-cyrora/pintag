// Unit tests for the Data Quality detector — run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import { dataQualityDetector, isMissingPhotos, isMissingAiDescription, isStaleListing, STALE_DAYS_THRESHOLD } from './data-quality-detector.js';
import { runInsightEngine } from './insight-engine.js';

const NOW = new Date('2026-07-18T00:00:00Z');

function property(overrides) {
  return {
    id: 'p-1', title_en: 'Test Listing', images: ['https://x/1.jpg'],
    description_en: 'A lovely home.', property_highlight_en: null,
    district_en: 'Sisattanak', property_type: 'villa',
    created_at: '2026-07-01T00:00:00Z', view_count: 10,
    ...overrides,
  };
}

// ── Pure rule checks ──────────────────────────────────────────────────────
test('isMissingPhotos: true when images is empty or not an array', () => {
  assert.equal(isMissingPhotos(property({ images: [] })), true);
  assert.equal(isMissingPhotos(property({ images: null })), true);
  assert.equal(isMissingPhotos(property({ images: undefined })), true);
  assert.equal(isMissingPhotos(property({ images: ['a.jpg'] })), false);
});
test('isMissingAiDescription: false if either description or highlight is present', () => {
  assert.equal(isMissingAiDescription(property({ description_en: null, property_highlight_en: null })), true);
  assert.equal(isMissingAiDescription(property({ description_en: '  ', property_highlight_en: null })), true);
  assert.equal(isMissingAiDescription(property({ description_en: 'text', property_highlight_en: null })), false);
  assert.equal(isMissingAiDescription(property({ description_en: null, property_highlight_en: 'highlight' })), false);
});
test('isStaleListing: false when younger than the threshold regardless of views', () => {
  const recentlyCreated = new Date(NOW);
  recentlyCreated.setDate(recentlyCreated.getDate() - (STALE_DAYS_THRESHOLD - 5));
  assert.equal(isStaleListing(property({ created_at: recentlyCreated.toISOString(), view_count: 0 }), NOW), false);
});
test('isStaleListing: true when old enough AND views are below the floor', () => {
  const oldEnough = new Date(NOW);
  oldEnough.setDate(oldEnough.getDate() - (STALE_DAYS_THRESHOLD + 5));
  assert.equal(isStaleListing(property({ created_at: oldEnough.toISOString(), view_count: 1 }), NOW), true);
});
test('isStaleListing: false when old enough but has meaningful views', () => {
  const oldEnough = new Date(NOW);
  oldEnough.setDate(oldEnough.getDate() - (STALE_DAYS_THRESHOLD + 5));
  assert.equal(isStaleListing(property({ created_at: oldEnough.toISOString(), view_count: 50 }), NOW), false);
});

// ── dataQualityDetector.detect ────────────────────────────────────────────
test('detect finds one finding per violated rule, none for a healthy listing', () => {
  const healthy = property({ id: 'healthy-1' });
  const missingPhotos = property({ id: 'bad-1', images: [] });
  const findings = dataQualityDetector.detect({ properties: [healthy, missingPhotos], now: NOW });
  assert.equal(findings.filter((f) => f.dimension_property_id === undefined && f.dimensionPropertyId === 'healthy-1').length, 0);
  const badFindings = findings.filter((f) => f.dimensionPropertyId === 'bad-1');
  assert.equal(badFindings.length, 1);
  assert.equal(badFindings[0].metricKey, 'missing_photos');
  assert.equal(badFindings[0].type, 'data_quality');
  assert.equal(badFindings[0].confidence, 1);
});
test('detect flags multiple simultaneous violations on the same listing', () => {
  const oldEnough = new Date(NOW);
  oldEnough.setDate(oldEnough.getDate() - (STALE_DAYS_THRESHOLD + 10));
  const troubled = property({ id: 'troubled-1', images: [], description_en: null, property_highlight_en: null, created_at: oldEnough.toISOString(), view_count: 0 });
  const findings = dataQualityDetector.detect({ properties: [troubled], now: NOW });
  const metricKeys = findings.map((f) => f.metricKey).sort();
  assert.deepEqual(metricKeys, ['missing_ai_description', 'missing_photos', 'stale_listing']);
});
test('detect returns nothing when properties list is empty or absent', () => {
  assert.deepEqual(dataQualityDetector.detect({ properties: [], now: NOW }), []);
  assert.deepEqual(dataQualityDetector.detect({ now: NOW }), []);
});

// ── dataQualityDetector.reevaluate ────────────────────────────────────────
test('reevaluate returns null for a non-data_quality insight (not mine)', () => {
  assert.equal(dataQualityDetector.reevaluate({ type: 'demand_spike', metric_key: 'search.total' }, { properties: [] }), null);
});
test('reevaluate returns null for an unrecognized metric_key (orphaned rule)', () => {
  assert.equal(dataQualityDetector.reevaluate({ type: 'data_quality', metric_key: 'no_such_rule_anymore' }, { properties: [] }), null);
});
test('reevaluate resolves when the property is no longer in the tracked set (deleted or status changed)', () => {
  const result = dataQualityDetector.reevaluate(
    { type: 'data_quality', metric_key: 'missing_photos', dimension_property_id: 'gone-1' },
    { properties: [property({ id: 'still-here' })], now: NOW }
  );
  assert.deepEqual(result, { stillSignificant: false });
});
test('reevaluate re-checks the rule against current property state', () => {
  const fixed = property({ id: 'fixed-1', images: ['now-has-a-photo.jpg'] });
  const stillBroken = property({ id: 'broken-1', images: [] });
  const fixedResult = dataQualityDetector.reevaluate(
    { type: 'data_quality', metric_key: 'missing_photos', dimension_property_id: 'fixed-1' },
    { properties: [fixed], now: NOW }
  );
  const brokenResult = dataQualityDetector.reevaluate(
    { type: 'data_quality', metric_key: 'missing_photos', dimension_property_id: 'broken-1' },
    { properties: [stillBroken], now: NOW }
  );
  assert.equal(fixedResult.stillSignificant, false);
  assert.equal(brokenResult.stillSignificant, true);
});

// ── Integration with the shared runInsightEngine lifecycle loop ─────────
test('runInsightEngine wires dataQualityDetector via extraContext with zero changes to the lifecycle loop', () => {
  const badProperty = property({ id: 'p-bad', images: [] });
  const { toInsert } = runInsightEngine(
    { day: '2026-07-18', metrics: {} }, [], [], '2026-07-18',
    [dataQualityDetector], { properties: [badProperty], now: NOW }
  );
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].type, 'data_quality');
  assert.equal(toInsert[0].metric_key, 'missing_photos');
  assert.equal(toInsert[0].dimension_property_id, 'p-bad');
  assert.equal(toInsert[0].trend, 'emerging');
});
test('runInsightEngine resolves a data-quality insight once the listing is fixed', () => {
  const openInsights = [{
    id: 'existing-insight', type: 'data_quality', metric_key: 'missing_photos',
    dimension_district: 'Sisattanak', dimension_property_type: 'villa', dimension_property_id: 'p-fixed',
    evidence: { rule: 'missing_photos', property_id: 'p-fixed' },
  }];
  const fixedProperty = property({ id: 'p-fixed', images: ['fixed.jpg'] });
  const { toResolve, toInsert } = runInsightEngine(
    { day: '2026-07-18', metrics: {} }, [], openInsights, '2026-07-18',
    [dataQualityDetector], { properties: [fixedProperty], now: NOW }
  );
  assert.deepEqual(toResolve, ['existing-insight']);
  assert.equal(toInsert.length, 0);
});
test('zScoreDetector-shaped default behavior is unaffected when extraContext is omitted', () => {
  // Confirms the additive extraContext parameter does not change behavior
  // for callers that never pass it (backward compatibility check).
  const { toInsert, toUpdate, toResolve } = runInsightEngine(
    { day: '2026-07-18', metrics: {} }, [], [], '2026-07-18'
  );
  assert.deepEqual(toInsert, []);
  assert.deepEqual(toUpdate, []);
  assert.deepEqual(toResolve, []);
});
