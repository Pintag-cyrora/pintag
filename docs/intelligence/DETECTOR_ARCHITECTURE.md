# Detector Architecture

> Scope note: this document covers the Intelligence Engine — the
> detection layer that turns raw metrics into `intelligence_insights` rows
> — not the UI that presents them. For the presentation layer, see
> `docs/intelligence/INTELLIGENCE_PAGE_ARCHITECTURE.md`. For the full
> pipeline (Metrics Engine → Insight Engine → Report Composer → Gemini)
> and its database invariants, see
> `supabase/functions/generate-intelligence-report/INTELLIGENCE_ARCHITECTURE.md`
> — that document is the canonical reference for the lifecycle rules
> (matching, hysteresis, trend, versioning); this one exists to give
> detectors themselves — what they are, what they must guarantee, and
> what exists today — their own focused reference as their number grows.

## Purpose

Detectors are responsible for converting raw metrics into structured
`intelligence_insights`. A detector's job is narrow and specific: look at
today's metrics (and recent history), decide whether something is
statistically significant, and describe it — nothing more. It does not
decide how that insight gets narrated (the Report Composer and Gemini's
job), how it gets ranked for Today's Highlights (the Intelligence page's
job), or how long it stays open (the shared lifecycle loop's job, common
to every detector).

The Intelligence Engine is deliberately built so **new detectors can be
added without changing existing ones**. Today there are two detectors
(`zScoreDetector`, `dataQualityDetector`). The architecture below is
written so that remains true as more are added.

## Detection Pipeline

```
Raw Metrics  (intelligence_daily_metrics() — today + 30 trailing days)
        │
        ▼
Detector Pipeline  (every registered detector runs against the same context)
        │
        ▼
Candidate Insights  (RawFinding[] — unranked, unmatched against history)
        │
        ▼
Ranking / Deduplication  (match against open insights by natural key;
        │                 insert / update / resolve with hysteresis)
        ▼
intelligence_insights  (the persistent, cross-day source of truth)
        │
        ▼
Intelligence Page  (reports, Today's Highlights, Insights Archive, Timeline)
```

Every detector sees the same `context` (today's snapshot plus 30 trailing
snapshots) and returns candidate findings independently of every other
detector. Matching, deduplication, and lifecycle management happen once,
in a single shared loop (`runInsightEngine`), after every detector has
run — a detector never matches its own findings against history, and
never writes to the database itself.

## Detector Contract

Every detector must satisfy the same shape:

```
{
  key: string,
  detect(context) -> RawFinding[],
  reevaluate?(insight, context) -> { stillSignificant: boolean | null } | null
}
```

`context` is `{ todaySnapshot: { day, metrics }, trailingSnapshots: [{ day, metrics }, ...], ...extraContext }`
— identical for every detector, every run. `extraContext` is an optional
6th argument to `runInsightEngine(todaySnapshot, trailingSnapshots, openInsights, today, detectors, extraContext)`,
merged flat into `context` alongside `todaySnapshot`/`trailingSnapshots`.
It exists because not every detector is z-score-over-daily-metrics shaped
— `dataQualityDetector` (see catalog below) evaluates raw `properties`
rows, not daily snapshots, and has no meaningful "30-day trailing mean" to
compare against. Rather than force every detector through the metrics
snapshot shape, `extraContext` lets `index.ts` hand a detector-specific
input (e.g. `{ properties }`) through the lifecycle loop untouched — the
loop itself never reads or interprets `extraContext`, it only merges and
forwards it. A detector that doesn't need it simply ignores the extra
keys on `context`.

A `RawFinding` is `{ type, metricKey, dimensionDistrict, dimensionPropertyType, dimensionPropertyId, title, summary, evidence, severity, confidence }`.

Each detector should:

- **Receive the same input structure.** Every detector is handed the same
  `context` object — `extraContext` (above) is the one sanctioned escape
  valve for detector-specific input; a detector still never receives a
  `context` shaped differently from any other detector's.
- **Return zero or more candidate insights.** An empty array is a
  perfectly normal result (nothing significant today) — a detector never
  needs to report "no findings" any other way.
- **Have no side effects.** A detector never writes to the database,
  never calls an external API, never mutates `context` or anything passed
  into it.
- **Be deterministic.** The same `context` must always produce the same
  `RawFinding[]`. This is what makes the whole engine safely re-runnable —
  idempotency and the manual preview workflow both depend on it.
- **Avoid database writes.** Persistence (insert/update/resolve) belongs
  exclusively to the shared lifecycle loop in `runInsightEngine`, which
  runs after every detector has already returned.
