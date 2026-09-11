// The DAILY report is a decision-making report, not a monthly executive
// summary and not an undifferentiated analytics dump.
//   node --test supabase/functions/generate-intelligence-report/daily-briefing.test.js
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

test('the daily report asks for the five-section Facts->Actions structure, in order (Intelligence report rework, v4.0.0)', () => {
  const p = daily();
  const want = ['# What Happened', '## What Users Are Doing', '## What It Means',
                '## What Needs Attention', '## Recommended Actions'];
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
                      '## Opportunities', '## AI Recommendations', '## Biggest Story',
                      "# Today's Story", '## What Changed Today', '## Buyer Behaviour',
                      '## Customer Intent', '## Unmet Demand & Inventory Opportunities',
                      '## Listings To Watch', '## Data / Product Issues', "## Tomorrow's Priorities"]) {
    assert.ok(!p.includes(dead), 'daily should no longer request: ' + dead);
  }
});

test('customer intent / unmet demand guidance survives inside the new sections, even though their own headings are gone', () => {
  const p = daily();
  const usersDoingIdx = p.indexOf('## What Users Are Doing');
  const custIntentIdx = p.indexOf('CUSTOMER INTENT SEGMENTS', usersDoingIdx);
  assert.ok(usersDoingIdx > -1 && custIntentIdx > usersDoingIdx, 'customer intent guidance should live inside "What Users Are Doing"');
  const attentionIdx = p.indexOf('## What Needs Attention');
  const unmetIdx = p.indexOf('unmet_demand.', attentionIdx);
  assert.ok(attentionIdx > -1 && unmetIdx > attentionIdx, 'unmet-demand guidance should live inside "What Needs Attention"');
  assert.match(p, /low_performing_listing/);
  assert.match(p, /high_performing_listing/);
});

test('every sentence lives in exactly one section -- facts, then behaviour, then interpretation, then attention, then actions', () => {
  const p = daily();
  assert.match(p, /Every sentence belongs in exactly one of the five sections below/);
  assert.match(p, /facts in their place, interpretation in its place, never blended into the same sentence/);
  assert.match(p, /PURE FACTS ONLY — no interpretation, no confidence tags/);
  assert.match(p, /Interpretation ONLY, and ONLY here/);
});

test('confidence labels are defined and reserved for interpretation, never for plain facts', () => {
  const p = daily();
  assert.match(p, /🟢 CONFIRMED — directly supported by the data/);
  assert.match(p, /🟡 LIKELY — a strong, reasonable conclusion/);
  assert.match(p, /⚪ HYPOTHESIS — a plausible explanation the data cannot yet confirm/);
  assert.match(p, /A plain factual metric or comparison .* never gets a tag/);
  assert.match(p, /every sentence in this section carries a 🟢\/🟡\/⚪ confidence tag/);
});

test('a stated percentage must also state the raw values it was computed from', () => {
  const p = daily();
  assert.match(p, /State a percentage without ALSO stating the underlying values it was computed from/);
  assert.match(p, /180 vs ~23 30-day average \(\+~683%\)/);
});

