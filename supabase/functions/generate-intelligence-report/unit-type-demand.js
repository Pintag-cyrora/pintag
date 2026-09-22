// Unit-Type Demand. Pure functions turning already-computed unit-type-level
// demand (unit_type_demand_segments, intelligence_daily_metrics()) and supply
// (active_inventory.available_unit_types, see
// 20260922000000_intelligence_unit_type_demand.sql) into ranked, classified
// rows report-composer.js narrates. Same "AI computes nothing" contract as
// trend-calculator.js/demand-supply-gap.js: every value here is a direct,
// reproducible function of its inputs; Gemini explains, it never recomputes
// or invents a classification itself.
//
// WHY THIS IS A SEPARATE, SIMPLER MODULE THAN demand-supply-gap.js. That
// module compares market-wide SEARCH demand (which has no listing/unit-type
// identity) against a (transaction_type, property_type, district) bucket of
// supply. Unit-type demand is the opposite: an inquiry is always attributed
// to one exact unit_types row (PR #104's unit_type_id), so the "segment" IS
// that row, not a coarser bucket -- there is no by_segment-style key-building
// to do, and matching supply is simply that row's own available_count. See
// this migration's own header comment for the full reasoning.
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as every
// other module in this pipeline.

import { dataConfidenceLabel } from './trend-calculator.js';

// A unit type with fewer than this many total signals (whatsapp_clicks +
// call_clicks + leads_created, summed) that day is too small a sample to
// call "demand" at all -- deliberately smaller than demand-supply-detector.js's
// MIN_SEARCH_SAMPLE=5 (market-wide searches), because a single unit type's
// own inquiry volume is inherently much smaller than a whole market segment's
// search volume; treating them with the same floor would silently suppress
// every unit-type finding. Matches the product spec's own worked example:
// 5 vs 0 inquiries is a real signal, 1-2 total inquiries is not.
export const MIN_UNIT_TYPE_SIGNAL_SAMPLE = 3;

// Reuses demand-supply-detector.js's SUPPLY_DEFICIT_RATIO philosophy (a
// segment is undersupplied when matching inventory is below half its demand
// count) rather than inventing a second threshold philosophy for the same
// underlying question at a finer grain.
export const UNIT_TYPE_SUPPLY_DEFICIT_RATIO = 0.5;

// Total inquiry-type signal for one unit-type segment that day.
export function unitTypeSignalCount(seg) {
  return (seg && seg.whatsapp_clicks || 0) + (seg && seg.call_clicks || 0) + (seg && seg.leads_created || 0);
}

// Collapses dataConfidenceLabel's 4-band sample-size vocabulary into the same
// 3-band HIGH/MEDIUM/LOW wording demandConfidenceBand() (demand-supply-gap.js)
// already uses for market-wide demand, so both read the same way in a report.
// A segment below MIN_UNIT_TYPE_SIGNAL_SAMPLE is always LOW regardless of what
// the raw band would otherwise say.
export function unitTypeDemandConfidenceBand(signalCount) {
  if (typeof signalCount !== 'number' || signalCount < MIN_UNIT_TYPE_SIGNAL_SAMPLE) return 'LOW';
  const band = dataConfidenceLabel(signalCount);
  if (band === 'very_high' || band === 'high') return 'HIGH';
  if (band === 'moderate') return 'MEDIUM';
  return 'LOW';
}

// Ranks unit_type_demand_segments by total signal strength — this is an
// ordering, not a synthesized score; the report always states the real
// whatsapp_clicks/call_clicks/leads_created numbers, never an invented index.
export function rankUnitTypeDemand(segments) {
  return [...(Array.isArray(segments) ? segments : [])]
    .map((seg) => {
      const signal_count = unitTypeSignalCount(seg);
      return { ...seg, signal_count, demand_confidence: unitTypeDemandConfidenceBand(signal_count) };
    })
    .sort((a, b) => b.signal_count - a.signal_count);
}

// Classifies one unit type's supply adequacy against its own demand.
// `availableCount` is active_inventory.available_unit_types[unit_type_id] —
// that exact unit type's own available_count when its parent property is
// genuinely bookable (see the migration) — or null when unavailable (any day
// other than the single most-recently-finalized one). Four states, matching
// classifySupplyStatus's (demand-supply-gap.js) own vocabulary exactly so a
// report can use one shared status legend: 'insufficient_data' (⚪),
// 'gap_strong' (🔴), 'gap_potential' (🟡), 'adequate' (no flag).
export function classifyUnitTypeSupplyStatus(seg, availableCount) {
  const signalCount = unitTypeSignalCount(seg);
  if (signalCount < MIN_UNIT_TYPE_SIGNAL_SAMPLE) return 'insufficient_data';
  if (availableCount == null) return 'insufficient_data';
  const ratio = signalCount > 0 ? availableCount / signalCount : (availableCount > 0 ? Infinity : 0);
  if (ratio < UNIT_TYPE_SUPPLY_DEFICIT_RATIO / 2) return 'gap_strong';
  if (ratio < UNIT_TYPE_SUPPLY_DEFICIT_RATIO) return 'gap_potential';
  return 'adequate';
}

// Builds the UNIT-TYPE DEMAND -> SUPPLY table report-composer.js narrates:
// one row per unit type, ranked by signal strength, each carrying its own
// confidence band, matching supply count (or null when supply isn't
// available for this day), and gap classification. `availableUnitTypes` is
// active_inventory.available_unit_types, keyed by unit_types.id (string).
export function buildUnitTypeDemandRows(segments, availableUnitTypes) {
  return rankUnitTypeDemand(segments).map((seg) => {
    const availableCount = availableUnitTypes ? (availableUnitTypes[seg.unit_type_id] ?? 0) : null;
    return {
      unit_type_id: seg.unit_type_id,
      unit_type_name: seg.unit_type_name,
      bedrooms: seg.bedrooms,
      price_amount: seg.price_amount,
      price_currency: seg.price_currency,
      price_frequency: seg.price_frequency,
      property_id: seg.property_id,
      district: seg.district,
      transaction_type: seg.transaction_type,
      whatsapp_clicks: seg.whatsapp_clicks,
      call_clicks: seg.call_clicks,
      leads_created: seg.leads_created,
      signal_count: seg.signal_count,
      demand_confidence: seg.demand_confidence,
      available_count: availableCount,
      status: classifyUnitTypeSupplyStatus(seg, availableCount),
    };
  });
}
