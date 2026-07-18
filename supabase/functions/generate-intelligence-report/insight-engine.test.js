// Unit tests for the Insight Engine — run with `node --test` (no build step,
// no dependencies; Node 22's automatic ESM-syntax detection loads this file
// and insight-engine.js directly). See docs/intelligence/DETECTOR_ARCHITECTURE.md
// for what each of these functions is responsible for.
//
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, stddev, detectSignificance, isStillSignificant, classifyTrend,
  confidenceFromZ, severityFromZ, priorityScore, insightKey,
  zScoreDetector, runInsightEngine,
} from './insight-engine.js';

// ── Pure statistics ─────────────────────────────────────────────────────
test('mean of an empty array is 0', () => {
  assert.equal(mean([]), 0);
});
test('mean computes the arithmetic average', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
});
test('stddev of fewer than 2 values is 0', () => {
  assert.equal(stddev([5]), 0);
  assert.equal(stddev([]), 0);
});
test('stddev computes sample standard deviation', () => {
  // [2,4,4,4,5,5,7,9], known sample stddev = 2.13809...
  const series = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.ok(Math.abs(stddev(series) - 2.13809) < 0.001);
});

// ── detectSignificance ───────────────────────────────────────────────────
test('detectSignificance flags a value far from the trailing mean', () => {
  const trailing = Array(30).fill(10); // mean=10, stddev=0... need variance
  const withNoise = trailing.map((v, i) => v + (i % 2 === 0 ? 1 : -1)); // mean=10, some spread
  const sig = detectSignificance(40, withNoise);
  assert.ok(sig, 'expected a significant result for a huge outlier');
  assert.equal(sig.direction, 'up');
  assert.ok(sig.z > 1.5);
});
test('detectSignificance returns null when today value is not a number', () => {
  assert.equal(detectSignificance(undefined, Array(10).fill(5)), null);
  assert.equal(detectSignificance(NaN, Array(10).fill(5)), null);
  assert.equal(detectSignificance(null, Array(10).fill(5)), null);
});
test('detectSignificance returns null below the minimum sample floor', () => {
  // Only 3 genuinely-measured trailing values — below the default minSample=7.
  const sig = detectSignificance(100, [5, 5, 5]);
  assert.equal(sig, null);
});
test('detectSignificance ignores undefined entries when counting the sample', () => {
  // 10 real values + 20 undefined (schema-drift gaps) — only the 10 count.
  const series = Array(10).fill(5).concat(Array(20).fill(undefined));
  const sig = detectSignificance(5, series); // no deviation, but sample is enough
  assert.equal(sig, null); // stddev is 0 here (no variance) -> null, not a crash
});
test('detectSignificance suppresses a near-zero-base "spike" (minMean floor)', () => {
  // Trailing mean is 1 (below default minMean=3) — a jump to 3 must not be flagged.
  const series = Array(10).fill(1);
  const sig = detectSignificance(3, series);
  assert.equal(sig, null);
});
test('detectSignificance direction reflects the sign of z', () => {
  const series = [10, 12, 8, 11, 9, 10, 12, 8];
  const up = detectSignificance(50, series);
  const down = detectSignificance(-30, series);
  assert.equal(up.direction, 'up');
  assert.equal(down.direction, 'down');
});

// ── isStillSignificant (hysteresis) ─────────────────────────────────────
test('isStillSignificant returns null when today value is unreadable', () => {
  assert.equal(isStillSignificant(undefined, [1, 2, 3, 4, 5]), null);
});
test('isStillSignificant returns null with zero genuinely-measured trailing data', () => {
  assert.equal(isStillSignificant(10, [undefined, undefined]), null);
});
test('isStillSignificant uses a lower bar than detectSignificance (hysteresis)', () => {
  const series = [10, 12, 8, 11, 9, 10, 12, 8, 9, 11];
  // A z just above 1.0 (the resolve bar) but below 1.5 (the open bar) should
  // still read as "still significant" -- this is the whole point of hysteresis.
  const mu = mean(series);
  const sd = stddev(series);
  const borderlineValue = mu + sd * 1.2;
  assert.equal(isStillSignificant(borderlineValue, series), true);
  assert.equal(detectSignificance(borderlineValue, series), null); // wouldn't OPEN at this z
});
test('isStillSignificant returns false once truly back to normal', () => {
  const series = [10, 12, 8, 11, 9, 10, 12, 8, 9, 11];
  assert.equal(isStillSignificant(mean(series), series), false);
});