test('a very large move against a small baseline leads with the absolute difference and a multiplier, not a bare huge percentage', () => {
  const p = daily();
  assert.match(p, /When today's move against a SMALL baseline is very large/);
  assert.match(p, /180 vs 15 yesterday \(\+165 interactions; 12× yesterday\)/);
  assert.match(p, /a huge percentage on a tiny baseline is the least informative way to say it/);
  assert.match(p, /Never let a percentage be the most prominent thing in a sentence when a tiny baseline is what's driving its size/);
  // The 30-day comparison must still be shown, as its own percentage figure.
  assert.match(p, /Still give the 30-day comparison as its own figure/);
});

test('a small sample is a signal to investigate, never proof of a problem -- and below "moderate" confidence the model must say so, not diagnose', () => {
  const p = daily();
  assert.match(p, /Treat a small sample as proof of a problem/);
  assert.match(p, /A listing with few impressions and 0 leads is a signal to investigate, not evidence it is failing/);
  assert.match(p, /Insufficient data to determine performance/);
  assert.match(p, /Below "moderate" confidence, do not diagnose the listing/);
});

test('gallery interactions: the aggregate trend may be discussed, but the model must disclose it cannot attribute engagement to specific listings or users', () => {
  const p = daily();
  assert.match(p, /do NOT break gallery interactions down by which listing, which photo, or how many distinct users/);
  assert.match(p, /say plainly that today's data cannot show which listings or how many users drove it — do not guess/);
  // The comparison it MAY legitimately draw instead -- against other real trend figures.
  assert.match(p, /compare the gallery-engagement trend against the listing-views and WhatsApp-click trends already given/);
});

test("the final action example no longer presupposes per-listing gallery data that doesn't exist", () => {
  // The original v3.0.0 "Strong" action example ("Check the gallery-loading
  // path on the listings receiving unusually high gallery interaction")
  // assumed a per-listing gallery breakdown the analytics never collected --
  // exactly what the new GALLERY INTERACTIONS honesty rule now forbids
  // claiming. Replaced with an example grounded in data that really exists
  // (impressions_no_leads / data-quality detectors).
  const p = daily();
  assert.ok(!p.includes('Check the gallery-loading path on the listings receiving unusually high gallery interaction'));
  assert.match(p, /Complete the missing location data on the listing with 16 impressions and 0 leads today/);
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
  // The zero-in-context rule outgrew this test and has its own below.
});

test('standing marketplace facts are explicitly banned unless they moved', () => {
  const p = daily();
  assert.match(p, /DO NOT NARRATE STANDING MARKETPLACE FACTS/);
  // The four values must be named individually — a vague "avoid composition"
  // instruction is what the model kept talking through.
  for (const v of ['current district inventory composition', 'current property-type composition',
                   'the current median price', 'total inventory']) {
    assert.ok(p.includes(v), 'must name: ' + v);
  }
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

test('length is a CEILING with no minimum — a short strong briefing is correct', () => {
  const p = daily();
  assert.match(p, /UNDER 60 SECONDS/);
  assert.match(p, /UNDER 350 WORDS — that is a ceiling, not a target, and there is NO minimum/);
  assert.match(p, /Never add a sentence to reach a length/);
  // A floor would invite padding, which is the opposite of the goal: a 150-word
  // briefing backed by evidence beats a padded 300-word one.
  assert.ok(!/200-350/.test(p), 'no lower bound may be stated');
  assert.ok(!/300-600 words/.test(p), 'the old daily length target must be gone');
});

test('ONE dominant story — signals are connected, not listed side by side', () => {
  const p = daily();
  assert.match(p, /ONE STORY, NOT FIVE/);
  assert.match(p, /the FIRST new-or-continuing insight is the day's story/);
  assert.match(p, /do not present several competing "biggest stories"/i);
  // The worked example must show two signals becoming one conversion story.
  assert.match(p, /Gallery engagement remains unusually strong, but today's users are not progressing to contact/);
});

test('the final section demands concrete, evidence-grounded actions, each with what/why/where/monitor', () => {
  const p = daily();
  for (const generic of ['consider optimizing image loading', 'investigate further', 'continue monitoring']) {
    assert.ok(p.toLowerCase().includes(generic.toLowerCase()),
      'must name the generic phrasing it rejects: ' + generic);
  }
  assert.match(p, /A generic instruction is not an action/);
  assert.match(p, /Complete the missing location data on the listing with 16 impressions and 0 leads today/);
  assert.match(p, /grounded in evidence that appears above/);
  assert.match(p, /what to do, why .* which listing or data point it relates to, and what to monitor afterward/);
  // And the count must follow the evidence, not the heading.
  assert.match(p, /If today's evidence supports only two actions, give two/);
});

test('a zero is judged against the day\'s traffic, not treated as automatically critical', () => {
  const p = daily();
  assert.match(p, /A ZERO IS ONLY AS INTERESTING AS THE TRAFFIC AROUND IT/);
  assert.match(p, /do NOT treat every zero-lead day as a critical problem/);
  assert.match(p, /0 leads with little or no traffic: no conclusion to draw/);
  assert.match(p, /0 leads with meaningful listing views or clicks: a real conversion problem/);
  assert.match(p, /0 leads with strong gallery engagement: possible conversion friction/);
  assert.match(p, /stated as a question rather than a verdict/);
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
  // 4.0.0 (Intelligence + Decision-Making rework) supersedes 3.0.0 (Customer
  // Intent) for the same reason every prior major bump did: a daily report
  // generated under the new prompt answers a materially different question
  // (five fixed sections, confidence-tagged interpretation, sample-size
  // honesty, gallery-attribution honesty) and must not be read as the same
  // artefact as one generated under 3.x.
  assert.equal(PROMPT_VERSION, '4.0.0', 'a 3.x daily report answers a different question from a 4.x one');
  // 1.2.0: headlineSections() also recognises "# What Happened", plus the
  // new checkUnsupportedCausation() check -- see report-validator.js.
  assert.equal(VALIDATOR_VERSION, '1.2.0');
  // Untouched layers must NOT have been bumped — the analytics did not
  // change meaning (no field renamed/removed/reinterpreted) and
  // intelligence_reports' own row shape is unchanged by this rework.
  assert.equal(SNAPSHOT_SCHEMA_VERSION, '1.1.0');
  assert.equal(REPORT_FORMAT_VERSION, '1.1.0');
});
