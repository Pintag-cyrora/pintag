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
// case-insensitive) title AND the same variant signature (bedrooms,
// bathrooms, price -- see variantSignature() below). Title alone isn't
// enough: the Multi-Unit Buildings feature's own design research surfaced
// a real false-positive risk here -- a building with a Studio, a 1 Bedroom,
// and a 2 Bedroom unit, entered as separate `properties` rows (before
// unit_types existed, or by a caller not yet using it), would very
// plausibly share the exact same title if staff had no dedicated place to
// put the variant name -- and must never be flagged as duplicates of each
// other. Two listings sharing both a title AND matching bedrooms/
// bathrooms/price are a much stronger duplicate signal than title alone;
// two listings sharing a title but differing on those is much more likely
// to be distinct unit variants than an accidental double-entry. This
// signature is deliberately coarse (three fields, not a fuzzy diff) --
// consistent with this detector's existing "simpler, defensible check
// ships first" philosophy. Buildings using the new unit_types model don't
// hit this at all (one properties row per building, not one per unit) --
// this fix protects legacy/transition-period data using the old pattern.
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

// Distinguishes true accidental duplicates from distinct unit-type variants
// sharing a building's title -- see the file-level comment above. Missing
// fields normalize to '' so two listings that are both simply missing
// bedrooms/bathrooms/price (the common case for most non-unit-type
// listings today) still group together exactly as before this fix.
function variantSignature(property) {
  return [
    property.bedrooms ?? '',
    property.bathrooms ?? '',
    property.sale_price || property.rent_price || property.price_display || '',
  ].join('|');
}

// Same-title groups, split further by variant signature -- only listings
// sharing both are grouped together.
function groupByTitleAndVariant(properties) {
  const titleGroups = groupByTitle(properties);
  const groups = new Map();
  titleGroups.forEach((titleGroup, titleKey) => {
    const byVariant = new Map();
    titleGroup.forEach((property) => {
      const sig = variantSignature(property);
      if (!byVariant.has(sig)) byVariant.set(sig, []);
      byVariant.get(sig).push(property);
    });
    byVariant.forEach((variantGroup, sig) => groups.set(`${titleKey}|${sig}`, variantGroup));
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
    summary: `${group.length} listings share this exact title, bedrooms, bathrooms, and price`,
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
    const groups = groupByTitleAndVariant(properties);
    const findings = [];
    groups.forEach((group) => {
      if (group.length < 2) return;
      group.forEach((property) => findings.push(buildFinding(property, group)));
    });
    return findings;
  },
  // Re-evaluates an open duplicate_listing insight. Resolves when the
  // property is gone (deleted/status changed out of the tracked set), when
  // it's no longer part of a same-title-and-variant group of 2+ (e.g.
  // staff retitled one of the duplicates to disambiguate them, or edited
  // bedrooms/bathrooms/price so they now read as distinct unit variants).
  reevaluate(insight, context) {
    if (insight.type !== 'data_quality' || insight.metric_key !== 'duplicate_listing') return null; // not mine
    const properties = context.properties || [];
    const property = properties.find((p) => p.id === insight.dimension_property_id);
    if (!property) return { stillSignificant: false };
    const groups = groupByTitleAndVariant(properties);
    const key = `${normalizeTitle(property.title_en)}|${variantSignature(property)}`;
    const group = groups.get(key) || [property];
    return { stillSignificant: group.length >= 2 };
  },
};

export { normalizeTitle, groupByTitle, variantSignature, groupByTitleAndVariant };
