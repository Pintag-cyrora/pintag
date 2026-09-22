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
import { buildDemandSupplyRows, buildBedroomDemandSupplyRows } from './demand-supply-gap.js';
import { buildUnitTypeDemandRows } from './unit-type-demand.js';

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

// Listing Opportunity classification (product spec item 6): instead of
// leaving "is this listing worth auditing, or is there just not enough
// data yet" to Gemini's judgment, this is computed deterministically from
// the SAME impressions sample-size band sampleConfidenceNote already
// exposes -- a low_performing_listing insight only ever reaches this
// pipeline once it has >=5 impressions (impressions_no_leads is floored at
// that in SQL), so "REVIEW NOW" vs "MONITOR ONLY" is really "does this
// listing clear the existing 'moderate' confidence bar or not", reusing
// dataConfidenceLabel rather than a second threshold. Deliberately does
// NOT attempt a three-way split into "high exposure" vs "high engagement"
// buckets: gallery interactions (the only real engagement signal) are not
// attributable to a specific listing (see the GALLERY INTERACTIONS rule
// below), so a per-listing "engagement" bucket would have to be invented
// from data that doesn't exist for it. high_performing_listing is already
// informational-only (severity fixed 'low' upstream) and does not need an
// opportunity tag of its own.
function listingOpportunityTag(i) {
  if (i.type !== 'low_performing_listing') return '';
  const impressions = i.evidence && typeof i.evidence.impressions === 'number' ? i.evidence.impressions : null;
  if (impressions === null) return '';
  const enoughExposure = dataConfidenceLabel(impressions) !== 'low';
  return enoughExposure
    ? ', listing opportunity: REVIEW NOW (enough exposure to justify an audit)'
    : ', listing opportunity: MONITOR ONLY (exposure too low to justify changes yet)';
}

