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

export function buildPrompt(reportType, composed, rawMetricsSummary, supply) {
  const newBlock = composed.new_insights.length
    ? composed.new_insights.map(insightSummaryLine).join('\n')
    : '(none)';
  const continuingBlock = composed.continuing_insights.length
    ? composed.continuing_insights.map(insightSummaryLine).join('\n')
    : '(none)';
  const resolvedBlock = composed.resolved_insights.length
    ? composed.resolved_insights.map(insightSummaryLine).join('\n')
    : '(none)';

  const supplyBlock = supply
    ? `\nCURRENT ACTIVE SUPPLY (live snapshot, not historical):\nBy district: ${JSON.stringify(supply.byDistrict)}\nBy property type: ${JSON.stringify(supply.byType)}\n`
    : '';

  const commonRules = `You are writing for Pintag, a real estate marketplace in Vientiane, Laos. You are given a set of insights that deterministic code has ALREADY detected, ranked, and classified as new/continuing/resolved — these are the only findings that exist. Your job is strictly to explain, connect, and narrate them clearly.

Do NOT:
- Discover anomalies yourself
- Decide what's significant
- Invent any statistic, percentage, or number not present in the data below
- State a number without it appearing in the evidence provided

You MAY:
- Explain WHY something might be happening, in plain business terms
- Connect related insights into one narrative (e.g. a demand spike + a supply shortage in the same district becomes one recruiting recommendation)
- Reference the raw metrics summary below for period totals

NEW INSIGHTS (🟢):\n${newBlock}\n
CONTINUING INSIGHTS (🔴):\n${continuingBlock}\n
RESOLVED INSIGHTS (✅):\n${resolvedBlock}
${supplyBlock}
RAW METRICS SUMMARY (period totals, safe to cite verbatim):
${JSON.stringify(rawMetricsSummary)}

Canonical districts: ${CANONICAL_DISTRICTS.join(', ')}. Canonical property types: ${CANONICAL_PROPERTY_TYPES.join(', ')}.`;

  const structureByType = {
    daily: `Write a DAILY INTELLIGENCE REPORT, 300-600 words, readable in under two minutes. Natural prose, not a list of statistics. Structure with these markdown headings, in order:
# Executive Summary
## Biggest Story
## Marketplace
## Buyer Behaviour
## Property Performance
## Product Insights
## Opportunities
## AI Recommendations`,
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
