// Demand/Supply detector -- Intelligence V2's first detector for the
// 'supply_shortage' insight type, wiring up the demand-vs-supply-ratio
// shape INTELLIGENCE_ARCHITECTURE.md / DETECTOR_ARCHITECTURE.md name as the
// still-missing piece: zScoreDetector already tracks raw inventory-count
// ANOMALIES (new_listings_added, active_inventory.total/by_district/
// by_property_type moving off their own 30-day baseline) -- this detector
// asks a different question entirely: does TODAY'S demand for a specific
// (transaction_type, property_type, district) segment exceed what Pintag
// currently has to show for it? A segment can have a perfectly ordinary,
// unchanging inventory count and still be badly undersupplied relative to
// how many people are searching for it -- that's not a z-score question,
// it's a ratio question, which is why this is a new detector rather than a
// new TRACKED_SCALAR_METRICS entry.
//
// Reads customer_intent_segments and active_inventory.by_segment straight
// off context.todaySnapshot.metrics (added by
// 20260905000000_intelligence_customer_intent.sql) -- no new context
// fetch, no new index.ts plumbing. Same reasoning intelligence_daily_
// metrics() itself gives for keeping the segment key to (transaction_type,
// property_type, district): search_events.bedrooms is a real column that
// is never populated (listings.html has no bedroom filter), so it is not a
// signal this detector can use either.
//
// Shape: rule-based (a ratio crossing a fixed threshold), not z-score --
// same category as dataQualityDetector, for the same reason: there is no
// meaningful "this segment's 30-day trailing mean demand/supply ratio" to
// compare against yet (customer_intent_segments is new; z-score's own
// minSample=7 guard would silently suppress every finding for months).
// Confidence is fixed at 1.0 (a ratio either crosses the line or it
// doesn't); severity scales with how far it crosses.
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as every
// other module in this pipeline.

// A segment with fewer than this many searches that day is too small a
// sample to call "demand" -- a single curious visitor isn't a market
// signal. Mirrors dataConfidenceLabel()'s own <10 "low confidence" band
// (trend-calculator.js) rather than inventing a new threshold philosophy.
const MIN_SEARCH_SAMPLE = 5;

// A segment is read as undersupplied when active matching inventory is
// below this fraction of that day's search count -- e.g. 0.5 means "fewer
// than one matching active listing for every two searches". Deliberately a
// plain ratio, not a percentile or statistical test: the architecture doc
// asks for exactly this shape ("demand-vs-supply ratio").
const SUPPLY_DEFICIT_RATIO = 0.5;

// Alternative trigger: even with adequate raw supply count, a high
// zero-result rate means the ACTIVE listings aren't actually matching the
// searches (e.g. price mismatch within the segment, or listings that don't
// truly fit despite sharing the coarse segment key) -- also unmet demand,
// from a different angle than a low raw supply count.
const HIGH_ZERO_RESULT_RATE = 0.3;

function segmentKey(seg) {
  return `${seg.transaction_type}|${seg.property_type}|${seg.district}`;
}

function metricKeyFor(seg) {
  return `unmet_demand.${segmentKey(seg)}`;
}

function parseMetricKey(metricKey) {
  const m = /^unmet_demand\.(.+)\|(.+)\|(.+)$/.exec(metricKey || '');
  if (!m) return null;
  return { transaction_type: m[1], property_type: m[2], district: m[3] };
}

// Which reason(s) this segment qualifies as unmet demand -- both may apply.
function unmetReasons(seg, supplyCount) {
  const reasons = [];
  if (seg.search_count < MIN_SEARCH_SAMPLE) return reasons;
  if (supplyCount != null && supplyCount < seg.search_count * SUPPLY_DEFICIT_RATIO) reasons.push('supply_deficit');
  const zeroRate = seg.search_count > 0 ? seg.zero_result_count / seg.search_count : 0;
  if (zeroRate >= HIGH_ZERO_RESULT_RATE) reasons.push('high_zero_result_rate');
  return reasons;
}

