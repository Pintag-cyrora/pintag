// Single source of truth for the version tags stamped onto every generated
// intelligence_reports row (product spec: "every report must include
// version metadata for traceability"). Bump the relevant constant whenever
// that layer's output shape or behavior changes materially enough that a
// historical report generated under the old version should be understood
// differently from one generated under the new version.
//
// generated_at (intelligence_reports, existing) already covers "Generated
// Timestamp"; model_used (existing) already covers "AI Model Version" —
// neither is duplicated here. This file only owns the four axes that had
// no existing column: which snapshot shape, which report row shape, which
// prompt template, which validator rule set produced a given report.
//
// Plain JS, no build step — same dual-runtime (Deno + node) convention as
// every other module in this function.

// Bump when intelligence_daily_metrics()'s or point_in_time_supply_
// snapshot()'s jsonb output shape changes (a field renamed, removed, or
// reinterpreted — not merely a new field appended, since additive changes
// don't change how existing fields should be read).
export const SNAPSHOT_SCHEMA_VERSION = '1.1.0';

// Bump when intelligence_reports' own row shape or semantics change (a
// column repurposed, a status value redefined) — not for additive columns.
export const REPORT_FORMAT_VERSION = '1.1.0';

// Bump whenever buildPrompt()'s instructions materially change (new
// section requested, a rule loosened/tightened) — affects how to interpret
// what Gemini was actually asked to do for a given historical report.
// 2.0.0 — the DAILY report became a briefing: new section structure
// (Today's Story / What Changed Today / Buyer Behaviour / Listings To Watch /
// Data / Product Issues / Tomorrow's Priorities), a today-vs-yesterday-first
// comparison hierarchy, an explicit small-sample rule, and a ban on restating
// standing marketplace composition. Weekly/monthly prompts are unchanged.
// 3.0.0 — Intelligence V2 (Customer Intent): two new optional daily sections
// (Customer Intent, Unmet Demand & Inventory Opportunities), the
// CUSTOMER INTENT SEGMENTS / JOURNEY-JOIN CONFIDENCE data blocks, an
// explicit no-invented-causation rule, and Listings To Watch's guidance
// extended to reference the two new insight types (low_performing_listing /
// high_performing_listing). Another major bump for the same reason 2.0.0
// was: a daily report generated under 2.x asked Gemini a materially
// different, narrower question than one generated under 3.x.
// 4.0.0 — Intelligence + Decision-Making rework: the daily report's eight
// topic-based sections (Today's Story / What Changed Today / Buyer
// Behaviour / Customer Intent / Unmet Demand & Inventory Opportunities /
// Listings To Watch / Data / Product Issues / Tomorrow's Priorities) are
// replaced by a fixed five-section Facts -> Behaviour -> Interpretation ->
// Attention -> Actions skeleton (# What Happened / ## What Users Are Doing /
// ## What It Means / ## What Needs Attention / ## Recommended Actions) —
// Customer Intent and Unmet Demand are now guidance within "What Users Are
// Doing"/"What Needs Attention" rather than their own headings. New rules:
// every interpretive/diagnostic sentence must carry a confidence tag (🟢
// CONFIRMED / 🟡 LIKELY / ⚪ HYPOTHESIS) and pure facts never carry one; a
// stated percentage must also state the raw values it came from, and when a
// day-over-day move is very large against a small baseline the model must
// lead with the absolute difference and a multiplier (e.g. "180 vs 15
// yesterday (+165 interactions; 12× yesterday)") rather than a bare huge
// percentage, while still giving the 30-day comparison as its own percentage
// figure; a listing
// insight's evidence line now carries a sample-size confidence band (reusing
// dataConfidenceLabel(), see insightSummaryLine() in report-composer.js) and
// below "moderate" the model must say "Insufficient data to determine
// performance" rather than diagnose; gallery-interaction claims must
// disclose that today's data cannot attribute engagement to specific
// listings or users. A daily report generated under 3.x asked Gemini a
// materially different, narrower question than one generated under 4.x.
// 5.0.0 — Demand -> Supply -> Gap rework: two new top-level sections,
// "## Demand & Supply" (the DEMAND -> SUPPLY -> GAP / BEDROOM-LEVEL DEMAND ->
// SUPPLY data blocks, wiring demand-supply-gap.js's ranked/classified rows —
// HIGH/MEDIUM/LOW demand confidence, adequate/gap_potential/gap_strong/
// insufficient_data gap status) and "## What Pintag Should Do" (up to 3
// evidence-ranked actions), plus two new labeled subsections inside
// "## What Needs Attention" — "### Listing Opportunities" (a deterministic
// REVIEW NOW / MONITOR ONLY tag per low_performing_listing insight, see
// listingOpportunityTag()) and "### Data Quality" (data-quality insights kept
// separate from behavioural findings, plus a "⚠️ DATA CHECK" line whenever
// the new SUSPICIOUS METRIC CHECK block fires — see galleryTrackingCheck()).
// New rules: an explicit FACT/SIGNAL/HYPOTHESIS/ACTION vocabulary formalizes
// the existing 🟢/🟡/⚪-tag convention; Recommended Actions and What Pintag
// Should Do must follow the EVIDENCE HIERARCHY FOR ACTIONS (inventory
// acquisition > listing optimization > data correction > tracking
// investigation > monitor); the JOURNEY-JOIN CONFIDENCE match/traceability
// rate now carries a minimum-sample guard (MIN_JOURNEY_SAMPLE_FOR_RATE=3,
// same reasoning as trend-calculator.js's MIN_BASELINE_FOR_PCT) and explicit
// population-scoping language, fixing the reported "0% match rate between
// clicks and leads" bug (a 1-sample ratio stated as if stable, and conflated
// with the separate whatsapp_clicks/leads_created totals). The word ceiling
// moved from 350 to 500 (a disclosed, deliberate tradeoff for the added
// sections) and the "five sections" framing became "the sections below" (no
// longer a fixed count). A daily report generated under 4.x asked Gemini a
// materially narrower question — no demand/supply/gap analysis, no
// deterministic listing-opportunity or data-quality-check surfacing — than
// one generated under 5.x.
// 6.0.0 — Inventory Acquisition Intelligence: a new "## Inventory
// Opportunities" section (between "## Demand & Supply" and "## What It
// Means") wires inventory-opportunity.js's buildInventoryOpportunities into
// the prompt via a new INVENTORY OPPORTUNITIES data block. Each demand
// segment is classified into exactly one of four deterministic tiers —
// "acquire_high" (🔴 HIGH-PRIORITY: gap_strong status + HIGH demand
// confidence + a "persistent" demand_trend, i.e. the segment's unmet-demand
// insight has stayed open across more than one day, so a one-day spike can
// never reach this tier), "acquire_potential" (🟡 POTENTIAL: a real gap that
// doesn't yet meet every acquire_high condition), "optimize" (matching
// supply is already adequate but the segment isn't converting — explicitly
// NEVER an acquisition recommendation, redirected to Listing Opportunities/
// Recommended Actions instead), and "insufficient_data" (⚪: too small a
// sample, demand confidence too low, or supply unknown for today — never a
// named gap). Each opportunity row also carries a concrete acquisition
// target when the evidence supports it: district/property type/transaction
// type (always), a bedroom count (only when the segment's bedroom sample
// clears the same >=10 floor the existing bedroom-intent rule uses), and a
// price band (top_price_band verbatim, in USD — the site's actual
// search-filter currency — never invented when null). The EVIDENCE
// HIERARCHY FOR ACTIONS rule (5.0.0) now explicitly maps its tier 1
// (inventory acquisition) and tier 2 (listing optimization) to these same
// classifications, so the two tiers and the new section can never disagree.
// A daily report generated under 5.x asked Gemini a materially narrower
// question — demand/supply gaps were shown, but never turned into a
// concrete, confidence-gated, trend-aware acquisition recommendation — than
// one generated under 6.x.
export const PROMPT_VERSION = '6.0.0';

