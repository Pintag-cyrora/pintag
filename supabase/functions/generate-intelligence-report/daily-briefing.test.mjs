// The DAILY report is a briefing, not a monthly executive summary.
//   node --test supabase/functions/generate-intelligence-report/daily-briefing.test.mjs
//
// Only the prompt, the section structure and the comparison hierarchy changed.
// The analytics, the Insight Engine, the trend calculator and the pipeline are
// untouched — these tests pin that too, because "make it read better" must not
// quietly become "change what the numbers mean".

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from './report-composer.js';
import { PROMPT_VERSION, VALIDATOR_VERSION, SNAPSHOT_SCHEMA_VERSION, REPORT_FORMAT_VERSION } from './versions.js';

const composed = { new_insights: [], continuing_insights: [], resolved_insights: [] };
const supply = { byDistrict: { Sisattanak: 42, Saysettha: 31 }, byType: { apartment: 50 } };
const trends = { searches: { today: 12, vs_yesterday: -0.37, vs_7day: 0.08 } };
const daily = () => buildPrompt('daily', composed, { views: 100 }, supply, trends);

test('the daily briefing asks for the new six-section structure, in order', () => {
  const p = daily();
  const want = ["# Today's Story", '## What Changed Today', '## Buyer Behaviour',
                '## Listings To Watch', '## Data / Product Issues', "## Tomorrow's Priorities"];
  let at = -1;
  for (const h of want) {
    const i = p.indexOf(h);
    assert.ok(i > -1, 'missing section: ' + h);
    assert.ok(i > at, 'out of order: ' + h);
    at = i;
  }
});

test('the OLD daily sections are gone', () => {
  const p = daily();
  for (const dead of ['## Marketplace', '## Property Performance', '## Product Insights',
                      '## Opportunities', '## AI Recommendations', '## Biggest Story']) {
    assert.ok(!p.includes(dead), 'daily should no longer request: ' + dead);
  }
});

test('yesterday is primary, 7-day secondary, 30-day only for real anomalies', () => {
  const p = daily();
  assert.match(p, /TODAY vs YESTERDAY is the primary comparison/i);
  assert.match(p, /7-day average is SECONDARY/i);
  assert.match(p, /30-day average ONLY when it reveals a genuinely significant anomaly/i);
  // And it must say NOT to walk every metric through all three.
  assert.match(p, /Do not walk every metric through all three baselines/i);
});

test('small samples must be described, not sold as percentages', () => {
  const p = daily();
  assert.match(p, /1 to 2 events is \+100% and usually means nothing/i);
  assert.match(p, /Reserve percentage-led statements for metrics with real volume/i);
  assert.match(p, /0 leads.*different on a day with 24 gallery interactions/is);
});

test('standing marketplace facts are explicitly banned unless they moved', () => {
  const p = daily();
  assert.match(p, /DO NOT RESTATE STANDING FACTS/);
  for (const phrase of ['The marketplace currently', 'Sisattanak currently holds',
                        'Apartments continue to be']) {
    assert.ok(p.includes(phrase), 'must name the banned opener: ' + phrase);
  }
});

test('supply composition is background for DAILY and narrative for weekly/monthly', () => {
  assert.match(daily(), /BACKGROUND CONTEXT ONLY — do NOT describe this composition/);
  // The same block must stay narratable where composition IS the story.
  for (const t of ['weekly', 'monthly']) {
    const p = buildPrompt(t, composed, {}, supply, trends);
    assert.ok(!p.includes('BACKGROUND CONTEXT ONLY'), t + ' must keep supply as narrative');
    assert.match(p, /CURRENT ACTIVE SUPPLY \(live snapshot/);
  }
});

test('the briefing is short and says so', () => {
  const p = daily();
  assert.match(p, /UNDER 60 SECONDS/);
  assert.match(p, /200-350 words/);
  assert.ok(!/300-600 words/.test(p), 'the old daily length target must be gone');
});

test('empty sections are omitted rather than padded', () => {
  const p = daily();
  assert.match(p, /OMIT ANY SECTION THAT HAS NO REAL CONTENT TODAY/);
  assert.match(p, /never write "nothing to report" under a heading/i);
});

test('weekly and monthly structures are UNCHANGED', () => {
  const w = buildPrompt('weekly', composed, {}, supply, trends);
  for (const h of ['# Executive Summary', '## What Changed This Week',
                   '## Continuing Trends', '## Resolved This Week', '## Recommendations']) {
    assert.ok(w.includes(h), 'weekly lost: ' + h);
  }
  const m = buildPrompt('monthly', composed, {}, supply, trends);
  for (const h of ['## Market Overview', '## Demand & Supply',
                   '## Notable Trends This Month', '## Outlook & Recommendations']) {
    assert.ok(m.includes(h), 'monthly lost: ' + h);
  }
});

test('the grounding rules that stop invented numbers are PRESERVED', () => {
  // The narrative changed; the honesty constraints must not have.
  const p = daily();
  assert.match(p, /Invent, estimate, or recompute any statistic/);
  assert.match(p, /the ONLY comparisons\/percentages you may state/);
  assert.match(p, /not enough data to compare yet/);
  assert.match(p, /Discover anomalies yourself/);
  // The pre-computed trend analysis and raw metrics are still handed over.
  assert.match(p, /TREND ANALYSIS \(pre-computed, exact/);
  assert.match(p, /RAW METRICS SUMMARY/);
  assert.ok(p.includes(JSON.stringify(trends)), 'trend values must reach the model verbatim');
});

test('the JSON output contract is unchanged', () => {
  const p = daily();
  for (const f of ['"title"', '"executive_summary"', '"body_markdown"',
                   '"mentioned_districts"', '"mentioned_property_types"']) {
    assert.ok(p.includes(f), 'output contract lost: ' + f);
  }
});

test('version metadata records the change', () => {
  assert.equal(PROMPT_VERSION, '2.0.0', 'a 1.x daily report answers a different question');
  assert.equal(VALIDATOR_VERSION, '1.1.0');
  // Untouched layers must NOT have been bumped — the analytics did not change.
  assert.equal(SNAPSHOT_SCHEMA_VERSION, '1.1.0');
  assert.equal(REPORT_FORMAT_VERSION, '1.1.0');
});
