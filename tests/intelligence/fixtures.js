// Shared mock data for the intelligence.html Playwright suite. Kept as
// functions (not module-level constants) so each test gets fresh objects --
// several tests mutate `reports` (Delete) or REPORT_INSIGHTS, and sharing
// one array across tests would make results depend on run order.
const NOW = new Date('2026-07-18T09:00:00Z');

function isoDaysAgo(days) { const d = new Date(NOW); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); }
function isoDateTimeHoursAgo(hours) { const d = new Date(NOW); d.setHours(d.getHours() - hours); return d.toISOString(); }

function makeReports() {
  return [
    {
      id: 'r-3', report_type: 'daily', title: 'Quiet day, nothing notable',
      period_start: isoDaysAgo(0), period_end: isoDaysAgo(0), generated_at: isoDateTimeHoursAgo(2),
      status: 'generated', error_message: null,
      executive_summary: 'No statistically significant changes were detected today.',
      body_markdown: '# Executive Summary\nNo statistically significant changes were detected today.\n\n## Marketplace\nEverything stayed within normal range.',
      metrics_snapshot: { listing_impressions: 452, listing_clicks: 38, listing_views: 30, listing_ctr: 0.084, whatsapp_clicks: 5, call_clicks: 2, leads_created: 5, leads_closed: 1, sessions_total: 210 },
      mentioned_districts: [], mentioned_property_types: [],
    },
    {
      id: 'r-2', report_type: 'daily', title: 'Demand spike in Sisattanak',
      period_start: isoDaysAgo(1), period_end: isoDaysAgo(1), generated_at: isoDateTimeHoursAgo(26),
      status: 'generated', error_message: null,
      executive_summary: 'A significant demand spike was detected in Sisattanak district.',
      body_markdown: '# Executive Summary\nA significant demand spike was detected in Sisattanak district.\n\n## Biggest Story\nSearches for Sisattanak villas jumped **240%** versus the 30-day baseline.',
      metrics_snapshot: {
        listing_impressions: 500, listing_clicks: 60, listing_views: 45, listing_ctr: 0.12, whatsapp_clicks: 9, call_clicks: 3, leads_created: 9, leads_closed: 2, sessions_total: 260,
        // Intelligence V2: segment leaderboard, ranked by search_count DESC
        // (same ordering intelligence_daily_metrics()'s seg_json produces).
        customer_intent_segments: [
          { transaction_type: 'sale', property_type: 'villa', district: 'Sisattanak', search_count: 24, avg_result_count: 3, zero_result_count: 9, impressions: 40, clicks: 12, leads_created: 1, top_price_band: { min: 150000, max: 250000 } },
          { transaction_type: 'rent', property_type: 'apartment', district: 'Chanthabouly', search_count: 8, avg_result_count: 12, zero_result_count: 0, impressions: 55, clicks: 20, leads_created: 3, top_price_band: { min: null, max: 500 } },
        ],
      },
      mentioned_districts: ['Sisattanak'], mentioned_property_types: ['villa'],
      data_confidence: 'high',
      validation: {
        snapshot_finalized: true, all_metrics_calculated: true, historical_comparison_available: true,
        contradictions_detected: [], narrative_fallback_used: false, confidence: 'high', sample_size: 45,
        validated_at: isoDateTimeHoursAgo(26),
      },
      snapshot_version: '1.1.0', report_version: '1.1.0', prompt_version: '1.1.0', validator_version: '1.0.0',
      model_used: 'gemini-2.5-flash',
    },
    {
      id: 'r-1', report_type: 'weekly', title: 'Weekly report failed',
      period_start: isoDaysAgo(8), period_end: isoDaysAgo(2), generated_at: isoDateTimeHoursAgo(70),
      status: 'failed', error_message: 'Gemini request timed out after 25000ms (attempt 4/4)',
      executive_summary: null, body_markdown: null, metrics_snapshot: null, mentioned_districts: null, mentioned_property_types: null,
    },
  ];
}

