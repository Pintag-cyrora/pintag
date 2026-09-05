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
export const PROMPT_VERSION = '3.0.0';

// Bump whenever report-validator.js's contradiction/grounding rules change
// — affects how much to trust "this report passed validation" for a given
// historical report.
// 1.1.0 — headlineSections() also recognises the daily briefing's
// "# Today's Story" as the headline section. The old headings still validate
// identically, so historical reports are unaffected.
export const VALIDATOR_VERSION = '1.1.0';
