# Phase 2 Plan

> Planning document only. No code changes. See
> `docs/intelligence/ROADMAP.md` for how Phase 2 fits into the long-term
> direction, and `docs/intelligence/INTELLIGENCE_PAGE_ARCHITECTURE.md` /
> `DETECTOR_ARCHITECTURE.md` for the architecture every module below must
> fit into, not redesign.

# Goal

Turn Intelligence from an information dashboard into an operational
assistant — a system that doesn't just tell staff what happened, but
tells them what to do about it.

## Scope test for every module below (confirmed)

Every widget on the Intelligence page should answer one of three
questions: **What happened?**, **What needs attention?**, or **What
should I do next?** If a proposed feature doesn't fit one of those
three, it belongs somewhere else (Analytics, Listings, Leads, etc.), not
here. See `INTELLIGENCE_PAGE_ARCHITECTURE.md`'s "The scope test for every
future widget/module" for the canonical statement of this — kept here
too since it's the first thing to check every module in this plan
against.

---

# Confirmed Near-Term Scope: Phase 2A (Alerts) and Phase 2B (Listings Needing Attention)

Build order and rationale are unchanged from the Candidate Modules
ranking below — Alerts first (no new detector required), then Listings
Needing Attention. This section captures the confirmed concrete scope
for each, superseding the more exploratory notes in the Candidate
Modules entries where the two overlap.

## Phase 2A — Alerts

