// Unit tests for the Demand/Supply detector — run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demandSupplyDetector, segmentKey, metricKeyFor, parseMetricKey,
  MIN_SEARCH_SAMPLE, SUPPLY_DEFICIT_RATIO, HIGH_ZERO_RESULT_RATE,
} from './demand-supply-detector.js';
import { runInsightEngine } from './insight-engine.js';

function segment(overrides) {
  return {
    transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak',
    search_count: 10, avg_result_count: 2, zero_result_count: 1,
    top_price_band: { min: 500, max: 800 },
    impressions: 20, clicks: 4, whatsapp_clicks: 1, call_clicks: 0, leads_created: 1,
    ...overrides,
  };
}
// Builds the { todaySnapshot: { day, metrics } } shape detect()/reevaluate()
// actually read off `context` (see the Detector contract: context is
// { todaySnapshot, trailingSnapshots, ...extraContext }).
function snapshotWith(segments, bySegment) {
  return { todaySnapshot: { day: '2026-07-18', metrics: {
    customer_intent_segments: segments,
    active_inventory: bySegment ? { by_segment: bySegment } : undefined,
  } } };
}

// ── Pure helpers ──────────────────────────────────────────────────────────
test('segmentKey / metricKeyFor / parseMetricKey round-trip', () => {
  const seg = segment({});
  const key = segmentKey(seg);
  assert.equal(key, 'for_rent|condo|Sisattanak');
  const mk = metricKeyFor(seg);
  assert.equal(mk, 'unmet_demand.for_rent|condo|Sisattanak');
  assert.deepEqual(parseMetricKey(mk), { transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak' });
});
test('parseMetricKey returns null for a metric_key this detector does not own', () => {
  assert.equal(parseMetricKey('active_inventory.total'), null);
  assert.equal(parseMetricKey(undefined), null);
});

// ── demandSupplyDetector.detect ────────────────────────────────────────────
test('detect flags a segment whose supply is well below its search count', () => {
  const seg = segment({ search_count: 10 });
  const context = snapshotWith([seg], { [segmentKey(seg)]: 2 }); // 2 < 10 * 0.5
  const findings = demandSupplyDetector.detect(context);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'supply_shortage');
  assert.equal(findings[0].metricKey, metricKeyFor(seg));
  assert.equal(findings[0].dimensionDistrict, 'Sisattanak');
  assert.equal(findings[0].dimensionPropertyType, 'condo');
  assert.ok(findings[0].evidence.reasons.includes('supply_deficit'));
});
test('detect does NOT flag a segment with adequate supply and a normal zero-result rate', () => {
  const seg = segment({ search_count: 10, zero_result_count: 1 }); // 10% zero-result, under the 30% bar
  const context = snapshotWith([seg], { [segmentKey(seg)]: 8 }); // 8 >= 10 * 0.5 -- not a deficit
  assert.deepEqual(demandSupplyDetector.detect(context), []);
});
test('detect flags a high zero-result rate even when raw supply count looks adequate', () => {
  const seg = segment({ search_count: 10, zero_result_count: 4 }); // 40% zero-result >= 30% bar
  const context = snapshotWith([seg], { [segmentKey(seg)]: 20 }); // plenty of raw supply
  const findings = demandSupplyDetector.detect(context);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].evidence.reasons.includes('high_zero_result_rate'));
  assert.ok(!findings[0].evidence.reasons.includes('supply_deficit'));
});
test('detect ignores a segment below the minimum search sample, regardless of supply', () => {
  const seg = segment({ search_count: MIN_SEARCH_SAMPLE - 1, zero_result_count: MIN_SEARCH_SAMPLE - 1 });
  const context = snapshotWith([seg], { [segmentKey(seg)]: 0 });
  assert.deepEqual(demandSupplyDetector.detect(context), []);
});
test('detect treats missing supply data as "supply unknown", not zero -- only the zero-result-rate trigger can fire', () => {
  const lowZero = segment({ search_count: 10, zero_result_count: 1 });
  const highZero = segment({ search_count: 10, zero_result_count: 5, district: 'Chanthabouly' });
  const context = snapshotWith([lowZero, highZero]); // no bySegment at all -- active_inventory.by_segment undefined
  const findings = demandSupplyDetector.detect(context);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].dimensionDistrict, 'Chanthabouly');
  assert.equal(findings[0].evidence.supply_count, null);
});
test('detect returns nothing when there are no segments at all (quiet day)', () => {
  assert.deepEqual(demandSupplyDetector.detect(snapshotWith([])), []);
  assert.deepEqual(demandSupplyDetector.detect({ todaySnapshot: { metrics: {} } }), []);
});
test('severity is high when both reasons fire, or on real volume, else medium', () => {
  const bothReasons = segment({ search_count: 10, zero_result_count: 5 }); // high_zero_result_rate + supply_deficit
  const bothCtx = snapshotWith([bothReasons], { [segmentKey(bothReasons)]: 1 });
  assert.equal(demandSupplyDetector.detect(bothCtx)[0].severity, 'high');

  const bigVolume = segment({ search_count: 25, zero_result_count: 2, district: 'Xaythany' }); // one reason, but big volume
  const bigCtx = snapshotWith([bigVolume], { [segmentKey(bigVolume)]: 5 });
  assert.equal(demandSupplyDetector.detect(bigCtx)[0].severity, 'high');

  const smallOneReason = segment({ search_count: 6, zero_result_count: 0, district: 'Saysettha' });
  const smallCtx = snapshotWith([smallOneReason], { [segmentKey(smallOneReason)]: 1 });
  assert.equal(demandSupplyDetector.detect(smallCtx)[0].severity, 'medium');
});

