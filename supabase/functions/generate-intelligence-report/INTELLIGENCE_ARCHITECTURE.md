# Intelligence Layer — Architecture Invariants

This document is the canonical reference for the rules the Intelligence
Layer must never violate, regardless of who (or what) is extending it
next — a human contributor, a future Claude session, or an AI agent
downstream of this system. If a change would require breaking one of
these rules, that's a signal to stop and reconsider the design, not to
edit this file to match the change.

## Baseline

The commit tagged `intelligence-layer-baseline` is the reference
implementation: the pipeline, the pluggable Detector interface, and every
invariant below, as reviewed and approved in the pre-merge architecture
review. Treat it as the thing future changes are diffed against, not just
the current state of the branch.

Future changes to this subsystem should be incremental and explicitly
justified against that baseline — e.g. "adds detector X per the Adding a
Detector section below" — rather than casual refactors of the core
pipeline, the detector interface, or the invariants documented here. A
change that would require rewriting or contradicting the baseline's
architecture is a signal to raise it for review explicitly, not to just
make it.

## Pipeline

```
Database (5 event tables)
   |
Metrics Engine (SQL)         intelligence_daily_metrics()
   |
Insight Engine (TypeScript)  insight-engine.js
   |
Report Composer (TypeScript) report-composer.js
   |
Gemini                       gemini-client.js
   |
Daily / Weekly / Monthly Intelligence Report
```

`index.ts` is a thin orchestrator. It imports all four layers and wires
them together; it does not itself compute metrics, detect significance,
decide what a report discusses, or talk to Gemini.

## Layer responsibilities

- **Metrics Engine computes facts only.** `intelligence_daily_metrics()`
  in the migration is plain counts and ratios — zero thresholds, zero
  judgment calls. It never decides whether a number is interesting.
- **Insight Engine detects and manages insights only.** `insight-engine.js`
  decides significance (via detectors — see below), matches findings
  against existing open insights, and manages their lifecycle
  (insert/update/resolve, with hysteresis). It never writes prose and
  never talks to Gemini.
- **Report Composer assembles report structure only.** `report-composer.js`
  decides which insights a given report discusses, in what role, and
  builds the structured prompt Gemini receives. It never invents a fact
  or a number — everything it hands to Gemini already came from the
  Insight Engine or the Metrics Engine.
- **Gemini writes prose only.** `gemini-client.js` is the only file that
  calls the Gemini API. The prompt it sends explicitly forbids
  discovering anomalies, deciding significance, or inventing a number not
  present in the structured input — see `buildPrompt()` in
  `report-composer.js` for the exact instruction.
- **Reports never create knowledge.** A report is a narrated view of
  `intelligence_insights` at a point in time. It does not exist as an
  independent source of truth — see Database Invariants below.
- **`intelligence_insights` is the single source of truth** for "what's
  happening in the marketplace." Reports are views over it, not the other
  way around.
- **One active (unresolved) insight represents one real-world condition.**
  Enforced at the database level, not just by application logic — see
  Database Invariants below.
- **Significance is always determined deterministically.** Today that
  means a z-score against a metric's own rolling 30-day baseline
  (`zScoreDetector` in `insight-engine.js`), with hysteresis (a lower bar
  to stay open than to open) to avoid flapping on ordinary noise. Future
  detector shapes (percentile-based, ratio-based, rule-based, ML-based)
  must be equally deterministic and auditable — "the model decided" is
  never an acceptable justification for why an insight opened.
- **A detector may be added without modifying the lifecycle engine** (the
  match/insert/update/resolve/hysteresis logic in `runInsightEngine()`)
  **or any other detector.** See "Adding a detector" below.
- **The AI never decides what is important.** Gemini never discovers
  anomalies, never invents a number not present in the structured input
  it was given, and is never the reason an insight opens, updates, or
  resolves.

## Adding a detector

A `Detector` is `{ key, detect(context) -> RawFinding[], reevaluate?(insight, context) -> {stillSignificant} | null }`,
defined in `insight-engine.js`. `context` is `{ todaySnapshot, trailingSnapshots }`.
`runInsightEngine()` accepts an array of detectors (default:
`DEFAULT_DETECTORS`, currently just `zScoreDetector`) and merges every
detector's findings before running the shared lifecycle logic — that
logic has no idea which detector produced a given finding.

To add a new detector:
1. Write an object satisfying the `Detector` interface.
2. Add it to `DEFAULT_DETECTORS` (or pass it explicitly to
   `runInsightEngine()` for a scoped rollout).
3. Nothing else changes. No edit to the lifecycle loop, `index.ts`, or
   any existing detector.