function severityFor(reasons, seg, supplyCount) {
  // Both reasons firing together, or a segment with real volume (>=20
  // searches -- comfortably past MIN_SEARCH_SAMPLE) is the strongest
  // signal; a single reason on a small-but-qualifying sample is worth
  // surfacing but not alarming.
  if (reasons.length >= 2 || seg.search_count >= 20) return 'high';
  return 'medium';
}

function buildFinding(seg, supplyCount, reasons) {
  const dims = `${seg.transaction_type} ${seg.property_type} in ${seg.district}`;
  const title = `Unmet demand: ${dims} (${seg.search_count} searches, ${supplyCount == null ? 'supply unknown' : `${supplyCount} matching active listings`})`;
  return {
    type: 'supply_shortage',
    metricKey: metricKeyFor(seg),
    dimensionDistrict: seg.district,
    dimensionPropertyType: seg.property_type,
    dimensionPropertyId: null,
    title,
    summary: title,
    evidence: {
      transaction_type: seg.transaction_type, property_type: seg.property_type, district: seg.district,
      search_count: seg.search_count, avg_result_count: seg.avg_result_count, zero_result_count: seg.zero_result_count,
      supply_count: supplyCount, reasons, top_price_band: seg.top_price_band || null,
    },
    severity: severityFor(reasons, seg, supplyCount),
    confidence: 1,
  };
}

export const demandSupplyDetector = {
  key: 'demand_supply',
  // context.todaySnapshot.metrics.customer_intent_segments: array from
  // intelligence_daily_metrics() (always present, '[]' on a quiet day).
  // context.todaySnapshot.metrics.active_inventory.by_segment: point-in-time
  // supply count keyed "tx|type|district", present only when this
  // todaySnapshot is the single most-recently-finalized day (see
  // point_in_time_supply_snapshot()) -- absent/undefined on any other day,
  // in which case supplyCount is null and only the zero-result-rate trigger
  // can fire (a ratio needs both sides; a rate does not).
  detect(context) {
    const metrics = (context.todaySnapshot && context.todaySnapshot.metrics) || {};
    const segments = Array.isArray(metrics.customer_intent_segments) ? metrics.customer_intent_segments : [];
    const bySegment = (metrics.active_inventory && metrics.active_inventory.by_segment) || null;

    const findings = [];
    segments.forEach((seg) => {
      const supplyCount = bySegment ? (bySegment[segmentKey(seg)] ?? 0) : null;
      const reasons = unmetReasons(seg, supplyCount);
      if (!reasons.length) return;
      findings.push(buildFinding(seg, supplyCount, reasons));
    });
    return findings;
  },
  // Re-evaluates an open unmet-demand insight against TODAY's segments --
  // if this segment had no searches at all today (it's simply not in the
  // array), that's a real "no longer measurable today" case, not a
  // schema-drift one, so it resolves rather than being left stuck open
  // forever the one day nobody searched for it.
  reevaluate(insight, context) {
    if (insight.type !== 'supply_shortage') return null;
    const parsed = parseMetricKey(insight.metric_key);
    if (!parsed) return null; // not one of ours (e.g. an active_inventory.* z-score key)

    const metrics = (context.todaySnapshot && context.todaySnapshot.metrics) || {};
    const segments = Array.isArray(metrics.customer_intent_segments) ? metrics.customer_intent_segments : [];
    const seg = segments.find((s) => s.transaction_type === parsed.transaction_type
      && s.property_type === parsed.property_type && s.district === parsed.district);
    if (!seg) return { stillSignificant: false };

    const bySegment = (metrics.active_inventory && metrics.active_inventory.by_segment) || null;
    const supplyCount = bySegment ? (bySegment[segmentKey(seg)] ?? 0) : null;
    return { stillSignificant: unmetReasons(seg, supplyCount).length > 0 };
  },
};

export { MIN_SEARCH_SAMPLE, SUPPLY_DEFICIT_RATIO, HIGH_ZERO_RESULT_RATE, segmentKey, metricKeyFor, parseMetricKey };