// ── demandSupplyDetector.reevaluate ────────────────────────────────────────
test('reevaluate returns null for a non-supply_shortage insight or an unparseable key (not mine)', () => {
  assert.equal(demandSupplyDetector.reevaluate({ type: 'demand_spike', metric_key: 'search.total' }, {}), null);
  assert.equal(demandSupplyDetector.reevaluate({ type: 'supply_shortage', metric_key: 'active_inventory.total' }, {}), null);
});
test('reevaluate resolves when the segment had no searches at all today', () => {
  const context = snapshotWith([]);
  const result = demandSupplyDetector.reevaluate(
    { type: 'supply_shortage', metric_key: 'unmet_demand.for_rent|condo|Sisattanak' }, context
  );
  assert.deepEqual(result, { stillSignificant: false });
});
test('reevaluate re-checks the same rule against today\'s data for that segment', () => {
  const recovered = segment({ search_count: 10, zero_result_count: 0 });
  const recoveredCtx = snapshotWith([recovered], { [segmentKey(recovered)]: 20 }); // now well-supplied
  const stillBad = segment({ search_count: 10, zero_result_count: 5 });
  const stillBadCtx = snapshotWith([stillBad], { [segmentKey(stillBad)]: 1 });

  assert.equal(demandSupplyDetector.reevaluate(
    { type: 'supply_shortage', metric_key: metricKeyFor(recovered) }, recoveredCtx
  ).stillSignificant, false);
  assert.equal(demandSupplyDetector.reevaluate(
    { type: 'supply_shortage', metric_key: metricKeyFor(stillBad) }, stillBadCtx
  ).stillSignificant, true);
});

// ── Integration with the shared runInsightEngine lifecycle loop ───────────
test('runInsightEngine wires demandSupplyDetector via context.todaySnapshot with zero changes to the lifecycle loop', () => {
  const seg = segment({ search_count: 12 });
  const { todaySnapshot } = snapshotWith([seg], { [segmentKey(seg)]: 1 });
  const { toInsert } = runInsightEngine(todaySnapshot, [], [], '2026-07-18', [demandSupplyDetector], {});
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].type, 'supply_shortage');
  assert.equal(toInsert[0].metric_key, metricKeyFor(seg));
});
