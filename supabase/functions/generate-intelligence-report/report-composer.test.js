// Unit tests for the Report Composer — run with `node --test`.
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeReportInput, isQuietPeriod, buildQuietDayReport, buildPrompt,
  buildReportInsightLinks, CANONICAL_DISTRICTS, CANONICAL_PROPERTY_TYPES,
} from './report-composer.js';

function insight(overrides) {
  return {
    id: 'id-1', type: 'demand_spike', severity: 'medium', confidence: 0.6,
    metric_key: 'search.by_district', dimension_district: 'Sisattanak',
    dimension_property_type: null, title: 'Sisattanak demand up', summary: 'Sisattanak demand up',
    trend: 'emerging', first_seen: '2026-07-01', last_seen: '2026-07-01', resolved_at: null,
    ...overrides,
  };
}

// A minimal duck-typed `db` stub — composeReportInput only ever calls
// db.select(table, query) and never inspects the query string itself beyond
// what our stub routes on, mirroring index.ts's real Db.select signature.
function makeDb(responses) {
  return {
    calls: [],
    async select(table, query) {
      this.calls.push({ table, query });
      const key = Object.keys(responses).find((k) => query.includes(k));
      return key ? responses[key] : [];
    },
  };
}

// ── composeReportInput — daily path (reads dailySweep, does not query) ──────
test('composeReportInput (daily) uses the dailySweep result directly for new insights', async () => {
  const db = makeDb({});
  const dailySweep = { inserted: [insight({ id: 'new-1' })], updatedIds: [], resolvedIds: [] };
  const period = { start: '2026-07-01', end: '2026-07-01' };
  const composed = await composeReportInput(db, 'daily', period, dailySweep);
  assert.equal(composed.new_insights.length, 1);
  assert.equal(composed.new_insights[0].id, 'new-1');
  assert.equal(composed.continuing_insights.length, 0);
  assert.equal(composed.resolved_insights.length, 0);
});
test('composeReportInput (daily) fetches continuing/resolved insights by id when the sweep found them', async () => {
  const db = makeDb({
    'id=in.(cont-1)': [insight({ id: 'cont-1', trend: 'strengthening' })],
    'id=in.(res-1)': [insight({ id: 'res-1', resolved_at: '2026-07-01T10:00:00Z' })],
  });
  const dailySweep = { inserted: [], updatedIds: ['cont-1'], resolvedIds: ['res-1'] };
  const period = { start: '2026-07-01', end: '2026-07-01' };
  const composed = await composeReportInput(db, 'daily', period, dailySweep);
  assert.equal(composed.continuing_insights.length, 1);
  assert.equal(composed.continuing_insights[0].id, 'cont-1');
  assert.equal(composed.resolved_insights.length, 1);
  assert.equal(composed.resolved_insights[0].id, 'res-1');
});