// ── classifyTrend ─────────────────────────────────────────────────────────
test('classifyTrend: no previous magnitude -> emerging', () => {
  assert.equal(classifyTrend(null, 3), 'emerging');
  assert.equal(classifyTrend(undefined, 3), 'emerging');
});
test('classifyTrend: previous is zero -> strengthening if now nonzero, else stable', () => {
  assert.equal(classifyTrend(0, 2), 'strengthening');
  assert.equal(classifyTrend(0, 0), 'stable');
});
test('classifyTrend: >15% relative increase -> strengthening', () => {
  assert.equal(classifyTrend(2, 3), 'strengthening');
});
test('classifyTrend: >15% relative decrease -> weakening', () => {
  assert.equal(classifyTrend(3, 2), 'weakening');
});
test('classifyTrend: within the 15% deadband -> stable', () => {
  assert.equal(classifyTrend(2, 2.1), 'stable');
});

// ── confidenceFromZ / severityFromZ ──────────────────────────────────────
test('confidenceFromZ is 0 at z=1.0 and rises with |z|', () => {
  assert.equal(confidenceFromZ(1.0), 0);
  assert.ok(confidenceFromZ(1.5) > 0, 'the open threshold itself should already read as nonzero confidence');
  assert.ok(confidenceFromZ(2.5) > confidenceFromZ(1.5));
  assert.equal(confidenceFromZ(4), 1);
  assert.equal(confidenceFromZ(10), 1); // clamped
});
test('severityFromZ thresholds match the documented cutoffs', () => {
  assert.equal(severityFromZ(1.4), 'low');
  assert.equal(severityFromZ(1.5), 'medium');
  assert.equal(severityFromZ(2.5), 'high');
  assert.equal(severityFromZ(3.5), 'critical');
  assert.equal(severityFromZ(-4), 'critical'); // magnitude, not sign
});

// ── priorityScore ─────────────────────────────────────────────────────────
test('priorityScore weights severity, confidence, and trend recency', () => {
  const base = { severity: 'medium', confidence: 0.5, trend: 'stable' };
  const emerging = { ...base, trend: 'emerging' };
  const weakening = { ...base, trend: 'weakening' };
  assert.ok(priorityScore(emerging) > priorityScore(base));
  assert.ok(priorityScore(weakening) < priorityScore(base));
});

// ── insightKey ────────────────────────────────────────────────────────────
test('insightKey builds a stable, dimension-order-independent key', () => {
  const k1 = insightKey('demand_spike', 'search.by_district', { district: 'Sisattanak' });
  const k2 = insightKey('demand_spike', 'search.by_district', { district: 'Sisattanak', propertyType: undefined });
  assert.equal(k1, k2);
});
test('insightKey treats missing dimensions as empty string, not "undefined"', () => {
  const k = insightKey('search_trend', 'search.total', {});
  assert.equal(k, 'search_trend|search.total|||');
});

// ── zScoreDetector.detect ─────────────────────────────────────────────────
function daySnapshot(day, metrics) { return { day, metrics }; }

