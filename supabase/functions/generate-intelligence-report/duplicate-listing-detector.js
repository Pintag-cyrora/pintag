// Duplicate Listing detector -- Phase 2B's second rule-based detector,
// and a structurally different shape from both zScoreDetector and
// dataQualityDetector: it is cross-sectional (a finding depends on
// comparing a property against every OTHER property in the same fetch),
// not a per-row check. That's why it's its own sibling module rather
// than a ninth rule inside data-quality-detector.js's RULES array --
// see DETECTOR_ARCHITECTURE.md's "Not yet implemented" note on
// supply_shortage/high_performing_listing for the same reasoning applied
// to other cross-sectional detector shapes.
//
// Heuristic, deliberately conservative: two active listings are flagged
// as likely duplicates only when they share the exact same (trimmed,
// case-insensitive) title. This is a strong, low-false-positive signal
// (two genuinely different listings sharing an identical title is rare)
// -- a fuzzier combined-attributes heuristic (same district + price +
// bedrooms, etc.) would catch more real duplicates but also more
// coincidental matches, and per the session's established discipline
// ("ship what's reliable, defer speculative logic"), the simpler,
// defensible check ships first.
//
// Produces the same intelligence_insights.type = 'data_quality' as
// data-quality-detector.js (metric_key is not CHECK-constrained, so no
// migration is needed to add a new metric_key under an existing type) --
// this keeps "duplicate listing" inside the same worklist as every other
// per-listing data-quality condition rather than inventing a new insight
// type for one detector.

function normalizeTitle(title) {
  return (title || '').trim().toLowerCase();
}

function groupByTitle(properties) {
  const groups = new Map();
  properties.forEach((property) => {
    const key = normalizeTitle(property.title_en);
    if (!key) return; // an untitled listing isn't a meaningful duplicate signal
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(property);
  });
  return groups;
}

function buildFinding(property, group) {
  const others = group.filter((p) => p.id !== property.id).map((p) => p.id);
  return {
    type: 'data_quality',
    metricKey: 'duplicate_listing',
    dimensionDistrict: property.district_en || null,
    dimensionPropertyType: property.property_type || null,
    dimensionPropertyId: property.id,
    title: `Possible duplicate: ${property.title_en || 'Untitled listing'}`,
    summary: `${group.length} listings share this exact title`,
    evidence: { rule: 'duplicate_listing', property_id: property.id, duplicate_of: others },
    severity: 'medium',
    confidence: 1,
  };
}

export const duplicateListingDetector = {
  key: 'duplicate_listing',
  // context.properties: same tracked-status property list dataQualityDetector
  // reads -- no additional context needed, since this detector's whole job
  // is comparing rows already present in that same fetch against each other.
  detect(context) {
    const properties = context.properties || [];
    const groups = groupByTitle(properties);
    const findings = [];
    groups.forEach((group) => {
      if (group.length < 2) return;
      group.forEach((property) => findings.push(buildFinding(property, group)));
    });
    return findings;
  },
  // Re-evaluates an open duplicate_listing insight. Resolves when the
  // property is gone (deleted/status changed out of the tracked set) or
  // when it's no longer part of a same-title group of 2+ (e.g. staff
  // retitled one of the duplicates to disambiguate them).
  reevaluate(insight, context) {
    if (insight.type !== 'data_quality' || insight.metric_key !== 'duplicate_listing') return null; // not mine
    const properties = context.properties || [];
    const property = properties.find((p) => p.id === insight.dimension_property_id);
    if (!property) return { stillSignificant: false };
    const groups = groupByTitle(properties);
    const group = groups.get(normalizeTitle(property.title_en)) || [property];
    return { stillSignificant: group.length >= 2 };
  },
};

export { normalizeTitle, groupByTitle };
