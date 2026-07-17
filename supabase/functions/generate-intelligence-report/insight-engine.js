// The Insight Engine — deterministic detection, ranking, and lifecycle
// management for intelligence_insights. Zero narration happens here;
// Gemini never sees this module's internals, only its output.
//
// Written as plain JS (no TypeScript syntax) so this exact file runs
// unmodified under both Deno (production, imported by index.ts) and plain
// `node` (unit tests) — no build step, no type-stripping flags, matches
// this codebase's zero-tooling convention.
//
// Architecture: detection is pluggable, the lifecycle is not. A Detector
// only ever produces RawFinding objects (see below); everything after that
// — matching against open insights, inserting, updating, resolving with
// hysteresis, computing trend — is one shared loop that has no idea which
// detector produced a given finding. Adding a new detector shape
// (percentile-based, ratio-based, rule-based, ML-based) means writing a
// new object satisfying the Detector interface and adding it to
// DEFAULT_DETECTORS — it never requires touching the lifecycle loop or any
// other detector. See INTELLIGENCE_ARCHITECTURE.md.

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

// Keeps only genuinely-measured numeric values, dropping entries where a
// metric could not be read at all (undefined/null/NaN — see the
// schema-drift note on detectSignificance/isStillSignificant below). A
// real measured 0 always survives this filter; a missing key never does.
function definedValues(arr) {
  return arr.filter((v) => typeof v === 'number' && !Number.isNaN(v));
}

// Is today's value significant enough to OPEN a new insight (or confirm
// an existing one)? Per-metric, self-adjusting bar (its own trailing
// stddev), not a universal percentage. minSample/minMean are the
// disclosed, deliberate exceptions — without them, a metric going from 1
// to 3 reads as "+200%" even though it's just noise on a near-zero base.
//
// Schema-drift safety: if today's value itself can't be read as a number
// (the metrics key is missing, not genuinely zero), this returns null
// rather than fabricating a reading from garbage — a missing key must
// never be able to open a new insight. Same for the trailing series: only
// genuinely-measured entries count toward minSample; a metric that only
// started being measured recently is correctly treated as "not enough
// history yet," not as 30 phantom zero-days.
export function detectSignificance(todayValue, trailingValues, opts) {
  opts = opts || {};
  const openZ = opts.openZ !== undefined ? opts.openZ : 1.5;
  const minSample = opts.minSample !== undefined ? opts.minSample : 7;
  const minMean = opts.minMean !== undefined ? opts.minMean : 3;

  if (typeof todayValue !== 'number' || Number.isNaN(todayValue)) return null;

  const valid = definedValues(trailingValues);
  if (valid.length < minSample) return null;

  const mu = mean(valid);
  if (mu < minMean) return null;
  const sd = stddev(valid, mu);
  if (sd === 0) return null;

  const z = (todayValue - mu) / sd;
  if (Math.abs(z) < openZ) return null;

  return { today: todayValue, mean: mu, stddev: sd, z, direction: z > 0 ? 'up' : 'down' };
}

