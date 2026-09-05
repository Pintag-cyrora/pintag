// Listing Performance detector -- Intelligence V2's detector for the two
// still-unimplemented types DETECTOR_ARCHITECTURE.md names:
// 'low_performing_listing' and 'high_performing_listing'. Section E of the
// Intelligence V2 plan ("Listings To Fix") is the low-performing side;
// high-performing is the cheap, symmetric complement using the same
// already-computed data, closing both documented gaps in one detector.
//
// Reads TWO leaderboards intelligence_daily_metrics() already computes
// every day -- impressions_no_leads (>=5 impressions, zero leads that
// day) and top_listings_by_ctr (>=5 impressions, ranked by CTR) -- off
// context.todaySnapshot.metrics, plus context.properties (the SAME
// data-quality fetch dataQualityDetector already uses, extended with one
// column, transaction_type, so a listing can be matched against a demand
// segment). No new query, no new extraContext field: this detector proves
// out the "no new fetch function needed" design the Intelligence V2 plan
// called for.
//
// Shape: rule-based (a leaderboard membership plus a data-quality/segment
// cross-check), not z-score -- same category as dataQualityDetector.
// Confidence fixed at 1.0.
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as every
// other module in this pipeline.

const HIGH_CTR_FLOOR = 0.15; // top_listings_by_ctr is already impressions>=5-floored; this is the extra bar for "high-performing", not noise

function findProperty(properties, id) {
  return (properties || []).find((p) => p.id === id) || null;
}

function isMissingPrice(property) {
  if (!property) return false;
  if (property.price_amount != null) return false;
  return !(property.price_display && property.price_display.trim());
}
function isMissingPhotos(property) {
  if (!property) return false;
  return !Array.isArray(property.images) || property.images.length === 0;
}

// Does this listing belong to today's #1 demand segment (by search_count)?
// customer_intent_segments is already sorted search_count DESC (see the
// migration's seg_json ORDER BY), so the first entry IS the top segment --
// no re-sorting needed here.
function matchesTopSegment(property, segments) {
  if (!property || !Array.isArray(segments) || !segments.length) return false;
  const top = segments[0];
  return property.transaction_type === top.transaction_type
    && property.property_type === top.property_type
    && property.district_en === top.district;
}

function buildLowPerformingFinding(row, property, segments) {
  const missingPrice = isMissingPrice(property);
  const missingPhotos = isMissingPhotos(property);
  const segmentMatch = matchesTopSegment(property, segments);
  // A listing with real engagement and zero leads is worth a look on its
  // own; it becomes HIGH priority when there's also a concrete, fixable
  // reason (a data-quality gap) or it's exactly what today's strongest
  // demand segment wants and still isn't converting.
  const severity = (missingPrice || missingPhotos || segmentMatch) ? 'high' : 'medium';
  const title = `Low performing: ${row.title || 'Untitled listing'} (${row.impressions} impressions, 0 leads)`;
  return {
    type: 'low_performing_listing',
    metricKey: `listing_performance.low.${row.property_id}`,
    dimensionDistrict: property && property.district_en || null,
    dimensionPropertyType: property && property.property_type || null,
    dimensionPropertyId: row.property_id,
    title,
    summary: title,
    evidence: {
      property_id: row.property_id, impressions: row.impressions, leads: 0,
      missing_price: missingPrice, missing_photos: missingPhotos, matches_top_segment: segmentMatch,
    },
    severity,
    confidence: 1,
  };
}

function buildHighPerformingFinding(row) {
  const title = `High performing: ${row.title || 'Untitled listing'} (${Math.round(row.ctr * 100)}% CTR, ${row.impressions} impressions)`;
  return {
    type: 'high_performing_listing',
    metricKey: `listing_performance.high.${row.property_id}`,
    dimensionDistrict: null,
    dimensionPropertyType: null,
    dimensionPropertyId: row.property_id,
    title,
    summary: title,
    evidence: { property_id: row.property_id, impressions: row.impressions, clicks: row.clicks, ctr: row.ctr },
    severity: 'low', // informational -- nothing to fix, kept low so it never crowds out an actionable finding
    confidence: 1,
  };
}

export const listingPerformanceDetector = {
  key: 'listing_performance',
  // context.properties: the same array dataQualityDetector reads (fetched
  // once by index.ts's fetchDataQualityProperties(), extended with
  // transaction_type for segment matching). context.todaySnapshot.metrics.
  // impressions_no_leads / top_listings_by_ctr: already-computed daily
  // leaderboards (intelligence_daily_metrics()), not fetched here.
  detect(context) {
    const metrics = (context.todaySnapshot && context.todaySnapshot.metrics) || {};
    const properties = context.properties || [];
    const segments = Array.isArray(metrics.customer_intent_segments) ? metrics.customer_intent_segments : [];
    const findings = [];

    (Array.isArray(metrics.impressions_no_leads) ? metrics.impressions_no_leads : []).forEach((row) => {
      const property = findProperty(properties, row.property_id);
      findings.push(buildLowPerformingFinding(row, property, segments));
    });

    (Array.isArray(metrics.top_listings_by_ctr) ? metrics.top_listings_by_ctr : []).forEach((row) => {
      if (row.ctr >= HIGH_CTR_FLOOR) findings.push(buildHighPerformingFinding(row));
    });

    return findings;
  },
  // Re-evaluates an open finding against TODAY's leaderboards. A property
  // no longer in the tracked-status fetch (deleted, or moved away from
  // active/available) is moot, exactly like dataQualityDetector's own
  // reevaluate -- resolve rather than leaving it stuck open for a listing
  // nobody can act on anymore.
  reevaluate(insight, context) {
    if (insight.type !== 'low_performing_listing' && insight.type !== 'high_performing_listing') return null;
    const properties = context.properties || [];
    const property = findProperty(properties, insight.dimension_property_id);
    if (!property) return { stillSignificant: false };

    const metrics = (context.todaySnapshot && context.todaySnapshot.metrics) || {};
    if (insight.type === 'low_performing_listing') {
      const stillThere = (Array.isArray(metrics.impressions_no_leads) ? metrics.impressions_no_leads : [])
        .some((row) => row.property_id === insight.dimension_property_id);
      return { stillSignificant: stillThere };
    }
    const row = (Array.isArray(metrics.top_listings_by_ctr) ? metrics.top_listings_by_ctr : [])
      .find((r) => r.property_id === insight.dimension_property_id);
    return { stillSignificant: !!row && row.ctr >= HIGH_CTR_FLOOR };
  },
};

export { HIGH_CTR_FLOOR, isMissingPrice, isMissingPhotos, matchesTopSegment };
