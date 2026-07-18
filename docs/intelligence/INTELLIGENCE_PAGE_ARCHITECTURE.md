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