- **Avoid UI logic.** A detector's `title`/`summary` should be a plain,
  factual description of what was measured (see `zScoreDetector`'s
  `buildTitle()` — "X up N% vs. 30-day average") — not narrative framing,
  formatting, or anything that assumes a particular presentation. Report
  narration is Gemini's job; ranking for display is the Intelligence
  page's job.

`reevaluate` is optional, and only needed if a detector's insights should
be able to auto-resolve once they stop being significant. The shared
lifecycle loop calls it once per open insight that wasn't re-matched this
run, trying each registered detector in turn:

- Returning `null` means "not mine" — if no detector claims an insight,
  it is force-resolved as orphaned (e.g. because the detector that
  originally opened it was removed).
- Returning `{ stillSignificant: null }` means "mine, but I can't tell
  right now" (see the schema-drift safety note below) — the insight is
  left untouched, neither resolved nor updated.
- Returning `{ stillSignificant: true | false }` means the detector could
  evaluate it — the lifecycle loop updates or resolves accordingly, using
  a lower bar to resolve than the one that opened it (hysteresis), so an
  insight sitting right at the boundary doesn't flap open/resolved on
  ordinary noise.

## Detector Catalog

### `zScoreDetector`

- **Key:** `z_score`
- **Purpose:** flags a metric as significant when today's value is at
  least 1.5 standard deviations from its own trailing 30-day mean — a
  per-metric, self-adjusting bar rather than a universal percentage
  threshold. This is currently the engine's only detector and the only
  one wired into `DEFAULT_DETECTORS`.
- **Metrics used:** two groups, defined in `TRACKED_SCALAR_METRICS` and
  `TRACKED_BREAKDOWN_METRICS`:

  | Metric key | Label | Insight type |
  |---|---|---|
  | `search.total` | total searches | `search_trend` |
  | `search.zero_result` | zero-result searches | `search_trend` |
  | `listing_ctr` | listing click-through rate | `ctr_improvement` (up) / `ctr_decline` (down) |
  | `whatsapp_clicks` | WhatsApp clicks | `conversion_anomaly` |
  | `leads_created` | leads created | `conversion_anomaly` |
  | `gallery_events` | gallery interactions | `ux_anomaly` |
  | `share_events` | share clicks | `ux_anomaly` |
  | `favorite_events` | favorite attempts | `ux_anomaly` |
  | `map_events` | map usage | `ux_anomaly` |
  | `search.by_district` | searches (per district) | `demand_spike` |
  | `search.by_property_type` | searches (per property type) | `demand_spike` |
  | `views_by_district` | listing views (per district) | `demand_spike` |
  | `views_by_property_type` | listing views (per property type) | `demand_spike` |

- **Insight types produced:** `search_trend`, `ctr_improvement`,
  `ctr_decline`, `conversion_anomaly`, `ux_anomaly`, `demand_spike` — 6 of
  the 10 types the `intelligence_insights.type` CHECK constraint allows.
- **Typical severity:** derived from `|z|` via `severityFromZ` —
  `critical` at `|z| ≥ 3.5`, `high` at `|z| ≥ 2.5`, `medium` at
  `|z| ≥ 1.5`, `low` below that. Confidence is derived from the same
  `|z|` via `confidenceFromZ`, scaled so `|z|=1.5` (just past the open
  bar) reads as low confidence and `|z|≥4` reads as full confidence.
- **Typical evidence payload:** `{ today, mean, stddev, z, direction }` —
  see Evidence Schema below.

**Not yet implemented:** `supply_shortage`, `high_performing_listing`,
`low_performing_listing`, and `price_trend` exist in the database's
allowed `type` values but have no detector producing them yet. Each
needs a genuinely different detector shape than z-score-vs-baseline
(cross-sectional percentile comparison, a demand/supply ratio, a
historical price series) — they are documented here as known gaps, not
as bugs, and are natural candidates for the "Adding a Detector" checklist
below.

### `dataQualityDetector`

- **Key:** `data_quality`
- **Purpose:** flags active listings with a data-quality problem a buyer
  or staff member would notice — missing photos, missing AI-generated
  copy, missing price/location, staleness, or a lack of leads. Added as
  part of Phase 2A (Alerts); extended with 5 more rules in Phase 2B
  (Listings Needing Attention) — see `docs/intelligence/PHASE2_PLAN.md`.
- **Shape: rule-based, not z-score-based.** This is the first detector
  that doesn't fit `zScoreDetector`'s pattern, and is the reason
  `extraContext` (above) exists: it evaluates a snapshot of current
  `properties` rows (fetched by `index.ts` via `fetchDataQualityProperties()`
  and passed in as `extraContext.properties`), not a daily metrics
  snapshot with a 30-day trailing baseline. Confidence is always `1.0`
  (a rule is either true or false — no statistical uncertainty to
  express) and severity is a fixed per-rule constant, not derived from a
  magnitude.
