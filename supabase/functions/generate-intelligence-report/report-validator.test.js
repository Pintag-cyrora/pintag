// Unit tests for the Report Validator. Run with `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReportContent, buildValidationFallbackReport } from './report-validator.js';

// evidence.today=64, evidence.mean=4 -> (64-4)/4 = 1500% exactly, so any
// narrative citing "1500%" is grounded against these numbers deliberately
// (round figures make the test's own arithmetic easy to eyeball).
function bigStoryInsight(overrides) {
  return Object.assign({
    id: 'i1', type: 'search_trend', title: 'Total searches up 1500% vs. 30-day average',
    summary: 'Total searches up 1500% vs. 30-day average', evidence: { today: 64, mean: 4, stddev: 5, z: 4.2, direction: 'up' },
  }, overrides);
}
function composedWith(newInsights) {
  return { period: { start: '2026-07-23', end: '2026-07-23' }, new_insights: newInsights, continuing_insights: [], resolved_insights: [] };
}

test('validateReportContent: passes a consistent, well-grounded narrative', () => {
  const composed = composedWith([bigStoryInsight()]);
  const gemini = {
    executive_summary: 'Total searches surged 1500% today compared to the 30-day average, a significant spike.',
    body_markdown: '# Executive Summary\nSurged.\n## Biggest Story\nSearches jumped sharply today, up 1500% vs. the recent baseline.',
  };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('validateReportContent: catches the exact "Returned to baseline" vs "up 1500%" contradiction', () => {
  const composed = composedWith([bigStoryInsight()]);
  const gemini = {
    executive_summary: 'Marketplace activity returned to baseline today.',
    body_markdown: '# Executive Summary\nReturned to baseline.\n## Biggest Story\nSearch activity was stable and within its normal range today.',
  };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, false);
  assert.ok(result.issues.length >= 1);
  assert.match(result.issues[0], /baseline|stable/i);
});

test('validateReportContent: does NOT flag a narrative that legitimately mentions both a spike and a later stabilization', () => {
  const composed = composedWith([bigStoryInsight()]);
  const gemini = {
    executive_summary: 'Searches spiked sharply today before stabilizing later in the day.',
    body_markdown: '# Executive Summary\nSpiked then stabilized.\n## Biggest Story\nSearches jumped up 1500% this morning, though activity was stable by evening.',
  };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, true);
});

test('validateReportContent: a borderline/low-severity insight is not held to the same strict standard', () => {
  const composed = composedWith([bigStoryInsight({ evidence: { today: 12, mean: 10, stddev: 2, z: 1.6, direction: 'up' } })]);
  const gemini = {
    executive_summary: 'Marketplace activity was broadly stable today with a minor uptick in searches.',
    body_markdown: '# Executive Summary\nBroadly stable.\n## Biggest Story\nActivity stayed within its normal range.',
  };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, true, 'a |z|=1.6 finding is not strong enough to make "stable" language contradictory');
});

test('validateReportContent: catches an invented percentage not present in any evidence/trend/metrics', () => {
  const composed = composedWith([]);
  const trends = { 'search.total': { today: 20, yesterday: 10, change_vs_yesterday: 100 } };
  const gemini = {
    executive_summary: 'WhatsApp clicks jumped an incredible 340% today, a remarkable result.',
    body_markdown: '# Executive Summary\nJumped 340%.\n## Biggest Story\nA huge, unprecedented spike.',
  };
  const result = validateReportContent(gemini, composed, trends, {});
  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /340/);
});

test('validateReportContent: a percentage that DOES match a trend/evidence number passes', () => {
  const composed = composedWith([]);
  const trends = { 'search.total': { today: 20, yesterday: 10, change_vs_yesterday: 100 } };
  const gemini = {
    executive_summary: 'Searches doubled today, up 100% vs. yesterday.',
    body_markdown: '# Executive Summary\nDoubled.\n## Biggest Story\nSearches were up 100% vs. yesterday.',
  };
  const result = validateReportContent(gemini, composed, trends, {});
  assert.equal(result.ok, true);
});

