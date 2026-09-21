// Unit tests for Inventory Acquisition Intelligence — run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demandPersistence, hasConversionProblem, classifyOpportunity, buildInventoryOpportunities,
} from './inventory-opportunity.js';
import { segmentKey, metricKeyFor } from './demand-supply-detector.js';

function segment(overrides) {
  return {
    transaction_type: 'for_rent', property_type: 'apartment', district: 'Sisattanak',
    search_count: 40, avg_result_count: 3, zero_result_count: 1,
    impressions: 80, clicks: 8, whatsapp_clicks: 2, call_clicks: 0, leads_created: 1,
    top_bedroom_count: null, bedroom_sample_size: 0, top_price_band: null,
    ...overrides,
  };
}
function composedWith({ newOnes = [], continuingOnes = [], resolvedOnes = [] } = {}) {
  return { new_insights: newOnes, continuing_insights: continuingOnes, resolved_insights: resolvedOnes };
}
function insightFor(seg, overrides) {
  return { id: 'i-1', type: 'supply_shortage', metric_key: metricKeyFor(seg), ...overrides };
}

// ── demandPersistence ────────────────────────────────────────────────────
test('demandPersistence: emerging when the matching insight is in new_insights', () => {
  const seg = segment({});
  const composed = composedWith({ newOnes: [insightFor(seg)] });
  assert.equal(demandPersistence(metricKeyFor(seg), composed), 'emerging');
});
test('demandPersistence: persistent when the matching insight is in continuing_insights', () => {
  const seg = segment({});
  const composed = composedWith({ continuingOnes: [insightFor(seg)] });
  assert.equal(demandPersistence(metricKeyFor(seg), composed), 'persistent');
});
test('demandPersistence: resolved when the matching insight is in resolved_insights', () => {
  const seg = segment({});
  const composed = composedWith({ resolvedOnes: [insightFor(seg)] });
  assert.equal(demandPersistence(metricKeyFor(seg), composed), 'resolved');
});
test('demandPersistence: unknown when no insight matches, and never throws on a missing/malformed composed object', () => {
  assert.equal(demandPersistence('unmet_demand.for_rent|apartment|Sisattanak', composedWith()), 'unknown');
  assert.equal(demandPersistence('unmet_demand.for_rent|apartment|Sisattanak', undefined), 'unknown');
  assert.equal(demandPersistence('unmet_demand.for_rent|apartment|Sisattanak', {}), 'unknown');
});

// ── hasConversionProblem ─────────────────────────────────────────────────
test('hasConversionProblem: true only with enough impressions (>=10) AND zero leads', () => {
  assert.equal(hasConversionProblem(segment({ impressions: 50, leads_created: 0 })), true);
  assert.equal(hasConversionProblem(segment({ impressions: 50, leads_created: 3 })), false);
});
test('hasConversionProblem: false when impressions are too low to judge at all, regardless of leads', () => {
  assert.equal(hasConversionProblem(segment({ impressions: 6, leads_created: 0 })), false);
  assert.equal(hasConversionProblem(segment({ impressions: null, leads_created: 0 })), false);
});

// ── classifyOpportunity (documented tier thresholds) ─────────────────────
test('classifyOpportunity: insufficient_data whenever supply status is insufficient_data', () => {
  assert.equal(classifyOpportunity(segment({ demand_confidence: 'HIGH' }), 'insufficient_data', 'persistent'), 'insufficient_data');
});
test('classifyOpportunity: insufficient_data whenever demand_confidence is LOW, even if the ratio itself reads as a gap', () => {
  assert.equal(classifyOpportunity(segment({ demand_confidence: 'LOW' }), 'gap_strong', 'persistent'), 'insufficient_data');
});
test('classifyOpportunity: adequate supply + no conversion problem -> null (nothing to report)', () => {
  const seg = segment({ demand_confidence: 'HIGH', impressions: 80, leads_created: 5 });
  assert.equal(classifyOpportunity(seg, 'adequate', 'persistent'), null);
});
test('classifyOpportunity: adequate supply + a real conversion problem -> optimize, never an acquisition tier', () => {
  const seg = segment({ demand_confidence: 'HIGH', impressions: 80, leads_created: 0 });
  assert.equal(classifyOpportunity(seg, 'adequate', 'persistent'), 'optimize');
});
test('classifyOpportunity: acquire_high requires ALL THREE of gap_strong + HIGH confidence + persistent', () => {
  const seg = segment({ demand_confidence: 'HIGH' });
  assert.equal(classifyOpportunity(seg, 'gap_strong', 'persistent'), 'acquire_high');
  assert.equal(classifyOpportunity(seg, 'gap_strong', 'emerging'), 'acquire_potential', 'a one-day-old gap must not reach the top tier');
  assert.equal(classifyOpportunity({ ...seg, demand_confidence: 'MEDIUM' }, 'gap_strong', 'persistent'), 'acquire_potential', 'MEDIUM confidence alone must not reach the top tier');
  assert.equal(classifyOpportunity(seg, 'gap_potential', 'persistent'), 'acquire_potential', 'gap_potential (not gap_strong) must not reach the top tier');
});

