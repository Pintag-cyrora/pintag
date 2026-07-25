// Unit tests for the Trend Calculator. Run with `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTrend, computeAllTrends, dataConfidenceLabel } from './trend-calculator.js';

function snap(day, val) {
  return { day, metrics: { search: { total: val } } };
}
const extract = (m) => (m.search ? m.search.total : undefined);

test('computeTrend: exact today/yesterday/avg_7d/avg_30d values', () => {
  // 30 trailing entries total, oldest first: 29 days at 10, then yesterday
  // (the last/most recent trailing entry) at 20.
  const trailing = Array.from({ length: 29 }, (_, i) => snap(`day-${i}`, 10));
  trailing.push(snap('yesterday', 20));
  const today = snap('today', 15);

  const t = computeTrend(extract, today, trailing);
  assert.equal(t.today, 15);
  assert.equal(t.yesterday, 20);
  // avg_7d: last 7 of trailing = six 10s + one 20 = (60+20)/7 = 11.43
  assert.equal(t.avg_7d, Math.round((6 * 10 + 20) / 7 * 100) / 100);
  // avg_30d over all 30 trailing entries: (29*10 + 20)/30
  assert.equal(t.avg_30d, Math.round((29 * 10 + 20) / 30 * 100) / 100);
});

test('computeTrend: change_vs_yesterday/7d/30d are exact percentages', () => {
  const trailing = Array.from({ length: 30 }, () => snap('d', 10));
  const today = snap('today', 15); // +50% vs a flat baseline of 10
  const t = computeTrend(extract, today, trailing);
  assert.equal(t.change_vs_yesterday, 50);
  assert.equal(t.change_vs_7d, 50);
  assert.equal(t.change_vs_30d, 50);
});

test('computeTrend: today missing from the snapshot returns nulls, never a fabricated number', () => {
  const trailing = Array.from({ length: 30 }, () => snap('d', 10));
  const today = { day: 'today', metrics: {} }; // extract() returns undefined
  const t = computeTrend(extract, today, trailing);
  assert.equal(t.today, null);
  assert.equal(t.change_vs_yesterday, null);
  assert.equal(t.change_vs_7d, null);
  assert.equal(t.change_vs_30d, null);
});

test('computeTrend: no trailing history at all -> yesterday/avg_7d/avg_30d are null, not 0', () => {
  const today = snap('today', 42);
  const t = computeTrend(extract, today, []);
  assert.equal(t.today, 42);
  assert.equal(t.yesterday, null);
  assert.equal(t.avg_7d, null);
  assert.equal(t.avg_30d, null);
  assert.equal(t.change_vs_yesterday, null);
});

test('computeTrend: near-zero baseline suppresses the percentage instead of reporting a huge number (the "Searches up 1504%" failure mode)', () => {
  // 29 days at 1, one day (yesterday) at 1 -> avg_30d = 1, well under the
  // MIN_BASELINE_FOR_PCT floor of 3. today=54 must NOT produce +5300%.
  const trailing = Array.from({ length: 30 }, () => snap('d', 1));
  const today = snap('today', 54);
  const t = computeTrend(extract, today, trailing);
  assert.equal(t.today, 54);
  assert.equal(t.yesterday, 1);
  assert.equal(t.change_vs_yesterday, null, 'baseline of 1 is below the minimum-baseline floor');
  assert.equal(t.change_vs_30d, null, 'avg_30d of 1 is below the minimum-baseline floor');
});

test('computeTrend: a real, well-supported baseline DOES produce a percentage', () => {
  const trailing = Array.from({ length: 30 }, () => snap('d', 20));
  const today = snap('today', 5); // -75%, baseline of 20 is well above the floor
  const t = computeTrend(extract, today, trailing);
  assert.equal(t.change_vs_30d, -75);
});

test('computeAllTrends returns one entry per TRACKED_SCALAR_METRICS key', () => {
  const today = { day: 'today', metrics: { search: { total: 5, zero_result: 1 }, listing_ctr: 0.1, whatsapp_clicks: 2, leads_created: 1, gallery_events: 0, share_events: 0, favorite_events: 0, map_events: 0 } };
  const trailing = Array.from({ length: 30 }, () => today);
  const trends = computeAllTrends(today, trailing);
  assert.ok(trends['search.total']);
  assert.equal(trends['search.total'].label, 'total searches');
  assert.ok(trends['listing_ctr']);
  assert.ok(trends['whatsapp_clicks']);
});

// ── dataConfidenceLabel ──────────────────────────────────────────────────
test('dataConfidenceLabel: exact banding thresholds', () => {
  assert.equal(dataConfidenceLabel(0), 'low');
  assert.equal(dataConfidenceLabel(9), 'low');
  assert.equal(dataConfidenceLabel(10), 'moderate');
  assert.equal(dataConfidenceLabel(29), 'moderate');
  assert.equal(dataConfidenceLabel(30), 'high');
  assert.equal(dataConfidenceLabel(99), 'high');
  assert.equal(dataConfidenceLabel(100), 'very_high');
  assert.equal(dataConfidenceLabel(5000), 'very_high');
});
test('dataConfidenceLabel: non-numeric input defaults to low, never throws', () => {
  assert.equal(dataConfidenceLabel(undefined), 'low');
  assert.equal(dataConfidenceLabel(null), 'low');
  assert.equal(dataConfidenceLabel(NaN), 'low');
});
