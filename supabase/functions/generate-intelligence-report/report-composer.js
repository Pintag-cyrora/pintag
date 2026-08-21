// Report Composer — decides which insights a report discusses, in what
// role, and assembles Gemini's structured input. It never decides
// significance (that's the Insight Engine's job, already done before this
// runs) and never writes prose (that's Gemini's job, after this runs) —
// see INTELLIGENCE_ARCHITECTURE.md.
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as
// insight-engine.js / metrics-utils.js.

import { priorityScore } from './insight-engine.js';

export const CANONICAL_DISTRICTS = [
  'Chanthabouly', 'Sikhottabong', 'Xaythany', 'Sisattanak',
  'Hadxaifong', 'Saysettha', 'Naxaithong',
];
export const CANONICAL_PROPERTY_TYPES = [
  'house', 'townhouse', 'villa', 'apartment', 'condo', 'commercial', 'land',
];

const MAX_DISCUSSED_INSIGHTS = 8;

function stripInternal(i) {
  const { _priority, ...rest } = i;
  return rest;
}

// composeReportInput selects which insights this report discusses and
// assembles the structured payload Gemini will narrate. `db` is any
// object exposing `select(table, query) -> Promise<row[]>` (duck-typed,
// not imported from index.ts, so this module stays independently
// testable with a mock).
export async function composeReportInput(db, reportType, period, dailySweep) {
  let newInsights = [];
  let continuingInsights = [];
  let resolvedInsights = [];

  if (reportType === 'daily' && dailySweep) {
    newInsights = dailySweep.inserted;
    if (dailySweep.updatedIds.length) {
      continuingInsights = await db.select('intelligence_insights', `select=*&id=in.(${dailySweep.updatedIds.join(',')})`);
    }
    if (dailySweep.resolvedIds.length) {
      resolvedInsights = await db.select('intelligence_insights', `select=*&id=in.(${dailySweep.resolvedIds.join(',')})`);
    }
  } else {
    // Weekly/Monthly are pure readers of insight state — no detection here.
    // "New" = opened within this period; "resolved" = resolved within this
    // period; "continuing" = still open, opened before this period, active
    // during it (last_seen falls inside the window).
    newInsights = await db.select(
      'intelligence_insights',
      `select=*&first_seen=gte.${period.start}&first_seen=lte.${period.end}`
    );
    resolvedInsights = await db.select(
      'intelligence_insights',
      `select=*&resolved_at=gte.${period.start}T00:00:00&resolved_at=lte.${period.end}T23:59:59`
    );
    const stillOpen = await db.select(
      'intelligence_insights',
      `select=*&resolved_at=is.null&last_seen=gte.${period.start}`
    );
    const newIds = new Set(newInsights.map((i) => i.id));
    continuingInsights = stillOpen.filter((i) => !newIds.has(i.id));
  }

  // Rank by read-time priority; always keep every new/resolved insight
  // regardless of rank (continuity matters more than rank for those), cap
  // the total so reports don't bloat as open insights accumulate.
  const withPriority = (arr) => arr.map((i) => ({ ...i, _priority: priorityScore(i) }));
  const rankedContinuing = withPriority(continuingInsights).sort((a, b) => b._priority - a._priority);

  const mustKeep = [...newInsights, ...resolvedInsights];
  const remainingSlots = Math.max(0, MAX_DISCUSSED_INSIGHTS - mustKeep.length);
  const discussedContinuing = rankedContinuing.slice(0, remainingSlots);

  return {
    period,
    new_insights: newInsights.map(stripInternal),
    continuing_insights: discussedContinuing.map(stripInternal),
    resolved_insights: resolvedInsights.map(stripInternal),
  };
}

// A period with nothing new, continuing, or resolved has nothing for
// Gemini to narrate — the daily orchestrator uses this to skip the Gemini
// call entirely (see buildQuietDayReport below) rather than asking the
// model to pad 300-600 words about nothing.
export function isQuietPeriod(composed) {
  return composed.new_insights.length === 0 &&
    composed.continuing_insights.length === 0 &&
    composed.resolved_insights.length === 0;
}

// Deterministic report content for a quiet period — same output shape as
// a parsed Gemini response (title/executive_summary/body_markdown/
// mentioned_districts/mentioned_property_types), so the caller can treat
// it identically either way. This is what replaced the old "skip a
// section if nothing worth saying" prompt instruction: the quiet case is
// now handled by code, not by asking the AI to judge it.
export function buildQuietDayReport(reportType, period) {
  const labelByType = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  const label = labelByType[reportType] || reportType;
  const periodLabel = period.start === period.end ? period.start : `${period.start} to ${period.end}`;
  const summary = `No statistically significant changes were detected for ${periodLabel}. Marketplace activity stayed within its normal range.`;
  return {
    title: `${label} report: quiet period, nothing notable`,
    executive_summary: summary,
    body_markdown: `# Executive Summary\n${summary}`,
    mentioned_districts: [],
    mentioned_property_types: [],
  };
}

