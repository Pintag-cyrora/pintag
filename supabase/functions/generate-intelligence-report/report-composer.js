// Report Composer — decides which insights a report discusses, in what
// role, and assembles Gemini's structured input. It never decides
// significance (that's the Insight Engine's job, already done before this
// runs) and never writes prose (that's Gemini's job, after this runs) —
// see INTELLIGENCE_ARCHITECTURE.md.
//
// Plain JS, same dual-runtime (Deno + node unit tests) rationale as
// insight-engine.js / metrics-utils.js.

import { priorityScore } from './insight-engine.js';
import { dataConfidenceLabel } from './trend-calculator.js';

export const CANONICAL_DISTRICTS = [
  'Chanthabouly', 'Sikhottabong', 'Xaythany', 'Sisattanak',
  'Hadxaifong', 'Saysettha', 'Naxaithong',
];
export const CANONICAL_PROPERTY_TYPES = [
  'house', 'townhouse', 'villa', 'row_rooms', 'apartment', 'condo', 'commercial', 'land',
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

// Sample-size confidence for a listing-performance insight (low_performing/
// high_performing_listing carry an `impressions` count in evidence — see
// listing-performance-detector.js). Reuses dataConfidenceLabel() verbatim
// (trend-calculator.js) — the same <10/<30/<100/100+ bands already used
// everywhere else a sample size needs banding — rather than inventing a
// second confidence concept. This is distinct from `confidence` above,
// which is the DETECTOR's certainty that the fact is true (fixed at 1.0 for
// every rule-based detector); this is "how much weight the SAMPLE can bear",
// which is what tells Gemini whether it may diagnose the listing at all or
// must say "Insufficient data to determine performance" instead.
function sampleConfidenceNote(i) {
  const impressions = i.evidence && typeof i.evidence.impressions === 'number' ? i.evidence.impressions : null;
  if (impressions === null) return '';
  return `, sample size: ${impressions} impressions (${dataConfidenceLabel(impressions)} confidence)`;
}

function insightSummaryLine(i) {
  const dims = [i.dimension_district, i.dimension_property_type].filter(Boolean).join('/');
  return `- [${i.type}] ${i.title}${dims ? ` (${dims})` : ''} — severity: ${i.severity}, confidence: ${Math.round((i.confidence || 0) * 100)}%${sampleConfidenceNote(i)}, trend: ${i.trend}${i.recommendation ? `, suggested action: ${i.recommendation}` : ''}`;
}

// Intelligence V2 (Customer Intent / Unmet Demand / Conversion Leaks —
// product spec §A/§B/§G/§J). customer_intent_segments and journey_join are
// already INSIDE rawMetricsSummary below (it is the whole day's metrics
// object, unchanged), but get the same explicit call-out supplyBlock/
// trendBlock already do — a model asked to find and correctly interpret
// two specific keys inside one large JSON blob, unprompted, is far less
// reliable than being told exactly what they mean and how to use them.
//
// DAILY ONLY: metrics-utils.js's sumMetrics() (weekly/monthly's
// rawMetricsSummary) does not merge these two fields across days yet — a
// deliberate v1 scope decision, not an oversight — so they are simply
// absent from a weekly/monthly rawMetricsSummary and this returns ''.
//
// Segments are (transaction_type, property_type, district) — NOT
// bedrooms: search_events.bedrooms is a real column but listings.html has
// no bedroom filter, so it is never populated and is not a real intent
// signal. top_price_band is the single most-searched price range WITHIN
// a segment, reported as context, not part of what defines the segment.
function customerIntentBlock(reportType, rawMetricsSummary) {
  if (reportType !== 'daily') return '';
  const segments = rawMetricsSummary && Array.isArray(rawMetricsSummary.customer_intent_segments)
    ? rawMetricsSummary.customer_intent_segments : null;
  if (!segments) return '';

  const jj = rawMetricsSummary.journey_join || null;
  const joinRatePct = (jj && jj.lead_events_with_session > 0)
    ? Math.round((jj.lead_events_matched_to_click / jj.lead_events_with_session) * 100)
    : null;

  return `\nCUSTOMER INTENT SEGMENTS (today, pre-computed, ranked by search volume — each is (transaction_type, property_type, district); bedrooms is NEVER part of a segment because it is not a real captured search filter today; top_price_band is the single most-searched price range within that segment, not part of what defines it):\n${JSON.stringify(segments)}\n` +
    (jj ? `\nJOURNEY-JOIN CONFIDENCE (how much of the search → click → contact chain is actually traceable via a shared session id today — this is a MEASURED rate, not an assumption; treat any segment-level lead/conversion claim above as carrying this same confidence, and say so explicitly when the rate is low rather than presenting the segment's lead counts as certain): ${JSON.stringify(jj)}${joinRatePct !== null ? ` — ${joinRatePct}% of session-attributed contacts today matched back to an earlier click in the same session` : ' — no session-attributed contacts today to measure a rate from'}\n` : '');
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

  const customerIntentBlockText = customerIntentBlock(reportType, rawMetricsSummary);

  const commonRules = `You are writing for Pintag, a real estate marketplace in Vientiane, Laos. You are given a set of insights that deterministic code has ALREADY detected, ranked, and classified as new/continuing/resolved, plus a pre-computed trend analysis — these are the only findings and the only numbers that exist. Your job is strictly to explain, connect, and narrate them clearly.

Do NOT:
- Discover anomalies yourself
- Decide what's significant
- Invent, estimate, or recompute any statistic, percentage, or number not present in the data below
- State a number without it appearing in the evidence, trend analysis, or raw metrics provided
- State a percentage without ALSO stating the underlying values it was computed from, using the exact figures already given. When today's move against a SMALL baseline is very large (roughly 5x or more), lead with the absolute difference and a multiplier instead of a percentage — e.g. "180 vs 15 yesterday (+165 interactions; 12× yesterday)" reads better than "+1100% vs yesterday" on the same numbers, because a huge percentage on a tiny baseline is the least informative way to say it. Still give the 30-day comparison as its own figure, e.g. "180 vs ~23 30-day average (+~683%)" — a percentage against a larger, steadier baseline is fine to state once the raw values sit right next to it. Never let a percentage be the most prominent thing in a sentence when a tiny baseline is what's driving its size
- Describe the data as "stable," "back to baseline," or "normal" when the trend analysis or a linked insight shows a statistically significant change in the same section — direction language must match the data
- Claim a CAUSE for an outcome beyond what the evidence directly shows. "This listing has 40 impressions, 0 leads, and is missing a price" is a fact you may state. "The missing price caused the 0 leads" is a claim this data cannot prove — state the facts side by side and phrase the connection as a hedged possibility ("may indicate", "worth checking whether"), never as a stated cause. Same discipline for behavioural claims: never state "users aren't contacting because they lack information" as fact — write "high gallery engagement combined with limited contact activity may indicate users want more information before contacting; this is a hypothesis and should be monitored" instead
- Treat a small sample as proof of a problem. A listing with few impressions and 0 leads is a signal to investigate, not evidence it is failing. When a listing's sample size is below "moderate" confidence (see the sample-size note next to its evidence below), do not diagnose it — write "Insufficient data to determine performance" and move on

You MAY:
- Explain WHY something might be happening, in plain business terms, ALWAYS as a hedged possibility unless the data makes it a plain fact
- Connect related insights into one narrative (e.g. a demand spike + a supply shortage in the same district becomes one recruiting recommendation)
- Reference the raw metrics summary below for period totals
- Say plainly "not enough data to compare yet" wherever the trend analysis shows null — this is the correct, honest thing to say, not a gap to fill in
- Use the CUSTOMER INTENT SEGMENTS data (when present) to describe what customers were actually looking for, which segments are underserved (also visible as a [supply_shortage] insight above when severe enough to open one), and which specific listings are worth fixing (also visible as [low_performing_listing]/[high_performing_listing] insights above) — always through the journey-join confidence caveat when discussing lead/conversion counts for a segment

CONFIDENCE LABELS — every INTERPRETIVE or diagnostic statement (a conclusion, an explanation, "this might mean X") must carry exactly one of these three tags. A plain factual metric or comparison ("Gallery interactions: 180 today vs 15 yesterday") never gets a tag — tags are for what you conclude FROM the facts, never for the facts themselves:
🟢 CONFIRMED — directly supported by the data, no interpretive leap
🟡 LIKELY — a strong, reasonable conclusion the available data supports, but not proven beyond doubt
⚪ HYPOTHESIS — a plausible explanation the data cannot yet confirm; say explicitly what would need to be true, or what to monitor, to confirm or rule it out

GALLERY INTERACTIONS — today's analytics measure a marketplace-wide total, and the trend analysis can compare it to yesterday/7-day/30-day averages, but they do NOT break gallery interactions down by which listing, which photo, or how many distinct users generated them. When gallery engagement is worth discussing, state what the aggregate trend actually shows, and say plainly that today's data cannot show which listings or how many users drove it — do not guess. You MAY compare the gallery-engagement trend against the listing-views and WhatsApp-click trends already given (e.g. "gallery engagement rose while WhatsApp clicks stayed flat") since both are real figures in the trend analysis, not a guess.

NEW INSIGHTS (🟢):\n${newBlock}\n
CONTINUING INSIGHTS (🔴):\n${continuingBlock}\n
RESOLVED INSIGHTS (✅):\n${resolvedBlock}
${supplyBlock}${trendBlock}${customerIntentBlockText}
RAW METRICS SUMMARY (period totals, safe to cite verbatim):
${JSON.stringify(rawMetricsSummary)}

Canonical districts: ${CANONICAL_DISTRICTS.join(', ')}. Canonical property types: ${CANONICAL_PROPERTY_TYPES.join(', ')}.`;

  const structureByType = {
    daily: `Write a DAILY INTELLIGENCE REPORT for the founder — a decision-making report, not an analytics dump. It must be readable in UNDER 60 SECONDS. Keep it UNDER 350 WORDS — that is a ceiling, not a target, and there is NO minimum. If today's evidence supports a strong 150-word report, write 150 words and stop. Never add a sentence to reach a length. This is a report about TODAY, not a market report.

A busy property/operations manager should finish this in under a minute and know: what changed, what matters, what might be wrong, and what should I do. Every sentence belongs in exactly one of the five sections below — facts in their place, interpretation in its place, never blended into the same sentence.

ONE STORY, NOT FIVE. The insights below are already ranked; the FIRST new-or-continuing insight is the day's story and everything else is supporting detail. Do not open with a survey of every metric, and do not present several competing "biggest stories". Where two signals are really one story, CONNECT them rather than reporting them separately — e.g. "Gallery engagement remains unusually strong, but today's users are not progressing to contact" is one story about conversion, not a browsing story plus a lead story.

COMPARISON HIERARCHY — use in this order:
1. TODAY vs YESTERDAY is the primary comparison. Lead with it.
2. The 7-day average is SECONDARY context, for saying whether today's move is part of a pattern.
3. The 30-day average ONLY when it reveals a genuinely significant anomaly. Do not walk every metric through all three baselines — that is what makes this read like a monthly report.
For any metric you compare, prefer showing it as Today | Yesterday | 30-day avg | Change (a short markdown table is fine when 3+ metrics are worth comparing this way) over a bare percentage sentence — the reader should never have to trust an unexplained percentage.

SMALL SAMPLES — a percentage is not automatically a finding. When the underlying counts are small (roughly single digits), say so in words instead of leading with the percentage: 1 to 2 events is +100% and usually means nothing. Reserve percentage-led statements for metrics with real volume. A ZERO IS ONLY AS INTERESTING AS THE TRAFFIC AROUND IT. Judge it against the same day's views, clicks and searches, and do NOT treat every zero-lead day as a critical problem:
- 0 leads with little or no traffic: no conclusion to draw. Say that, or leave it out.
- 0 leads with meaningful listing views or clicks: a real conversion problem, and worth leading with.
- 0 leads with strong gallery engagement: possible conversion friction between browsing and contacting — worth investigating, stated as a question rather than a verdict.
A listing insight's evidence line may carry a sample size and confidence band (e.g. "sample size: 6 impressions (low confidence)"). Below "moderate" confidence, do not diagnose the listing — write "Insufficient data to determine performance" and move on.

DO NOT NARRATE STANDING MARKETPLACE FACTS. Specifically, do NOT describe:
- current district inventory composition
- current property-type composition
- the current median price
- total inventory
These are the same most days and are NOT news. Mention one only when it materially changed or when it is needed to explain a change. Avoid openers like "The marketplace currently...", "Sisattanak currently holds...", "Apartments continue to be...".

WRITE LIKE THIS: "Search activity fell 37% today (12 vs 19 yesterday) but remains above the 7-day average of 9." / "Gallery interactions: 180 vs 15 yesterday (+165 interactions; 12× yesterday); 180 vs ~23 30-day average (+~683%)." / "🟡 LIKELY: today's gallery engagement combined with flat WhatsApp clicks suggests users are browsing more without a matching rise in contacts — worth monitoring, not yet a confirmed conversion problem." / "Five active listings are still missing prices and should be fixed. 🟢 CONFIRMED."

Structure with these markdown headings, in order. OMIT ANY SECTION THAT HAS NO REAL CONTENT TODAY — do not pad, and never write "nothing to report" under a heading:
# What Happened
(PURE FACTS ONLY — no interpretation, no confidence tags. The day's key metrics and any change vs yesterday worth naming, e.g. "Gallery interactions: 180 vs 15 yesterday (+165 interactions; 12× yesterday); 180 vs ~23 30-day average (+~683%). 87 searches today vs 62 yesterday." A comparison table (Today | Yesterday | 30-day avg | Change) is welcome here for 3+ metrics. 1-3 sentences, still fact-only.)
## What Users Are Doing
(Behaviour, still stated as facts, not conclusions: searches, listing views, gallery interactions, WhatsApp/call clicks, leads. Include, from CUSTOMER INTENT SEGMENTS when present, what customers actually searched for today in plain language, e.g. "today's strongest demand was renters wanting a condo in Sisattanak, mostly around $500-$800/month" — omit this if every segment's sample is too small to say anything with confidence, and say so explicitly rather than presenting a 2-search segment as "the" customer profile. Numbers and comparisons only — save the "why" for What It Means.)
## What It Means
(Interpretation ONLY, and ONLY here — every sentence in this section carries a 🟢/🟡/⚪ confidence tag per the CONFIDENCE LABELS rule above. Connect the facts above into a story about buyer behaviour, conversion, or demand; separate what's confirmed from what's a hypothesis. When gallery interactions are part of the story, follow the GALLERY INTERACTIONS rule above — say what the trend shows and say plainly what today's data cannot show.)
## What Needs Attention
(Specific listings, data-quality problems, or unusual behaviour worth a look — including anything surfaced above as a [low_performing_listing], [high_performing_listing] or [data_quality] insight, and segments where demand meaningfully exceeds supply ([supply_shortage] insights with a metric_key starting "unmet_demand."). State the facts (impressions, leads, what's missing) plainly; when you connect a data gap to an outcome, tag it 🟡 LIKELY or ⚪ HYPOTHESIS per the causation rule above — never state the gap as the proven cause. Respect the small-sample rule: a listing below "moderate" confidence gets "Insufficient data to determine performance," not a diagnosis. Omit the section if none qualify.)
## Recommended Actions
(2-4 CONCRETE actions the Pintag team can actually take today, each grounded in evidence that appears above. For each action, cover: what to do, why (the evidence and confidence tag it rests on), which listing or data point it relates to, and what to monitor afterward — e.g. "Complete the missing location data for [listing]. 🟡 LIKELY data-quality issue — 16 impressions, 0 leads. Monitor: impressions, views and contacts over the next 7 days." A generic instruction is not an action: "consider optimizing image loading", "investigate further" and "continue monitoring" are all failures unless you say exactly what to investigate, on which listing or segment, and what would settle it. Weak: "Consider optimizing image loading." Strong: "Complete the missing location data on the listing with 16 impressions and 0 leads today, then track impressions, views and contacts over the next week to see whether visibility improves." If today's evidence supports only two actions, give two.)`,
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
