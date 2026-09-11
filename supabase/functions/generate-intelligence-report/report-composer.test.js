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