> **Status: implemented and merged to `main` (PR #41).** Ships 5 of the
> 6 example types below — "Import failures" is deferred (see issue #43's
> sibling tracking issue for import monitoring as its own reusable
> subsystem, not bolted onto Alerts). Alerts is deliberately scoped to
> only the 3 most urgent `data_quality` conditions (`missing_photos`,
> `missing_ai_description`, `stale_listing`) now that Phase 2B covers the
> full data-quality worklist — see Phase 2B's status note below for how
> the overlap was resolved.

The Intelligence landing page's "action required" area — answers "what
needs attention" directly. Confirmed example alert types:

- New high-value lead
- Listings missing photos
- Listings missing AI description
- Stale listings
- Import failures
- Scheduled report failures

Note the range here: some of these (missing photos/description, stale
listings) are listing-data conditions that overlap with Phase 2B: worth
resolving explicitly during implementation (an Alert can reference the
same underlying insight a Listings-Needing-Attention row surfaces,
rather than each maintaining its own duplicate check — see the Guiding
Principle below). Others (import failures, scheduled report failures)
are operational/pipeline health signals, closer in spirit to the
Platform Health candidate module than to a per-listing insight — these
may need a new insight type or may be better read directly from
`intelligence_reports.status`/existing import logs rather than forcing
them through the same detector shape as everything else. Confirm the
exact source for each before implementation, not by assumption.

## Phase 2B — Listings Needing Attention

> **Status: implemented, on branch `claude/phase2b-listings-attention`,
> not yet merged.** Ships 8 of the 9 example conditions below — "Poor
> image quality" stays out of scope (needs image-analysis AI that
> doesn't exist yet). The conceptual overlap with Alerts/Data Quality
> was resolved exactly as anticipated below: `dataQualityDetector` was
> extended (in place, no new detector shape) with 5 more per-property
> rules, plus one new sibling detector (`duplicateListingDetector`,
> genuinely cross-sectional — see `DETECTOR_ARCHITECTURE.md`) for
> "Duplicate listings." Both detectors write the same `intelligence_
> insights` rows Alerts already reads; Alerts was narrowed to an
> explicit 3-metric_key allow-list so the two sections present the same
> underlying data at two different granularities (urgent subset vs.
> full per-listing worklist) rather than duplicating each other.

A worklist, prioritized **by impact, not by listing ID or recency of
creation**. Confirmed example conditions:

- No primary photo
- Missing AI highlight
- Missing neighborhood insight
- Missing price
- Duplicate listings
- Old listing with no views
- Old listing with no leads
- Missing location
- Poor image quality (future AI — explicitly flagged as not buildable
  yet, requires image-analysis capability that doesn't exist today)

**Each item must explain why it appears** (not just flag it — state the
specific condition, e.g. "No views in 45 days" rather than a bare
"Attention needed") **and, ideally, include a one-click action to
resolve it** where one exists (e.g. a direct link into the listing's
edit form, pre-scrolled to the missing field). Where no one-click fix is
possible (duplicate listings, "poor image quality"), the explanation
alone is still the minimum bar — never show an item with no stated
reason.

Most of these conditions are simple presence/absence checks against
`properties` columns, not statistical detections — confirms the Data
Quality candidate module's note below about needing a rule-based (not
z-score) detector shape, and reinforces resolving the conceptual overlap
between Listings Needing Attention and Data Quality during
implementation rather than shipping two separate, overlapping worklists.

---

# Candidate Modules

Ranked by estimated user value relative to implementation complexity —
highest value-to-complexity ratio first. All nine modules from the
Roadmap are included; ranking here is a planning input, not a
commitment.

## 1. Listings Needing Attention

- **Purpose:** surface specific listings that need staff action — stale,
  underperforming, or flagged by a detector — as a worklist instead of
  something staff has to notice on their own.
- **Primary data source(s):** `intelligence_insights` filtered to
  listing-scoped types (`low_performing_listing` once a detector exists;
  today's `demand_spike`/`ctr_decline` insights with a
  `dimension_property_id` would already partially qualify), plus
  `properties` for basic listing metadata (title, status, last updated).
- **Dependencies:** a `low_performing_listing` detector (does not exist
  yet — see `DETECTOR_ARCHITECTURE.md`'s "Not yet implemented" list).
  Without it, this module launches with a narrower set of insights than
  its name implies.
- **Estimated complexity:** Low (page-side: a filtered, sorted list view
  — the same rendering pattern as Report History) once the detector
  exists; Medium including the detector.
- **Estimated user value:** High — this is the most directly actionable
  module on the list; "here are 5 listings to fix today" is immediately
  usable without interpretation.
- **Notes:** the cleanest first Phase 2 module — it's a *view*, not a new
  judgment, once even a minimal detector exists.

## 2. Alerts

- **Purpose:** a single, prioritized feed of open high/critical-severity
  insights across every type — the "is anything on fire" surface.
- **Primary data source(s):** `intelligence_insights` filtered to
  `resolved_at IS NULL AND severity IN ('high','critical')`.
- **Dependencies:** none beyond what already exists — every current
  insight type already carries `severity`.
- **Estimated complexity:** Low — a filtered, sorted view over existing
  data, reusing `renderReportHistoryTable`-style rendering and
  `groupInsightsByRecency`/ranking concepts already built for Today's
  Highlights.
- **Estimated user value:** High — a standing "what's currently bad"
  view is one of the four questions the Intelligence page exists to
  answer (Purpose section, `INTELLIGENCE_PAGE_ARCHITECTURE.md`), and it's
  buildable entirely from data that exists today.
- **Notes:** genuinely buildable first — no new detector required. Should
  reuse `HIGHLIGHT_RANK_FACTORS`-style ranking rather than inventing a
  second ranking scheme.

## 3. Data Quality

- **Purpose:** flag structural problems in the listing data itself —
  missing photos, missing/incomplete fields, stale listings — as a
  cleanup queue.
- **Primary data source(s):** primarily `properties` directly (most data
  quality checks are simple column/field presence checks, not
  statistical), potentially surfaced through a new `data_quality`
  detector type so it also benefits from the insight lifecycle
  (open/resolved tracking, "resolved 12 listings this week").
- **Dependencies:** a new detector type not in the current 10-value
  `intelligence_insights.type` CHECK constraint — requires a small
  additive migration (new allowed `type` value) before it can be modeled
  as an insight rather than a one-off query.
- **Estimated complexity:** Medium — the checks themselves are simple,
  but doing this "the Intelligence way" (as trackable insights, not a
  bespoke one-off report) requires the type migration and a
  rule-based (not z-score) detector shape.
- **Estimated user value:** Medium-High — directly actionable, but
  narrower in scope than Listings Needing Attention, which likely
  subsumes some of the same underlying data once both exist.
- **Notes:** consider merging conceptually with Listings Needing
  Attention rather than building two overlapping worklists — worth
  resolving during Phase 2 kickoff, not left as a build-time surprise.

## 4. Platform Health

- **Purpose:** the operational (not business) health of the Intelligence
  pipeline itself and the platform's supporting systems — is the daily
  cron running, are edge functions succeeding, is data flowing in.
- **Primary data source(s):** `intelligence_reports` (already the source
  for today's System Health section), extended with a "has each expected
  report period actually fired" check; potentially edge function
  invocation logs if/when accessible.
- **Dependencies:** the already-flagged Phase 2 recommendation to add
  `started_at`/`duration_ms` to `intelligence_reports`; a scheduled-run
  expectation model (e.g. "a daily report should exist for every day
  since launch — which ones are missing?").
- **Estimated complexity:** Medium — mostly extending System Health's
  existing logic (`renderSystemHealth`) rather than new infrastructure,
  but "detect a missing scheduled run" is a new kind of check (absence,
  not a metric threshold).
- **Estimated user value:** Medium — valuable for catching silent
  failures, but it's diagnostic rather than directly revenue/operationally
  actionable the way Listings Needing Attention or Alerts are.
- **Notes:** a natural extension of Section 5 (System Health) rather than
  a wholly new section — worth prototyping as "System Health v2" before
  committing to a separate module.

## 5. Lead Activity

- **Purpose:** surface trends and anomalies in the existing Leads CRM
  (`leads` table) — response times, conversion patterns, stalled leads —
  as Intelligence-tracked insights rather than raw CRM counts.
- **Primary data source(s):** `leads`, `lead_events` (both already live,
  per the earlier Leads CRM and Intelligence pivot work this session);
  `whatsapp_clicks`/`leads_created`/`leads_closed` already flow into
  `intelligence_daily_metrics()` and are already tracked by
  `zScoreDetector` as `conversion_anomaly`.
- **Dependencies:** none for a baseline version — the underlying metrics
  and a detector already exist. A richer version (e.g. "leads stalled at
  `contacted` for N days") would need new metrics and possibly a new
  detector.
- **Estimated complexity:** Low for a baseline (surface existing
  `conversion_anomaly` insights plus the raw counts already in
  `metrics_snapshot`); Medium-High for stall/pipeline-aware detection.
- **Estimated user value:** Medium — valuable to agents/staff who work
  leads daily, but narrower audience than platform-wide modules.
- **Notes:** good candidate to prototype cheaply (baseline version) early,
  then decide whether the richer version earns its complexity based on
  actual usage — consistent with the "collect first, understand second,
  optimize third" philosophy from this session's earlier Intelligence
  pivot work.

## 6. Search Trends

- **Purpose:** which searches, filters, and zero-result queries are
  happening — demand signals not yet reflected in supply.
- **Primary data source(s):** `search_events` (already live), already
  partially surfaced via the `search_trend` and `demand_spike` insight
  types.
- **Dependencies:** none for a baseline view — mostly a presentation
  layer over data and insight types that already exist.
- **Estimated complexity:** Low-Medium — similar shape to Alerts (a
  filtered view over existing insights) plus some direct
  `search_events` aggregation for things not yet insight-worthy (e.g. top
  searched terms/filters that haven't crossed a significance bar).
- **Estimated user value:** Medium — useful for supply-recruiting
  decisions, but more of a "browse and explore" module than an
  action-forcing one like Alerts or Listings Needing Attention.
- **Notes:** natural pairing with Market Trends (below) — consider
  scoping them together rather than as two fully separate builds.

## 7. Market Trends

- **Purpose:** marketplace-wide trends over longer windows — price
  movement, district/property-type demand shifts, seasonal patterns.
- **Primary data source(s):** `intelligence_daily_metrics()` aggregated
  over longer windows than a single report period; the `price_trend`
  insight type (not yet detected — see Detector Catalog).
- **Dependencies:** a `price_trend` detector (a historical price series
  detector shape, explicitly flagged as not yet implemented) and,
  likely, a longer-window aggregation than the current 30-day rolling
  baseline supports well.
- **Estimated complexity:** High — requires new detector logic for a
  different statistical shape (trend-over-time, not day-vs-30-day-mean)
  and probably new SQL aggregation.
- **Estimated user value:** Medium-High for management/strategic use, but
  lower day-to-day urgency than the operational modules above.
- **Notes:** the most "report-like" of the operational modules — may be
  better served initially by a Weekly/Monthly report section than a
  standalone dashboard module. Worth revisiting scope once Phase 3
  begins.

## 8. AI Recommendations

- **Purpose:** synthesized, cross-insight suggestions ("recruit more
  listings in District X") rather than per-insight recommendations.
- **Primary data source(s):** the current active `intelligence_insights`
  set — this is explicitly a Gemini synthesis step already partially
  described in the original Intelligence Layer design (the report's own
  "AI Recommendations" section), not a new data source.
- **Dependencies:** several other modules (Listings Needing Attention,
  Search Trends, Market Trends) provide better raw material once they
  exist — this module's *quality* depends on those being built first,
  even though it's technically buildable today.
- **Estimated complexity:** Medium — the report already does a version of
  this per-report; generalizing it into a standing, page-level module
  (not just inside one report's body) is the new work, not the concept.
- **Estimated user value:** High once the underlying insight coverage is
  rich — Medium today, since thin insight coverage produces thin
  recommendations.
- **Notes:** this is a genuine, disclosed exception to "avoid additional
  AI calls" (see Guiding Principle below) — flagged explicitly rather
  than silently adding a second AI call path.

## 9. Forecasts

- **Purpose:** predictive projections (demand, price, inventory) rather
  than descriptions of what already happened.
- **Primary data source(s):** historical `intelligence_daily_metrics()`
  series, once enough history has accumulated.
- **Dependencies:** a meaningfully long history window (this is
  explicitly a "let data accumulate first" item, not something to build
  before there's enough data to forecast from) and a genuinely new
  detector/modeling shape distinct from the current z-score approach.
- **Estimated complexity:** High — a different problem class than
  detection (projecting forward vs. flagging deviation), likely
  requiring new modeling code and careful handling of forecast
  uncertainty in the UI.
- **Estimated user value:** Medium-High long-term, Low today — there
  isn't yet enough historical data for a forecast to be trustworthy.
- **Notes:** correctly the last item on the Roadmap (Phase 4) — flagged
  here mainly to confirm it should stay last, not to plan its
  implementation now.

---

# Recommended Build Order

1. **Alerts** — no new detector required, reuses the same ranking
   philosophy as Today's Highlights, and directly answers "what needs my
   attention" with data that already exists. Best first module: highest
   value-to-effort ratio in the set.
2. **Listings Needing Attention** — the second-cleanest build; even a
   minimal `low_performing_listing` detector unlocks a genuinely
   actionable worklist, and Alerts' ranking/rendering pattern can be
   reused directly.
3. **Lead Activity (baseline version)** — cheap to ship using data and
   insight types that already exist; defers the harder stall-detection
   version until real usage shows it's worth building.
4. **Data Quality** — sequenced after the two attention-worklist modules
   so its overlap with Listings Needing Attention can be resolved by
   design rather than accident; requires the smallest schema change of
   the remaining modules (one new `type` value).
5. **Platform Health (System Health v2)** — extends existing System
   Health logic rather than building new infrastructure; sequenced here
   because `started_at`/`duration_ms` tracking is useful scaffolding for
   whatever comes after it too.
6. **Search Trends** — mostly presentation over data that already
   exists; scoped next to Market Trends conceptually, built first since
   it needs no new detector.
7. **Market Trends** — deferred until after Search Trends because it
   needs a genuinely new detector shape (`price_trend`) and probably a
   longer aggregation window; higher complexity, lower urgency than
   everything above it.
8. **AI Recommendations** — sequenced after Listings Needing Attention,
   Search Trends, and Market Trends specifically because its output
   quality depends on the insight coverage those modules either produce
   or surface.
9. **Forecasts** — last, by design — correctly a Phase 4 concern; listed
   here only for completeness of the ranking exercise.

This order optimizes for shipping something staff can act on immediately
(Alerts, Listings Needing Attention) before investing in the modules that
either need new detector machinery (Data Quality, Market Trends) or need
the earlier modules to already exist to be worth building (AI
Recommendations).

---

# Guiding Principle

Every Phase 2 module should consume existing Intelligence data whenever
possible. Avoid duplicate business logic — a new module is a new *view*
over `intelligence_insights` (and, where needed, a new detector feeding
it), not a parallel query path that re-derives significance on its own.
Avoid additional AI calls unless there is a clear architectural reason —
AI Recommendations is the one module above where a second AI-driven step
is plausibly justified (cross-insight synthesis is a genuinely different
task than detection or narration), and even that should be scoped and
confirmed deliberately, not added by default. Prefer extending the
existing Intelligence Layer — new detectors registered into
`DEFAULT_DETECTORS`, new insight types added additively to the `type`
CHECK constraint, new page sections following the existing
`.section-block` pattern — over creating parallel systems that happen to
live next to it.

---

# Success Criteria

Phase 2 is complete when the Intelligence page has moved from "here is
what happened" to "here is what you should do about it" for at least
the highest-value modules above — concretely, when staff have at least
one standing, always-current worklist (Alerts and/or Listings Needing
Attention) they can act on directly from the page, built on detectors
and data that follow the established architecture rather than a
parallel system. This is intentionally not a fixed checklist of all nine
modules — Phase 2 should be judged complete when it has demonstrably
shifted the page's role, not when every candidate module has shipped.
Some modules above (Market Trends, Forecasts) may reasonably slip into
Phase 3/4 without that meaning Phase 2 failed.