// Hysteresis: the bar to STAY open is deliberately lower than the bar to
// open in the first place, so a value sitting right at the boundary
// doesn't flap open/resolved/open/resolved on ordinary day-to-day noise.
//
// Returns true/false when it can genuinely evaluate, or null when it
// can't (today's value unreadable, or no genuinely-measured trailing
// data at all). null is a distinct outcome from false on purpose: a
// metric whose key vanished from the SQL output must never be able to
// silently force-resolve a real, ongoing insight just because its
// coerced-to-zero series looks like "back to normal" — the caller must
// treat null as "leave this insight alone," not as "resolve it."
export function isStillSignificant(todayValue, trailingValues, opts) {
  opts = opts || {};
  const resolveZ = opts.resolveZ !== undefined ? opts.resolveZ : 1.0;

  if (typeof todayValue !== 'number' || Number.isNaN(todayValue)) return null;

  const valid = definedValues(trailingValues);
  if (!valid.length) return null;

  const mu = mean(valid);
  const sd = stddev(valid, mu);
  if (sd === 0) return null;

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

// ── z-score detector — the built-in, and currently only, Detector ───────
// A Detector is: { key, detect(context) -> RawFinding[], reevaluate?(insight, context) -> {stillSignificant} | null }.
//
// context: { todaySnapshot: {day, metrics}, trailingSnapshots: [{day, metrics}, ...] }.
// RawFinding: { type, metricKey, dimensionDistrict, dimensionPropertyType,
//               dimensionPropertyId, title, summary, evidence, severity, confidence }.
//
// reevaluate is optional and only needed if a detector's insights should
// ever be able to auto-resolve when they stop being significant — the
// lifecycle loop calls it once per open insight it didn't re-match this
// run, tries each registered detector in turn, and force-resolves any
// insight no detector claims (an orphaned metric_key — e.g. because a
// detector was removed). Returning null means "not mine, ask someone
// else" (or, if none claim it, force-resolve); returning
// { stillSignificant: null } means "mine, but I can't tell right now —
// leave it alone" (the schema-drift safety case above).
const TRACKED_SCALAR_METRICS = [
  { metricKey: 'search.total', label: 'total searches', type: 'search_trend', extract: (m) => (m.search ? m.search.total : undefined) },
  { metricKey: 'search.zero_result', label: 'zero-result searches', type: 'search_trend', extract: (m) => (m.search ? m.search.zero_result : undefined) },
  { metricKey: 'listing_ctr', label: 'listing click-through rate', type: { up: 'ctr_improvement', down: 'ctr_decline' }, extract: (m) => (typeof m.listing_ctr === 'number' ? m.listing_ctr * 100 : undefined) },
  { metricKey: 'whatsapp_clicks', label: 'WhatsApp clicks', type: 'conversion_anomaly', extract: (m) => m.whatsapp_clicks },
  { metricKey: 'leads_created', label: 'leads created', type: 'conversion_anomaly', extract: (m) => m.leads_created },
  { metricKey: 'gallery_events', label: 'gallery interactions', type: 'ux_anomaly', extract: (m) => m.gallery_events },
  { metricKey: 'share_events', label: 'share clicks', type: 'ux_anomaly', extract: (m) => m.share_events },
  { metricKey: 'favorite_events', label: 'favorite attempts', type: 'ux_anomaly', extract: (m) => m.favorite_events },
  { metricKey: 'map_events', label: 'map usage', type: 'ux_anomaly', extract: (m) => m.map_events },
];

const TRACKED_BREAKDOWN_METRICS = [
  { metricKey: 'search.by_district', label: 'searches', type: 'demand_spike', extract: (m) => (m.search ? m.search.by_district : undefined), dimension: 'district' },
  { metricKey: 'search.by_property_type', label: 'searches', type: 'demand_spike', extract: (m) => (m.search ? m.search.by_property_type : undefined), dimension: 'propertyType' },
  { metricKey: 'views_by_district', label: 'listing views', type: 'demand_spike', extract: (m) => m.views_by_district, dimension: 'district' },
  { metricKey: 'views_by_property_type', label: 'listing views', type: 'demand_spike', extract: (m) => m.views_by_property_type, dimension: 'propertyType' },
];

// Re-exported for tests/tooling that want to inspect what's currently
// wired without reaching into the detector's closure.
export { TRACKED_SCALAR_METRICS, TRACKED_BREAKDOWN_METRICS };

function findSpec(metricKey) {
  return TRACKED_SCALAR_METRICS.find((s) => s.metricKey === metricKey) ||
    TRACKED_BREAKDOWN_METRICS.find((s) => s.metricKey === metricKey) || null;
}

// Raw extracted values only, undefined preserved (no zero-coercion) — the
// significance functions above are what decide how to treat a gap.
function seriesFor(trailingSnapshots, extract) {
  return trailingSnapshots.map((s) => extract(s.metrics));
}

// A breakdown dict entry that's simply absent (this district had no
// searches that day) is a real, legitimate zero. A breakdown dict that's
// itself entirely absent (the whole feature's key vanished from the SQL
// output) is schema drift and must propagate as undefined, not as an
// empty-dict-full-of-zeros.
function breakdownValueAt(spec, metrics, key) {
  const dict = spec.extract(metrics);
  if (dict === undefined) return undefined;
  return typeof dict[key] === 'number' ? dict[key] : 0;
}

function buildTitle(label, sig) {
  const pct = sig.mean !== 0 ? Math.round(((sig.today - sig.mean) / sig.mean) * 100) : null;
  const dir = sig.direction === 'up' ? 'up' : 'down';
  return pct !== null
    ? `${label[0].toUpperCase()}${label.slice(1)} ${dir} ${Math.abs(pct)}% vs. 30-day average`
    : `${label[0].toUpperCase()}${label.slice(1)} ${dir} vs. 30-day average`;
}

function detectScalarFindings(todaySnapshot, trailingSnapshots) {
  const findings = [];
  TRACKED_SCALAR_METRICS.forEach((spec) => {
    const todayVal = spec.extract(todaySnapshot.metrics);
    const series = seriesFor(trailingSnapshots, spec.extract);
    const sig = detectSignificance(todayVal, series);
    if (!sig) return;
    const type = typeof spec.type === 'string' ? spec.type : spec.type[sig.direction];
    findings.push({
      type, metricKey: spec.metricKey, dimensionDistrict: null, dimensionPropertyType: null, dimensionPropertyId: null,
      title: buildTitle(spec.label, sig), summary: buildTitle(spec.label, sig),
      evidence: sig, severity: severityFromZ(sig.z), confidence: confidenceFromZ(sig.z),
    });
  });
  return findings;
}

function detectBreakdownFindings(todaySnapshot, trailingSnapshots) {
  const findings = [];
  TRACKED_BREAKDOWN_METRICS.forEach((spec) => {
    const keys = new Set();
    trailingSnapshots.forEach((s) => Object.keys(spec.extract(s.metrics) || {}).forEach((k) => keys.add(k)));
    Object.keys(spec.extract(todaySnapshot.metrics) || {}).forEach((k) => keys.add(k));

    keys.forEach((key) => {
      const todayVal = breakdownValueAt(spec, todaySnapshot.metrics, key);
      const series = trailingSnapshots.map((s) => breakdownValueAt(spec, s.metrics, key));
      const sig = detectSignificance(todayVal, series);
      if (!sig) return;
      findings.push({
        type: spec.type, metricKey: spec.metricKey,
        dimensionDistrict: spec.dimension === 'district' ? key : null,
        dimensionPropertyType: spec.dimension === 'propertyType' ? key : null,
        dimensionPropertyId: null,
        title: buildTitle(`${key} ${spec.label}`, sig), summary: buildTitle(`${key} ${spec.label}`, sig),
        evidence: sig, severity: severityFromZ(sig.z), confidence: confidenceFromZ(sig.z),
      });
    });
  });
  return findings;
}

export const zScoreDetector = {
  key: 'z_score',
  detect(context) {
    return [
      ...detectScalarFindings(context.todaySnapshot, context.trailingSnapshots),
      ...detectBreakdownFindings(context.todaySnapshot, context.trailingSnapshots),
    ];
  },
  reevaluate(insight, context) {
    const spec = findSpec(insight.metric_key);
    if (!spec) return null;

    if (spec.dimension) {
      const key = spec.dimension === 'district' ? insight.dimension_district : insight.dimension_property_type;
      const todayVal = breakdownValueAt(spec, context.todaySnapshot.metrics, key);
      const series = context.trailingSnapshots.map((s) => breakdownValueAt(spec, s.metrics, key));
      return { stillSignificant: isStillSignificant(todayVal, series) };
    }

    const todayVal = spec.extract(context.todaySnapshot.metrics);
    const series = seriesFor(context.trailingSnapshots, spec.extract);
    return { stillSignificant: isStillSignificant(todayVal, series) };
  },
};

// The pluggability point: add a new detector object here (or pass a
// custom array into runInsightEngine) to wire in a new detection shape.
// Nothing below this line — or in index.ts — needs to change.
export const DEFAULT_DETECTORS = [zScoreDetector];

// ── Main entry point ─────────────────────────────────────────────────
// todaySnapshot: { day, metrics } for the period being evaluated.
// trailingSnapshots: array of { day, metrics } for the 30 days before it,
//   oldest first (does NOT include todaySnapshot).
// openInsights: current intelligence_insights rows where resolved_at IS NULL.
// today: 'YYYY-MM-DD' string for first_seen/last_seen.
// detectors: optional array of Detector objects; defaults to DEFAULT_DETECTORS.
//
// Returns { toInsert, toUpdate, toResolve } — plain data, no side effects.
// The caller (index.ts) is responsible for actually writing these via the
// service-role REST client. This function itself never inspects which
// detector produced a finding — see INTELLIGENCE_ARCHITECTURE.md.
export function runInsightEngine(todaySnapshot, trailingSnapshots, openInsights, today, detectors) {
  detectors = detectors || DEFAULT_DETECTORS;
  const context = { todaySnapshot, trailingSnapshots };

  const detected = [];
  detectors.forEach((detector) => {
    (detector.detect(context) || []).forEach((finding) => detected.push(finding));
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

    let result = null;
    for (const detector of detectors) {
      if (typeof detector.reevaluate === 'function') {
        result = detector.reevaluate(ins, context);
        if (result) break;
      }
    }

    if (!result) { toResolve.push(ins.id); return; } // no detector claims this metric_key — orphaned, force-resolve.
    if (result.stillSignificant === null) return;     // claimed, but unreadable this run — leave untouched (schema-drift safety).
    if (!result.stillSignificant) {
      toResolve.push(ins.id);
    } else {
      toUpdate.push({ id: ins.id, last_seen: today, trend: 'weakening' });
    }
  });

  return { toInsert, toUpdate, toResolve };
}
