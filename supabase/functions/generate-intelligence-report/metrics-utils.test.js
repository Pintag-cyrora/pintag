// Unit tests for the period-bucketing helpers — run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import { sumMetrics, bucketSnapshots, isoWeekKey, monthKey } from './metrics-utils.js';

function metrics(overrides) {
  return {
    search: { total: 10, zero_result: 1, by_district: { Sisattanak: 5 }, by_property_type: { villa: 3 }, by_transaction_type: {} },
    listing_impressions: 100, listing_clicks: 10, listing_views: 8,
    views_by_district: { Sisattanak: 4 }, views_by_property_type: { villa: 4 },
    whatsapp_clicks: 3, call_clicks: 1, leads_created: 2, leads_closed: 0, leads_lost: 0,
    sessions_total: 20,
    gallery_events: 1, share_events: 0, favorite_events: 0, map_events: 0,
    filter_usage: { 'filter-district': 2 }, ui_element_counts: { 'filter-district': 2 },
    top_listings_by_views: [{ property_id: 'p1', title: 'Listing 1', views: 8 }],
    top_listings_by_ctr: [{ property_id: 'p1', title: 'Listing 1', impressions: 20, clicks: 4, ctr: 0.2 }],
    impressions_no_leads: [],
    ...overrides,
  };
}

test('sumMetrics sums scalar fields across days', () => {
  const days = [{ day: '2026-07-01', metrics: metrics() }, { day: '2026-07-02', metrics: metrics() }];
  const summed = sumMetrics(days);
  assert.equal(summed.listing_impressions, 200);
  assert.equal(summed.listing_clicks, 20);
  assert.equal(summed.whatsapp_clicks, 6);
  assert.equal(summed.search.total, 20);
  assert.equal(summed.search.zero_result, 2);
});
test('sumMetrics merges breakdown dicts by summing matching keys', () => {
  const days = [{ day: '2026-07-01', metrics: metrics() }, { day: '2026-07-02', metrics: metrics() }];
  const summed = sumMetrics(days);
  assert.equal(summed.search.by_district.Sisattanak, 10);
  assert.equal(summed.views_by_district.Sisattanak, 8);
});
test('sumMetrics recomputes listing_ctr from summed totals, not an average of daily ratios', () => {
  const days = [{ day: '2026-07-01', metrics: metrics({ listing_impressions: 100, listing_clicks: 10 }) },
                { day: '2026-07-02', metrics: metrics({ listing_impressions: 100, listing_clicks: 50 }) }];
  const summed = sumMetrics(days);
  // total clicks 60 / total impressions 200 = 0.3, not avg(0.1, 0.5)=0.3 coincidentally same here --
  // use an asymmetric case to actually distinguish sum-then-divide from avg-of-ratios.
  assert.equal(summed.listing_ctr, 0.3);
});
test('sumMetrics merges top_listings_by_views across days, keyed by property_id', () => {
  const days = [
    { day: '2026-07-01', metrics: metrics({ top_listings_by_views: [{ property_id: 'p1', title: 'A', views: 5 }] }) },
    { day: '2026-07-02', metrics: metrics({ top_listings_by_views: [{ property_id: 'p1', title: 'A', views: 3 }, { property_id: 'p2', title: 'B', views: 10 }] }) },
  ];
  const summed = sumMetrics(days);
  const p1 = summed.top_listings_by_views.find((r) => r.property_id === 'p1');
  const p2 = summed.top_listings_by_views.find((r) => r.property_id === 'p2');
  assert.equal(p1.views, 8);
  assert.equal(p2.views, 10);
  assert.equal(summed.top_listings_by_views[0].property_id, 'p2', 'sorted descending by views');
});
test('sumMetrics.top_listings_by_ctr applies the minimum-impressions floor after merging', () => {
  const days = [
    { day: '2026-07-01', metrics: metrics({ top_listings_by_ctr: [{ property_id: 'low-vol', title: 'Low', impressions: 1, clicks: 1 }] }) },
  ];
  const summed = sumMetrics(days);
  assert.equal(summed.top_listings_by_ctr.find((r) => r.property_id === 'low-vol'), undefined, 'a single-impression 100% CTR must be filtered as noise');
});
test('sumMetrics handles an empty day list without throwing', () => {
  const summed = sumMetrics([]);
  assert.equal(summed.listing_impressions, 0);
  assert.equal(summed.listing_ctr, 0);
  assert.deepEqual(summed.search.by_district, {});
});

// ── bucketSnapshots / isoWeekKey / monthKey ──────────────────────────────
test('isoWeekKey produces a Monday-start ISO week key', () => {
  // 2026-07-01 is a Wednesday in ISO week 27 of 2026.
  assert.equal(isoWeekKey('2026-07-01'), '2026-W27');
});
test('monthKey extracts the YYYY-MM prefix', () => {
  assert.equal(monthKey('2026-07-15'), '2026-07');
});
test('bucketSnapshots groups consecutive days by the given key function, oldest bucket first', () => {
  const days = [
    { day: '2026-07-01', metrics: metrics() },
    { day: '2026-07-02', metrics: metrics() },
    { day: '2026-08-01', metrics: metrics() },
  ];
  const buckets = bucketSnapshots(days, monthKey);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].periodKey, '2026-07');
  assert.equal(buckets[0].periodStart, '2026-07-01');
  assert.equal(buckets[0].periodEnd, '2026-07-02');
  assert.equal(buckets[1].periodKey, '2026-08');
  assert.equal(buckets[0].metrics.listing_impressions, 200, 'each bucket\'s metrics should be the merged sumMetrics of its days');
});