function insightSummaryLine(i) {
  const dims = [i.dimension_district, i.dimension_property_type].filter(Boolean).join('/');
  return `- [${i.type}] ${i.title}${dims ? ` (${dims})` : ''} — severity: ${i.severity}, confidence: ${Math.round((i.confidence || 0) * 100)}%, trend: ${i.trend}${i.recommendation ? `, suggested action: ${i.recommendation}` : ''}`;
}

export function buildPrompt(reportType, composed, rawMetricsSummary, supply, trendAnalysis) {
  const newBlock = composed.new_insights.length
    ? composed.new_insights.map(insightSummaryLine).join('\n')
    : '(none)';
  const continuingBlock = composed.continuing_insights.length
    ? composed.continuing_insights.map(insightSummaryLine).join('\n')
    : '(none)';
  const resolvedBlock = composed.resolved_insights.length
    ? composed.resolved_insights.map(insightSummaryLine).join('\n')
    : '(none)';

  // For WEEKLY/MONTHLY the composition of supply IS the story. For DAILY it
  // is standing background: "Sisattanak has X listings" is true every day and
  // says nothing about today, so it is explicitly marked do-not-narrate unless
  // a linked insight or the trend analysis shows it actually moved. This is
  // the single biggest cause of a daily report reading like a monthly one.
  const supplyBlock = supply
    ? (reportType === 'daily'
        ? `\nCURRENT ACTIVE SUPPLY (BACKGROUND CONTEXT ONLY — do NOT describe this composition in the report. It is the same most days and is not news. Use it only to interpret a change that the insights or trend analysis actually show, e.g. to explain why one district absorbed a demand spike):\nBy district: ${JSON.stringify(supply.byDistrict)}\nBy property type: ${JSON.stringify(supply.byType)}\n`
        : `\nCURRENT ACTIVE SUPPLY (live snapshot, not historical):\nBy district: ${JSON.stringify(supply.byDistrict)}\nBy property type: ${JSON.stringify(supply.byType)}\n`)
    : '';

  // Trend Calculator output (product spec §3/§7) — the ONLY comparisons
  // ("today vs yesterday," "vs the 7/30-day average," Week/Month-over-
  // Week) this report may state. A null field means the comparison
  // couldn't be computed (no history yet, or a baseline too small to
  // divide by meaningfully) — that must be narrated as "not enough data
  // to compare," never guessed at or silently rounded to a number.
  const trendBlock = trendAnalysis
    ? `\nTREND ANALYSIS (pre-computed, exact — the ONLY comparisons/percentages you may state; a null value means that comparison genuinely cannot be made yet, say so in words rather than inventing a number):\n${JSON.stringify(trendAnalysis)}\n`
    : '';

  const commonRules = `You are writing for Pintag, a real estate marketplace in Vientiane, Laos. You are given a set of insights that deterministic code has ALREADY detected, ranked, and classified as new/continuing/resolved, plus a pre-computed trend analysis — these are the only findings and the only numbers that exist. Your job is strictly to explain, connect, and narrate them clearly.

Do NOT:
- Discover anomalies yourself
- Decide what's significant
- Invent, estimate, or recompute any statistic, percentage, or number not present in the data below
- State a number without it appearing in the evidence, trend analysis, or raw metrics provided
- Describe the data as "stable," "back to baseline," or "normal" when the trend analysis or a linked insight shows a statistically significant change in the same section — direction language must match the data

You MAY:
- Explain WHY something might be happening, in plain business terms
- Connect related insights into one narrative (e.g. a demand spike + a supply shortage in the same district becomes one recruiting recommendation)
- Reference the raw metrics summary below for period totals
- Say plainly "not enough data to compare yet" wherever the trend analysis shows null — this is the correct, honest thing to say, not a gap to fill in

NEW INSIGHTS (🟢):\n${newBlock}\n
CONTINUING INSIGHTS (🔴):\n${continuingBlock}\n
RESOLVED INSIGHTS (✅):\n${resolvedBlock}
${supplyBlock}${trendBlock}
RAW METRICS SUMMARY (period totals, safe to cite verbatim):
${JSON.stringify(rawMetricsSummary)}

Canonical districts: ${CANONICAL_DISTRICTS.join(', ')}. Canonical property types: ${CANONICAL_PROPERTY_TYPES.join(', ')}.`;

  const structureByType = {
    daily: `Write a DAILY INTELLIGENCE BRIEFING for the founder. It must be readable in UNDER 60 SECONDS — aim for 200-350 words. This is a briefing about TODAY, not a market report.

It answers exactly four things: what happened today, what changed, what matters, and what to do next.

COMPARISON HIERARCHY — use in this order:
1. TODAY vs YESTERDAY is the primary comparison. Lead with it.
2. The 7-day average is SECONDARY context, for saying whether today's move is part of a pattern.
3. The 30-day average ONLY when it reveals a genuinely significant anomaly. Do not walk every metric through all three baselines — that is what makes this read like a monthly report.

SMALL SAMPLES — a percentage is not automatically a finding. When the underlying counts are small (roughly single digits), say so in words instead of leading with the percentage: 1 to 2 events is +100% and usually means nothing. Reserve percentage-led statements for metrics with real volume. Interpret a zero in the context of the day's other volume — "0 leads" means something different on a day with 24 gallery interactions than on a day with no traffic at all.

DO NOT RESTATE STANDING FACTS. Which district holds the most listings, which property type is most common, the median price, the overall marketplace composition — these are the same most days and are NOT news. Mention one only when it materially changed or when it is needed to explain a change. Avoid openers like "The marketplace currently...", "Sisattanak currently holds...", "Apartments continue to be...".

WRITE LIKE THIS: "Search activity fell 37% today but remains above the 7-day average." / "Gallery engagement rose again today, suggesting users are actively exploring listing photos." / "Despite strong gallery engagement, no leads were created today — this is the biggest conversion question to investigate." / "Five active listings are still missing prices and should be fixed."

Structure with these markdown headings, in order. OMIT ANY SECTION THAT HAS NO REAL CONTENT TODAY — do not pad, and never write "nothing to report" under a heading:
# Today's Story
(1-3 sentences: the single most important thing that happened today.)
## What Changed Today
(A short list of the meaningful changes vs yesterday. Not every metric — the ones that matter.)
## Buyer Behaviour
(What users actually DID: searches, listing views, gallery interactions, contacts, leads. Interpretation, not a list of numbers.)
## Listings To Watch
(Only listings that deserve attention today: unusual engagement, high impressions with poor CTR, views but no contacts, missing critical data, a sudden change. Omit the section if none qualify.)
## Data / Product Issues
(Data-quality and product problems, kept separate from marketplace performance. Omit if none.)
## Tomorrow's Priorities
(2-4 concrete actions that follow from today's intelligence.)`,
    weekly: `Write a WEEKLY INTELLIGENCE REPORT. Compare this week to the previous week; highlight TRENDS, not just totals. Structure with these markdown headings:
# Executive Summary
## What Changed This Week
## Continuing Trends
## Resolved This Week
## Recommendations`,
    monthly: `Write a MONTHLY INTELLIGENCE REPORT. Professional executive market summary — should read like a CBRE, JLL or Savills market report, suitable for management or investors, not like raw analytics. Structure with these markdown headings:
# Executive Summary
## Market Overview
## Demand & Supply
## Notable Trends This Month
## Outlook & Recommendations`,
  };

  return `${commonRules}\n\n${structureByType[reportType]}\n\nReturn ONLY valid JSON, no additional text, in this exact format:
{
  "title": "a short descriptive title for this report, max 100 characters",
  "executive_summary": "2-3 sentences, the absolute headline takeaway",
  "body_markdown": "the full report body using the headings above",
  "mentioned_districts": ["array of canonical district names actually discussed"],
  "mentioned_property_types": ["array of canonical property type keys actually discussed"]
}`;
}