// ── composeReportInput — weekly/monthly path (pure reader, queries by period) ──
test('composeReportInput (weekly) classifies new/resolved/continuing from period boundaries', async () => {
  const period = { start: '2026-07-01', end: '2026-07-07' };
  const db = makeDb({
    'first_seen=gte.2026-07-01': [insight({ id: 'new-1', first_seen: '2026-07-03' })],
    'resolved_at=gte.2026-07-01': [insight({ id: 'res-1', resolved_at: '2026-07-05T00:00:00Z' })],
    'resolved_at=is.null': [
      insight({ id: 'new-1', first_seen: '2026-07-03' }), // still open, opened within period -> excluded from continuing
      insight({ id: 'cont-1', first_seen: '2026-06-01', last_seen: '2026-07-06' }), // opened earlier, still open -> continuing
    ],
  });
  const composed = await composeReportInput(db, 'weekly', period, undefined);
  assert.equal(composed.new_insights.length, 1);
  assert.equal(composed.new_insights[0].id, 'new-1');
  assert.equal(composed.resolved_insights.length, 1);
  assert.equal(composed.resolved_insights[0].id, 'res-1');
  assert.equal(composed.continuing_insights.length, 1);
  assert.equal(composed.continuing_insights[0].id, 'cont-1', 'new-1 must not double-count as continuing');
});
test('composeReportInput caps continuing insights but always keeps every new/resolved one', async () => {
  const period = { start: '2026-07-01', end: '2026-07-07' };
  // 3 new + 3 resolved (6 "must keep") + 10 continuing candidates -- with
  // MAX_DISCUSSED_INSIGHTS=8, remainingSlots = max(0, 8-6) = 2, so only the
  // top-2-ranked continuing insights should survive; all 6 new/resolved must.
  const newOnes = Array.from({ length: 3 }, (_, i) => insight({ id: `new-${i}`, first_seen: '2026-07-02' }));
  const resolvedOnes = Array.from({ length: 3 }, (_, i) => insight({ id: `res-${i}`, resolved_at: '2026-07-03T00:00:00Z' }));
  const continuingCandidates = Array.from({ length: 10 }, (_, i) =>
    insight({ id: `cont-${i}`, first_seen: '2026-06-01', last_seen: '2026-07-05', severity: i === 0 ? 'critical' : 'low' }));
  const db = makeDb({
    'first_seen=gte.2026-07-01': newOnes,
    'resolved_at=gte.2026-07-01': resolvedOnes,
    'resolved_at=is.null': continuingCandidates,
  });
  const composed = await composeReportInput(db, 'monthly', period, undefined);
  assert.equal(composed.new_insights.length, 3);
  assert.equal(composed.resolved_insights.length, 3);
  assert.equal(composed.continuing_insights.length, 2, 'only 2 of the 10 continuing candidates should fit the remaining slots');
  assert.ok(composed.continuing_insights.some((i) => i.id === 'cont-0'), 'the highest-severity continuing insight must survive the cap');
});
test('composeReportInput strips internal _priority field before returning', async () => {
  const period = { start: '2026-07-01', end: '2026-07-07' };
  const db = makeDb({
    'resolved_at=is.null': [insight({ id: 'cont-1', first_seen: '2026-06-01', last_seen: '2026-07-05' })],
  });
  const composed = await composeReportInput(db, 'weekly', period, undefined);
  assert.equal(composed.continuing_insights[0]._priority, undefined);
});

// ── isQuietPeriod / buildQuietDayReport ──────────────────────────────────
test('isQuietPeriod is true only when all three groups are empty', () => {
  assert.equal(isQuietPeriod({ new_insights: [], continuing_insights: [], resolved_insights: [] }), true);
  assert.equal(isQuietPeriod({ new_insights: [insight()], continuing_insights: [], resolved_insights: [] }), false);
});
test('buildQuietDayReport returns a well-formed, Gemini-shaped deterministic report', () => {
  const period = { start: '2026-07-01', end: '2026-07-01' };
  const report = buildQuietDayReport('daily', period);
  assert.ok(report.title);
  assert.ok(report.executive_summary);
  assert.ok(report.body_markdown.startsWith('# Executive Summary'));
  assert.deepEqual(report.mentioned_districts, []);
  assert.deepEqual(report.mentioned_property_types, []);
});

// ── buildPrompt ───────────────────────────────────────────────────────────
test('buildPrompt embeds the canonical lists and the report-type-specific structure', () => {
  const composed = { new_insights: [insight()], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, { listing_impressions: 100 }, null);
  assert.ok(prompt.includes(CANONICAL_DISTRICTS[0]));
  assert.ok(prompt.includes(CANONICAL_PROPERTY_TYPES[0]));
  // The daily report is now a five-section Facts->Actions report
  // (PROMPT_VERSION 4.0.0): "# What Happened" replaced "# Today's Story"
  // (which itself replaced "Executive Summary / Biggest Story"), and the old
  // marketplace-composition sections are gone. See daily-briefing.test.js
  // for the full structure contract.
  assert.ok(prompt.includes('DAILY INTELLIGENCE REPORT'));
  assert.ok(prompt.includes('# What Happened'));
  assert.ok(!prompt.includes('## Biggest Story'));
  assert.ok(!prompt.includes("# Today's Story"));
});
test('buildPrompt selects the weekly/monthly structure correctly', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const weekly = buildPrompt('weekly', composed, {}, null);
  const monthly = buildPrompt('monthly', composed, {}, null);
  assert.ok(weekly.includes('WEEKLY INTELLIGENCE REPORT'));
  assert.ok(monthly.includes('MONTHLY INTELLIGENCE REPORT'));
});
test('buildPrompt includes the supply block only when supply is provided', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const withSupply = buildPrompt('daily', composed, {}, { byDistrict: { Sisattanak: 5 }, byType: { villa: 3 } });
  const withoutSupply = buildPrompt('daily', composed, {}, null);
  assert.ok(withSupply.includes('CURRENT ACTIVE SUPPLY'));
  assert.ok(!withoutSupply.includes('CURRENT ACTIVE SUPPLY'));
});
test('buildPrompt embeds the trend analysis block only when provided, and instructs "only these comparisons"', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const trends = { 'search.total': { today: 5, yesterday: 54, avg_7d: 11, avg_30d: 3.4, change_vs_yesterday: -90.7, change_vs_30d: 47.1 } };
  const withTrend = buildPrompt('daily', composed, {}, null, trends);
  const withoutTrend = buildPrompt('daily', composed, {}, null);
  assert.ok(withTrend.includes('TREND ANALYSIS'));
  assert.ok(withTrend.includes('-90.7'));
  assert.ok(withTrend.includes('ONLY comparisons'));
  assert.ok(!withoutTrend.includes('TREND ANALYSIS'));
});
test('buildPrompt tells Gemini never to invent numbers or contradict a significant trend with "stable" language', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /never invent|Invent, estimate, or recompute/i);
  assert.match(prompt, /stable.*baseline.*normal|direction language must match/i);
});

