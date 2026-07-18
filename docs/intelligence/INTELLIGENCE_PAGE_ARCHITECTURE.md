# Intelligence Page Architecture

> Scope note: this document covers `intelligence.html` — the presentation
> layer staff actually look at. For the pipeline that produces the data it
> presents (Metrics Engine → Insight Engine → Report Composer → Gemini),
> see `supabase/functions/generate-intelligence-report/INTELLIGENCE_ARCHITECTURE.md`.
> This page is Pintag-only. It is not shared with, and must not be mixed
> with, Marketing OS or any other project.

## Purpose

The Intelligence page is the operational intelligence dashboard for Pintag —
the place to visit every morning to understand everything happening on the
platform. Its purpose is to answer:

- What happened recently?
- What trends are emerging?
- What requires my attention?
- Is the platform healthy?
- What has the AI discovered?

**Reports are one component of Intelligence — they are not the Intelligence
page itself.** A report is a periodic narrative snapshot. The Intelligence
page is the durable home for everything the platform knows, of which
reports are a single, valuable, but non-exclusive view.

## Design Principles

- **Generate intelligence once.** All significance detection, ranking, and
  classification happens once, upstream, in the Insight Engine. The page
  never re-derives a judgment the backend already made.
- **Present the same intelligence in multiple ways.** A report's narrative,
  Today's Highlights, the Insights Archive, and the Insight Timeline are
  four different views over the same underlying `intelligence_insights`
  rows — not four independent analyses.
- **Avoid additional AI calls for presentation.** Gemini is invoked once,
  during report generation, by the edge function. Nothing in
  `intelligence.html` calls an LLM. Every on-page feature — including
  Today's Highlights — is deterministic client-side logic over data that
  already exists.
- **Centralize business logic.** Classification and ranking rules live in
  one named function each (`groupInsightsByRecency`,
  `rankInsightForHighlight`), not copy-pasted across the sections that use
  them.
- **Keep UI components lightweight.** Render functions
  (`renderOverviewStats`, `renderReportHistoryTable`, `renderHighlights`,
  etc.) format and inject HTML. They do not classify, rank, or decide
  significance — that's upstream logic's job, called into from the render
  path, never re-implemented inside it.
- **Prefer shared helper functions over duplicated logic.** `sbGet`,
  `esc`, `renderMarkdown`, `groupInsightsByRecency` are each written once
  and reused everywhere they apply.
- **Design for future expansion without restructuring.** New sections are
  added as independent `.section-block`s with their own render function;
  new future modules are entries in a data array
  (`FUTURE_MODULES`), not new markup; new ranking factors are entries in
  a list (`HIGHLIGHT_RANK_FACTORS`), not a rewritten formula.

## Modularization

**Decision (M1.1 stabilization):** `intelligence.html`'s page-specific
JavaScript lives in a companion file, `intelligence.js`, loaded via a
plain `<script src="intelligence.js"></script>` — not inlined in the
HTML file itself. This preserves the project's zero-build-step
convention (still just a script tag, no bundler, no transpilation) while
keeping markup/CSS and behavior in separate files, the same shape already
used for cross-page libraries (`config.js`, `dev-banner.js`,
`terminology.js`, `amenities.js`) but scoped to this one page instead of
shared across many.

**Why now, not later:** Phase 1 shipped with everything inline, and the
file was already 947 lines with only 5 of the eventual ~14 sections
built — the other 9 are still just placeholder cards. `admin.html` (2791
lines, everything inline) is the visible cost of not making this call
early. Doing the extraction before Phase 2 adds real code for Alerts,
Listings Needing Attention, etc. means every future module is written
directly into its final home, rather than being added to an already-huge
inline block and extracted later under more pressure.

**Deliberately not done yet:** splitting `intelligence.js` further into
per-module files (e.g. `intelligence-alerts.js`, `intelligence-search-trends.js`).
Today there is exactly one JS file and it is already coherent — a
speculative split with no real modules to divide along yet would be
guessing at boundaries rather than discovering them. **Revisit this once
a concrete file-size or navigability problem actually appears** (a
natural moment: after the first one or two Phase 2 modules land) — the
same "wait for a real problem, not a hypothetical one" discipline applied
below to the new/continuing/resolved classification.

## Data Flow

