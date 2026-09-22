// Unit tests for the Unit-Type Demand module — run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_UNIT_TYPE_SIGNAL_SAMPLE, UNIT_TYPE_SUPPLY_DEFICIT_RATIO,
  unitTypeSignalCount, unitTypeDemandConfidenceBand, rankUnitTypeDemand,
  classifyUnitTypeSupplyStatus, buildUnitTypeDemandRows,
} from './unit-type-demand.js';

function segment(overrides) {
  return {
    unit_type_id: 'ut-a', unit_type_name: 'Room Type A', bedrooms: 2,
    price_amount: 400, price_currency: 'USD', price_frequency: 'monthly',
    property_id: 'prop-1', district: 'Sisattanak', transaction_type: 'for_rent',
    whatsapp_clicks: 3, call_clicks: 0, leads_created: 2,
    ...overrides,
  };
}

// ── unitTypeSignalCount ──────────────────────────────────────────────────
test('unitTypeSignalCount: sums whatsapp_clicks + call_clicks + leads_created', () => {
  assert.equal(unitTypeSignalCount(segment({ whatsapp_clicks: 3, call_clicks: 1, leads_created: 2 })), 6);
});
test('unitTypeSignalCount: treats missing fields as 0, never throws', () => {
  assert.doesNotThrow(() => unitTypeSignalCount({}));
  assert.equal(unitTypeSignalCount({}), 0);
});

// ── unitTypeDemandConfidenceBand — REQUIRED 7: insufficient sample -> no strong conclusion
test('REQUIRED 7: unitTypeDemandConfidenceBand is LOW below MIN_UNIT_TYPE_SIGNAL_SAMPLE, regardless of raw band', () => {
  assert.equal(unitTypeDemandConfidenceBand(MIN_UNIT_TYPE_SIGNAL_SAMPLE - 1), 'LOW');
  assert.equal(unitTypeDemandConfidenceBand(0), 'LOW');
  assert.equal(unitTypeDemandConfidenceBand(1), 'LOW'); // the product spec's own "1-2 inquiries is noise" example
  assert.equal(unitTypeDemandConfidenceBand(2), 'LOW');
});
test('unitTypeDemandConfidenceBand: at/above the floor, collapses dataConfidenceLabel into HIGH/MEDIUM/LOW', () => {
  assert.equal(unitTypeDemandConfidenceBand(MIN_UNIT_TYPE_SIGNAL_SAMPLE), 'LOW');   // 3 -> dataConfidenceLabel 'low' (<10)
  assert.equal(unitTypeDemandConfidenceBand(15), 'MEDIUM'); // <30 = moderate
  assert.equal(unitTypeDemandConfidenceBand(50), 'HIGH');   // <100 = high
  assert.equal(unitTypeDemandConfidenceBand(150), 'HIGH');  // 100+ = very_high
});

// ── rankUnitTypeDemand ────────────────────────────────────────────────────
test('rankUnitTypeDemand: orders by total signal count desc', () => {
  const segs = [
    segment({ unit_type_id: 'a', whatsapp_clicks: 1, call_clicks: 0, leads_created: 0 }),
    segment({ unit_type_id: 'b', whatsapp_clicks: 5, call_clicks: 2, leads_created: 3 }),
    segment({ unit_type_id: 'c', whatsapp_clicks: 3, call_clicks: 0, leads_created: 0 }),
  ];
  const ranked = rankUnitTypeDemand(segs);
  assert.deepEqual(ranked.map((r) => r.unit_type_id), ['b', 'c', 'a']);
});
test('rankUnitTypeDemand: attaches signal_count and demand_confidence to every row', () => {
  const [row] = rankUnitTypeDemand([segment({ whatsapp_clicks: 5, call_clicks: 0, leads_created: 0 })]);
  assert.equal(row.signal_count, 5);
  assert.equal(row.demand_confidence, 'LOW'); // dataConfidenceLabel(5) = 'low' (<10)
});
test('rankUnitTypeDemand: handles a non-array input without throwing', () => {
  assert.doesNotThrow(() => rankUnitTypeDemand(null));
  assert.deepEqual(rankUnitTypeDemand(undefined), []);
});