// ── Intelligence V2: customer intent / journey-join block ────────────────
test('buildPrompt (daily) includes the customer intent block only when customer_intent_segments is present', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{ transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak', search_count: 12, top_price_band: { min: 500, max: 800 } }];
  const withSegments = buildPrompt('daily', composed, { customer_intent_segments: segments }, null);
  const withoutSegments = buildPrompt('daily', composed, { listing_impressions: 10 }, null);
  assert.ok(withSegments.includes('CUSTOMER INTENT SEGMENTS'));
  assert.ok(withSegments.includes('Sisattanak'));
  assert.ok(!withoutSegments.includes('ranked by search volume'), 'the data block itself (not just the always-present heading guidance) must be absent');
});
test('buildPrompt (daily) includes journey-join confidence, with a measured match rate, only when journey_join is present', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const jj = { listing_events_total: 10, listing_events_with_session: 9, lead_events_total: 4, lead_events_with_session: 4, lead_events_matched_to_click: 2 };
  const rawMetrics = { customer_intent_segments: [{ transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak', search_count: 5 }], journey_join: jj };
  const prompt = buildPrompt('daily', composed, rawMetrics, null);
  assert.ok(prompt.includes('JOURNEY-JOIN CONFIDENCE'));
  assert.ok(prompt.includes('50%'), 'lead_events_matched_to_click(2) / lead_events_with_session(4) = 50%');
});
test('buildPrompt never includes the customer intent block for weekly/monthly (sumMetrics does not merge it yet)', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{ transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak', search_count: 12 }];
  const weekly = buildPrompt('weekly', composed, { customer_intent_segments: segments }, null);
  const monthly = buildPrompt('monthly', composed, { customer_intent_segments: segments }, null);
  assert.ok(!weekly.includes('ranked by search volume'));
  assert.ok(!monthly.includes('ranked by search volume'));
});

// ── Intelligence: bedroom intent (top_bedroom_count / bedroom_sample_size) ──
test('buildPrompt (daily): a segment with a clear bedroom majority is passed through verbatim, with the sample-size guard present', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{
    transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak',
    search_count: 40, top_price_band: { min: 500, max: 800 },
    top_bedroom_count: 2, bedroom_sample_size: 32,
  }];
  const prompt = buildPrompt('daily', composed, { customer_intent_segments: segments }, null);
  assert.ok(prompt.includes('"top_bedroom_count":2'));
  assert.ok(prompt.includes('"bedroom_sample_size":32'));
  assert.match(prompt, /bedroom_sample_size is at least 10/);
});

test('buildPrompt (daily): a mostly-null/no-preference segment reports top_bedroom_count:null as a legitimate finding, not missing data', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{
    transaction_type: 'for_rent', property_type: 'apartment', district: 'Chanthabouly',
    search_count: 50, top_bedroom_count: null, bedroom_sample_size: 15,
  }];
  const prompt = buildPrompt('daily', composed, { customer_intent_segments: segments }, null);
  assert.ok(prompt.includes('"top_bedroom_count":null'));
  assert.match(prompt, /legitimate finding, not missing data/);
});