```
generate-intelligence-report (Edge Function)
        │
        ▼
intelligence_reports  ──┐
        │                │
        ▼                │
intelligence_insights ◄──┘  (linked via report_insights)
        │
        ▼
┌───────────────────────────────────────────────┐
│                  Overview tab                  │
│                                                 │
│  Section 1: Overview stats                     │
│  Today's Highlights                            │
│  Section 2: Latest Intelligence Report          │
│  Section 3: Report History                     │
│  Section 4: Generate Report                     │
│  Section 5: System Health                      │
│  Reserved: Future Modules                       │
└───────────────────────────────────────────────┘
        │
        ▼
   Insights Archive tab  ──►  Insight Timeline
```

Every box below `intelligence_insights` reads from the same two tables
(`intelligence_reports`, `intelligence_insights`, joined through
`report_insights`) fetched via the existing Supabase REST API. Nothing in
this diagram introduces a new data source or a new backend call.

## Today's Highlights

**Why it exists:** the rest of the page (a full report, a history table,
an insights archive) all require reading. Today's Highlights exists so a
returning staff member can understand what matters in about 30 seconds,
before deciding whether to read further.

**Why it uses `intelligence_insights`, not report prose:** the report's
`body_markdown` is written for narrative flow, not for scanning — its
first few lines are whatever reads best as an opening, not necessarily
what's most significant. `intelligence_insights` already carries
structured, machine-usable significance (`severity`, `confidence`,
`trend`, resolution state), so ranking from insights produces highlights
that reflect actual importance rather than narrative position.

**Why it makes no additional AI call:** the Insight Engine has already
done the significance judgment once, upstream, when the report was
generated. Asking Gemini (or any model) to re-summarize would be
re-deciding a judgment that already exists, violating "generate
intelligence once," and would add cost, latency, and a second place a
number could silently drift from its source.

**Why it stays pinned to the latest report while browsing history:**
Today's Highlights answers "what should I know the moment I open this
page" — a question about *now*, not about whatever historical report a
staff member happens to be inspecting via Report History or the Advanced
date picker. Pinning it to `latestReportId` regardless of what's displayed
in Section 2 keeps that meaning intact; recomputing it per browsed report
would turn it into a second, redundant view of "the currently open
report," which Section 2's chip row already provides.

### Rendering pipeline

```
Insights (fetched once, alongside the latest report's chip row)
        │
        ▼
groupInsightsByRecency(insights, report)
        │   classifies each insight as new / continuing / resolved
        │   for this report's period — shared with Section 2's chip row
        ▼
rankInsightForHighlight(insight, group)
        │   sums HIGHLIGHT_RANK_FACTORS (see below)
        ▼
deriveHighlights(groups)
        │   sorts by rank, caps at MAX_HIGHLIGHTS (5)
        │   maps to { icon, text }
        ▼
renderHighlights(items)
        │   draws the card, or the "No major highlights today." empty state
        ▼
   #highlights-card
```

No step in this pipeline performs a network call, and no step duplicates
logic that lives elsewhere — `groupInsightsByRecency` is the same
function Section 2 uses to build its 🟢/🔴/✅ chip row.

## Known Duplication: New/Continuing/Resolved Classification

**Status: acknowledged, intentionally not centralized yet (M1.1
stabilization decision).** "Is this insight new, continuing, or resolved
relative to this report's period" is currently computed **three separate
times**, in three different places, and nothing guarantees they agree:

1. **Daily reports** — `index.ts`'s `runDailyInsightSweep()` classifies
   by what `runInsightEngine()` actually did on that specific run
   (`toInsert` → new, `toUpdate` → continuing, `toResolve` → resolved).
   This is ground truth for the day the sweep ran.
2. **Weekly/monthly reports** — `report-composer.js`'s
   `composeReportInput()` re-derives the same three groups by comparing
   `first_seen`/`resolved_at` against the report's period boundaries
   (`first_seen` inside the period → new; `resolved_at` inside the period
   → resolved; still open, opened earlier, touched during the period →
   continuing). This is a period-boundary heuristic, not a replay of what
   any sweep actually decided.
