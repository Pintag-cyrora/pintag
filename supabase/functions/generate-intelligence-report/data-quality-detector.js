// Data Quality detector — Phase 2A's first rule-based (not z-score)
// detector, backing three of the confirmed Alerts/Listings-Needing-
// Attention conditions: missing photos, missing AI-generated highlight or
// description, and stale listings. See
// docs/intelligence/DETECTOR_ARCHITECTURE.md for the Detector contract
// this satisfies, and the Modularization/Known-Duplication sections of
// docs/intelligence/PHASE2_PLAN.md for why this is a new sibling module
// rather than shoehorned into insight-engine.js's z-score logic.
//
// Unlike zScoreDetector, this detector's findings are deterministic rule
// checks over the current state of `properties`, not statistical
// deviations over a metrics time series -- there is no "z-score" to
// report, only "this condition is currently true or false." severity and
// confidence are therefore fixed per rule (confidence = 1.0: a rule check
// is either true or false, never a statistical estimate) rather than
// derived from a magnitude.
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as
// insight-engine.js.

const STALE_DAYS_THRESHOLD = 45;
const STALE_VIEW_THRESHOLD = 3; // fewer than this many views over that window reads as "stale", not just new

function daysSince(dateStr, now) {
  return (now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}

// Only these statuses represent listings actively being shown to buyers --
// a draft/sold/inactive listing's data-quality is not staff's morning
// priority the way a live listing's is.
const TRACKED_STATUSES = ['active', 'available'];

function isMissingPhotos(property) {
  return !Array.isArray(property.images) || property.images.length === 0;
}
function isMissingAiDescription(property) {
  return !(property.description_en && property.description_en.trim()) &&
    !(property.property_highlight_en && property.property_highlight_en.trim());
}
function isStaleListing(property, now) {
  if (!property.created_at) return false;
  const ageDays = daysSince(property.created_at, now);
  if (ageDays < STALE_DAYS_THRESHOLD) return false;
  return (property.view_count || 0) < STALE_VIEW_THRESHOLD;
}

const RULES = [
  { metricKey: 'missing_photos', check: (p, _now) => isMissingPhotos(p), title: (p) => `Missing photos: ${p.title_en || 'Untitled listing'}`, severity: 'high' },
  { metricKey: 'missing_ai_description', check: (p, _now) => isMissingAiDescription(p), title: (p) => `Missing description: ${p.title_en || 'Untitled listing'}`, severity: 'medium' },
  { metricKey: 'stale_listing', check: (p, now) => isStaleListing(p, now), title: (p) => `Stale listing: ${p.title_en || 'Untitled listing'}`, severity: 'medium' },
];

function findRule(metricKey) {
  return RULES.find((r) => r.metricKey === metricKey) || null;
}

function buildFinding(rule, property) {
  return {
    type: 'data_quality',
    metricKey: rule.metricKey,
    dimensionDistrict: property.district_en || null,
    dimensionPropertyType: property.property_type || null,
    dimensionPropertyId: property.id,
    title: rule.title(property),
    summary: rule.title(property),
    // No z-score here -- see the module header. Kept as a plain evidence
    // object (not { z, mean, stddev, ... }) so a reader of intelligence_insights
    // can tell at a glance this is a rule-based, not statistical, finding.
    evidence: { rule: rule.metricKey, property_id: property.id },
    severity: rule.severity,
    confidence: 1,
  };
}

export const dataQualityDetector = {
  key: 'data_quality',
  // context.properties: array of currently-tracked-status properties, each
  // with at least { id, title_en, images, description_en,
  // property_highlight_en, district_en, property_type, created_at,
  // view_count }. Populated by index.ts via one plain `properties` select,
  // the same pattern fetchCurrentSupply() already uses -- passed through
  // runInsightEngine's context object, not fetched by this detector itself
  // (a detector must not perform its own DB I/O; see the Detector contract).
  detect(context) {
    const properties = context.properties || [];
    const now = context.now ? new Date(context.now) : new Date();
    const findings = [];
    properties.forEach((property) => {
      RULES.forEach((rule) => {
        if (rule.check(property, now)) findings.push(buildFinding(rule, property));
      });
    });
    return findings;
  },
  // Re-evaluates an open data_quality insight that wasn't freshly matched
  // this run. If the property is no longer in the tracked-status fetch
  // (deleted, or moved to draft/sold/inactive), the underlying condition
  // is moot -- resolve rather than leaving a permanently-stale insight
  // open for a listing nobody can act on anymore.
  reevaluate(insight, context) {
    if (insight.type !== 'data_quality') return null; // not mine
    const rule = findRule(insight.metric_key);
    if (!rule) return null; // an orphaned metric_key -- let the lifecycle loop force-resolve it
    const properties = context.properties || [];
    const property = properties.find((p) => p.id === insight.dimension_property_id);
    if (!property) return { stillSignificant: false }; // no longer tracked -- resolve
    const now = context.now ? new Date(context.now) : new Date();
    return { stillSignificant: rule.check(property, now) };
  },
};

export { TRACKED_STATUSES, STALE_DAYS_THRESHOLD, STALE_VIEW_THRESHOLD, isMissingPhotos, isMissingAiDescription, isStaleListing };
