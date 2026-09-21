// Unit tests for the Demand -> Supply -> Gap module — run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demandConfidenceBand, rankDemandSegments, classifySupplyStatus,
  buildDemandSupplyRows, bedroomBucketFor, buildBedroomDemandSupplyRows,
  BEDROOM_SAMPLE_FLOOR,
} from './demand-supply-gap.js';
import { MIN_SEARCH_SAMPLE, SUPPLY_DEFICIT_RATIO, segmentKey } from './demand-supply-detector.js';

function segment(overrides) {
  return {
    transaction_type: 'for_rent', property_type: 'apartment', district: 'Sisattanak',
    search_count: 20, avg_result_count: 3, zero_result_count: 1,
    impressions: 40, clicks: 8, whatsapp_clicks: 2, call_clicks: 0, leads_created: 1,
    top_bedroom_count: null, bedroom_sample_size: 0,
    ...overrides,
  };
}

// ── demandConfidenceBand ─────────────────────────────────────────────────
test('demandConfidenceBand: below MIN_SEARCH_SAMPLE is always LOW, regardless of the raw band', () => {
  assert.equal(demandConfidenceBand(MIN_SEARCH_SAMPLE - 1), 'LOW');
  assert.equal(demandConfidenceBand(0), 'LOW');
});
test('demandConfidenceBand: moderate sample -> MEDIUM, high/very_high -> HIGH', () => {
  assert.equal(demandConfidenceBand(15), 'MEDIUM'); // dataConfidenceLabel: <30 = moderate
  assert.equal(demandConfidenceBand(50), 'HIGH');    // <100 = high
  assert.equal(demandConfidenceBand(150), 'HIGH');   // 100+ = very_high
});

// ── rankDemandSegments ───────────────────────────────────────────────────
test('rankDemandSegments: orders by search_count desc, impressions as tiebreaker', () => {
  const segs = [
    segment({ district: 'A', search_count: 10, impressions: 5 }),
    segment({ district: 'B', search_count: 30, impressions: 1 }),
    segment({ district: 'C', search_count: 30, impressions: 50 }),
  ];
  const ranked = rankDemandSegments(segs);
  assert.deepEqual(ranked.map((s) => s.district), ['C', 'B', 'A']);
});
test('rankDemandSegments: annotates each segment with demand_confidence, never mutates the input array', () => {
  const segs = [segment({ search_count: 2 }), segment({ search_count: 150 })];
  const ranked = rankDemandSegments(segs);
  assert.equal(ranked.find((s) => s.search_count === 2).demand_confidence, 'LOW');
  assert.equal(ranked.find((s) => s.search_count === 150).demand_confidence, 'HIGH');
  assert.equal(segs[0].demand_confidence, undefined, 'original array must not be mutated');
});

// ── classifySupplyStatus (REQUIRED TEST 1-3) ────────────────────────────
test('REQUIRED 1: strong demand + low supply -> a gap classification (strong or potential), never "adequate"', () => {
  const seg = segment({ search_count: 40 }); // well above MIN_SEARCH_SAMPLE
  const status = classifySupplyStatus(seg, 2); // 2/40 = 0.05, far under SUPPLY_DEFICIT_RATIO/2
  assert.equal(status, 'gap_strong');
  const status2 = classifySupplyStatus(seg, 15); // 15/40 = 0.375, between the two thresholds
  assert.equal(status2, 'gap_potential');
});
test('REQUIRED 2: strong demand + adequate supply -> "adequate", no gap alert', () => {
  const seg = segment({ search_count: 40 });
  const status = classifySupplyStatus(seg, 40); // 1:1 ratio, comfortably >= SUPPLY_DEFICIT_RATIO
  assert.equal(status, 'adequate');
});
test('REQUIRED 3: sample size below MIN_SEARCH_SAMPLE -> "insufficient_data", regardless of supply', () => {
  const seg = segment({ search_count: MIN_SEARCH_SAMPLE - 1 });
  assert.equal(classifySupplyStatus(seg, 0), 'insufficient_data');
  assert.equal(classifySupplyStatus(seg, 100), 'insufficient_data');
});
test('classifySupplyStatus: supply unknown (null, e.g. not the most-recently-finalized day) -> "insufficient_data", never guessed', () => {
  const seg = segment({ search_count: 40 });
  assert.equal(classifySupplyStatus(seg, null), 'insufficient_data');
});
test('classifySupplyStatus: zero demand is "insufficient_data", not a false gap from a 0/0 ratio', () => {
  const seg = segment({ search_count: 0 });
  // search_count=0 is below MIN_SEARCH_SAMPLE, so the sample floor is checked
  // BEFORE the ratio math ever has a chance to divide by zero.
  assert.equal(classifySupplyStatus(seg, 0), 'insufficient_data');
});