test('buildPrompt (daily): the prompt forbids majority language for a near-even split -- only mode/plurality phrasing is allowed', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  // 11 out of 25 bedroom-specific searches named "3" -- a plurality, nowhere
  // near a majority. The composer does not compute this split itself (that
  // lives in the SQL DISTINCT ON ... ORDER BY cnt DESC); it must simply never
  // let the prompt claim more than the data (a bare top_bedroom_count +
  // bedroom_sample_size) can support.
  const segments = [{
    transaction_type: 'for_sale', property_type: 'house', district: 'Xaythany',
    search_count: 25, top_bedroom_count: 3, bedroom_sample_size: 25,
  }];
  const prompt = buildPrompt('daily', composed, { customer_intent_segments: segments }, null);
  assert.match(prompt, /MODE\/PLURALITY, not a majority/);
  assert.match(prompt, /never as "users prefer N bedrooms"/);
});

test('buildPrompt (daily): low bedroom_sample_size still passes the segment through, with the <10 guard instructing "not yet enough data"', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{
    transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak',
    search_count: 12, top_bedroom_count: 2, bedroom_sample_size: 3,
  }];
  const prompt = buildPrompt('daily', composed, { customer_intent_segments: segments }, null);
  assert.ok(prompt.includes('"bedroom_sample_size":3'));
  assert.match(prompt, /not yet enough bedroom-specific data/);
});

test('buildPrompt (daily): never makes a supply-side bedroom-availability claim in the prompt guidance', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{ transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak', search_count: 12, top_bedroom_count: 2, bedroom_sample_size: 12 }];
  const prompt = buildPrompt('daily', composed, { customer_intent_segments: segments }, null);
  assert.match(prompt, /DEMAND-side data only/);
  assert.match(prompt, /not a dimension the current supply\/inventory data is segmented by/);
});

test('buildPrompt (daily): backward-compatible with older customer_intent_segments lacking top_bedroom_count/bedroom_sample_size entirely', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  // Shape produced by the PRE-bedroom migration -- no top_bedroom_count/
  // bedroom_sample_size keys at all, not just null values.
  const segments = [{ transaction_type: 'for_rent', property_type: 'condo', district: 'Sisattanak', search_count: 12, top_price_band: { min: 500, max: 800 } }];
  assert.doesNotThrow(() => buildPrompt('daily', composed, { customer_intent_segments: segments }, null));
  const prompt = buildPrompt('daily', composed, { customer_intent_segments: segments }, null);
  assert.ok(prompt.includes('CUSTOMER INTENT SEGMENTS'));
  assert.ok(prompt.includes('Sisattanak'));
  assert.ok(!prompt.includes('"top_bedroom_count"'), 'the guidance text mentions the field name, but the DATA itself must not fabricate one for old-shaped segments');
});
test('buildPrompt tells Gemini not to state an invented cause beyond what the evidence shows', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /cannot prove|Claim a CAUSE/i);
});

// ── Intelligence: facts vs interpretation, confidence labels, sample size ──
test('buildPrompt defines the three confidence tags and reserves them for interpretation, never plain facts', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /🟢 CONFIRMED/);
  assert.match(prompt, /🟡 LIKELY/);
  assert.match(prompt, /⚪ HYPOTHESIS/);
  assert.match(prompt, /never gets a tag/);
});
test('buildPrompt requires the raw values behind every stated percentage', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /State a percentage without ALSO stating the underlying values/);
  assert.match(prompt, /180 vs ~23 30-day average/);
  assert.match(prompt, /12× yesterday/, 'a very large move against a small baseline should prefer a multiplier over a bare percentage');
});
test('buildPrompt tells Gemini a small sample is a signal to investigate, never proof of failure', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /Treat a small sample as proof of a problem/);
  assert.match(prompt, /Insufficient data to determine performance/);
});
test('buildPrompt is explicit that gallery interactions cannot be attributed to specific listings or users with today\'s data', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /do NOT break gallery interactions down by which listing/);
  assert.match(prompt, /say plainly that today's data cannot show which listings or how many users drove it/);
});
test('buildPrompt (daily) restructures around the five-section Facts->Actions skeleton, in order', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  const want = ['# What Happened', '## What Users Are Doing', '## What It Means', '## What Needs Attention', '## Recommended Actions'];
  let at = -1;
  want.forEach((h) => {
    const i = prompt.indexOf(h);
    assert.ok(i > -1, 'missing section: ' + h);
    assert.ok(i > at, 'out of order: ' + h);
    at = i;
  });
});

