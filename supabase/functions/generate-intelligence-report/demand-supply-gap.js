// Demand -> Supply -> Gap. Pure functions turning already-computed demand
// (customer_intent_segments, intelligence_daily_metrics()) and supply
// (active_inventory.available_by_segment / available_by_bedroom_segment,
// see 20260920000000_intelligence_demand_supply_gap.sql) into the ranked,
// classified rows report-composer.js narrates in the Demand Signals /
// Supply & Market Gaps sections. Same "AI computes nothing" contract as
// trend-calculator.js: every value here is a direct, reproducible function
// of its inputs; Gemini explains, it never recomputes or invents one.
//
// Reuses demand-supply-detector.js's own MIN_SEARCH_SAMPLE/
// SUPPLY_DEFICIT_RATIO/segmentKey() rather than inventing a second threshold
// philosophy for what is, underneath, the same "is this segment
// undersupplied" question that detector already persists as a
// supply_shortage insight — this module additionally RANKS and PRESENTS
// that same math for the report's new sections, using identical numbers,
// so the persisted insight and the report narrative can never disagree.
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as every
// other module in this pipeline.

import { MIN_SEARCH_SAMPLE, SUPPLY_DEFICIT_RATIO, segmentKey } from './demand-supply-detector.js';
import { dataConfidenceLabel } from './trend-calculator.js';

// A demand confidence band collapsed from the existing 4-band sample-size
// vocabulary (dataConfidenceLabel — <10/<30/<100/100+ low/moderate/high/
// very_high) into the 3-band HIGH/MEDIUM/LOW wording the Demand Signals
// section uses. Same underlying thresholds, not a new scale:
// 'very_high'/'high' -> HIGH, 'moderate' -> MEDIUM, 'low' -> LOW. A segment
// below MIN_SEARCH_SAMPLE (the same floor demand-supply-detector.js already
// uses to decide whether a segment is even a candidate) is always LOW
// regardless of what the raw band would otherwise say — a handful of
// searches is not "demand" no matter how it's banded.
export function demandConfidenceBand(searchCount) {
  if (typeof searchCount !== 'number' || searchCount < MIN_SEARCH_SAMPLE) return 'LOW';
  const band = dataConfidenceLabel(searchCount);
  if (band === 'very_high' || band === 'high') return 'HIGH';
  if (band === 'moderate') return 'MEDIUM';
  return 'LOW';
}

// Ranks customer_intent_segments by demand strength — search_count first
// (the direct measure of "how many people looked for this"), impressions as
// a tiebreaker (how much supply already got shown for it). This is an
// ordering, not a synthesized "demand score" formula; the report always
// states the real search_count/impressions numbers, never an invented index.
export function rankDemandSegments(segments) {
  return [...(Array.isArray(segments) ? segments : [])]
    .sort((a, b) => (b.search_count - a.search_count) || ((b.impressions || 0) - (a.impressions || 0)))
    .map((seg) => ({ ...seg, demand_confidence: demandConfidenceBand(seg.search_count) }));
}

// Classifies one segment's supply adequacy against its demand.
// `supplyCount` is active_inventory.available_by_segment[segmentKey(seg)] —
// genuinely bookable inventory (market_status='available' AND
// workflow_status='active', see the migration) — or null when unavailable
// (any day other than the single most-recently-finalized one; a stock
// metric is never fabricated for a historical day). Four states:
// 'insufficient_data' (⚪ — below MIN_SEARCH_SAMPLE, or supply isn't known
// for this day), 'gap_strong' (🔴), 'gap_potential' (🟡), 'adequate' (no
// flag). Reuses SUPPLY_DEFICIT_RATIO (demand-supply-detector.js) as the
// potential-gap line and half that ratio as the strong-gap line, rather
// than inventing a second, unrelated threshold philosophy.
export function classifySupplyStatus(seg, supplyCount) {
  if (typeof seg.search_count !== 'number' || seg.search_count < MIN_SEARCH_SAMPLE) return 'insufficient_data';
  if (supplyCount == null) return 'insufficient_data';
  const ratio = seg.search_count > 0 ? supplyCount / seg.search_count : (supplyCount > 0 ? Infinity : 0);
  if (ratio < SUPPLY_DEFICIT_RATIO / 2) return 'gap_strong';
  if (ratio < SUPPLY_DEFICIT_RATIO) return 'gap_potential';
  return 'adequate';
}

// Builds the DEMAND + SUPPLY + GAP table report-composer.js narrates: one
// row per segment, ranked by demand, each carrying its own confidence band,
// matching supply count (or null when supply isn't available for this day),
// and gap classification.
export function buildDemandSupplyRows(segments, bySegmentSupply) {
  return rankDemandSegments(segments).map((seg) => {
    const supplyCount = bySegmentSupply ? (bySegmentSupply[segmentKey(seg)] ?? 0) : null;
    return {
      transaction_type: seg.transaction_type,
      property_type: seg.property_type,
      district: seg.district,
      search_count: seg.search_count,
      impressions: seg.impressions,
      demand_confidence: seg.demand_confidence !== undefined ? seg.demand_confidence : demandConfidenceBand(seg.search_count),
      supply_count: supplyCount,
      status: classifySupplyStatus(seg, supplyCount),
    };
  });
}

// Bedroom-bucketed demand/supply, for segments with enough bedroom signal
// to name a number at all — reuses report-composer.js's own existing
// bedroom_sample_size >= 10 gate (customerIntentBlock's rule), not a new
// threshold. `byBedroomSupply` is
// active_inventory.available_by_bedroom_segment, keyed
// "transaction_type|district|bedroom_bucket" (bedroom_bucket: '0'..'3','4+' —
// see the migration). A segment's top_bedroom_count (an integer, possibly 0)
// is bucketed the same way before lookup so both sides of the join agree.
export const BEDROOM_SAMPLE_FLOOR = 10;

export function bedroomBucketFor(bedroomCount) {
  if (typeof bedroomCount !== 'number' || bedroomCount < 0) return null;
  return bedroomCount >= 4 ? '4+' : String(bedroomCount);
}

export function buildBedroomDemandSupplyRows(segments, byBedroomSupply) {
  const rows = [];
  (Array.isArray(segments) ? segments : []).forEach((seg) => {
    if (seg.top_bedroom_count == null) return; // no plurality bedroom to report at all for this segment
    if (typeof seg.bedroom_sample_size !== 'number' || seg.bedroom_sample_size < BEDROOM_SAMPLE_FLOOR) return;
    const bucket = bedroomBucketFor(seg.top_bedroom_count);
    if (bucket == null) return;
    const key = `${seg.transaction_type}|${seg.district}|${bucket}`;
    const supplyCount = byBedroomSupply ? (byBedroomSupply[key] ?? 0) : null;
    rows.push({
      transaction_type: seg.transaction_type,
      district: seg.district,
      bedroom_bucket: bucket,
      bedroom_sample_size: seg.bedroom_sample_size,
      supply_count: supplyCount,
      status: classifySupplyStatus({ search_count: seg.bedroom_sample_size }, supplyCount),
    });
  });
  return rows.sort((a, b) => b.bedroom_sample_size - a.bedroom_sample_size);
}