// ── buildInventoryOpportunities — REQUIRED integration tests ─────────────

// REQUIRED 1: strong demand + low supply -> acquisition opportunity
test('REQUIRED 1: strong, persistent demand + low supply -> acquire_high', () => {
  const seg = segment({ search_count: 40, impressions: 80 });
  const composed = composedWith({ continuingOnes: [insightFor(seg)] });
  const bySegment = { [segmentKey(seg)]: 2 }; // 2/40 = 0.05 -> gap_strong
  const rows = buildInventoryOpportunities([seg], bySegment, composed);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, 'acquire_high');
  assert.equal(rows[0].supply_status, 'gap_strong');
  assert.equal(rows[0].demand_trend, 'persistent');
});

// REQUIRED 2: strong demand + adequate supply -> no acquisition recommendation
test('REQUIRED 2: strong demand + adequate supply (and healthy conversion) -> no row at all', () => {
  const seg = segment({ search_count: 40, impressions: 80, leads_created: 5 });
  const bySegment = { [segmentKey(seg)]: 38 }; // 38/40 = 0.95 -> adequate
  const rows = buildInventoryOpportunities([seg], bySegment, composedWith());
  assert.equal(rows.length, 0);
});

// REQUIRED 3: existing supply + poor conversion -> optimization, not acquisition
test('REQUIRED 3: adequate supply + zero leads despite real exposure -> optimize, never an acquisition tier', () => {
  const seg = segment({ search_count: 40, impressions: 60, leads_created: 0 });
  const bySegment = { [segmentKey(seg)]: 40 }; // adequate
  const rows = buildInventoryOpportunities([seg], bySegment, composedWith());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, 'optimize');
  assert.notEqual(rows[0].classification, 'acquire_high');
  assert.notEqual(rows[0].classification, 'acquire_potential');
});

// REQUIRED 4: low sample size -> insufficient data
test('REQUIRED 4: low sample size (below MIN_SEARCH_SAMPLE) -> insufficient_data regardless of how the raw ratio looks', () => {
  const seg = segment({ search_count: 3 });
  const bySegment = { [segmentKey(seg)]: 0 };
  const rows = buildInventoryOpportunities([seg], bySegment, composedWith());
  assert.equal(rows[0].classification, 'insufficient_data');
});

// REQUIRED 5: bedroom + district demand -> specific acquisition target
test('REQUIRED 5: a qualifying bedroom plurality attaches a concrete bedroom_count target', () => {
  const seg = segment({
    search_count: 40, impressions: 80, district: 'Sisattanak', transaction_type: 'for_rent',
    top_bedroom_count: 2, bedroom_sample_size: 20,
  });
  const composed = composedWith({ continuingOnes: [insightFor(seg)] });
  const bySegment = { [segmentKey(seg)]: 2 };
  const rows = buildInventoryOpportunities([seg], bySegment, composed);
  assert.equal(rows[0].bedroom_count, 2);
  assert.equal(rows[0].district, 'Sisattanak');
});
test('a bedroom plurality below the sample floor (10) never attaches a bedroom_count target', () => {
  const seg = segment({ search_count: 40, impressions: 80, top_bedroom_count: 2, bedroom_sample_size: 9 });
  const rows = buildInventoryOpportunities([seg], { [segmentKey(seg)]: 2 }, composedWith());
  assert.equal(rows[0].bedroom_count, null);
});

// REQUIRED 6: price compatibility (top_price_band passed through, never invented)
test('REQUIRED 6: top_price_band is carried through verbatim when present, and stays null when absent -- never fabricated', () => {
  const withBand = segment({ search_count: 40, impressions: 80, top_price_band: { min: 500, max: 800 } });
  const withoutBand = segment({ search_count: 40, impressions: 80, district: 'Saysettha', top_price_band: null });
  const rows = buildInventoryOpportunities(
    [withBand, withoutBand],
    { [segmentKey(withBand)]: 2, [segmentKey(withoutBand)]: 2 },
    composedWith()
  );
  const bandRow = rows.find((r) => r.district === 'Sisattanak');
  const noBandRow = rows.find((r) => r.district === 'Saysettha');
  assert.deepEqual(bandRow.top_price_band, { min: 500, max: 800 });
  assert.equal(noBandRow.top_price_band, null);
});

