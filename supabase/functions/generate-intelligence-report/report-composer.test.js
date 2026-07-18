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
  assert.ok(prompt.includes('DAILY INTELLIGENCE REPORT'));
  assert.ok(prompt.includes('Biggest Story'));
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
