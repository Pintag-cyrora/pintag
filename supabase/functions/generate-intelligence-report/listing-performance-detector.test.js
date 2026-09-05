// Unit tests for the Listing Performance detector — run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listingPerformanceDetector, isMissingPrice, isMissingPhotos, matchesTopSegment, HIGH_CTR_FLOOR,
} from './listing-performance-detector.js';
import { runInsightEngine } from './insight-engine.js';

function property(overrides) {
  return {
    id: 'p-1', title_en: 'Test Listing', images: ['https://x/1.jpg'], price_display: '$500', price_amount: 500,
    district_en: 'Sisattanak', property_type: 'condo', transaction_type: 'for_rent',
    ...overrides,
  };
}
function topSegment(overrides) {
  return { transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak', search_count: 20, ...overrides };
}
// { todaySnapshot: { day, metrics } } -- the shape detect()/reevaluate()
// actually read off `context` (Detector contract).
function ctx(properties, metrics) {
  return { todaySnapshot: { day: '2026-07-18', metrics }, properties };
}

// ── Pure helpers ──────────────────────────────────────────────────────────
test('isMissingPrice: true only when both price_amount and price_display are absent', () => {
  assert.equal(isMissingPrice(property({ price_amount: null, price_display: '' })), true);
  assert.equal(isMissingPrice(property({ price_amount: null, price_display: '$500' })), false);
  assert.equal(isMissingPrice(property({ price_amount: 500, price_display: null })), false);
});
test('isMissingPhotos: true when images is empty, null, or absent', () => {
  assert.equal(isMissingPhotos(property({ images: [] })), true);
  assert.equal(isMissingPhotos(property({ images: null })), true);
  assert.equal(isMissingPhotos(property({ images: ['a.jpg'] })), false);
});
test('matchesTopSegment: true iff transaction/property type/district all match the #1 (first) segment', () => {
  const segs = [topSegment({}), topSegment({ district: 'Chanthabouly' })];
  assert.equal(matchesTopSegment(property({}), segs), true); // matches segs[0]
  assert.equal(matchesTopSegment(property({ district_en: 'Chanthabouly' }), segs), false); // matches segs[1], not the top one
  assert.equal(matchesTopSegment(property({}), []), false);
  assert.equal(matchesTopSegment(null, segs), false);
});

// ── listingPerformanceDetector.detect ──────────────────────────────────────
test('detect flags a listing in impressions_no_leads as low_performing_listing', () => {
  const p = property({ id: 'p-low' });
  const context = ctx([p], { impressions_no_leads: [{ property_id: 'p-low', title: 'Test Listing', impressions: 40 }], top_listings_by_ctr: [] });
  const findings = listingPerformanceDetector.detect(context);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'low_performing_listing');
  assert.equal(findings[0].dimensionPropertyId, 'p-low');
  assert.equal(findings[0].dimensionDistrict, 'Sisattanak');
  assert.equal(findings[0].evidence.impressions, 40);
  assert.equal(findings[0].confidence, 1);
});
test('low_performing_listing severity is high when the listing has a concrete data-quality problem', () => {
  const noPriceProperty = property({ id: 'p-noprice', price_amount: null, price_display: '' });
  const context = ctx([noPriceProperty], { impressions_no_leads: [{ property_id: 'p-noprice', title: 'x', impressions: 10 }], top_listings_by_ctr: [] });
  assert.equal(listingPerformanceDetector.detect(context)[0].severity, 'high');
  assert.equal(listingPerformanceDetector.detect(context)[0].evidence.missing_price, true);
});
test('low_performing_listing severity is high when the listing matches today\'s #1 demand segment, even with no data-quality problem', () => {
  const healthyMatch = property({ id: 'p-match' }); // for_rent/condo/Sisattanak -- matches topSegment()
  const context = ctx([healthyMatch], {
    impressions_no_leads: [{ property_id: 'p-match', title: 'x', impressions: 10 }],
    top_listings_by_ctr: [],
    customer_intent_segments: [topSegment({})],
  });
  const finding = listingPerformanceDetector.detect(context)[0];
  assert.equal(finding.severity, 'high');
  assert.equal(finding.evidence.matches_top_segment, true);
  assert.equal(finding.evidence.missing_price, false);
  assert.equal(finding.evidence.missing_photos, false);
});
test('low_performing_listing severity is medium for a healthy listing outside the top segment', () => {
  const healthyNoMatch = property({ id: 'p-nomatch', district_en: 'Xaythany' });
  const context = ctx([healthyNoMatch], {
    impressions_no_leads: [{ property_id: 'p-nomatch', title: 'x', impressions: 10 }],
    top_listings_by_ctr: [],
    customer_intent_segments: [topSegment({})],
  });
  assert.equal(listingPerformanceDetector.detect(context)[0].severity, 'medium');
});
test('detect flags a listing above the HIGH_CTR_FLOOR as high_performing_listing, and skips one below it', () => {
  const context = ctx([], {
    impressions_no_leads: [],
    top_listings_by_ctr: [
      { property_id: 'p-hot', title: 'Hot Listing', impressions: 50, clicks: 10, ctr: HIGH_CTR_FLOOR + 0.05 },
      { property_id: 'p-cold', title: 'Cold Listing', impressions: 50, clicks: 2, ctr: HIGH_CTR_FLOOR - 0.05 },
    ],
  });
  const findings = listingPerformanceDetector.detect(context);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'high_performing_listing');
  assert.equal(findings[0].dimensionPropertyId, 'p-hot');
  assert.equal(findings[0].severity, 'low'); // informational, never crowds out an actionable finding
});
test('detect returns nothing on a quiet day with empty leaderboards', () => {
  assert.deepEqual(listingPerformanceDetector.detect(ctx([], { impressions_no_leads: [], top_listings_by_ctr: [] })), []);
  assert.deepEqual(listingPerformanceDetector.detect({ todaySnapshot: { metrics: {} }, properties: [] }), []);
});