// Bump whenever report-validator.js's contradiction/grounding rules change
// — affects how much to trust "this report passed validation" for a given
// historical report.
// 1.1.0 — headlineSections() also recognises the daily briefing's
// "# Today's Story" as the headline section. The old headings still validate
// identically, so historical reports are unaffected.
// 1.2.0 — headlineSections() also recognises prompt v4.0.0's "# What
// Happened" as the headline section (old headings still validate
// identically). New third check, checkUnsupportedCausation(): flags an
// unhedged cause-and-effect sentence ("caused by", "is causing", "is the
// reason for", ...) anywhere in body_markdown when that same sentence
// contains no hedge word (may/might/could/likely/hypothesis/suggests/...) —
// the mechanical enforcement of the pipeline's existing no-invented-
// causation prompt rule, on the same cheap/keyword-based philosophy as the
// two existing checks.
// 1.3.0 — New fourth check, checkMatchRateSmallSample(): flags a stated
// journey-join match/traceability percentage anywhere in body_markdown when
// rawMetricsSummary.journey_join.lead_events_with_session is below
// MIN_JOURNEY_SAMPLE_FOR_RATE (report-composer.js) — a defense-in-depth
// backstop for the prompt-level fix to the reported "0% match rate between
// clicks and leads" bug (see PROMPT_VERSION 5.0.0's note).
export const VALIDATOR_VERSION = '1.3.0';