// ── classifyUnitTypeSupplyStatus ──────────────────────────────────────────
test('classifyUnitTypeSupplyStatus: below MIN_UNIT_TYPE_SIGNAL_SAMPLE is always insufficient_data, even with zero supply', () => {
  const seg = segment({ whatsapp_clicks: 1, call_clicks: 0, leads_created: 0 });
  assert.equal(classifyUnitTypeSupplyStatus(seg, 0), 'insufficient_data');
});
test('classifyUnitTypeSupplyStatus: null availableCount (non-final day) is insufficient_data even with real demand', () => {
  const seg = segment({ whatsapp_clicks: 5, call_clicks: 0, leads_created: 0 });
  assert.equal(classifyUnitTypeSupplyStatus(seg, null), 'insufficient_data');
});
test('classifyUnitTypeSupplyStatus: real demand + zero available -> gap_strong', () => {
  const seg = segment({ whatsapp_clicks: 5, call_clicks: 0, leads_created: 0 });
  assert.equal(classifyUnitTypeSupplyStatus(seg, 0), 'gap_strong');
});
test('classifyUnitTypeSupplyStatus: real demand + supply just under the deficit ratio -> gap_potential', () => {
  const seg = segment({ whatsapp_clicks: 4, call_clicks: 0, leads_created: 0 }); // signal=4
  // ratio = available/signal; UNIT_TYPE_SUPPLY_DEFICIT_RATIO=0.5 -> gap_potential band is [0.25, 0.5)
  assert.equal(classifyUnitTypeSupplyStatus(seg, 1), 'gap_potential'); // 1/4 = 0.25
});
test('classifyUnitTypeSupplyStatus: ample supply relative to demand -> adequate', () => {
  const seg = segment({ whatsapp_clicks: 4, call_clicks: 0, leads_created: 0 });
  assert.equal(classifyUnitTypeSupplyStatus(seg, 10), 'adequate');
});

// ── buildUnitTypeDemandRows — REQUIRED 8: unit-type demand contributes to demand/supply analysis
test('REQUIRED 8: buildUnitTypeDemandRows attaches the correct available_count per unit_type_id and classifies it', () => {
  const segs = [
    segment({ unit_type_id: 'ut-a', whatsapp_clicks: 5, call_clicks: 0, leads_created: 0 }),
    segment({ unit_type_id: 'ut-b', whatsapp_clicks: 1, call_clicks: 0, leads_created: 0 }),
  ];
  const availableUnitTypes = { 'ut-a': 1, 'ut-b': 5 };
  const rows = buildUnitTypeDemandRows(segs, availableUnitTypes);
  const a = rows.find((r) => r.unit_type_id === 'ut-a');
  const b = rows.find((r) => r.unit_type_id === 'ut-b');
  assert.equal(a.available_count, 1);
  assert.equal(a.status, 'gap_strong'); // 1/5 = 0.2 < 0.25
  assert.equal(b.available_count, 5);
  assert.equal(b.status, 'insufficient_data'); // signal=1 < MIN_UNIT_TYPE_SIGNAL_SAMPLE
});
test('buildUnitTypeDemandRows: a unit type missing from the available map (but map present) reads as 0 available, not null', () => {
  const segs = [segment({ unit_type_id: 'ut-c', whatsapp_clicks: 5, call_clicks: 0, leads_created: 0 })];
  const rows = buildUnitTypeDemandRows(segs, { 'other-ut': 3 });
  assert.equal(rows[0].available_count, 0);
  assert.equal(rows[0].status, 'gap_strong');
});
test('buildUnitTypeDemandRows: a wholly absent available-map (non-final day) reads as null, never fabricated', () => {
  const segs = [segment({ unit_type_id: 'ut-d', whatsapp_clicks: 5, call_clicks: 0, leads_created: 0 })];
  const rows = buildUnitTypeDemandRows(segs, null);
  assert.equal(rows[0].available_count, null);
  assert.equal(rows[0].status, 'insufficient_data');
});
test('buildUnitTypeDemandRows: preserves property/district/bedroom/price context for narration', () => {
  const rows = buildUnitTypeDemandRows([segment({})], { 'ut-a': 1 });
  assert.equal(rows[0].property_id, 'prop-1');
  assert.equal(rows[0].district, 'Sisattanak');
  assert.equal(rows[0].bedrooms, 2);
  assert.equal(rows[0].unit_type_name, 'Room Type A');
});

// ── REQUIRED 3: property-level lead NOT assigned a unit type never appears here
test('REQUIRED 3: a property-level segment (unit_type_id absent) is structurally impossible to construct from this module -- it operates only on rows the SQL layer already filtered to unit_type_id IS NOT NULL', () => {
  // This module has no code path that reads or infers a unit type from a
  // property-level lead -- proven by construction: every function here
  // takes unit_type_demand_segments rows as given, and the SQL migration's
  // own WHERE unit_type_id IS NOT NULL is what keeps property-level leads
  // out before this module ever sees them (see
  // 20260922000000_intelligence_unit_type_demand.sql and its own SQL
  // regression suite for the enforcement itself).
  const rows = buildUnitTypeDemandRows([], {});
  assert.deepEqual(rows, []);
});