test('zScoreDetector.detect finds a scalar significant metric', () => {
  const trailing = Array.from({ length: 10 }, (_, i) => daySnapshot(`2026-06-${i + 1}`, { whatsapp_clicks: 5 + (i % 2) }));
  const today = daySnapshot('2026-07-01', { whatsapp_clicks: 40 });
  const findings = zScoreDetector.detect({ todaySnapshot: today, trailingSnapshots: trailing });
  const wa = findings.find((f) => f.metricKey === 'whatsapp_clicks');
  assert.ok(wa, 'expected a whatsapp_clicks finding');
  assert.equal(wa.type, 'conversion_anomaly');
  assert.equal(wa.dimensionDistrict, null);
});
test('zScoreDetector.detect finds a breakdown significant metric with a dimension', () => {
  const trailing = Array.from({ length: 10 }, (_, i) =>
    daySnapshot(`2026-06-${i + 1}`, { views_by_district: { Sisattanak: 5 + (i % 2), Saysettha: 5 } }));
  const today = daySnapshot('2026-07-01', { views_by_district: { Sisattanak: 50, Saysettha: 5 } });
  const findings = zScoreDetector.detect({ todaySnapshot: today, trailingSnapshots: trailing });
  const hit = findings.find((f) => f.dimensionDistrict === 'Sisattanak');
  assert.ok(hit, 'expected a Sisattanak demand_spike finding');
  assert.equal(hit.type, 'demand_spike');
  const noHit = findings.find((f) => f.dimensionDistrict === 'Saysettha');
  assert.equal(noHit, undefined, 'Saysettha had no deviation and should not fire');
});
test('zScoreDetector.detect treats a schema-drift-missing breakdown dict as undefined, not zeros', () => {
  // trailing days never had `views_by_district` at all (the key vanished) --
  // must not be read as "every district had 0 views every day" (which would
  // make today's real numbers look like a false spike).
  const trailing = Array.from({ length: 10 }, (_, i) => daySnapshot(`2026-06-${i + 1}`, {}));
  const today = daySnapshot('2026-07-01', { views_by_district: { Sisattanak: 50 } });
  const findings = zScoreDetector.detect({ todaySnapshot: today, trailingSnapshots: trailing });
  const hit = findings.find((f) => f.dimensionDistrict === 'Sisattanak');
  assert.equal(hit, undefined, 'insufficient genuine sample -- must not fabricate a finding from absent history');
});
test('zScoreDetector.detect returns nothing on a genuinely quiet day', () => {
  const trailing = Array.from({ length: 10 }, (_, i) => daySnapshot(`2026-06-${i + 1}`, { whatsapp_clicks: 10 }));
  const today = daySnapshot('2026-07-01', { whatsapp_clicks: 10 });
  const findings = zScoreDetector.detect({ todaySnapshot: today, trailingSnapshots: trailing });
  assert.equal(findings.length, 0);
});

// A trailing series with real variance (not a flat constant — stddev=0
// series are correctly refused by detectSignificance/isStillSignificant,
// since there's no baseline spread to judge a deviation against).
const VARIED_10 = [10, 12, 8, 11, 9, 10, 12, 8, 9, 11];
function variedTrailing(metricKey) {
  return VARIED_10.map((v, i) => daySnapshot(`2026-06-${i + 1}`, { [metricKey]: v }));
}
function variedBreakdownTrailing(metricKey, dimKey) {
  return VARIED_10.map((v, i) => daySnapshot(`2026-06-${i + 1}`, { [metricKey]: { [dimKey]: v } }));
}

// ── zScoreDetector.reevaluate ─────────────────────────────────────────────
test('zScoreDetector.reevaluate returns null for an unrecognized metric_key (orphaned)', () => {
  const result = zScoreDetector.reevaluate(
    { metric_key: 'no_such_metric_anymore' },
    { todaySnapshot: daySnapshot('2026-07-01', {}), trailingSnapshots: [] }
  );
  assert.equal(result, null);
});
test('zScoreDetector.reevaluate resolves a scalar metric using isStillSignificant', () => {
  const trailing = variedTrailing('whatsapp_clicks');
  const insight = { metric_key: 'whatsapp_clicks' };
  const result = zScoreDetector.reevaluate(insight, {
    todaySnapshot: daySnapshot('2026-07-01', { whatsapp_clicks: mean(VARIED_10) }),
    trailingSnapshots: trailing,
  });
  assert.equal(result.stillSignificant, false);
});
test('zScoreDetector.reevaluate resolves a breakdown metric using its own dimension', () => {
  const trailing = variedBreakdownTrailing('views_by_district', 'Sisattanak');
  const insight = { metric_key: 'views_by_district', dimension_district: 'Sisattanak' };
  const result = zScoreDetector.reevaluate(insight, {
    todaySnapshot: daySnapshot('2026-07-01', { views_by_district: { Sisattanak: mean(VARIED_10) } }),
    trailingSnapshots: trailing,
  });
  assert.equal(result.stillSignificant, false);
});

