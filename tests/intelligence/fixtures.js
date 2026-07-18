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
      metrics_snapshot: { listing_impressions: 500, listing_clicks: 60, listing_views: 45, listing_ctr: 0.12, whatsapp_clicks: 9, call_clicks: 3, leads_created: 9, leads_closed: 2, sessions_total: 260 },
      mentioned_districts: ['Sisattanak'], mentioned_property_types: ['villa'],
    },
    {
      id: 'r-1', report_type: 'weekly', title: 'Weekly report failed',
      period_start: isoDaysAgo(8), period_end: isoDaysAgo(2), generated_at: isoDateTimeHoursAgo(70),
      status: 'failed', error_message: 'Gemini request timed out after 25000ms (attempt 4/4)',
      executive_summary: null, body_markdown: null, metrics_snapshot: null, mentioned_districts: null, mentioned_property_types: null,
    },
  ];
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
    },
  };
}

module.exports = {
  makeReports, makeInsights, makeReportInsights, makeLeads, makeDataQualityInsight,
  isoDaysAgo, isoDateTimeHoursAgo, NOW,
};