test('validateReportContent: a percentage grounded in the raw metrics summary (not just trends/evidence) also passes', () => {
  const composed = composedWith([]);
  const rawMetricsSummary = { listing_ctr: 0.084 }; // narrative might restate as "8%" or "8.4%"
  const gemini = {
    executive_summary: 'The listing click-through rate held at 8% today.',
    body_markdown: '# Executive Summary\nCTR at 8%.\n## Biggest Story\nNothing notable — CTR sat at 8%.',
  };
  const result = validateReportContent(gemini, composed, {}, rawMetricsSummary);
  assert.equal(result.ok, true);
});

test('validateReportContent: quiet composed input (no insights) with no percentages at all passes trivially', () => {
  const composed = composedWith([]);
  const gemini = { executive_summary: 'A quiet day.', body_markdown: '# Executive Summary\nA quiet day. Nothing notable happened.' };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, true);
});

// ── "# What Happened" — PROMPT_VERSION 4.0.0's new headline heading ─────
test('validateReportContent: recognises "# What Happened" (v4.0.0) as the headline section for direction-contradiction, same as the old "# Today\'s Story"', () => {
  const composed = composedWith([bigStoryInsight()]);
  const gemini = {
    executive_summary: 'Marketplace activity returned to baseline today.',
    body_markdown: '# What Happened\nSearch activity was stable and within its normal range today.\n## What It Means\nSomething else entirely.',
  };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, false, 'stable language under the new headline heading must still be checked against a real |z|>=2.5 spike');
  assert.match(result.issues.join(' '), /baseline|stable/i);
});
test('validateReportContent: a report using "# What Happened" that legitimately matches the data direction still passes', () => {
  const composed = composedWith([bigStoryInsight()]);
  const gemini = {
    executive_summary: 'Total searches surged 1500% today compared to the 30-day average.',
    body_markdown: '# What Happened\nSearches jumped sharply, up 1500% vs. the recent baseline.',
  };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, true);
});

// ── checkUnsupportedCausation — the mechanical backstop for the prompt's ──
// ── no-invented-causation rule (report-composer.js commonRules) ──────────
test('validateReportContent: flags an unhedged "caused by" claim anywhere in body_markdown, not just the headline sections', () => {
  const composed = composedWith([]);
  const gemini = {
    executive_summary: 'A quiet day overall.',
    body_markdown: '# What Happened\nNothing major today.\n## What Needs Attention\nThe missing price is caused by an admin error and is why this listing has 0 leads.',
  };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /unhedged cause-and-effect/i);
});
test('validateReportContent: does NOT flag a causal phrase when the same sentence also carries a hedge word ("hypothesis", "worth checking")', () => {
  const composed = composedWith([]);
  const gemini = {
    executive_summary: 'A quiet day overall.',
    body_markdown: '# What Happened\nNothing major today.\n## What Needs Attention\nThe missing price is the reason for the 0 leads, though this is just a hypothesis worth checking.',
  };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, true);
});
test('validateReportContent: does NOT flag ordinary prose that happens to contain "why" without an unhedged causal phrase', () => {
  const composed = composedWith([]);
  const gemini = {
    executive_summary: 'A quiet day overall.',
    body_markdown: '# What Happened\nHere is why today was quiet: traffic was low across the board.',
  };
  const result = validateReportContent(gemini, composed, {}, {});
  assert.equal(result.ok, true);
});

// ── buildValidationFallbackReport ────────────────────────────────────────
test('buildValidationFallbackReport: produces a plain, labeled report with no invented prose', () => {
  const composed = {
    period: { start: '2026-07-23', end: '2026-07-23' },
    new_insights: [bigStoryInsight()],
    continuing_insights: [],
    resolved_insights: [],
  };
  const report = buildValidationFallbackReport('daily', composed.period, composed);
  assert.match(report.title, /verified data only/i);
  assert.match(report.executive_summary, /validation failed/i);
  assert.match(report.body_markdown, /Total searches up 1500%/);
  assert.deepEqual(report.mentioned_districts, []);
});
