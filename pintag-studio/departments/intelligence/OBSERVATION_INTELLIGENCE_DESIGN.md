# Observation Intelligence — Deferred Design

**Status: approved design, not implemented.** Paused deliberately — not for a technical reason, but a product one: the founder isn't yet using Marketing OS daily through a real interface (see the Founder Test Interface milestone, built instead). Pick this up once genuine daily usage exists, so the rules below are refined "from real experience rather than assumptions" (the founder's own words) rather than built ahead of any real signal to tune them against.

*This document is the proposal as agreed before the pause — not retroactively rewritten. If real usage changes any of the reasoning below, that's expected; update this doc when implementation actually starts.*

## Problem

Marketing OS can now observe the outside world (TikTok, via the Observation Source framework — M2.2). Every observation currently flows straight into the Daily Briefing narrative unfiltered. The founder's stated concern: "the value of Marketing OS is not that it knows more data — it's that it knows what deserves my attention." Left unaddressed, the Daily Briefing risks becoming a statistics dump rather than an executive summary as more Observation Sources are added.

## Product principle

Marketing OS should behave like an experienced executive team — interrupt the founder only when something meaningful changes. Every Observation Source should answer three questions before anything reaches the founder: What happened? Does it matter? Who should care?

Long-term philosophy (the founder's framing, kept verbatim since it should keep governing this when it's built): *Collect everything. Notice only meaningful change. Reason only when necessary. Recommend only one action.*

## Proposed architecture

A new stage between Observation Sources and the Daily Briefing:

```
Observation Sources → Observation Intelligence → Daily Briefing
```

Deterministic rule engine — **no LLM, no ML, no scoring model** this stage. New file: `pipeline/lib/observation-intelligence.ts`, sibling to `pipeline/lib/observations.ts`.

### Interface

```ts
export type RoutingOutcome =
  | { decision: 'ignore'; reason: string }
  | { decision: 'department'; department: string; reason: string }
  | { decision: 'executive'; reason: string };

export type RoutingRule = (observation: Observation) => RoutingOutcome | undefined;
```

A rule inspects one `Observation`, returns a verdict or `undefined` to defer to the next rule. `classifyObservation()` runs an ordered `ROUTING_RULES: RoutingRule[]` array, first match wins, always ending in a required catch-all (defaults to `ignore`, logs a warning so an operator notices a genuinely unhandled kind exists — nothing is ever silently unmatched). Same "ordered list of small independent handlers behind one aggregator" pattern already used for Knowledge Layer source adapters and Observation Sources themselves — a third application, not a new idea.

### Data flow

```
gatherAllObservations()     — one necessary extension: source failures (not
                               connected, expired token) become real
                               Observation objects (kind: 'source_error')
                               instead of a separate side-channel, so the
                               same classifier handles them too (this is
                               what makes "Integration failure → Platform"
                               possible at all)
        ↓  Observation[]
routeObservations()          — classifies every observation, groups by outcome
        ↓
  ignore      → dropped
  department  → dispatchDepartmentObservations() → existing systems, not a
                new inbox (see Reuse below)
  executive   → formatted into the Daily Briefing prompt (existing
                formatObservation(), unchanged)
```

`daily-briefing.ts`'s `gatherObservations()` is the only touch point — it calls `routeObservations()` before formatting and only formats the `executive` group. `buildPrompt()` / `generateDailyBriefing()` / `dashboard/morning.html` do not change.

### Extensibility (how future departments/sources register rules)

`department` is a plain string, not a closed enum — a new department name needs zero type changes anywhere. New rules are appended to `ROUTING_RULES`. Once genuinely large (multiple sources, dozens of rules), the natural next step is splitting into `observation-intelligence/rules/<source>.ts` files aggregated into one array — the same scaling path `knowledge-sources/` and `observation-sources/` already established. Not pre-built now for a single-digit rule count (one source, TikTok) — that would be complexity paid today for a benefit that may not arrive on schedule.

### Concrete rules (TikTok only — the only source that exists)

| Rule | Outcome |
|---|---|
| `account_snapshot` | **Ignore** — already explicitly non-comparative context (no persisted baseline to claim a trend from, per M2.2's honesty boundary) |
| `video_performance`, ratio ≥ 1.3 | **Executive** |
| `video_performance`, ratio ≤ 0.7 | **Department: writer** |
| `video_performance`, in between | **Ignore** |
| `source_error`, any reason | **Department: platform** |
| anything unrecognized | **Ignore** + a visible warning (the catch-all) |

Requires one small addition to `pipeline/lib/observation-sources/tiktok.ts`: the outperform/underperform ratio and average, currently only embedded in prose (`whyItMatters`), need to also live in the observation's `data` field so the classifier reads real numbers instead of parsing generated sentences.

Thresholds (1.3 / 0.7) belong in `brain/org-config.json` as a new `observation_intelligence` section, not hardcoded — matching `CLAUDE.md`'s standing "pipeline code stays config-driven" rule and the existing precedent (`quality_score.min_threshold_per_dimension`, `auto_publish_eligible.min_confidence`).

### Reuse for "Department" outcomes — no new inbox needed

- Writer/research-shaped observations → `proposeSuggestion({ kind: 'marketing-observation', ... })` — already the right existing `SuggestionKind`, zero schema change.
- Platform-shaped observations (`source_error`) → `console.warn`, explicitly documented as the seam a real Platform-department inbox replaces later. Forcing these into the Knowledge Suggestion System would be the same category error already flagged once for `knowledge/brands/pintag/` — an operational alert isn't a knowledge candidate.

### One explicit behavior change flagged for confirmation before building

Once source failures flow through the classifier as `source_error` → Platform, a persistently-unconfigured or disconnected source stops appearing in the Daily Briefing narrative (it's Platform's problem now, not surfaced to the founder every morning). This is a deliberate interpretation of "interrupt only when something meaningful changes" (a known, unchanging gap isn't new information daily) — not yet confirmed by the founder, since implementation was paused before that confirmation happened.

### Two of the founder's own examples that are NOT buildable honestly today, and why

- **"Research notices recurring questions in TikTok comments"** — TikTok's Display API returns `comment_count`, never comment *text*. There is no official, non-scraping way to know what a comment says. Not fakeable without inventing capability that doesn't exist.
- **"Writer notices unusually strong content performance" (as a pattern, not a single outlier)** — this implies reasoning across multiple observations over time. A stateless, no-persisted-history classifier can't do that. Same "change-aware, not snapshot" future direction already flagged twice (M2, M2.2), still not built.

## Not in scope when this is eventually built

Any real Platform-department inbox beyond `console.warn`. Any cross-observation/trend-based rules (needs persisted history — a separate future step). Any rule for a second Observation Source (none exists yet). Any LLM/ML involvement anywhere in this stage.

## Trigger to resume

Real daily usage of the Founder Test Interface producing an actual signal-to-noise problem worth solving — not a fixed calendar date. Per Department-Driven Development's standing discipline: build from operation, not from anticipation.