// REQUIRED 7: rental vs sale separation
test('REQUIRED 7: identical district/property_type but different transaction_type produce two independent rows', () => {
  const rental = segment({ transaction_type: 'for_rent', search_count: 40, impressions: 80 });
  const sale = segment({ transaction_type: 'for_sale', search_count: 40, impressions: 80 });
  const bySegment = { [segmentKey(rental)]: 2, [segmentKey(sale)]: 38 }; // rental: gap, sale: adequate
  const rows = buildInventoryOpportunities([rental, sale], bySegment, composedWith());
  const rentalRow = rows.find((r) => r.transaction_type === 'for_rent');
  const saleRow = rows.find((r) => r.transaction_type === 'for_sale');
  assert.ok(rentalRow, 'the rental segment must produce its own row');
  assert.equal(rentalRow.supply_status, 'gap_strong');
  assert.ok(!saleRow, 'the sale segment is adequately supplied with healthy conversion -- no row');
});

// REQUIRED 8: emerging vs persistent demand
test('REQUIRED 8: the SAME strong gap is acquire_potential when emerging (day 1) and acquire_high once persistent', () => {
  const seg = segment({ search_count: 40, impressions: 80 });
  const bySegment = { [segmentKey(seg)]: 2 };
  const emergingRows = buildInventoryOpportunities([seg], bySegment, composedWith({ newOnes: [insightFor(seg)] }));
  const persistentRows = buildInventoryOpportunities([seg], bySegment, composedWith({ continuingOnes: [insightFor(seg)] }));
  assert.equal(emergingRows[0].classification, 'acquire_potential');
  assert.equal(emergingRows[0].demand_trend, 'emerging');
  assert.equal(persistentRows[0].classification, 'acquire_high');
  assert.equal(persistentRows[0].demand_trend, 'persistent');
});

// REQUIRED 9: a tracking/data-quality anomaly (here: an implausibly tiny
// sample masquerading as a dramatic 0-supply gap) cannot create an
// acquisition opportunity -- the existing sample-size guard is the
// mechanism, exercised directly against the most extreme case.
test('REQUIRED 9: an implausibly small sample with "0 supply" cannot read as an acquisition opportunity', () => {
  const seg = segment({ search_count: 2 }); // below MIN_SEARCH_SAMPLE=5
  const rows = buildInventoryOpportunities([seg], { [segmentKey(seg)]: 0 }, composedWith());
  assert.equal(rows[0].classification, 'insufficient_data');
  assert.notEqual(rows[0].classification, 'acquire_high');
});

// REQUIRED 10: missing supply data -> insufficient evidence
test('REQUIRED 10: supply map entirely absent (not the most-recently-finalized day) -> insufficient_data, never a guessed gap', () => {
  const seg = segment({ search_count: 40, impressions: 80 });
  const rows = buildInventoryOpportunities([seg], null, composedWith());
  assert.equal(rows[0].classification, 'insufficient_data');
  assert.equal(rows[0].supply_count, null);
});

// REQUIRED 11: deterministic output
test('REQUIRED 11: identical input always produces identical output (no hidden randomness or wall-clock dependency)', () => {
  const segs = [
    segment({ search_count: 40, impressions: 80, district: 'Sisattanak' }),
    segment({ search_count: 12, impressions: 20, district: 'Saysettha', transaction_type: 'for_sale' }),
  ];
  const bySegment = { [segmentKey(segs[0])]: 2, [segmentKey(segs[1])]: 1 };
  const composed = composedWith({ continuingOnes: [insightFor(segs[0])] });
  const first = buildInventoryOpportunities(segs, bySegment, composed);
  const second = buildInventoryOpportunities(segs, bySegment, composed);
  assert.deepEqual(first, second);
});

// REQUIRED 12: existing report remains backward compatible
test('REQUIRED 12: old-shaped segments (no top_bedroom_count/bedroom_sample_size keys at all) and a missing composed object never throw', () => {
  const oldSeg = { transaction_type: 'for_rent', property_type: 'condo', district: 'Chanthabouly', search_count: 40, impressions: 80 };
  assert.doesNotThrow(() => buildInventoryOpportunities([oldSeg], { [segmentKey(oldSeg)]: 2 }, undefined));
  const rows = buildInventoryOpportunities([oldSeg], { [segmentKey(oldSeg)]: 2 }, undefined);
  assert.equal(rows[0].bedroom_count, null);
  assert.equal(rows[0].demand_trend, 'unknown');
});
test('REQUIRED 12: an empty segments array produces an empty result, no throw', () => {
  assert.deepEqual(buildInventoryOpportunities([], {}, composedWith()), []);
  assert.deepEqual(buildInventoryOpportunities(undefined, {}, composedWith()), []);
});