- **Rules** (each independently evaluated per property, in
  `data-quality-detector.js`):

  | Rule | Condition | Severity |
  |---|---|---|
  | `missing_photos` | no `images` | `high` |
  | `missing_price` | no `price_display` (the one field every buyer-facing surface renders, regardless of transaction type) | `high` |
  | `missing_ai_highlight` | no `property_highlight_en` | `medium` |
  | `missing_ai_description` | no `description_en` | `medium` |
  | `missing_location` | no `district_en` or no `village_en` | `medium` |
  | `missing_neighborhood_insight` | no `neighborhood_insight_en` | `low` |
  | `stale_listing` | age ≥ `STALE_DAYS_THRESHOLD` (45 days) AND `view_count` < `STALE_VIEW_THRESHOLD` (3) | `medium` |
  | `no_leads` | age ≥ `STALE_DAYS_THRESHOLD` (45 days, the same "old enough to judge" bar `stale_listing` uses) AND the property has zero rows in `leads` | `medium` |

  `missing_ai_highlight` and `missing_ai_description` are checked
  independently (Phase 2A originally combined them into one "missing both"
  check; Phase 2B split them so a listing missing just one gets its own
  specific reason). `no_leads` needs data beyond `properties` —
  `extraContext.propertyIdsWithLeads` (a `Set` built by `index.ts` via
  `fetchPropertyIdsWithLeads()`) is passed alongside `properties` for this
  one rule to consult.

  Only listings with `status IN ('active', 'available')` (`TRACKED_STATUSES`)
  are evaluated — a sold/withdrawn listing's stale photos aren't a live
  problem.
- **Insight type produced:** `data_quality` (one CHECK-constraint value,
  added specifically for this detector — see the
  `20260718110000_data_quality_insight_type.sql` migration). `metric_key`
  is a plain `text` column, not CHECK-constrained, so every rule above
  (and `duplicateListingDetector`'s `duplicate_listing`, below) reuses this
  same `type` without needing its own migration.
- **`reevaluate`:** returns `{ stillSignificant: false }` when the
  property is no longer present in the current tracked-status fetch
  (deleted, or its status moved away from active/available) — the
  listing stopped being a live data-quality concern the moment it left
  the tracked set, regardless of whether the underlying gap was ever
  fixed. Otherwise it re-checks the rule against the property's current
  data and reports whether the original condition still holds.
- **Known, accepted limitation:** because this detector's evidence never
  contains a `z` value, `classifyTrend`'s null-previousMagnitude
  short-circuit always classifies its insights as `trend: 'emerging'`,
  never `strengthening`/`weakening`/`stable`. This is harmless (no crash,
  no incorrect data) — a presence/absence condition doesn't really have a
  magnitude to trend anyway — and is deliberately left as-is rather than
  giving rule-based detectors a second, parallel trend concept.

### `duplicateListingDetector`

- **Key:** `duplicate_listing`
- **Purpose:** flags likely duplicate listings — the one Phase 2B
  condition that isn't a per-property presence/absence check. Added as
  part of Phase 2B (Listings Needing Attention).
- **Shape: cross-sectional, not per-row.** Unlike every rule in
  `dataQualityDetector`, a finding here depends on comparing a property
  against every *other* property in the same fetch — the reason this
  lives in its own sibling module (`duplicate-listing-detector.js`)
  rather than as a ninth rule in `dataQualityDetector`'s `RULES` array.
  Shares the same `extraContext.properties` input `dataQualityDetector`
  reads; needs nothing extra.
- **Heuristic, deliberately conservative:** two active listings are
  flagged only when they share both the exact same (trimmed,
  case-insensitive) `title_en` **and** the same variant signature
  (`bedrooms`, `bathrooms`, and `sale_price`/`rent_price`/`price_display`
  — see `variantSignature()`). Title alone isn't enough: the Multi-Unit
  Buildings feature's design research surfaced a real false-positive risk
  here — a building with a Studio, a 1 Bedroom, and a 2 Bedroom unit,
  entered as separate `properties` rows (before `unit_types` existed, or
  by a caller not yet using it), would very plausibly share the exact same
  title, and must never be flagged as duplicates of each other. Two
  listings matching on both title and variant signature are a much
  stronger duplicate signal than title alone; two listings sharing a title
  but differing on bedrooms/bathrooms/price are much more likely to be
  distinct unit variants than an accidental double-entry. This signature
  is deliberately coarse (three fields, not a fuzzy diff) — per this
  session's "ship what's reliable, defer speculative logic" discipline.
  Untitled listings are never grouped (an empty title is not a meaningful
  duplicate signal). Buildings using the `unit_types` model don't hit this
  at all (one `properties` row per building, not one per unit) — this
  check protects legacy/transition-period data still using the old
  one-row-per-unit pattern.
- **Insight type produced:** `data_quality` (same type as
  `dataQualityDetector`, distinguished by `metric_key = 'duplicate_listing'`
  — see the `metric_key` note above).
- **No one-click fix.** Per `PHASE2_PLAN.md`: "where no one-click fix is
  possible (duplicate listings), the explanation alone is still the
  minimum bar." The Intelligence page still offers an "Edit listing" link
  (so staff can review/compare), but there's no automated resolution.
- **`reevaluate`:** resolves when the property is gone from the tracked
  set, or when it's no longer part of a same-title-and-variant group of 2+
  (e.g. staff retitled one of the duplicates to disambiguate them, or
  edited bedrooms/bathrooms/price so they now read as distinct unit
  variants).

## Evidence Schema

`evidence` is intentionally detector-specific — there is no shared schema
across detectors, because different detection methods produce genuinely
different supporting data (a z-score detector's evidence looks nothing
like what a future ratio-based or percentile-based detector would need).
This section is a reference for UI developers reading `evidence` today,
not a contract detectors must conform to.

**`zScoreDetector`'s evidence shape** (used by every insight type it
produces):