function insightSummaryLine(i) {
  const dims = [i.dimension_district, i.dimension_property_type].filter(Boolean).join('/');
  return `- [${i.type}] ${i.title}${dims ? ` (${dims})` : ''} — severity: ${i.severity}, confidence: ${Math.round((i.confidence || 0) * 100)}%${sampleConfidenceNote(i)}${listingOpportunityTag(i)}, trend: ${i.trend}${i.recommendation ? `, suggested action: ${i.recommendation}` : ''}`;
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
// bedrooms: bedrooms is deliberately never part of the segment key (adding
// it would fragment every segment). listings.html's Bedroom Count filter
// (Any/1/2/3/4/5+) DOES now genuinely populate search_events.bedrooms, so
// each segment additionally carries top_bedroom_count (the single
// most-searched bedroom value in that segment — a plurality/mode, which
// can be null when "Any"/no-preference was itself the most common search)
// and bedroom_sample_size (how many of the segment's searches actually
// carried a bedroom preference, i.e. excludes "Any" — deliberately NOT the
// same as search_count, which would overstate how much bedroom signal
// exists). top_price_band is the single most-searched price range WITHIN
// a segment, reported as context, not part of what defines the segment.
// Below this many session-attributed contacts, a "% matched back to a
// click" figure is a ratio over a near-nothing denominator (1/1 = 100%,
// 0/1 = 0%) — exactly as unstable as a percentage over a tiny baseline
// anywhere else in this pipeline (see trend-calculator.js's own
// MIN_BASELINE_FOR_PCT=3, same value, same reasoning). This is the fix for
// the reported bug: "WhatsApp clicks: 1, Leads: 1" produced "a 0% match
// rate between clicks and leads" — a join-rate computed from
// lead_events_with_session=1 stated as if it were a stable, meaningful
// percentage, AND conflated with the unrelated whatsapp_clicks/
// leads_created totals it was never computed from. Exported so
// report-validator.js can enforce the same threshold as a mechanical
// backstop (checkMatchRateSmallSample) rather than duplicating a second,
// possibly-drifting number.
export const MIN_JOURNEY_SAMPLE_FOR_RATE = 3;

function customerIntentBlock(reportType, rawMetricsSummary) {
  if (reportType !== 'daily') return '';
  const segments = rawMetricsSummary && Array.isArray(rawMetricsSummary.customer_intent_segments)
    ? rawMetricsSummary.customer_intent_segments : null;
  if (!segments) return '';

  const jj = rawMetricsSummary.journey_join || null;
  const joinRatePct = (jj && jj.lead_events_with_session >= MIN_JOURNEY_SAMPLE_FOR_RATE)
    ? Math.round((jj.lead_events_matched_to_click / jj.lead_events_with_session) * 100)
    : null;

  return `\nCUSTOMER INTENT SEGMENTS (today, pre-computed, ranked by search volume — each is (transaction_type, property_type, district); bedrooms is NEVER part of what defines a segment; top_price_band is the single most-searched price range within that segment, not part of what defines it either. Each segment also carries top_bedroom_count and bedroom_sample_size: top_bedroom_count is the single most-searched bedroom value for that segment (a MODE/PLURALITY, not a majority, and it can be null when "Any"/no-preference was itself the most common search — that is a real, legitimate finding, not missing data); bedroom_sample_size is how many searches in that segment actually specified a bedroom count, separate from and always ≤ the segment's search_count. NEVER state or imply a bedroom preference for a segment unless bedroom_sample_size is at least 10 — below that, say plainly that there is not yet enough bedroom-specific data for that segment, do not name a number. Even at or above 10, phrase it as "the most common bedroom count searched for was N" or similar plurality language, never as "users prefer N bedrooms" or "most users want N bedrooms" (a plurality is not a majority unless the data itself shows one). This is DEMAND-side data only — never say or imply anything about how many N-bedroom listings are actually available; bedroom is not a dimension the current supply/inventory data is segmented by):\n${JSON.stringify(segments)}\n` +
    (jj ? `\nJOURNEY-JOIN CONFIDENCE (how much of the search → click → contact chain is actually traceable via a shared session id today — this is a MEASURED rate, not an assumption; treat any segment-level lead/conversion claim above as carrying this same confidence, and say so explicitly when the rate is low rather than presenting the segment's lead counts as certain. IMPORTANT — POPULATION: this rate's population is ONLY today's session-attributed contacts (lead_events_with_session below); it is a DIFFERENT, smaller population than the raw whatsapp_clicks/leads_created totals in the raw metrics summary, which count every contact regardless of session-tracking. NEVER describe this rate as "a match rate between clicks and leads" or otherwise conflate it with those totals — always name it as the journey/tracking traceability rate, and state which population (how many session-attributed contacts) it was computed from): ${JSON.stringify(jj)}${joinRatePct !== null ? ` — ${joinRatePct}% of ${jj.lead_events_with_session} session-attributed contact(s) today matched back to an earlier click in the same session` : ` — only ${jj ? jj.lead_events_with_session : 0} session-attributed contact(s) today, too few to state a meaningful percentage; say plainly "not enough session-attributed contacts yet to measure traceability" instead of a percentage`}\n` : '');
}

// Deterministic check for product spec item 8 — a gallery-interaction drop
// to near-zero should not be silently narrated as a behavioural finding
// when the traffic that would normally produce it (listing impressions)
// is still flowing, because that specific combination is also consistent
// with a broken tracking event. This is a DETECTION, not an
// interpretation: it only fires on the exact suspicious shape (today's
// gallery count near zero, yesterday's was real, and today's impressions
// are still meaningfully active) — an ordinary, unremarkable gallery count
// never triggers this block, so the GALLERY INTERACTIONS rule elsewhere in
// commonRules still governs the normal case.
const GALLERY_NEAR_ZERO_FLOOR = 2;
const GALLERY_PRIOR_MEANINGFUL_FLOOR = 10;
const IMPRESSIONS_STILL_ACTIVE_FLOOR = 10;

function galleryTrackingCheck(trendAnalysis, rawMetricsSummary) {
  const g = trendAnalysis && trendAnalysis.gallery_events;
  if (!g || typeof g.today !== 'number' || typeof g.yesterday !== 'number') return '';
  if (g.today > GALLERY_NEAR_ZERO_FLOOR || g.yesterday < GALLERY_PRIOR_MEANINGFUL_FLOOR) return '';
  const impressions = rawMetricsSummary && typeof rawMetricsSummary.listing_impressions === 'number'
    ? rawMetricsSummary.listing_impressions : null;
  if (impressions === null || impressions < IMPRESSIONS_STILL_ACTIVE_FLOOR) return '';
  return `\nSUSPICIOUS METRIC CHECK — GALLERY TRACKING (deterministic; this is not your judgment call to make): gallery interactions fell from ${g.yesterday} yesterday to ${g.today} today while listing impressions remained active today (${impressions}). A near-total drop in one engagement metric while the traffic that would normally produce it kept flowing may reflect a genuine behavioural change, but is equally consistent with a tracking/analytics problem (a broken event, a code change). In the Data Quality section you MUST surface this explicitly as "⚠️ DATA CHECK", name both possibilities, and say that tracking should be verified before this is treated as a confirmed behavioural signal. Do not present it as a confirmed behavioural finding anywhere in the report, and do not restate it elsewhere as a plain fact without this same caveat.\n`;
}

// Demand -> Supply -> Gap (product spec items 2-5) — wires
// demand-supply-gap.js's pure ranking/classification functions into the
// prompt, the same way customerIntentBlock already wires
// customer_intent_segments in: real numbers, pre-ranked and
// pre-classified, Gemini narrates but never (re)computes a gap
// classification itself. Daily-only for the same reason customerIntentBlock
// is (sumMetrics() does not merge customer_intent_segments/active_inventory
// across days). active_inventory.available_by_segment/
// available_by_bedroom_segment (20260920000000_intelligence_demand_supply_
// gap.sql) are present only for the single most-recently-finalized day —
// when absent, buildDemandSupplyRows/buildBedroomDemandSupplyRows already
// degrade every row to supply_count=null/status="insufficient_data" rather
// than fabricating a number, so this block still safely renders demand
// alone on any other day.
function demandSupplyBlock(reportType, rawMetricsSummary) {
  if (reportType !== 'daily') return '';
  const segments = rawMetricsSummary && Array.isArray(rawMetricsSummary.customer_intent_segments)
    ? rawMetricsSummary.customer_intent_segments : null;
  if (!segments || !segments.length) return '';

  const activeInventory = rawMetricsSummary.active_inventory || {};
  const bySegmentSupply = activeInventory.available_by_segment || null;
  const byBedroomSupply = activeInventory.available_by_bedroom_segment || null;

  const rows = buildDemandSupplyRows(segments, bySegmentSupply);
  const bedroomRows = buildBedroomDemandSupplyRows(segments, byBedroomSupply);

  return `\nDEMAND -> SUPPLY -> GAP (today, pre-computed and pre-classified — ranked by search volume; each row is (transaction_type, property_type, district). demand_confidence is HIGH/MEDIUM/LOW — a segment with fewer than 5 searches is always LOW, not a real demand signal yet; do not name a "strongest demand segment" if every row is LOW. supply_count is genuinely bookable matching inventory right now (market_status=available AND workflow_status=active), or null when today is not the single most-recently-finalized day — never invent a number when supply_count is null. status is exactly one of: "adequate" (no gap — say nothing further), "gap_potential" (🟡 POTENTIAL GAP), "gap_strong" (🔴 POTENTIAL INVENTORY GAP — the strongest signal this data can support), "insufficient_data" (⚪ not enough searches or supply unknown — NEVER call this a confirmed gap of any kind). Use these exact status values to choose your gap language; never upgrade "gap_potential" to a confirmed shortage, and never call an "insufficient_data" row a gap):\n${JSON.stringify(rows)}\n` +
    (bedroomRows.length ? `\nBEDROOM-LEVEL DEMAND -> SUPPLY (only segments with at least 10 bedroom-specific searches and a real bedroom plurality — bedroom_bucket "0" means Studio, "4+" collapses 4-or-more bedrooms; phrase bedroom_sample_size language as a plurality per the CUSTOMER INTENT SEGMENTS rule above, never as a majority or a stated preference; same status/gap vocabulary as above):\n${JSON.stringify(bedroomRows)}\n` : '');
}

// Unit-Type Demand (see unit-type-demand.js) — a SEPARATE, finer-grained
// signal from DEMAND -> SUPPLY -> GAP above: that block is market-wide
// SEARCH demand against a (transaction_type, property_type, district)
// bucket; this one is actual WhatsApp/call/lead activity attributed to one
// SPECIFIC unit_types row (PR #104's unit_type_id), compared against that
// same row's own available_count. A property-level CTA (unit_type_id null,
// by construction) can never appear here — this block is never evidence for
// or against a property-level lead, and vice versa. Daily-only for the same
// reason customerIntentBlock/demandSupplyBlock are (sumMetrics() does not
// merge unit_type_demand_segments/active_inventory across days).
function unitTypeDemandBlock(reportType, rawMetricsSummary) {
  if (reportType !== 'daily') return '';
  const segments = rawMetricsSummary && Array.isArray(rawMetricsSummary.unit_type_demand_segments)
    ? rawMetricsSummary.unit_type_demand_segments : null;
  if (!segments || !segments.length) return '';

  const availableUnitTypes = (rawMetricsSummary.active_inventory && rawMetricsSummary.active_inventory.available_unit_types) || null;
  const rows = buildUnitTypeDemandRows(segments, availableUnitTypes);

  return `\nUNIT-TYPE DEMAND -> SUPPLY (today, pre-computed and pre-classified — ranked by total signal (whatsapp_clicks + call_clicks + leads_created) for ONE SPECIFIC unit type within ONE SPECIFIC property, never a market-wide segment. This is a DIFFERENT population from DEMAND -> SUPPLY -> GAP and from CUSTOMER INTENT SEGMENTS above — those are search-based and market-wide; this is actual contact activity on one exact unit_types row, and a property-level lead (no specific unit selected) can never appear here. demand_confidence is HIGH/MEDIUM/LOW — a unit type with fewer than 3 total signals that day is always LOW, not a real demand signal (1-2 total inquiries is noise, not a market preference — NEVER state or imply a preference from a sample this small). available_count is that exact unit type's own current availability when its parent property is genuinely bookable, or null when today is not the single most-recently-finalized day — never invent a number when it is null. status uses the exact same vocabulary as DEMAND -> SUPPLY -> GAP: "adequate" (no gap), "gap_potential" (🟡 POTENTIAL GAP), "gap_strong" (🔴 POTENTIAL INVENTORY GAP), "insufficient_data" (⚪ — NEVER a confirmed gap of any kind). When you mention a unit type, always name its property/district context (e.g. "2-bedroom Room Type A units at [property] in [district]") — never describe it as a market-wide trend, and never merge it with the property-level DEMAND -> SUPPLY -> GAP numbers for the same property, which measure a different thing (searches, not unit-specific contacts):\n${JSON.stringify(rows)}\n`;
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
  const demandSupplyBlockText = demandSupplyBlock(reportType, rawMetricsSummary);
  const unitTypeDemandBlockText = unitTypeDemandBlock(reportType, rawMetricsSummary);
  const galleryCheckText = galleryTrackingCheck(trendAnalysis, rawMetricsSummary);

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

FACT vs SIGNAL vs HYPOTHESIS vs ACTION — every sentence you write is exactly one of these four kinds, and must never present a weaker kind as a stronger one:
- FACT: a measured number or plain observation ("25 impressions and 0 leads today"). Never tagged.
- SIGNAL: an observation with real evidentiary support behind it — a 🟢 CONFIRMED or 🟡 LIKELY conclusion.
- HYPOTHESIS: a plausible, unproven explanation — always ⚪ HYPOTHESIS, always naming what would need to be true to confirm it.
- ACTION: a concrete instruction, stated only in "Recommended Actions" / "What Pintag Should Do".
Do NOT collapse a HYPOTHESIS into a FACT. Wrong: "Users are not finding the information they need." Right, as three separate statements: FACT — "25 impressions and 0 leads." / ⚪ HYPOTHESIS — "Missing price, amenity, or rental-term information may be reducing contact intent." / ACTION — "Monitor lead conversion over the next 7 days."

EVIDENCE HIERARCHY FOR ACTIONS — every action you propose (in "Recommended Actions" and "What Pintag Should Do") must be justified by exactly one of these, and you must prefer the first evidence type on this list that genuinely applies today; never propose "monitor" when stronger evidence already justifies a more specific action:
1. Inventory acquisition — a demand segment (or bedroom segment) above shows a "gap_strong"/"gap_potential" status: measurable demand with insufficient matching supply.
2. Listing optimization — a listing carries "listing opportunity: REVIEW NOW": sufficient exposure (impressions) but poor conversion.
3. Data correction — a [data_quality] insight or a Data Quality-section finding shows listing/analytics data is incomplete or inconsistent.
4. Tracking investigation — a SUSPICIOUS METRIC CHECK block above, or another metric behaving in a way the data itself flags as unexpected.
5. Monitor — none of the above apply with enough evidence; say so honestly rather than inventing a stronger action. Never recommend editing or auditing a listing for "low performance" when its evidence shows insufficient exposure ("listing opportunity: MONITOR ONLY") — that is the reserved case for tier 5, not tier 2.

GALLERY INTERACTIONS — today's analytics measure a marketplace-wide total, and the trend analysis can compare it to yesterday/7-day/30-day averages, but they do NOT break gallery interactions down by which listing, which photo, or how many distinct users generated them. When gallery engagement is worth discussing, state what the aggregate trend actually shows, and say plainly that today's data cannot show which listings or how many users drove it — do not guess. You MAY compare the gallery-engagement trend against the listing-views and WhatsApp-click trends already given (e.g. "gallery engagement rose while WhatsApp clicks stayed flat") since both are real figures in the trend analysis, not a guess.

NEW INSIGHTS (🟢):\n${newBlock}\n
CONTINUING INSIGHTS (🔴):\n${continuingBlock}\n
RESOLVED INSIGHTS (✅):\n${resolvedBlock}
${supplyBlock}${trendBlock}${customerIntentBlockText}${demandSupplyBlockText}${unitTypeDemandBlockText}${galleryCheckText}
RAW METRICS SUMMARY (period totals, safe to cite verbatim):
${JSON.stringify(rawMetricsSummary)}

Canonical districts: ${CANONICAL_DISTRICTS.join(', ')}. Canonical property types: ${CANONICAL_PROPERTY_TYPES.join(', ')}.`;

  const structureByType = {
    daily: `Write a DAILY INTELLIGENCE REPORT for the founder — a decision-making report, not an analytics dump. It must be readable in UNDER 90 SECONDS. Keep it UNDER 500 WORDS — that is a ceiling, not a target, and there is NO minimum. If today's evidence supports a strong 150-word report, write 150 words and stop. Never add a sentence to reach a length. This is a report about TODAY, not a market report. The ceiling moved from 350 to 500 words specifically to make room for the Demand & Supply / Listing Opportunities / Data Quality sections below — it is still a ceiling to be undercut whenever the evidence is thin, not a target to fill.

A busy property/operations manager should finish this in under two minutes and know: what changed, what matters, do we have enough inventory for what people want, what might be wrong, and what should I do. Every sentence belongs in exactly one of the sections below — facts in their place, interpretation in its place, never blended into the same sentence.

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
(Behaviour, still stated as facts, not conclusions: searches, listing views, gallery interactions, WhatsApp/call clicks, leads. Include, from CUSTOMER INTENT SEGMENTS when present, what customers actually searched for today in plain language, e.g. "today's strongest demand was renters wanting a condo in Sisattanak, mostly around $500-$800/month" — omit this if every segment's sample is too small to say anything with confidence, and say so explicitly rather than presenting a 2-search segment as "the" customer profile. Where a segment's bedroom_sample_size is at least 10, you may add the most-searched bedroom count to the same sentence as a plurality, e.g. "...mostly around $500-$800/month, most often searching for 2 bedrooms" — never below that sample size, and never phrase it as a majority or as what users "prefer". Numbers and comparisons only — save the "why" for What It Means.)
## Demand & Supply
(Uses the DEMAND -> SUPPLY -> GAP data block above, when present — pre-ranked and pre-classified real numbers; you never compute a gap classification yourself. For the strongest 1-3 demand segments (by search_count), state the segment, its demand_confidence as 🟢 HIGH / 🟡 MEDIUM / ⚪ LOW (LOW means too few searches to call it demand at all — do not name a "strongest demand segment" if every row is LOW), its supply_count (or "supply data not available for today" when null — never invent a number), and its gap status exactly as given: "gap_strong" -> 🔴 POTENTIAL INVENTORY GAP, "gap_potential" -> 🟡 POTENTIAL GAP, "adequate" -> no gap language at all, "insufficient_data" -> ⚪ not enough data to call this a gap. NEVER upgrade "gap_potential" to a confirmed shortage, and NEVER call an "insufficient_data" row a gap of any kind. When the BEDROOM-LEVEL DEMAND -> SUPPLY block is present, you may add one sentence naming the strongest bedroom-specific demand+supply pairing (e.g. "2-bedroom rentals are the strongest measurable bedroom demand in Sisattanak; current matching supply: 4 available listings"), phrased as a plurality per the bedroom rule above, tagged with the same gap vocabulary. When the UNIT-TYPE DEMAND -> SUPPLY block is present with at least one row whose demand_confidence is not LOW, you may add up to one sentence naming the single strongest unit-type-level finding, always with its property/district context (e.g. "🟢 2-bedroom Room Type A units at [property] in Sisattanak generated 5 WhatsApp/call/lead signals today against 1 available unit — 🔴 POTENTIAL INVENTORY GAP at the unit level"). This is a DIFFERENT, more specific population than the market-wide DEMAND -> SUPPLY -> GAP numbers above (actual contact activity on one exact unit type, not search volume across a district) — never merge the two into one sentence, never describe a unit-type finding as if it were market-wide, and never mention it at all when every UNIT-TYPE DEMAND -> SUPPLY row is "insufficient_data" or LOW confidence. Omit this entire section if all three data blocks above are absent or every row in each is "insufficient_data".)
## What It Means
(Interpretation ONLY, and ONLY here — every sentence in this section carries a 🟢/🟡/⚪ confidence tag per the CONFIDENCE LABELS rule above. Connect the facts above into a story about buyer behaviour, conversion, or demand; separate what's confirmed from what's a hypothesis. When gallery interactions are part of the story, follow the GALLERY INTERACTIONS rule above — say what the trend shows and say plainly what today's data cannot show.)
## What Needs Attention
(Specific listings, data-quality problems, or unusual behaviour worth a look — including anything surfaced above as a [low_performing_listing], [high_performing_listing] or [data_quality] insight, and segments where demand meaningfully exceeds supply ([supply_shortage] insights with a metric_key starting "unmet_demand."). State the facts (impressions, leads, what's missing) plainly; when you connect a data gap to an outcome, tag it 🟡 LIKELY or ⚪ HYPOTHESIS per the causation rule above — never state the gap as the proven cause. Respect the small-sample rule: a listing below "moderate" confidence gets "Insufficient data to determine performance," not a diagnosis. Break this section into the two labeled parts below; omit either (or the whole section) if nothing qualifies.
### Listing Opportunities
Each [low_performing_listing] insight above carries a deterministic "listing opportunity" tag — REVIEW NOW (enough exposure to justify an audit) or MONITOR ONLY (exposure too low to justify changes yet). Group your mentions by that tag: lead with REVIEW NOW listings, stating impressions/leads plainly and, if evidenced (missing_price/missing_photos/matches_top_segment in its evidence), a 🟡 LIKELY or ⚪ HYPOTHESIS reason. For MONITOR ONLY listings, note briefly that there isn't enough exposure yet to diagnose them — do not recommend changing one.
### Data Quality
List data-quality problems separately from user-behaviour findings: any [data_quality] insight above (missing price, photos, description, location, neighborhood insight, stale listings, no leads yet), plus a "⚠️ DATA CHECK" line whenever a SUSPICIOUS METRIC CHECK block is present above — state it as a possible tracking/data-quality issue to verify, exactly as that block instructs, never as a confirmed behavioural change. Never blend a data-quality fact with a behavioural interpretation in the same sentence.)
## Recommended Actions
(2-4 CONCRETE actions the Pintag team can actually take today, each grounded in evidence that appears above and ordered by the EVIDENCE HIERARCHY FOR ACTIONS rule above — an available inventory-acquisition action outranks a listing-optimization one, which outranks a data-correction one, and so on. For each action, cover: what to do, why (the evidence and confidence tag it rests on, and which hierarchy tier it is), which listing, segment or data point it relates to, and what to monitor afterward — e.g. "Complete the missing location data for [listing]. 🟡 LIKELY data-quality issue — 16 impressions, 0 leads. Monitor: impressions, views and contacts over the next 7 days." A generic instruction is not an action: "consider optimizing image loading", "investigate further" and "continue monitoring" are all failures unless you say exactly what to investigate, on which listing or segment, and what would settle it. Weak: "Consider optimizing image loading." Strong: "Complete the missing location data on the listing with 16 impressions and 0 leads today, then track impressions, views and contacts over the next week to see whether visibility improves." If today's evidence supports only two actions, give two.)
## What Pintag Should Do
(The executive-level distillation of the same evidence above: UP TO 3 concrete actions, ranked by the EVIDENCE HIERARCHY FOR ACTIONS rule — prioritize acquiring more listings in a demonstrated demand gap, then improving specific high-exposure listings, then fixing listing data, then investigating a tracking/analytics anomaly, then monitoring emerging demand. These may restate the strongest 1-3 actions from "Recommended Actions" at a company-priority level rather than inventing new ones. Do NOT use a generic recommendation like "continue monitoring" here unless today's evidence is genuinely insufficient for anything stronger — say so plainly if that's the case rather than padding to reach 3.)`,
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