// ── insightSummaryLine — sample-size confidence for listing-performance insights ──
test('insightSummaryLine (via buildPrompt) appends a sample-size confidence band for a listing-performance insight', () => {
  const lowSample = {
    id: 'lp-1', type: 'low_performing_listing', severity: 'high', confidence: 1, trend: 'emerging',
    metric_key: 'listing_performance.low.p1', title: 'Low performing: X (6 impressions, 0 leads)',
    dimension_district: null, dimension_property_type: null,
    evidence: { property_id: 'p1', impressions: 6, leads: 0 },
  };
  const composed = { new_insights: [lowSample], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /sample size: 6 impressions \(low confidence\)/);
});
test('insightSummaryLine omits the sample-size note for insights with no impressions field (e.g. a z-score insight)', () => {
  // "sample size:" also appears in the daily structure's own static
  // instructional text (explaining the convention), so this checks the
  // insight's OWN summary line specifically, not the prompt as a whole.
  const zscore = {
    id: 'z-1', type: 'search_trend', severity: 'medium', confidence: 0.5, trend: 'emerging',
    metric_key: 'search.total', title: 'Searches up 40% vs. 30-day average',
    dimension_district: null, dimension_property_type: null,
    evidence: { today: 40, mean: 28, stddev: 5, z: 2.4, direction: 'up' },
  };
  const composed = { new_insights: [zscore], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  const lineStart = prompt.indexOf('[search_trend] Searches up 40%');
  assert.ok(lineStart > -1, 'the insight summary line must be present');
  const lineEnd = prompt.indexOf('\n', lineStart);
  const line = prompt.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  assert.ok(!line.includes('sample size:'), 'a z-score insight has no impressions field, so its own line must not fabricate one');
});
test('buildPrompt (daily) still guides Gemini to use customer intent / unmet demand data and the new insight types, now inside the five-section structure', () => {
  // PROMPT_VERSION 4.0.0 folded the old standalone "## Customer Intent" /
  // "## Unmet Demand & Inventory Opportunities" headings into guidance
  // within "What Users Are Doing" / "What Needs Attention" -- the content
  // guidance must survive even though the dedicated headings are gone.
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.ok(!prompt.includes('## Customer Intent'));
  assert.ok(!prompt.includes('## Unmet Demand & Inventory Opportunities'));
  assert.match(prompt, /CUSTOMER INTENT SEGMENTS/);
  assert.match(prompt, /unmet_demand\./);
  assert.match(prompt, /low_performing_listing/);
  assert.match(prompt, /high_performing_listing/);
});

// ── Demand -> Supply -> Gap rework (v5.0.0) -- product spec items 1-12 ──────

// item 1: FACT/SIGNAL/HYPOTHESIS/ACTION vocabulary
test('buildPrompt defines the FACT/SIGNAL/HYPOTHESIS/ACTION vocabulary and gives the exact user-reported before/after example', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /FACT vs SIGNAL vs HYPOTHESIS vs ACTION/);
  assert.match(prompt, /Wrong: "Users are not finding the information they need\."/);
  assert.match(prompt, /FACT — "25 impressions and 0 leads\."/);
  assert.match(prompt, /Missing price, amenity, or rental-term information may be reducing contact intent/);
});

// item 10: evidence hierarchy for actions
test('buildPrompt defines the 5-tier EVIDENCE HIERARCHY FOR ACTIONS, in priority order', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  const hierarchyIdx = prompt.indexOf('EVIDENCE HIERARCHY FOR ACTIONS');
  assert.ok(hierarchyIdx > -1);
  const order = ['Inventory acquisition', 'Listing optimization', 'Data correction', 'Tracking investigation', 'Monitor'];
  let at = hierarchyIdx;
  order.forEach((tier) => {
    const i = prompt.indexOf(tier, at);
    assert.ok(i > at, 'evidence hierarchy tier out of order or missing: ' + tier);
    at = i;
  });
});