// A daily report whose AI narrative failed the Report Validator twice and
// fell back to the plain, data-only report -- see report-validator.js's
// buildValidationFallbackReport(). Used to test the fallback banner.
function makeValidationFallbackReport() {
  return {
    id: 'r-fallback', report_type: 'daily', title: 'Daily report: verified data only (2026-07-17)',
    period_start: isoDaysAgo(1), period_end: isoDaysAgo(1), generated_at: isoDateTimeHoursAgo(26),
    status: 'generated', error_message: null,
    executive_summary: 'AI narrative validation failed for 2026-07-17 — showing verified data only, without AI-written prose.',
    body_markdown: '# Executive Summary\nAI narrative validation failed for 2026-07-17 — showing verified data only, without AI-written prose.\n\n## New\n- Total searches up 1500% vs. 30-day average',
    metrics_snapshot: { listing_impressions: 500, listing_clicks: 60, listing_views: 45, listing_ctr: 0.12, whatsapp_clicks: 9, call_clicks: 3, leads_created: 9, leads_closed: 2, sessions_total: 260 },
    mentioned_districts: [], mentioned_property_types: [],
    data_confidence: 'low',
    validation: {
      snapshot_finalized: true, all_metrics_calculated: true, historical_comparison_available: true,
      contradictions_detected: ['Headline/Biggest-Story language says "baseline" but the deterministic data shows a significant increase.'],
      narrative_fallback_used: true, confidence: 'low', sample_size: 8,
      validated_at: isoDateTimeHoursAgo(26),
    },
  };
}

function makeInsights() {
  return {
    'ins-1': {
      id: 'ins-1', type: 'demand_spike', severity: 'high', confidence: 0.92, metric_key: 'district_demand',
      dimension_district: 'Sisattanak', dimension_property_type: 'villa', dimension_property_id: null,
      title: 'Demand spike: Sisattanak villas', summary: 'Searches jumped 240% vs 30-day baseline.',
      evidence: { z: 3.1, mean: 12, today: 41 }, recommendation: 'Consider recruiting more villa listings in Sisattanak.',
      trend: 'emerging', first_seen: isoDaysAgo(1), last_seen: isoDaysAgo(0), resolved_at: null,
    },
  };
}

function makeReportInsights() {
  return [
    { report_id: 'r-2', insight_id: 'ins-1', role: 'biggest_story' },
    { report_id: 'r-3', insight_id: 'ins-1', role: 'mentioned' },
  ];
}

function makeLeads() {
  return [
    {
      id: 'lead-1', status: 'new', property_id: 'p-1',
      created_at: new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString(),
      properties: { title_en: 'Riverside Villa' },
    },
  ];
}

function makeDataQualityInsight() {
  return {
    'dq-1': {
      id: 'dq-1', type: 'data_quality', metric_key: 'missing_photos', severity: 'high', confidence: 1,
      dimension_district: 'Sisattanak', dimension_property_type: 'villa', dimension_property_id: 'p-2',
      title: 'Missing photos: Riverside Condo', summary: 'Missing photos: Riverside Condo',
      evidence: { rule: 'missing_photos', property_id: 'p-2' }, recommendation: null,
      trend: 'emerging', first_seen: isoDaysAgo(1), last_seen: isoDaysAgo(0), resolved_at: null,
      properties: { title_en: 'Riverside Condo' },
    },
  };
}

// Phase 2B fixture: two separate listings each with their own data_quality
// issues, one of them (p-4) with THREE simultaneous issues -- this is what
// Listings Needing Attention groups by dimension_property_id and ranks by
// summed severity weight (p-4's 3 issues should out-rank p-5's single one).
function makeListingsNeedingAttentionInsights() {
  return {
    'la-1': {
      id: 'la-1', type: 'data_quality', metric_key: 'missing_price', severity: 'high', confidence: 1,
      dimension_district: 'Chanthabouly', dimension_property_type: 'apartment', dimension_property_id: 'p-4',
      title: 'Missing price: Sunset Apartment', summary: 'Missing price: Sunset Apartment',
      evidence: { rule: 'missing_price', property_id: 'p-4' }, recommendation: null,
      trend: 'emerging', first_seen: isoDaysAgo(2), last_seen: isoDaysAgo(0), resolved_at: null,
      properties: { title_en: 'Sunset Apartment' },
    },
    'la-2': {
      id: 'la-2', type: 'data_quality', metric_key: 'missing_ai_highlight', severity: 'medium', confidence: 1,
      dimension_district: 'Chanthabouly', dimension_property_type: 'apartment', dimension_property_id: 'p-4',
      title: 'Missing AI highlight: Sunset Apartment', summary: 'Missing AI highlight: Sunset Apartment',
      evidence: { rule: 'missing_ai_highlight', property_id: 'p-4' }, recommendation: null,
      trend: 'emerging', first_seen: isoDaysAgo(2), last_seen: isoDaysAgo(0), resolved_at: null,
      properties: { title_en: 'Sunset Apartment' },
    },
    'la-3': {
      id: 'la-3', type: 'data_quality', metric_key: 'missing_location', severity: 'medium', confidence: 1,
      dimension_district: null, dimension_property_type: 'apartment', dimension_property_id: 'p-4',
      title: 'Missing location: Sunset Apartment', summary: 'Missing location: Sunset Apartment',
      evidence: { rule: 'missing_location', property_id: 'p-4' }, recommendation: null,
      trend: 'emerging', first_seen: isoDaysAgo(2), last_seen: isoDaysAgo(0), resolved_at: null,
      properties: { title_en: 'Sunset Apartment' },
    },
    'la-4': {
      id: 'la-4', type: 'data_quality', metric_key: 'missing_neighborhood_insight', severity: 'low', confidence: 1,
      dimension_district: 'Sikhottabong', dimension_property_type: 'house', dimension_property_id: 'p-5',
      title: 'Missing neighborhood insight: Quiet House', summary: 'Missing neighborhood insight: Quiet House',
      evidence: { rule: 'missing_neighborhood_insight', property_id: 'p-5' }, recommendation: null,
      trend: 'emerging', first_seen: isoDaysAgo(3), last_seen: isoDaysAgo(0), resolved_at: null,
      properties: { title_en: 'Quiet House' },
    },
  };
}

