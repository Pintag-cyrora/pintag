// Inventory Acquisition Intelligence — turns the Demand -> Supply -> Gap
// classification (demand-supply-gap.js) into concrete listing-acquisition
// opportunities for report-composer.js's "## Inventory Opportunities"
// section. Same "AI computes nothing" contract as every other module in
// this pipeline: every classification here is a deterministic function of
// real, already-computed data; Gemini narrates the rows, it never invents
// a tier or a target itself.
//
// Deliberately reuses demand-supply-gap.js's classifySupplyStatus/
// demandConfidenceBand/rankDemandSegments and demand-supply-detector.js's
// segmentKey/metricKeyFor rather than a second threshold philosophy — this
// module's job is strictly ADDITIVE: (1) decide whether a gap is a genuine
// acquisition candidate or a conversion problem in disguise, (2) attach a
// persistence read (emerging/persistent) from the existing insight
// lifecycle so a one-day spike can't read as high-priority, (3) shape a
// concrete acquisition target (district/type/bedrooms/tx/price) from
// fields the segment already carries. It never changes what "adequate" or
// "gap_strong" mean, and never touches demand-supply-gap.js's own tested
// output shape (buildDemandSupplyRows/buildBedroomDemandSupplyRows) — this
// module reads the RAW ranked segments directly instead, because it needs
// fields (top_bedroom_count, top_price_band, leads_created) that section's
// narrower row shape deliberately omits.
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as every
// other module in this pipeline.

import { rankDemandSegments, classifySupplyStatus, BEDROOM_SAMPLE_FLOOR } from './demand-supply-gap.js';
import { segmentKey, metricKeyFor } from './demand-supply-detector.js';
import { dataConfidenceLabel } from './trend-calculator.js';

// ── Demand persistence (product spec item 6) ────────────────────────────
// Reuses the existing insight lifecycle rather than inventing new
// per-segment history tracking: demandSupplyDetector (already wired into
// index.ts's DEFAULT_DETECTORS + demandSupplyDetector) opens/keeps open a
// 'supply_shortage' insight at metric_key `unmet_demand.<segmentKey>` for
// every segment this module also flags as gap_strong/gap_potential (same
// SUPPLY_DEFICIT_RATIO). Its first_seen/last_seen already distinguish
// "opened today" from "still open, opened on an earlier day" — exactly
// emerging vs persistent — without fabricating a new time series.
//
// 'declining' is deliberately NOT produced here: the trend calculator
// (trend-calculator.js) only tracks scalar/breakdown metrics via z-score,
// not a per-segment demand/supply ratio over time, so there is no real
// data yet to say a gap is easing rather than worsening. Claiming one
// would be exactly the kind of fabricated precision this pipeline exists
// to forbid — a future migration could add a tracked ratio series if this
// is wanted later.
//
// 'resolved' is a defined, real outcome (the insight closed since it's no
// longer unmet) but is unreachable for a row this module actually reports
// as a gap: if today's data still classifies the segment gap_strong/
// gap_potential, the corresponding insight cannot simultaneously be
// resolved (both come from the same day's classification). Kept as an
// honest, correct value regardless — it will show up if this function is
// ever called for a segment that JUST became adequate again.
// 'unknown' covers the (expected to be rare, since demandSupplyDetector
// runs the same day off the same segments) case where no insight matches
// at all — treated as conservatively as 'emerging' by callers, never as
// 'persistent'.
export function demandPersistence(metricKey, composed) {
  const c = composed || {};
  const inList = (arr) => Array.isArray(arr) && arr.some((i) => i && i.metric_key === metricKey);
  if (inList(c.new_insights)) return 'emerging';
  if (inList(c.continuing_insights)) return 'persistent';
  if (inList(c.resolved_insights)) return 'resolved';
  return 'unknown';
}

// ── Conversion problem (product spec item 2B) ───────────────────────────
// A segment whose matching supply is already adequate is a demand gap
// ONLY if it also isn't converting: enough impressions to judge at all
// (reuses the same "moderate confidence" floor -- dataConfidenceLabel !==
// 'low', i.e. >=10 -- sampleConfidenceNote/listingOpportunityTag already
// use in report-composer.js) and zero leads despite that exposure. Below
// that exposure floor, there simply isn't enough evidence to call it
// either a conversion problem or a healthy segment -- silence, not a claim.
export function hasConversionProblem(seg) {
  const impressions = typeof seg.impressions === 'number' ? seg.impressions : null;
  if (impressions === null || dataConfidenceLabel(impressions) === 'low') return false;
  const leads = typeof seg.leads_created === 'number' ? seg.leads_created : 0;
  return leads === 0;
}