// ── listingPerformanceDetector.reevaluate ──────────────────────────────────
test('reevaluate returns null for an insight type this detector does not own', () => {
  assert.equal(listingPerformanceDetector.reevaluate({ type: 'data_quality' }, { properties: [] }), null);
});
test('reevaluate resolves when the property is no longer in the tracked-status fetch', () => {
  const result = listingPerformanceDetector.reevaluate(
    { type: 'low_performing_listing', dimension_property_id: 'gone-1' },
    ctx([property({ id: 'still-here' })], { impressions_no_leads: [] })
  );
  assert.deepEqual(result, { stillSignificant: false });
});
test('reevaluate re-checks low_performing_listing against today\'s impressions_no_leads', () => {
  const p = property({ id: 'p-1' });
  const stillBad = listingPerformanceDetector.reevaluate(
    { type: 'low_performing_listing', dimension_property_id: 'p-1' },
    ctx([p], { impressions_no_leads: [{ property_id: 'p-1', impressions: 10 }] })
  );
  const fixed = listingPerformanceDetector.reevaluate(
    { type: 'low_performing_listing', dimension_property_id: 'p-1' },
    ctx([p], { impressions_no_leads: [] }) // got a lead since, or fell below the impressions floor
  );
  assert.equal(stillBad.stillSignificant, true);
  assert.equal(fixed.stillSignificant, false);
});
test('reevaluate re-checks high_performing_listing against today\'s top_listings_by_ctr', () => {
  const p = property({ id: 'p-1' });
  const stillHot = listingPerformanceDetector.reevaluate(
    { type: 'high_performing_listing', dimension_property_id: 'p-1' },
    ctx([p], { top_listings_by_ctr: [{ property_id: 'p-1', ctr: HIGH_CTR_FLOOR + 0.1 }] })
  );
  const cooledOff = listingPerformanceDetector.reevaluate(
    { type: 'high_performing_listing', dimension_property_id: 'p-1' },
    ctx([p], { top_listings_by_ctr: [{ property_id: 'p-1', ctr: HIGH_CTR_FLOOR - 0.1 }] })
  );
  assert.equal(stillHot.stillSignificant, true);
  assert.equal(cooledOff.stillSignificant, false);
});

// ── Integration with the shared runInsightEngine lifecycle loop ──────────
test('runInsightEngine wires listingPerformanceDetector via context.todaySnapshot/properties with zero changes to the lifecycle loop', () => {
  const p = property({ id: 'p-low' });
  const { todaySnapshot, properties } = { todaySnapshot: { day: '2026-07-18', metrics: { impressions_no_leads: [{ property_id: 'p-low', title: 'x', impressions: 10 }], top_listings_by_ctr: [] } }, properties: [p] };
  const { toInsert } = runInsightEngine(todaySnapshot, [], [], '2026-07-18', [listingPerformanceDetector], { properties });
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].type, 'low_performing_listing');
  assert.equal(toInsert[0].dimension_property_id, 'p-low');
});
