# Intelligence — UX & Design Review (2026-07-19)

> Backing material for a review deliverable, not a spec. This document exists
> so the finding list is git-searchable even without opening the interactive
> version. The primary deliverable is the published review artifact (screenshots
> with annotations, side-by-side consistency comparisons, and the full
> reasoning behind each finding) — ask the session/product owner for the link
> if you don't have it. This pass changed **no product code** — `intelligence.html`
> and `intelligence.js` are unmodified by this commit; screenshots below are the
> only new files.

## Scope

In scope: `intelligence.html` + `intelligence.js` (the Overview tab and Insights
Archive/Timeline view). Out of scope: dark mode (a documented, intentional
no-op — not a finding), `admin.html`'s own nav/tab chrome (`.admin-nav-btn` is
a shared component — unifying it with the body's `.insp-btn` family is a
cross-page change, noted as a dependency), and the backend/Insight Engine
architecture (referenced only as context, not re-litigated).

## Screenshots in this directory

All captured against the real `intelligence.html` served locally, driven by
the committed Playwright mocks (`tests/intelligence/mock-supabase.js` +
`fixtures.js`) — not mockups.

- `ux-review-01-full-page.png` — the full Overview tab, top to bottom, fully populated.
- `ux-review-02a-overview-stats.png`, `ux-review-02b-alerts.png`, `ux-review-02f-history.png`, `ux-review-02h-generate.png` — individual section crops used for the card-geometry and color-vocabulary comparisons.
- `ux-review-03a-empty-alerts.png`, `ux-review-03b-empty-report.png` — the two empty-state implementations, captured side by side (see finding C5 — they render nearly identically despite different code paths).
- `ux-review-04-loading.png` — mid-fetch loading state, showing the one already-consistent pattern across sections.
- `ux-review-05-large-dataset.png` — Alerts and Listings Needing Attention under a realistic backlog (8 near-identical rows) — the evidence for the "scan in 30 seconds" and grouping findings.
- `ux-review-06-mobile.png` — full page at 390px width.

## Findings summary (mirrors the review artifact's priority table)

| ID | Finding | Priority | Effort | Timing |
|---|---|---|---|---|
| V1 | No clear first move — every section header is the same weight | High | Medium | Longer-term |
| V2 | Alerts doesn't visually lead despite being the priority section | High | Small | Quick win |
| V3 / U3 | No grouping at volume — 8 identical rows instead of 1 summarized line | Medium | Large | Longer-term |
| V4 | "Coming soon" reads as a real section at full visual weight | Medium | Small | Quick win |
| W1 | Overview Stats leads but answers none of the scope-test questions | High | Medium | Longer-term |
| W2 | Today's Highlights duplicates the Report directly below it | Medium | Medium | Longer-term — needs owner confirmation |
| W3 | "Coming soon" candidate for removal from this page entirely | Medium | Small | Quick win |
| C1 | Card radius/padding drift — 10px vs 12px, no rule | Low | Small | Quick win |
| C2 | 4 color vocabularies reusing the same 4 hues for different meanings | High | Medium | Longer-term |
| C3 | 25+ emoji as the entire icon system, with real meaning collisions | Medium | Medium | Longer-term |
| C4 | Two button systems — nav vs. body — no shared tokens | Low | Medium | Longer-term — cross-page |
| C5 | Empty-state duplication in code (not visible to users) | Low | Small | Quick win |
| C6 | Label size drift across 5 near-identical values | Low | Small | Quick win |
| C7 | Responsive coverage thin — 3 of 9 sections have breakpoints | High | Large | Longer-term |
| C8 | Loading states — keep as-is, the one already-consistent pattern | — | — | No action needed |
| U1 | No visible error state — failure and "nothing to report" look identical | High | Small–Medium | Quick win |
| U2 | Redundant round-trip between Alerts and Attention (same tick) | Low | Medium | Longer-term — handle carefully |
| U4 | Accessibility — color/emoji-only signal, unaudited focus states | High | Medium | Longer-term |
| U5 | Multiple independent fetches per load, uncached Timeline reopen | Low | Medium | Longer-term |
| U6 | Full-page reload after every Generate/Delete action | Low | Small | Quick win — verify first |

## Next step

This document and its screenshots are informational. Nothing here should be
implemented until the product owner has reviewed the findings and chosen
which ones become the next Intelligence implementation phase.