// Intelligence V2 fixtures: one of each new insight type, all linked to r-2
// (which carries the matching customer_intent_segments above) -- Unmet
// Demand & Listings To Fix, unlike Customer Intent, are insight-driven
// (intelligence.js filters the report's OWN linked insights), not read
// straight off metrics_snapshot.
function makeIntelligenceV2Insights() {
  return {
    'ins-2': {
      id: 'ins-2', type: 'supply_shortage', severity: 'high', confidence: 1, metric_key: 'unmet_demand.sale|villa|Sisattanak',
      dimension_district: 'Sisattanak', dimension_property_type: 'villa', dimension_property_id: null,
      title: 'Unmet demand: sale villa in Sisattanak (24 searches, 2 matching active listings)',
      summary: 'Unmet demand: sale villa in Sisattanak (24 searches, 2 matching active listings)',
      evidence: {
        transaction_type: 'sale', property_type: 'villa', district: 'Sisattanak',
        search_count: 24, avg_result_count: 3, zero_result_count: 9, supply_count: 2,
        reasons: ['supply_deficit', 'high_zero_result_rate'], top_price_band: { min: 150000, max: 250000 },
      },
      recommendation: null, trend: 'emerging', first_seen: isoDaysAgo(1), last_seen: isoDaysAgo(1), resolved_at: null,
    },
    'ins-3': {
      id: 'ins-3', type: 'low_performing_listing', severity: 'high', confidence: 1, metric_key: 'listing_performance.low.p-6',
      dimension_district: 'Sisattanak', dimension_property_type: 'villa', dimension_property_id: 'p-6',
      title: 'Low performing: Hillside Villa (18 impressions, 0 leads)',
      summary: 'Low performing: Hillside Villa (18 impressions, 0 leads)',
      evidence: { property_id: 'p-6', impressions: 18, leads: 0, missing_price: false, missing_photos: true, matches_top_segment: true },
      recommendation: null, trend: 'emerging', first_seen: isoDaysAgo(1), last_seen: isoDaysAgo(1), resolved_at: null,
      properties: { title_en: 'Hillside Villa' },
    },
    'ins-4': {
      id: 'ins-4', type: 'high_performing_listing', severity: 'low', confidence: 1, metric_key: 'listing_performance.high.p-7',
      dimension_district: null, dimension_property_type: null, dimension_property_id: 'p-7',
      title: 'High performing: Riverside Condo (22% CTR, 40 impressions)',
      summary: 'High performing: Riverside Condo (22% CTR, 40 impressions)',
      evidence: { property_id: 'p-7', impressions: 40, clicks: 9, ctr: 0.22 },
      recommendation: null, trend: 'emerging', first_seen: isoDaysAgo(1), last_seen: isoDaysAgo(1), resolved_at: null,
      properties: { title_en: 'Riverside Condo' },
    },
  };
}

function makeIntelligenceV2ReportInsights() {
  return [
    { report_id: 'r-2', insight_id: 'ins-2', role: 'mentioned' },
    { report_id: 'r-2', insight_id: 'ins-3', role: 'mentioned' },
    { report_id: 'r-2', insight_id: 'ins-4', role: 'mentioned' },
  ];
}

module.exports = {
  makeReports, makeInsights, makeReportInsights, makeLeads, makeDataQualityInsight,
  makeListingsNeedingAttentionInsights, makeValidationFallbackReport,
  makeIntelligenceV2Insights, makeIntelligenceV2ReportInsights,
  isoDaysAgo, isoDateTimeHoursAgo, NOW,
};