3. **The Intelligence page** — `intelligence.js`'s
   `groupInsightsByRecency()` re-derives the *same* period-boundary
   heuristic as (2), independently, purely for display (the chip row and
   Today's Highlights). `report_insights` stores a `role`
   (`biggest_story`/`mentioned`), never the new/continuing/resolved
   classification itself, so the frontend has no choice but to recompute
   it rather than read it.

(1) and (2)/(3) are different *kinds* of classification (an actual
per-run record vs. a period-boundary inference), and (2) and (3) are the
same logic written twice in two languages. **Why this is being left
alone for now, deliberately:** the correct fix — most likely, persisting
the classification onto `report_insights` at write time so (2) and (3)
collapse into "read what's already there" — is a real architectural
change, and there is no evidence yet that the three implementations have
actually diverged in practice. Centralizing prematurely, on a guess about
where the drift *might* happen, risks solving the wrong problem or
solving a problem that never materializes. **The trigger to actually do
this work: a concrete divergence is observed (the UI shows an insight as
"continuing" that a report discussed as "new", or similar), or ongoing
maintenance friction from touching this logic in three places becomes
real** — not a scheduled cleanup task. Until then, this section is the
single place a future contributor can find all three implementations
listed together, so a fix (when warranted) starts from a clear map
rather than rediscovering the duplication from scratch.

## Highlight Ranking

Ranking is intentionally modular, built around a list —
`HIGHLIGHT_RANK_FACTORS` — rather than one inline formula, the same shape
as `DEFAULT_DETECTORS` in the Insight Engine's own architecture. This
document deliberately does not enumerate today's exact weights; those are
implementation detail that will keep shifting as factors are added. What
matters architecturally is the shape:

- **Each factor is independent.** It reads from the insight (and its
  new/continuing/resolved group) and returns a number. It does not
  inspect or depend on any other factor's output.
- **Each factor returns a numeric contribution, nothing else.** No
  factor renders HTML, mutates the insight, or decides display order —
  that's `deriveHighlights`' and `renderHighlights`' job.
- **Each factor has no side effects.** Calling a factor twice with the
  same input always returns the same output. Factors never write to the
  database, never call an API, never mutate shared state.
- **Each factor is inexpensive to compute.** All inputs are already in
  memory by the time ranking runs; a factor should never need its own
  fetch.

`rankInsightForHighlight` sums every factor's contribution. Adding a new
dimension of significance — **Business Impact**, **User Impact**,
**Urgency**, **Novelty**, or any factor not yet imagined — means adding one
more entry to `HIGHLIGHT_RANK_FACTORS`. It does not require touching the
existing factors, `deriveHighlights`, `renderHighlights`, or the pipeline
that calls into ranking. This is the framework; new factors are additions
to it, not redesigns of it.

## Future Modules

The reserved "More Intelligence" grid on the Overview tab is a
placeholder for modules not yet built, including:

- Platform Health
- Listings Needing Attention
- Lead Activity
- Search Trends
- Market Trends
- Data Quality
- AI Recommendations
- Forecasts
- Alerts

Each is currently a data entry in `FUTURE_MODULES` — an icon and a label,
nothing more — rendered by `renderFutureModules()`. Building one out means
replacing its placeholder card with a real `.section-block` and a render
function, following the exact same pattern Sections 1–5 already
establish. No section of this page needs to be restructured to
accommodate a new module.

**When a future module is built, it should consume existing Intelligence
data whenever possible, rather than duplicating business logic.** For
example: "Listings Needing Attention" should read from
`intelligence_insights` (filtered to relevant types — e.g.
`low_performing_listing`, `data_quality` findings, once those detectors
exist) rather than running its own independent significance check against
raw metrics. "Alerts" should be a filtered, prioritized view over the same
open, high/critical-severity insights the rest of the page already
surfaces — not a parallel alerting pipeline. The Insight Engine is the one
place significance is decided; every module downstream of it, present or
future, should be a view, not a second source of judgment.

## Philosophy

**The Intelligence Layer generates knowledge once. Everything else —
reports, highlights, alerts, dashboards, recommendations, and future
modules — is simply a different presentation of that same knowledge.**

This is the guiding philosophy for all future Intelligence page
development. Before adding a new feature, ask: does this need new
knowledge (a new detector, upstream in the Insight Engine), or does it
need a new *view* of knowledge that already exists? Almost everything on
this page — and almost everything planned for it — is the latter.