`reevaluate` is optional — implement it if insights from this detector
should be able to auto-resolve when they stop being significant. If a
detector doesn't provide one (or no registered detector recognizes an
open insight's `metric_key`), that insight force-resolves the next time
it's not re-matched — treat that as "this metric is no longer tracked,"
not a bug.

Four insight `type`s are already declared in the migration's CHECK
constraint but have no detector behind them yet: `supply_shortage`,
`high_performing_listing`, `low_performing_listing`, `price_trend`. Each
needs a genuinely different detector shape (cross-sectional/percentile,
demand-vs-supply ratio, cross-sectional, and blocked on price-history
data not existing yet, respectively) — not a `TRACKED_SCALAR_METRICS`
entry. This is expected, not an oversight; implement them as new
detectors when they're actually needed.

## Database Invariants

What the database *guarantees*, versus what application code merely
*intends* — a future contributor should know exactly which properties
hold even if a caller misbehaves, retries badly, or races itself.

- **Only one generated report per `(report_type, period_start, period_end)`**
  — enforced by a partial unique index on `intelligence_reports`
  (`WHERE status = 'generated'`), not just the edge function's own
  idempotency check. A `status='failed'` row may coexist with a later
  successful retry for the same period; two `status='generated'` rows for
  the same period can never coexist.
- **Only one active (unresolved) insight per real-world condition** —
  enforced by a partial unique index on `intelligence_insights` over
  `(type, metric_key, dimension_district, dimension_property_type,
  dimension_property_id)` (`WHERE resolved_at IS NULL`). Built as a
  `coalesce(..., '')` expression index, not a plain column index —
  standard SQL unique indexes treat `NULL` as distinct from `NULL`, so a
  plain-column version would silently fail to catch duplicates whenever a
  dimension is unset, which is the common case (most insight types use
  only one dimension, or none). Confirmed empirically during
  verification: the plain-column version let a real duplicate through.
  The sweep lock (below) prevents the race that would otherwise attempt
  to violate this; the index is the backstop if it's ever bypassed.
- **`report_insights` links never duplicate** — the existing
  `PRIMARY KEY (report_id, insight_id, role)` enforces this at the row
  level; `buildReportInsightLinks()` in `report-composer.js` is what
  prevents the *application* from ever attempting a duplicate insert in
  the first place (an insight that's both "new" and "resolved" within the
  same weekly/monthly window is deduplicated to one row, higher-priority
  role wins), rather than relying on the constraint to reject it after
  the fact.
- **Reports are disposable; `intelligence_insights` is the source of
  truth.** Deleting a report (the manual preview workflow's Delete
  button, or an explicit `force: true` regenerate replacing an existing
  report) cascades to `report_insights` only — `intelligence_insights`
  rows are never touched by a report deletion. Destroying a generated
  view must never destroy the underlying tracked conditions or their
  history.
- **Any impossible state should be prevented by a database constraint
  where practical, not just application logic.** Application-level checks
  (the idempotency lookup, the sweep lock, the pre-insert dedup) exist for
  efficiency and clean error messages, not as the only line of defense;
  the partial unique indexes and the join table's primary key are what
  make these guarantees true regardless of which caller, retry, or future
  code path attempts to write.

## Versioning

Every detector, report format, and insight schema evolves **additively**,
never by changing the meaning of historical data.

- Adding a new detector, a new metric, or a new report section never
  changes what an *already-generated* report or an *already-recorded*
  insight means. Historical reports and insights must stay interpretable
  exactly as they were generated, indefinitely.
- If a genuinely breaking change is ever required (a detector's
  significance criteria fundamentally redefined, a report format
  restructured incompatibly), introduce it as a **new version** — a new
  detector `key`, a new `report_type` variant, or an explicit schema
  version marker — rather than silently changing the semantics of
  existing rows in place.
- This is what keeps the Intelligence Timeline honest: an insight's
  history (first seen → every report that discussed it → resolved) and
  cross-period report comparisons (weekly vs. last week, this month vs.
  last month) both depend on old and new data meaning the same thing when
  read side by side. A silent semantic change would corrupt every
  comparison spanning the change, invisibly.

## Concurrency

Two requests to the edge function for the same period (a duplicate cron
fire, or a manual regenerate racing a scheduled run) must never produce
two open insights tracking the same condition or two reports for the same
period. See the "Only one..." invariants above for the database-level
guarantees, and `acquireSweepLock()`/`releaseSweepLock()` in `index.ts`
for the application-level mechanism (a single-row claim table, not a
Postgres session-level advisory lock — Supabase's REST API is served over
a pooled connection, so consecutive HTTP calls from the edge function are
not guaranteed to land on the same underlying database session, which
would make session-scoped advisory locks unreliable to acquire in one
request and release in another).