// items 2-3-4-5: new Demand & Supply section and its DEMAND -> SUPPLY -> GAP data block
test('buildPrompt (daily) new "## Demand & Supply" section wires the DEMAND -> SUPPLY -> GAP data block, using real numbers only', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{ transaction_type: 'for_rent', property_type: 'apartment', district: 'Sisattanak', search_count: 40, impressions: 80 }];
  const rawMetrics = { customer_intent_segments: segments, active_inventory: { available_by_segment: { 'for_rent|apartment|Sisattanak': 2 } } };
  const prompt = buildPrompt('daily', composed, rawMetrics, null);
  assert.match(prompt, /## Demand & Supply/);
  assert.match(prompt, /DEMAND -> SUPPLY -> GAP/);
  assert.match(prompt, /"status":"gap_strong"/);
  assert.match(prompt, /"supply_count":2/);
  assert.match(prompt, /POTENTIAL INVENTORY GAP/);
});

// item 12 / REQUIRED 3 & 12: never fabricate a gap when supply is unknown for the day
test('REQUIRED: demandSupplyBlock never fabricates a gap when active_inventory/available_by_segment is entirely absent -- every row reads insufficient_data', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{ transaction_type: 'for_rent', property_type: 'apartment', district: 'Sisattanak', search_count: 40, impressions: 80 }];
  const prompt = buildPrompt('daily', composed, { customer_intent_segments: segments }, null);
  assert.match(prompt, /DEMAND -> SUPPLY -> GAP/);
  assert.match(prompt, /"status":"insufficient_data"/);
  assert.ok(!prompt.includes('"status":"gap_strong"'));
  assert.ok(!prompt.includes('"status":"gap_potential"'));
  assert.ok(!prompt.includes('"status":"adequate"'));
});
test('demandSupplyBlock is entirely absent when there are no customer_intent_segments at all (nothing to rank)', () => {
  // "DEMAND -> SUPPLY -> GAP" also names the data block in the always-present
  // "## Demand & Supply" static instructions (same pattern as CUSTOMER INTENT
  // SEGMENTS), so this checks for the DATA block's own JSON keys instead.
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, { listing_impressions: 50 }, null);
  assert.ok(!prompt.includes('"demand_confidence"'), 'the data block itself must be absent when there are no segments');
});

// item 5 (bedroom demand+supply) and item 11: backward-compatible when bedroom-intent data is absent
test('REQUIRED: existing reports keep working when bedroom-intent data (top_bedroom_count/bedroom_sample_size) is entirely absent -- no bedroom block, no throw', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{ transaction_type: 'for_rent', property_type: 'apartment', district: 'Sisattanak', search_count: 40, impressions: 80 }];
  assert.doesNotThrow(() => buildPrompt('daily', composed, { customer_intent_segments: segments }, null));
  const prompt = buildPrompt('daily', composed, { customer_intent_segments: segments }, null);
  // "BEDROOM-LEVEL DEMAND -> SUPPLY" also names the block in the always-present
  // static instructions, so check for the data block's own JSON key instead.
  assert.ok(!prompt.includes('"bedroom_bucket"'));
});
test('bedroom-level demand+supply block appears only when a segment has a real bedroom plurality and enough sample', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{
    transaction_type: 'for_rent', property_type: 'apartment', district: 'Sisattanak',
    search_count: 40, impressions: 80, top_bedroom_count: 2, bedroom_sample_size: 20,
  }];
  const rawMetrics = { customer_intent_segments: segments, active_inventory: { available_by_bedroom_segment: { 'for_rent|Sisattanak|2': 4 } } };
  const prompt = buildPrompt('daily', composed, rawMetrics, null);
  assert.match(prompt, /BEDROOM-LEVEL DEMAND -> SUPPLY/);
  assert.match(prompt, /"bedroom_bucket":"2"/);
  assert.match(prompt, /"supply_count":4/);
});