// ── buildDemandSupplyRows ────────────────────────────────────────────────
test('buildDemandSupplyRows: produces one row per segment, ranked by demand, with real supply_count from active_inventory.available_by_segment', () => {
  const segs = [
    segment({ district: 'Chanthabouly', search_count: 30, impressions: 60 }),
    segment({ district: 'Saysettha', search_count: 12, impressions: 20 }),
  ];
  const bySegment = {
    [segmentKey(segs[0])]: 18, // 18/30 = 0.6, adequate
    [segmentKey(segs[1])]: 1,  // 1/12 = 0.083, strong gap
  };
  const rows = buildDemandSupplyRows(segs, bySegment);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].district, 'Chanthabouly'); // higher search_count ranks first
  assert.equal(rows[0].supply_count, 18);
  assert.equal(rows[0].status, 'adequate');
  assert.equal(rows[1].district, 'Saysettha');
  assert.equal(rows[1].supply_count, 1);
  assert.equal(rows[1].status, 'gap_strong');
});
test('buildDemandSupplyRows: a segment absent from the supply map reads as 0 matching listings, not null (the segment key genuinely has zero)', () => {
  const segs = [segment({ district: 'Xaythany', search_count: 15 })];
  const rows = buildDemandSupplyRows(segs, {}); // supply map present but has no entry for this segment
  assert.equal(rows[0].supply_count, 0);
  assert.equal(rows[0].status, 'gap_strong');
});
test('buildDemandSupplyRows: supply map itself absent (not the most-recently-finalized day) -> supply_count/status are null/insufficient_data for every row', () => {
  const segs = [segment({ search_count: 30 })];
  const rows = buildDemandSupplyRows(segs, null);
  assert.equal(rows[0].supply_count, null);
  assert.equal(rows[0].status, 'insufficient_data');
});

// ── bedroomBucketFor ─────────────────────────────────────────────────────
test('bedroomBucketFor: 0-3 are their own bucket, 4+ collapses, negative/non-numeric is null', () => {
  assert.equal(bedroomBucketFor(0), '0');
  assert.equal(bedroomBucketFor(2), '2');
  assert.equal(bedroomBucketFor(3), '3');
  assert.equal(bedroomBucketFor(4), '4+');
  assert.equal(bedroomBucketFor(9), '4+');
  assert.equal(bedroomBucketFor(-1), null);
  assert.equal(bedroomBucketFor(null), null);
  assert.equal(bedroomBucketFor(undefined), null);
});

// ── buildBedroomDemandSupplyRows (REQUIRED TESTS 6-7) ────────────────────
test('REQUIRED 6: bedroom demand combined with district produces one row per qualifying segment', () => {
  const segs = [
    segment({ district: 'Sisattanak', transaction_type: 'for_rent', top_bedroom_count: 2, bedroom_sample_size: 12 }),
  ];
  const rows = buildBedroomDemandSupplyRows(segs, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].district, 'Sisattanak');
  assert.equal(rows[0].bedroom_bucket, '2');
  assert.equal(rows[0].bedroom_sample_size, 12);
});
test('REQUIRED 7: bedroom demand combined with available supply -> real supply_count and a gap classification', () => {
  const segs = [
    segment({ district: 'Sisattanak', transaction_type: 'for_rent', top_bedroom_count: 2, bedroom_sample_size: 20 }),
  ];
  const byBedroomSupply = { 'for_rent|Sisattanak|2': 4 }; // 4/20 = 0.2, strong gap
  const rows = buildBedroomDemandSupplyRows(segs, byBedroomSupply);
  assert.equal(rows[0].supply_count, 4);
  assert.equal(rows[0].status, 'gap_strong');
});
test('buildBedroomDemandSupplyRows: below BEDROOM_SAMPLE_FLOOR (10) is omitted entirely, never reported with a fabricated confidence', () => {
  const segs = [
    segment({ top_bedroom_count: 2, bedroom_sample_size: BEDROOM_SAMPLE_FLOOR - 1 }),
  ];
  assert.deepEqual(buildBedroomDemandSupplyRows(segs, {}), []);
});
test('buildBedroomDemandSupplyRows: a segment with no bedroom plurality at all (top_bedroom_count null, "Any" won) is omitted, not reported as bucket "null"', () => {
  const segs = [segment({ top_bedroom_count: null, bedroom_sample_size: 50 })];
  assert.deepEqual(buildBedroomDemandSupplyRows(segs, {}), []);
});
test('buildBedroomDemandSupplyRows: a Studio (bedroom 0) plurality is reported, not treated as "no preference"', () => {
  const segs = [segment({ district: 'Chanthabouly', transaction_type: 'for_rent', top_bedroom_count: 0, bedroom_sample_size: 15 })];
  const rows = buildBedroomDemandSupplyRows(segs, { 'for_rent|Chanthabouly|0': 6 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bedroom_bucket, '0');
  assert.equal(rows[0].supply_count, 6);
});
test('buildBedroomDemandSupplyRows: sorted by bedroom_sample_size desc (strongest bedroom signal first)', () => {
  const segs = [
    segment({ district: 'A', top_bedroom_count: 1, bedroom_sample_size: 12 }),
    segment({ district: 'B', top_bedroom_count: 2, bedroom_sample_size: 40 }),
  ];
  const rows = buildBedroomDemandSupplyRows(segs, {});
  assert.deepEqual(rows.map((r) => r.district), ['B', 'A']);
});
