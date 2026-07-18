# Intelligence Roadmap

> High-level direction only. This document describes where the
> Intelligence system is heading, not how each phase will be implemented —
> see `INTELLIGENCE_PAGE_ARCHITECTURE.md` for the architecture those
> implementations must fit into, and
> `supabase/functions/generate-intelligence-report/INTELLIGENCE_ARCHITECTURE.md`
> for the pipeline invariants they must preserve.

## Phase 1 — Intelligence Reports & Dashboard ✅

The foundation: a generated, narrated report; a persistent record of
detected conditions; and a page to read them from.

- Report generation (Daily / Weekly / Monthly, via the Insight Engine +
  Report Composer + Gemini pipeline)
- Report History
- Today's Highlights
- System Health

## Phase 2 — Actionable Intelligence

Surfacing what specifically needs a human to act, not just what
happened.

- Listings Needing Attention
- Alerts
- Data Quality

## Phase 3 — Operational Intelligence

Rounding out day-to-day operational visibility beyond report periods.

- Lead Activity
- Search Trends
- Market Trends
- Platform Health

## Phase 4 — Predictive Intelligence

Moving from describing the present to anticipating what's next.

- Forecasts
- AI Recommendations
- Opportunity Detection

## Phase 5 — Autonomous Intelligence

Intelligence that doesn't just inform a decision but participates in
making it.

- AI-generated actions
- Automated recommendations
- Self-monitoring intelligence

---

Each phase builds on the same Intelligence Layer invariants established in
Phase 1: knowledge is generated once, upstream, and every later phase adds
a new *presentation* or *action* over that knowledge — not a second,
parallel source of judgment.
