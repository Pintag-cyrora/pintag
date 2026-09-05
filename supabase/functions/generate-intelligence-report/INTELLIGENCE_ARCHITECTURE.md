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
Daily Metrics Snapshot (SQL) daily_metrics_snapshot (immutable, one row/day)
   |
Insight Engine (TypeScript)  insight-engine.js
   |
Trend Calculator (TS)        trend-calculator.js
   |
Report Composer (TypeScript) report-composer.js
   |
Gemini                       gemini-client.js
   |
Validation Layer (TS)        report-validator.js
   |
Daily / Weekly / Monthly Intelligence Report
```

`index.ts` is a thin orchestrator. It imports every layer and wires them
together; it does not itself compute metrics, detect significance, compute
trends, decide what a report discusses, talk to Gemini, or validate
Gemini's output.

## Layer responsibilities

- **Metrics Engine computes facts only.** `intelligence_daily_metrics()`
  in the migration is plain counts and ratios — zero thresholds, zero
  judgment calls. It never decides whether a number is interesting.
- **The Daily Metrics Snapshot is written exactly once per day and never
  recalculated.** `daily_metrics_snapshot` is populated by
  `ensure_daily_metrics_snapshot()` (`INSERT ... ON CONFLICT DO NOTHING`,
  and it refuses to finalize today-or-later) and is immutable by database
  trigger — any `UPDATE` attempt raises an exception. Every report reads
  history from this table, never by recomputing
  `intelligence_daily_metrics()` over the live event tables for a past
  day. This is what makes "the same report generated twice from the same
  period produces the same numbers" a database guarantee, not a hopeful
  side effect of event tables happening to be append-only.
- **Insight Engine detects and manages insights only.** `insight-engine.js`
  decides significance (via detectors — see below), matches findings
  against existing open insights, and manages their lifecycle
  (insert/update/resolve, with hysteresis). It never writes prose and
  never talks to Gemini.
- **Trend Calculator computes comparisons only, never narrates them.**
  `trend-calculator.js` is the ONLY place today-vs-yesterday,
  vs-7-day-average, vs-30-day-average, and Week/Month-over-Week
  percentages are computed. Every comparison is a direct arithmetic
  function of the snapshot values it's given — nothing is estimated. A
  baseline below `MIN_BASELINE_FOR_PCT` (3) produces `null`, not a huge or
  misleading percentage — this is the fix for the literal "Searches up
  1504%" failure mode the product spec named: a near-zero baseline must
  never be allowed to produce a large, technically-correct-but-meaningless
  percentage. Gemini receives this module's output as the ONLY
  comparisons it may state (see `buildPrompt()`'s TREND ANALYSIS block) —
  it never recomputes a percentage itself.
- **Report Composer assembles report structure only.** `report-composer.js`
  decides which insights a given report discusses, in what role, and
  builds the structured prompt Gemini receives. It never invents a fact
  or a number — everything it hands to Gemini already came from the
  Insight Engine, the Trend Calculator, or the Metrics Engine.
- **Gemini writes prose only.** `gemini-client.js` is the only file that
  calls the Gemini API. The prompt it sends explicitly forbids
  discovering anomalies, deciding significance, inventing a number not
  present in the structured input, or describing the data as
  "stable"/"back to baseline" when the trend analysis or a linked insight
  shows a statistically significant change — see `buildPrompt()` in
  `report-composer.js` for the exact instruction.
- **Validation Layer checks the narrative mechanically, after the fact,
  and never trusts the prompt alone.** `report-validator.js` runs after
  every Gemini call (never on the deterministic quiet-day/fallback paths,
  which are correct by construction) and checks two things purely
  mechanically, with no AI involved: (1) direction contradiction — does
  headline/Biggest-Story language use "stable"/"baseline" wording while a
  strongly significant (`|z| >= 2.5`) insight points the opposite
  direction with no offsetting direction language in the same section;
  (2) number grounding — does every percentage stated in those sections
  correspond (±1, for rounding) to a number that actually appears in the
  insight evidence, the trend analysis, or the raw metrics summary. On
  failure, `index.ts` retries once with the specific issue(s) named in a
  corrective follow-up prompt; if that still fails, it falls back to
  `buildValidationFallbackReport()` — a plain, labeled, data-only report
  — rather than ever persisting a narrative the pipeline itself knows is
  contradictory or unsupported. This is a deliberately cheap, reliable,
  keyword/regex-based check, not a second AI call judging the first —
  see report-validator.js's own header comment for why that tradeoff was
  chosen.
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
defined in `insight-engine.js` (or a sibling module, for a detector
substantial enough to warrant its own file — see `data-quality-detector.js`,
`duplicate-listing-detector.js`, `demand-supply-detector.js`, and
`listing-performance-detector.js`). `context` is
`{ todaySnapshot, trailingSnapshots, ...extraContext }`.
`runInsightEngine()` accepts an array of detectors and merges every
detector's findings before running the shared lifecycle logic — that
logic has no idea which detector produced a given finding. `DEFAULT_DETECTORS`
(just `zScoreDetector`) is the bare default when `runInsightEngine()` is
called with no detectors argument; `index.ts`'s daily sweep actually runs
five — `[...DEFAULT_DETECTORS, dataQualityDetector, duplicateListingDetector,
demandSupplyDetector, listingPerformanceDetector]` — so `DEFAULT_DETECTORS`
names a fallback list, not the full production roster. See
`docs/intelligence/DETECTOR_ARCHITECTURE.md`'s Detector Catalog for what
each one does.

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

`price_trend` is declared in the migration's CHECK constraint but has no
detector behind it yet — it's blocked on price-history data not existing
yet, not a `TRACKED_SCALAR_METRICS` entry. This is expected, not an
oversight; implement it as a new detector when it's actually needed.
`supply_shortage`, `high_performing_listing`, and `low_performing_listing`
were the same kind of documented gap until Intelligence V2 added
`demandSupplyDetector` (a demand-vs-supply ratio, `supply_shortage`) and
`listingPerformanceDetector` (a leaderboard-membership check, the other
two) — see `docs/intelligence/DETECTOR_ARCHITECTURE.md` for their full
catalog entries.

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

## Data Accuracy Invariants

Rules specific to the accuracy/reproducibility guarantees added on top of
the baseline pipeline — see the migration
`20260724000000_daily_metrics_snapshot.sql` and `trend-calculator.js`/
`report-validator.js`.

- **A day's numbers, once finalized, never change.** Enforced by
  `daily_metrics_snapshot`'s `BEFORE UPDATE` trigger
  (`reject_daily_metrics_snapshot_update()`), not just by convention. A
  genuinely wrong historical snapshot requires an explicit `DELETE` +
  re-finalize by staff — never a silent overwrite by any code path,
  including a future one nobody has written yet.
- **"Today" (or later) is never finalized.**
  `ensure_daily_metrics_snapshot()` clamps its own upper bound to
  `CURRENT_DATE - 1` regardless of what range it's asked for — an
  in-progress day's numbers are still moving and must never be frozen as
  if the day were complete.
- **Confidence is banded from sample size, not asserted by the AI.**
  `data_confidence_from_sample_size()` (SQL) and `dataConfidenceLabel()`
  (`trend-calculator.js`) implement the exact same thresholds
  (`<10`/`<30`/`<100`/`100+` -> low/moderate/high/very_high) — duplicated
  deliberately (one for set-based SQL finalization, one for TS period
  aggregation), not called cross-runtime. If these thresholds ever change,
  both must change together.
- **A report's `validation` log is written by `report-validator.js` and
  `index.ts` only, never asserted by Gemini.** Gemini has no way to mark
  its own output as validated — `contradictions_detected`,
  `narrative_fallback_used`, and `confidence` are all computed and set by
  code, after Gemini's response is already in hand.
- **A percentage the narrative states must trace back to real evidence.**
  This is enforced by `checkNumberGrounding()`, not merely requested by
  the prompt — the prompt's instructions are the first line of defense,
  the validator is the one that's actually checked before a report is
  ever persisted.

## BI Metrics: flow vs. stock

`20260725000000_intelligence_bi_metrics.sql` extends the Daily Metrics
Snapshot with real business metrics (new/removed listings, active
inventory, asking price, days on market, top district/listing, conversion
ratios). The one distinction every new metric had to be sorted into before
it could be added:

- **Flow metrics** (new listings added, listings removed, days-on-market
  transitions, search-to-view/view-to-contact conversion, most-searched-
  district, most-viewed-listing) are genuine per-day historical facts,
  computed inside `intelligence_daily_metrics()` itself — safely
  re-derivable for any past date, exactly like `search.total` or
  `whatsapp_clicks` always have been.
- **Stock metrics** (`active_inventory`, `asking_price`) are a read of
  "right now," not a time series — Pintag has no historical point-in-time
  inventory data before the day this migration's snapshot-writing starts
  capturing it. These live in a separate function
  (`point_in_time_supply_snapshot()`) and are merged into
  `daily_metrics_snapshot` by `ensure_daily_metrics_snapshot()` **only for
  the single most-recently-finalized day** — every earlier day in a
  multi-day backfill gets `null` for both, honestly, rather than a
  fabricated "current inventory as of a past date." This is the same
  discipline the original `intelligence_daily_metrics()` comment already
  established for supply data — extended, not violated, by finally adding
  it.
- **New metrics that don't fit either bucket are left out, not
  approximated.** New-vs-returning-user counts are the clearest example:
  Pintag has no persistent cross-session visitor identifier (only a
  per-tab `session_id` in `sessionStorage`), so "returning user" cannot be
  measured honestly today. Building it would mean adding a persistent
  identifier (e.g. a `localStorage`-backed id alongside the existing
  session id) first — flagged as a real follow-up, not silently
  approximated with a weaker signal that would measure something else
  while claiming to measure this.

Any future flow metric follows the first pattern (add to
`intelligence_daily_metrics()`, safely re-callable for any range); any
future stock/current-state metric follows the second (its own function,
merged only at `v_end`) — this split is now the standing rule for adding
BI metrics, not a one-off decision.

`20260905000000_intelligence_customer_intent.sql` (Intelligence V2) added
one field of each kind, following this same split rather than introducing
a third bucket: `customer_intent_segments` (a per-`(transaction_type,
property_type, district)` search-segment leaderboard — a flow metric,
computed inside `intelligence_daily_metrics()`, safely re-derivable for
any past date) and `active_inventory.by_segment` (a `"tx|type|district" →
count` map — a stock metric, added to `point_in_time_supply_snapshot()`
and merged only for the single most-recently-finalized day, exactly like
`active_inventory`'s existing fields). The segment key deliberately
excludes bedrooms (`search_events.bedrooms` is a real column that is
never populated — listings.html has no bedroom filter) and exact price
bands (would require duplicating `budget-bands.js`'s currency-specific
band boundaries into SQL) — both additive changes only, no existing field
renamed or reinterpreted, so `SNAPSHOT_SCHEMA_VERSION` was not bumped.

## Version Metadata

Every generated report carries version metadata for traceability and
reproducibility (`intelligence_reports.snapshot_version`,
`report_version`, `prompt_version`, `validator_version`, plus the
pre-existing `model_used` and `generated_at`, which already cover "AI
Model Version" and "Generated Timestamp" and are not duplicated):

| Field | Meaning | Source of truth |
|---|---|---|
| `snapshot_version` | Shape of the `daily_metrics_snapshot` jsonb this report read | `versions.js` → `SNAPSHOT_SCHEMA_VERSION` |
| `report_version` | Shape/semantics of the `intelligence_reports` row itself | `versions.js` → `REPORT_FORMAT_VERSION` |
| `prompt_version` | Which `buildPrompt()` template generated the narrative | `versions.js` → `PROMPT_VERSION` |
| `validator_version` | Which `report-validator.js` rule set checked the narrative | `versions.js` → `VALIDATOR_VERSION` |
| `model_used` | AI Model Version (or `'deterministic'` for quiet-day/no-AI reports) | set directly in `index.ts` |
| `generated_at` | Generated Timestamp | database default, set at insert |

Rules:

- `prompt_version`/`validator_version` are `NULL` on quiet-day and
  validation-fallback reports — a prompt/validator genuinely didn't run
  for those, and a version tag would misrepresent that as having happened.
- Reports generated before this migration have all four new columns
  `NULL`, deliberately not backfilled — see **Versioning** below. `NULL`
  means "generated before version tracking existed," never "unknown
  version of the current system."
- `versions.js` is the single place all four constants live. Bump the
  relevant one whenever that layer's *output shape or behavior* changes
  materially — not for every commit, and not for purely additive changes
  (a new field appended, a new optional param) that don't change how
  already-generated reports should be interpreted.

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