// Which insights get linked to the generated report, and in what role.
// 'biggest_story' is whichever new/continuing insight ranks highest by
// read-time priority; everything else discussed gets 'mentioned'.
// Deduplicated by insight id — an insight that qualifies as both "new"
// and "resolved" within the same weekly/monthly period (opened and
// closed inside one window) must produce exactly one link, not two: two
// rows with the same (report_id, insight_id, role) would violate the
// join table's primary key, and even when roles happened to differ, the
// same insight would otherwise render as two duplicate chips in the
// frontend. Higher-priority role wins when an insight would otherwise
// qualify for more than one.
const ROLE_PRIORITY = { biggest_story: 2, mentioned: 1 };

export function buildReportInsightLinks(composed) {
  const roleById = new Map();
  function consider(insight, role) {
    if (!insight || !insight.id) return;
    const current = roleById.get(insight.id);
    if (!current || (ROLE_PRIORITY[role] || 0) > (ROLE_PRIORITY[current] || 0)) {
      roleById.set(insight.id, role);
    }
  }

  const candidates = [...composed.new_insights, ...composed.continuing_insights]
    .map((i) => ({ ...i, _priority: priorityScore(i) }))
    .sort((a, b) => b._priority - a._priority);
  const biggestStoryId = candidates[0]?.id;
  candidates.forEach((i) => consider(i, i.id === biggestStoryId ? 'biggest_story' : 'mentioned'));
  composed.resolved_insights.forEach((i) => consider(i, 'mentioned'));

  return Array.from(roleById.entries()).map(([insight_id, role]) => ({ insight_id, role }));
}
