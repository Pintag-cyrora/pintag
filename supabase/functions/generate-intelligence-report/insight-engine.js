// The Insight Engine — deterministic detection, ranking, and lifecycle
// management for intelligence_insights. Zero narration happens here;
// Gemini never sees this module's internals, only its output.
//
// Written as plain JS (no TypeScript syntax) so this exact file runs
// unmodified under both Deno (production, imported by index.ts) and plain
// `node` (unit tests) — no build step, no type-stripping flags, matches
// this codebase's zero-tooling convention.
//
// Pluggability: a future tracked metric (a new module's output, a price
// time series once one exists, etc.) is one more entry in
// TRACKED_SCALAR_METRICS or TRACKED_BREAKDOWN_METRICS below — the
// detection/persistence loop in runInsightEngine() never changes.

// ── Pure statistics ──────────────────────────────────────────────────
export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stddev(arr, m) {
  if (arr.length < 2) return 0;
  const mu = m === undefined ? mean(arr) : m;
  const variance = arr.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// Is today's value significant enough to OPEN a new insight (or confirm
// an existing one)? Per-metric, self-adjusting bar (its own trailing
// stddev), not a universal percentage. minSample/minMean are the
// disclosed, deliberate exceptions — without them, a metric going from 1
// to 3 reads as "+200%" even though it's just noise on a near-zero base.
export function detectSignificance(todayValue, trailingValues, opts) {
  opts = opts || {};
  const openZ = opts.openZ !== undefined ? opts.openZ : 1.5;
  const minSample = opts.minSample !== undefined ? opts.minSample : 7;
  const minMean = opts.minMean !== undefined ? opts.minMean : 3;

  const validSample = trailingValues.filter((v) => v !== null && v !== undefined).length;
  if (validSample < minSample) return null;

  const mu = mean(trailingValues);
  if (mu < minMean) return null;
  const sd = stddev(trailingValues, mu);
  if (sd === 0) return null;

  const z = (todayValue - mu) / sd;
  if (Math.abs(z) < openZ) return null;

  return { today: todayValue, mean: mu, stddev: sd, z, direction: z > 0 ? 'up' : 'down' };
}

// Hysteresis: the bar to STAY open is deliberately lower than the bar to
// open in the first place, so a value sitting right at the boundary
// doesn't flap open/resolved/open/resolved on ordinary day-to-day noise.
export function isStillSignificant(todayValue, trailingValues, opts) {
  opts = opts || {};
  const resolveZ = opts.resolveZ !== undefined ? opts.resolveZ : 1.0;
  const mu = mean(trailingValues);
  const sd = stddev(trailingValues, mu);
  if (sd === 0) return false;
  const z = (todayValue - mu) / sd;
  return Math.abs(z) >= resolveZ;
}

// emerging (brand new) / strengthening / weakening / stable — purely from
// comparing this update's magnitude to the insight's own last recorded
// magnitude. This is what lets the report say "CONTINUING, and getting
// worse" without Gemini having to infer direction from raw numbers.
export function classifyTrend(previousMagnitude, currentMagnitude) {
  if (previousMagnitude === null || previousMagnitude === undefined) return 'emerging';
  const deadband = 0.15;
  if (previousMagnitude === 0) return currentMagnitude === 0 ? 'stable' : 'strengthening';
  const relChange = (currentMagnitude - previousMagnitude) / Math.abs(previousMagnitude);
  if (relChange > deadband) return 'strengthening';
  if (relChange < -deadband) return 'weakening';
  return 'stable';
}

// |z|=1.5 (just crossed the open bar) -> ~0.17 confidence; |z|=4+ -> 1.0.
// Monotonic and bounded; the exact curve is an implementation detail.
export function confidenceFromZ(z) {
  const absZ = Math.abs(z);
  return Math.max(0, Math.min(1, (absZ - 1.0) / 3.0));
}

export function severityFromZ(z) {
  const absZ = Math.abs(z);
  if (absZ >= 3.5) return 'critical';
  if (absZ >= 2.5) return 'high';
  if (absZ >= 1.5) return 'medium';
  return 'low';
}

// Report-time ranking only — never stored on the row, since "how much
// should today's report care" depends on the reading context (a
// 10-day-old fading insight ranks differently than a brand-new one with
// identical raw numbers).
export function priorityScore(insight) {
  const severityWeight = { low: 1, medium: 2, high: 3, critical: 4 }[insight.severity] || 2;
  const recencyFactor =
    insight.trend === 'emerging' ? 1.2 :
    insight.trend === 'strengthening' ? 1.15 :
    insight.trend === 'weakening' ? 0.8 : 1.0;
  return severityWeight * insight.confidence * recencyFactor;
}

export function insightKey(type, metricKey, dims) {
  dims = dims || {};
  return [type, metricKey, dims.district || '', dims.propertyType || '', dims.propertyId || ''].join('|');
}

// ── Tracked metrics registry — the pluggability point ───────────────────
export const TRACKED_SCALAR_METRICS = [
  { metricKey: 'search.total', label: 'total searches', type: 'search_trend', extract: (m) => m.search.total },
  { metricKey: 'search.zero_result', label: 'zero-result searches', type: 'search_trend', extract: (m) => m.search.zero_result },
  { metricKey: 'listing_ctr', label: 'listing click-through rate', type: { up: 'ctr_improvement', down: 'ctr_decline' }, extract: (m) => m.listing_ctr * 100 },
  { metricKey: 'whatsapp_clicks', label: 'WhatsApp clicks', type: 'conversion_anomaly', extract: (m) => m.whatsapp_clicks },
  { metricKey: 'leads_created', label: 'leads created', type: 'conversion_anomaly', extract: (m) => m.leads_created },
  { metricKey: 'gallery_events', label: 'gallery interactions', type: 'ux_anomaly', extract: (m) => m.gallery_events },
  { metricKey: 'share_events', label: 'share clicks', type: 'ux_anomaly', extract: (m) => m.share_events },
  { metricKey: 'favorite_events', label: 'favorite attempts', type: 'ux_anomaly', extract: (m) => m.favorite_events },
  { metricKey: 'map_events', label: 'map usage', type: 'ux_anomaly', extract: (m) => m.map_events },
];

export const TRACKED_BREAKDOWN_METRICS = [
  { metricKey: 'search.by_district', label: 'searches', type: 'demand_spike', extract: (m) => m.search.by_district, dimension: 'district' },
  { metricKey: 'search.by_property_type', label: 'searches', type: 'demand_spike', extract: (m) => m.search.by_property_type, dimension: 'propertyType' },
  { metricKey: 'views_by_district', label: 'listing views', type: 'demand_spike', extract: (m) => m.views_by_district, dimension: 'district' },
  { metricKey: 'views_by_property_type', label: 'listing views', type: 'demand_spike', extract: (m) => m.views_by_property_type, dimension: 'propertyType' },
];

function findSpec(metricKey) {
  return TRACKED_SCALAR_METRICS.find((s) => s.metricKey === metricKey) ||
    TRACKED_BREAKDOWN_METRICS.find((s) => s.metricKey === metricKey) || null;
}

function seriesFor(trailingSnapshots, extract) {
  return trailingSnapshots.map((s) => {
    const v = extract(s.metrics);
    return typeof v === 'number' ? v : 0;
  });
}

function buildTitle(label, sig) {
  const pct = sig.mean !== 0 ? Math.round(((sig.today - sig.mean) / sig.mean) * 100) : null;
  const dir = sig.direction === 'up' ? 'up' : 'down';
  return pct !== null
    ? `${label[0].toUpperCase()}${label.slice(1)} ${dir} ${Math.abs(pct)}% vs. 30-day average`
    : `${label[0].toUpperCase()}${label.slice(1)} ${dir} vs. 30-day average`;
}

// ── Main entry point ─────────────────────────────────────────────────
// todaySnapshot: { day, metrics } for the period being evaluated.
// trailingSnapshots: array of { day, metrics } for the 30 days before it,
//   oldest first (does NOT include todaySnapshot).
// openInsights: current intelligence_insights rows where resolved_at IS NULL.
// today: 'YYYY-MM-DD' string for first_seen/last_seen.
//
// Returns { toInsert, toUpdate, toResolve } — plain data, no side effects.
// The caller (index.ts) is responsible for actually writing these via the
// service-role REST client.
export function runInsightEngine(todaySnapshot, trailingSnapshots, openInsights, today) {
  const detected = [];

  TRACKED_SCALAR_METRICS.forEach((spec) => {
    const todayVal = spec.extract(todaySnapshot.metrics) || 0;
    const series = seriesFor(trailingSnapshots, spec.extract);
    const sig = detectSignificance(todayVal, series);
    if (!sig) return;
    const type = typeof spec.type === 'string' ? spec.type : spec.type[sig.direction];
    detected.push({
      type, metricKey: spec.metricKey, dimensionDistrict: null, dimensionPropertyType: null, dimensionPropertyId: null,
      title: buildTitle(spec.label, sig), summary: buildTitle(spec.label, sig),
      evidence: sig, severity: severityFromZ(sig.z), confidence: confidenceFromZ(sig.z),
    });
  });

  TRACKED_BREAKDOWN_METRICS.forEach((spec) => {
    const keys = new Set();
    trailingSnapshots.forEach((s) => Object.keys(spec.extract(s.metrics) || {}).forEach((k) => keys.add(k)));
    Object.keys(spec.extract(todaySnapshot.metrics) || {}).forEach((k) => keys.add(k));

    keys.forEach((key) => {
      const todayVal = (spec.extract(todaySnapshot.metrics) || {})[key] || 0;
      const series = trailingSnapshots.map((s) => (spec.extract(s.metrics) || {})[key] || 0);
      const sig = detectSignificance(todayVal, series);
      if (!sig) return;
      detected.push({
        type: spec.type, metricKey: spec.metricKey,
        dimensionDistrict: spec.dimension === 'district' ? key : null,
        dimensionPropertyType: spec.dimension === 'propertyType' ? key : null,
        dimensionPropertyId: null,
        title: buildTitle(`${key} ${spec.label}`, sig), summary: buildTitle(`${key} ${spec.label}`, sig),
        evidence: sig, severity: severityFromZ(sig.z), confidence: confidenceFromZ(sig.z),
      });
    });
  });

  const openByKey = new Map();
  openInsights.forEach((ins) => {
    const key = insightKey(ins.type, ins.metric_key, {
      district: ins.dimension_district, propertyType: ins.dimension_property_type, propertyId: ins.dimension_property_id,
    });
    openByKey.set(key, ins);
  });

  const toInsert = [];
  const toUpdate = [];
  const matchedOpenIds = new Set();

  detected.forEach((d) => {
    const key = insightKey(d.type, d.metricKey, { district: d.dimensionDistrict, propertyType: d.dimensionPropertyType, propertyId: d.dimensionPropertyId });
    const existing = openByKey.get(key);
    if (existing) {
      matchedOpenIds.add(existing.id);
      const prevMagnitude = existing.evidence && typeof existing.evidence.z === 'number' ? Math.abs(existing.evidence.z) : null;
      toUpdate.push({
        id: existing.id, last_seen: today, evidence: d.evidence, severity: d.severity, confidence: d.confidence,
        trend: classifyTrend(prevMagnitude, Math.abs(d.evidence.z)),
      });
    } else {
      toInsert.push({
        type: d.type, severity: d.severity, confidence: d.confidence, metric_key: d.metricKey,
        dimension_district: d.dimensionDistrict, dimension_property_type: d.dimensionPropertyType, dimension_property_id: d.dimensionPropertyId,
        title: d.title, summary: d.summary, evidence: d.evidence, trend: 'emerging',
        first_seen: today, last_seen: today,
      });
    }
  });

  const toResolve = [];
  openInsights.forEach((ins) => {
    if (matchedOpenIds.has(ins.id)) return;
    const spec = findSpec(ins.metric_key);
    if (!spec) { toResolve.push(ins.id); return; }
    const extract = spec.dimension
      ? (m) => (spec.extract(m) || {})[
          ins.dimension_district && spec.dimension === 'district' ? ins.dimension_district : ins.dimension_property_type
        ] || 0
      : spec.extract;
    const todayVal = extract(todaySnapshot.metrics) || 0;
    const series = seriesFor(trailingSnapshots, extract);
    if (!isStillSignificant(todayVal, series)) {
      toResolve.push(ins.id);
    } else {
      toUpdate.push({ id: ins.id, last_seen: today, trend: 'weakening' });
    }
  });

  return { toInsert, toUpdate, toResolve };
}