```json
{
  "today": 41,
  "mean": 12,
  "stddev": 9.3,
  "z": 3.1,
  "direction": "up"
}
```

- `today` — the raw measured value for the period being evaluated.
- `mean` — the trailing 30-day mean this value was compared against.
- `stddev` — the trailing 30-day standard deviation.
- `z` — `(today - mean) / stddev`; its sign gives `direction`, its
  magnitude drives `severity` and `confidence`.
- `direction` — `'up'` or `'down'`.

**`dataQualityDetector`'s evidence shape:**

```json
{
  "rule": "missing_photos",
  "property_id": "b6b1e6b2-..."
}
```

- `rule` — which of the eight rules (above) triggered.
- `property_id` — the specific listing this insight is about; also
  populated on `dimensionPropertyId` for indexed lookups, kept here too
  since `evidence` is meant to be a self-contained audit trail per
  detector, not something a reader must cross-reference the row's other
  columns to interpret.

**`duplicateListingDetector`'s evidence shape:**

```json
{
  "rule": "duplicate_listing",
  "property_id": "b6b1e6b2-...",
  "duplicate_of": ["a1c2d3e4-...", "f5g6h7i8-..."]
}
```

- `rule` — always `'duplicate_listing'` (this detector has only one rule).
- `property_id` — the listing this insight is about.
- `duplicate_of` — every other property id sharing this listing's
  normalized title, at detection time. A listing in a group of 3 lists
  the other 2 ids here.

Any future detector should document its own evidence shape in this same
section when it's added, following the same worked-example format —
keys, one-line meaning each, and a realistic sample payload — so this
document stays a complete reference rather than partially documenting
only the original detector.

## Adding a Detector

1. **Implement the detector.** Write an object satisfying the Detector
   contract above (`{ key, detect(context), reevaluate? }`) in
   `insight-engine.js`, or a new sibling module if it's substantial enough
   to warrant its own file.
2. **Register the detector.** Add it to `DEFAULT_DETECTORS` (or pass a
   custom array into `runInsightEngine` for a non-default wiring). This
   should be the only place the detector needs to be referenced for it to
   start running — the lifecycle loop, `index.ts`, and every existing
   detector should require zero changes.
3. **Document the evidence payload.** Add a worked example to the
   Evidence Schema section above, in the same format as `zScoreDetector`'s.
4. **Add tests.** Unit-test the detector's `detect()` against hand-built
   `context` fixtures with known expected findings (and known
   non-findings — confirm it correctly returns nothing when there's
   nothing significant). If it implements `reevaluate`, test the
   still-significant / no-longer-significant / can't-evaluate cases
   explicitly.
5. **Verify generated insights.** Run the full engine against a realistic
   multi-day synthetic series and confirm the insights it opens, updates,
   and resolves match hand-computed expectations — not just that
   `detect()` returns the right shape in isolation.
6. **Confirm no duplicate functionality.** Check the existing detector
   catalog (this document) before adding a new one — if an existing
   detector already covers the same metric and significance question, extend
   or parameterize it rather than adding a second detector that competes
   with it for the same insight key.

## Design Philosophy

**Detectors discover facts. Reports explain facts. Highlights summarize
facts. Future modules visualize facts.**

The Intelligence Engine should generate knowledge once, and every
downstream feature should consume that same knowledge rather than
recomputing it. A detector is the only place a "this is significant"
judgment is made. Everything after that — the Report Composer's
selection of what to discuss, Gemini's narration, Today's Highlights'
ranking, the Insights Archive's filtering, any future module's display —
is a consumer of `intelligence_insights`, never a second place that
independently re-decides significance.
