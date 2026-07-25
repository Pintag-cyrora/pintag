// The Trend Calculator — the explicit pipeline stage between the Metrics
// Engine (raw daily snapshots) and everything downstream (Insight Engine
// evidence enrichment, the report prompt, the frontend). It computes
// exact, reproducible comparisons — today vs yesterday, vs the trailing
// 7-day average, vs the trailing 30-day average — as plain numbers.
//
// Nothing here estimates or infers. Every field is a direct arithmetic
// function of the snapshot values it's given. Gemini (or any other
// consumer) receives this object and explains it; it never recomputes or
// second-guesses it — see INTELLIGENCE_ARCHITECTURE.md's "AI writes prose
// only" rule, extended here to "AI computes nothing."
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as
// insight-engine.js / metrics-utils.js / report-composer.js.

import { TRACKED_SCALAR_METRICS, mean } from './insight-engine.js';

// Minimum trailing average a percentage-change comparison is computed
// against — mirrors insight-engine.js's own minMean guard (also 3). A
// baseline of 1 turning into 54 is technically "+5300%," but that number is
// meaningless noise on a near-zero base, not a real trend; reporting it
// verbatim is exactly the "Searches up 1504%" failure mode this module
// exists to prevent. Below this floor, change_vs_* comes back null rather
// than a huge, misleading percentage — the caller must render that as
// "not enough baseline to compare," never as 0% or omitted silently.
const MIN_BASELINE_FOR_PCT = 3;

// Exported for reuse by index.ts's Week-over-Week / Month-over-Month
// comparison (current period total vs. the immediately-preceding
// equal-length period total) -- the exact same "don't report a
// percentage off a near-zero baseline" guard applies there too.
export function pctChange(today, baseline) {
  if (typeof today !== 'number' || typeof baseline !== 'number') return null;
  if (baseline < MIN_BASELINE_FOR_PCT) return null;
  return Math.round(((today - baseline) / baseline) * 1000) / 10; // one decimal place
}

function avgOfLastN(series, n) {
  const slice = series.slice(-n).filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (!slice.length) return null;
  return Math.round(mean(slice) * 100) / 100;
}

// trailingSnapshots: oldest-first array of { day, metrics }, NOT including
// today. Returns null for any field that can't be computed from what's
// actually present (missing key, empty history) rather than fabricating a
// zero — a metric with 0 days of history has "no yesterday," not "yesterday
// was 0."
export function computeTrend(extract, todaySnapshot, trailingSnapshots) {
  const today = extract(todaySnapshot.metrics);
  const series = trailingSnapshots.map((s) => extract(s.metrics)).filter((v) => typeof v === 'number' && !Number.isNaN(v));

  const yesterday = trailingSnapshots.length
    ? (() => { const v = extract(trailingSnapshots[trailingSnapshots.length - 1].metrics); return typeof v === 'number' ? v : null; })()
    : null;
  const avg7d = avgOfLastN(series, 7);
  const avg30d = avgOfLastN(series, 30);

  return {
    today: typeof today === 'number' ? today : null,
    yesterday,
    avg_7d: avg7d,
    avg_30d: avg30d,
    change_vs_yesterday: pctChange(today, yesterday),
    change_vs_7d: pctChange(today, avg7d),
    change_vs_30d: pctChange(today, avg30d),
  };
}

// Computes the trend object for every core scalar metric this pipeline
// tracks (reuses insight-engine.js's own TRACKED_SCALAR_METRICS registry —
// one list of "which metrics matter," not two independently-maintained
// copies). Keyed by metric_key so the report composer/prompt can look up
// "search.total"'s trend directly.
export function computeAllTrends(todaySnapshot, trailingSnapshots) {
  const out = {};
  TRACKED_SCALAR_METRICS.forEach((spec) => {
    out[spec.metricKey] = { label: spec.label, ...computeTrend(spec.extract, todaySnapshot, trailingSnapshots) };
  });
  return out;
}

// ── Confidence banding (mirrors data_confidence_from_sample_size() in the
// migration exactly — see that function's comment for the exact
// thresholds). Duplicated deliberately, not called via RPC from here: this
// module is also used to compute a period's confidence entirely in
// TypeScript/JS (e.g. summed sample size across a weekly/monthly range),
// without a round-trip to Postgres for a single CASE expression.
export function dataConfidenceLabel(sampleSize) {
  if (typeof sampleSize !== 'number' || Number.isNaN(sampleSize)) return 'low';
  if (sampleSize < 10) return 'low';
  if (sampleSize < 30) return 'moderate';
  if (sampleSize < 100) return 'high';
  return 'very_high';
}