// item 6 / REQUIRED 4 & 5: listing opportunity classification
test('REQUIRED: a low_performing_listing insight with enough exposure (>=10 impressions) gets a "REVIEW NOW" listing-opportunity tag -- a listing-optimization candidate', () => {
  const highExposure = {
    id: 'lp-1', type: 'low_performing_listing', severity: 'high', confidence: 1, trend: 'emerging',
    metric_key: 'listing_performance.low.p1', title: 'Low performing: X (40 impressions, 0 leads)',
    dimension_district: null, dimension_property_type: null,
    evidence: { property_id: 'p1', impressions: 40, leads: 0 },
  };
  const composed = { new_insights: [highExposure], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /listing opportunity: REVIEW NOW \(enough exposure to justify an audit\)/);
});
test('REQUIRED: a low_performing_listing insight with too little exposure (<10 impressions) gets a "MONITOR ONLY" tag, never a diagnosis', () => {
  const lowExposure = {
    id: 'lp-2', type: 'low_performing_listing', severity: 'medium', confidence: 1, trend: 'emerging',
    metric_key: 'listing_performance.low.p2', title: 'Low performing: Y (6 impressions, 0 leads)',
    dimension_district: null, dimension_property_type: null,
    evidence: { property_id: 'p2', impressions: 6, leads: 0 },
  };
  const composed = { new_insights: [lowExposure], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /listing opportunity: MONITOR ONLY \(exposure too low to justify changes yet\)/);
});
test('a high_performing_listing insight never gets a listing-opportunity tag (informational only, not an audit candidate)', () => {
  const highPerformer = {
    id: 'hp-1', type: 'high_performing_listing', severity: 'low', confidence: 1, trend: 'stable',
    metric_key: 'listing_performance.high.p3', title: 'High performing: Z (20% CTR, 40 impressions)',
    dimension_district: null, dimension_property_type: null,
    evidence: { property_id: 'p3', impressions: 40, clicks: 8, ctr: 0.2 },
  };
  const composed = { new_insights: [highPerformer], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  // "listing opportunity" also appears in the always-present static
  // instructions, so isolate the insight's OWN summary line specifically.
  const lineStart = prompt.indexOf('[high_performing_listing]');
  assert.ok(lineStart > -1);
  const lineEnd = prompt.indexOf('\n', lineStart);
  const line = prompt.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  assert.ok(!line.includes('listing opportunity:'));
});

// item 8: missing listing information surfaces as a data-quality flag
test('REQUIRED: a [data_quality] insight (missing listing information) is surfaced in the report, distinctly from behavioural findings', () => {
  const dq = {
    id: 'dq-1', type: 'data_quality', severity: 'high', confidence: 1, trend: 'emerging',
    metric_key: 'missing_price', title: 'Missing price: Untitled listing',
    dimension_district: 'Sisattanak', dimension_property_type: 'apartment',
    evidence: { rule: 'missing_price', property_id: 'p9' },
  };
  const composed = { new_insights: [dq], continuing_insights: [], resolved_insights: [] };
  const prompt = buildPrompt('daily', composed, {}, null);
  assert.match(prompt, /\[data_quality\]/);
  assert.match(prompt, /### Data Quality/);
});

// item 9 / REQUIRED: suspicious gallery-interaction drop -> data/tracking warning
test('REQUIRED: a gallery-interaction drop to near-zero while listing impressions stay active triggers the SUSPICIOUS METRIC CHECK, framed as a possible tracking issue, not a confirmed behavioural finding', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const trends = { gallery_events: { today: 0, yesterday: 80, avg_7d: 60, avg_30d: 50 } };
  const rawMetrics = { listing_impressions: 120 };
  const prompt = buildPrompt('daily', composed, rawMetrics, null, trends);
  assert.match(prompt, /SUSPICIOUS METRIC CHECK — GALLERY TRACKING/);
  assert.match(prompt, /gallery interactions fell from 80 yesterday to 0 today/);
  assert.match(prompt, /⚠️ DATA CHECK/);
  assert.match(prompt, /Do not present it as a confirmed behavioural finding/);
});
test('the gallery suspicious-metric check does NOT fire when impressions dropped too (an ordinary quiet day, not suspicious)', () => {
  // "SUSPICIOUS METRIC CHECK" also names the block in the always-present
  // static "### Data Quality" instructions, so check for the dynamic block's
  // own instantiated text (real numbers) instead of the bare heading.
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const trends = { gallery_events: { today: 0, yesterday: 80, avg_7d: 60, avg_30d: 50 } };
  const rawMetrics = { listing_impressions: 2 };
  const prompt = buildPrompt('daily', composed, rawMetrics, null, trends);
  assert.ok(!prompt.includes('gallery interactions fell from'));
});
test('the gallery suspicious-metric check does NOT fire on an ordinary, non-near-zero gallery count', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const trends = { gallery_events: { today: 45, yesterday: 80, avg_7d: 60, avg_30d: 50 } };
  const rawMetrics = { listing_impressions: 120 };
  const prompt = buildPrompt('daily', composed, rawMetrics, null, trends);
  assert.ok(!prompt.includes('gallery interactions fell from'));
});