// ── Opportunity classification (product spec item 3) ────────────────────
// Exact, documented thresholds -- transparent tiers over an opaque score,
// per the spec's own preference:
//
//   status === 'insufficient_data'  -> 'insufficient_data' (⚪)
//   demand_confidence === 'LOW'     -> 'insufficient_data' (⚪) -- a real
//     ratio can still sit on a sample too thin to act on (search_count in
//     [MIN_SEARCH_SAMPLE, 10), still "LOW" per demandConfidenceBand even
//     though classifySupplyStatus no longer says insufficient_data)
//   status === 'adequate'           -> 'optimize' when hasConversionProblem
//     (matching supply already exists; this is a conversion/listing
//     problem, never an acquisition one), else null (nothing to report)
//   status === 'gap_strong'
//     AND demand_confidence === 'HIGH'
//     AND persistence === 'persistent'  -> 'acquire_high' (🔴)
//   otherwise (gap_strong or gap_potential, confidence HIGH/MEDIUM)
//                                    -> 'acquire_potential' (🟡)
//
// The persistence requirement is the direct implementation of "a one-day
// spike should not automatically trigger acquisition" (item 6): only a
// gap that has survived at least one full day-over-day cycle (open in
// continuing_insights, not just freshly inserted today) can reach the top
// tier, regardless of how strong today's single reading looks.
export function classifyOpportunity(seg, status, persistence) {
  if (status === 'insufficient_data') return 'insufficient_data';
  if (seg.demand_confidence === 'LOW') return 'insufficient_data';
  if (status === 'adequate') return hasConversionProblem(seg) ? 'optimize' : null;
  // status is 'gap_strong' or 'gap_potential' here, confidence HIGH/MEDIUM.
  if (status === 'gap_strong' && seg.demand_confidence === 'HIGH' && persistence === 'persistent') {
    return 'acquire_high';
  }
  return 'acquire_potential';
}

// Attaches a bedroom target only when the segment clears the SAME
// bedroom_sample_size >= 10 floor and real-plurality (top_bedroom_count
// not null) rule customerIntentBlock/buildBedroomDemandSupplyRows already
// enforce -- never a second, looser bedroom threshold for this feature.
function bedroomTargetFor(seg) {
  if (seg.top_bedroom_count == null) return null;
  if (typeof seg.bedroom_sample_size !== 'number' || seg.bedroom_sample_size < BEDROOM_SAMPLE_FLOOR) return null;
  return seg.top_bedroom_count;
}

// Builds one row per ranked segment, classified and (where the evidence
// supports it) carrying a concrete acquisition target. Rows classified
// null (status adequate, no conversion problem -- genuinely nothing to
// report) are dropped; every other classification is kept, INCLUDING
// 'optimize' and 'insufficient_data' rows, so the prompt can explicitly
// state what should NOT be treated as an acquisition opportunity (product
// spec item 2's "must distinguish", item 5's "avoid false market gaps")
// rather than the distinction only existing by silent omission.
//
// `segments`: rawMetricsSummary.customer_intent_segments (today's array).
// `bySegmentSupply`: rawMetricsSummary.active_inventory.available_by_segment
// (or null/absent on any day other than the single most-recently-finalized
// one -- classifySupplyStatus already reads that as insufficient_data,
// never a fabricated number).
// `composed`: the same {new_insights, continuing_insights, resolved_insights}
// object buildPrompt already receives, for persistence lookups.
export function buildInventoryOpportunities(segments, bySegmentSupply, composed) {
  return rankDemandSegments(segments)
    .map((seg) => {
      const supplyCount = bySegmentSupply ? (bySegmentSupply[segmentKey(seg)] ?? 0) : null;
      const status = classifySupplyStatus(seg, supplyCount);
      const persistence = demandPersistence(metricKeyFor(seg), composed);
      const classification = classifyOpportunity(seg, status, persistence);
      if (classification === null) return null;
      return {
        transaction_type: seg.transaction_type,
        property_type: seg.property_type,
        district: seg.district,
        search_count: seg.search_count,
        impressions: typeof seg.impressions === 'number' ? seg.impressions : null,
        demand_confidence: seg.demand_confidence,
        supply_count: supplyCount,
        supply_status: status,
        demand_trend: persistence,
        classification,
        bedroom_count: bedroomTargetFor(seg),
        top_price_band: seg.top_price_band || null,
      };
    })
    .filter(Boolean);
}