// ── runInsightEngine — the shared lifecycle loop ─────────────────────────
test('runInsightEngine inserts a new insight for a fresh significant finding', () => {
  const trailing = variedTrailing('whatsapp_clicks');
  const today = daySnapshot('2026-07-01', { whatsapp_clicks: 80 });
  const { toInsert, toUpdate, toResolve } = runInsightEngine(today, trailing, [], '2026-07-01');
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].metric_key, 'whatsapp_clicks');
  assert.equal(toInsert[0].trend, 'emerging');
  assert.equal(toUpdate.length, 0);
  assert.equal(toResolve.length, 0);
});
test('runInsightEngine updates an existing open insight matched by key', () => {
  const trailing = variedTrailing('whatsapp_clicks');
  const today = daySnapshot('2026-07-01', { whatsapp_clicks: 80 });
  const openInsights = [{
    id: 'existing-1', type: 'conversion_anomaly', metric_key: 'whatsapp_clicks',
    dimension_district: null, dimension_property_type: null, dimension_property_id: null,
    evidence: { z: 2.0 },
  }];
  const { toInsert, toUpdate } = runInsightEngine(today, trailing, openInsights, '2026-07-01');
  assert.equal(toInsert.length, 0, 'must update the existing row, not insert a duplicate');
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].id, 'existing-1');
});
test('runInsightEngine force-resolves an open insight whose metric_key no detector claims', () => {
  const trailing = Array.from({ length: 10 }, (_, i) => daySnapshot(`2026-06-${i + 1}`, {}));
  const today = daySnapshot('2026-07-01', {});
  const openInsights = [{ id: 'orphan-1', type: 'search_trend', metric_key: 'no_longer_tracked', dimension_district: null, dimension_property_type: null, dimension_property_id: null }];
  const { toResolve } = runInsightEngine(today, trailing, openInsights, '2026-07-01');
  assert.deepEqual(toResolve, ['orphan-1']);
});
test('runInsightEngine leaves an insight untouched when its metric cannot be evaluated this run (schema drift)', () => {
  // whatsapp_clicks is a known metric, but every trailing day is missing it
  // entirely (undefined, not 0) -- isStillSignificant must return null, and
  // the insight must be left alone, not force-resolved.
  const trailing = Array.from({ length: 10 }, (_, i) => daySnapshot(`2026-06-${i + 1}`, {})); // no whatsapp_clicks key at all
  const today = daySnapshot('2026-07-01', {}); // still missing -> extract() returns undefined
  const openInsights = [{ id: 'drift-1', type: 'conversion_anomaly', metric_key: 'whatsapp_clicks', dimension_district: null, dimension_property_type: null, dimension_property_id: null }];
  const { toResolve, toUpdate } = runInsightEngine(today, trailing, openInsights, '2026-07-01');
  assert.equal(toResolve.length, 0, 'must not force-resolve on unreadable data');
  assert.equal(toUpdate.length, 0, 'must not fabricate an update on unreadable data');
});
test('runInsightEngine resolves an insight once it is genuinely back to normal', () => {
  const trailing = variedTrailing('whatsapp_clicks');
  const today = daySnapshot('2026-07-01', { whatsapp_clicks: mean(VARIED_10) }); // back to baseline, not re-matched by detect()
  const openInsights = [{ id: 'settled-1', type: 'conversion_anomaly', metric_key: 'whatsapp_clicks', dimension_district: null, dimension_property_type: null, dimension_property_id: null }];
  const { toResolve } = runInsightEngine(today, trailing, openInsights, '2026-07-01');
  assert.deepEqual(toResolve, ['settled-1']);
});

// ── Pluggability: a second, non-z-score detector registered via the
// `detectors` param must flow through the exact same persistence/lifecycle
// path with zero changes to runInsightEngine itself. This is the concrete
// proof that the Detector interface is genuinely pluggable, not just
// documented as such. ──────────────────────────────────────────────────────
test('a custom detector registered via the detectors param is honored end to end', () => {
  const stubDetector = {
    key: 'always_flags_test_metric',
    detect() {
      return [{
        type: 'search_trend', metricKey: 'stub_metric',
        dimensionDistrict: null, dimensionPropertyType: null, dimensionPropertyId: null,
        title: 'Stub finding', summary: 'Stub finding', evidence: { z: 5, today: 1, mean: 0, stddev: 1, direction: 'up' },
        severity: 'high', confidence: 0.9,
      }];
    },
  };
  const { toInsert } = runInsightEngine(
    daySnapshot('2026-07-01', {}), [], [], '2026-07-01', [stubDetector]
  );
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].metric_key, 'stub_metric');
});
test('runInsightEngine defaults to DEFAULT_DETECTORS when no detectors param is given', () => {
  // Confirms the default-parameter wiring itself, independent of the stub test above.
  const trailing = variedTrailing('whatsapp_clicks');
  const today = daySnapshot('2026-07-01', { whatsapp_clicks: 80 });
  const { toInsert } = runInsightEngine(today, trailing, []); // no `today` date, no detectors — defaults must not throw
  assert.equal(toInsert.length, 1);
});