// item 7 / REQUIRED 10: the exact reported bug -- WhatsApp clicks:1, Leads:1 must
// never produce a stated "0% match rate between clicks and leads"
test('REQUIRED: a 1-sample journey-join population never states a percentage, and the prompt scopes it as a different population from whatsapp_clicks/leads_created', () => {
  const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
  const segments = [{ transaction_type: 'for_rent', property_type: 'apartment', district: 'Sisattanak', search_count: 12 }];
  const jj = { listing_events_total: 3, listing_events_with_session: 3, lead_events_total: 1, lead_events_with_session: 1, lead_events_matched_to_click: 0 };
  const rawMetrics = { customer_intent_segments: segments, journey_join: jj, whatsapp_clicks: 1, leads_created: 1 };
  const prompt = buildPrompt('daily', composed, rawMetrics, null);
  assert.ok(!prompt.includes('0% of'), 'must not state a percentage computed from a 1-sample journey-join population');
  assert.match(prompt, /too few to state a meaningful percentage/);
  assert.match(prompt, /NEVER describe this rate as "a match rate between clicks and leads"/);
});

// ── buildReportInsightLinks — the dedup fix ─────────────────────────────
test('buildReportInsightLinks assigns biggest_story to the highest-priority new/continuing insight', () => {
  const composed = {
    new_insights: [insight({ id: 'low-pri', severity: 'low', confidence: 0.3, trend: 'stable' })],
    continuing_insights: [insight({ id: 'high-pri', severity: 'critical', confidence: 0.95, trend: 'strengthening' })],
    resolved_insights: [],
  };
  const links = buildReportInsightLinks(composed);
  const biggest = links.find((l) => l.role === 'biggest_story');
  assert.equal(biggest.insight_id, 'high-pri');
  const mentioned = links.find((l) => l.insight_id === 'low-pri');
  assert.equal(mentioned.role, 'mentioned');
});
test('buildReportInsightLinks deduplicates an insight appearing in both new and resolved (opened+closed same period)', () => {
  // The exact double-insert bug this function was built to fix: an insight
  // that was opened AND resolved within the same weekly/monthly window used
  // to appear in both new_insights and resolved_insights, producing two
  // report_insights rows for the same (report_id, insight_id) pair.
  const sameInsight = insight({ id: 'dup-1', severity: 'high', confidence: 0.8 });
  const composed = {
    new_insights: [sameInsight],
    continuing_insights: [],
    resolved_insights: [sameInsight],
  };
  const links = buildReportInsightLinks(composed);
  const rowsForDup = links.filter((l) => l.insight_id === 'dup-1');
  assert.equal(rowsForDup.length, 1, 'must produce exactly one row, not one per group membership');
});
test('buildReportInsightLinks: biggest_story role wins over mentioned when the same insight qualifies for both', () => {
  // dup-1 is both the (only, hence highest-priority) new/continuing candidate
  // -- biggest_story -- and also appears in resolved_insights -- mentioned.
  // The higher-priority role must win.
  const sameInsight = insight({ id: 'dup-1' });
  const composed = { new_insights: [sameInsight], continuing_insights: [], resolved_insights: [sameInsight] };
  const links = buildReportInsightLinks(composed);
  assert.equal(links.length, 1);
  assert.equal(links[0].role, 'biggest_story');
});
test('buildReportInsightLinks ignores insights with no id', () => {
  const composed = { new_insights: [{ title: 'no id' }], continuing_insights: [], resolved_insights: [] };
  const links = buildReportInsightLinks(composed);
  assert.equal(links.length, 0);
});
