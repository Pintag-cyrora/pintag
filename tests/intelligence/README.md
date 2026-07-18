# Intelligence Frontend Tests

Playwright coverage for `intelligence.html`. Fully mocked — no real
Supabase project, credentials, or network access required. Isolated from
the app itself (which has no build step and no `package.json` of its
own) — this directory's `package.json` exists only so the test tooling
has somewhere to declare its one dependency.

## Running locally

```sh
cd tests/intelligence
npm install
npx playwright install --with-deps chromium   # first time only
npm test
```

If you're in an environment with a pre-provisioned Chromium binary
(avoiding a fresh download), point at it instead of installing a second
copy:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm test
```

## What's covered

- Section 1 (Overview stats): populated and empty states.
- Today's Highlights: renders ranked insights, shows the empty message,
  and stays pinned to the latest report while browsing history.
- Section 2 (Latest Report): markdown rendering, chip row, the Advanced
  toggle, the Supporting Data panel.
- Section 3 (Report History): row ordering, clicking into a non-latest
  report (including a failed one), "back to latest."
- Section 4 (Generate Report): loading → success status text.
- Section 5 (System Health): last success/execution/error, and the
  honestly-labeled "Not tracked" duration (no fabricated numbers).
- The reserved Future Modules placeholder grid.
- The Delete workflow.
- Insights Archive + Insight Timeline, including the "discussed in
  report" jump-back-to-Overview link.
- XSS safety: a malicious report title/markdown is escaped and never
  executes.

## What isn't covered here

- Unit-level correctness of the Insight Engine / Report Composer /
  Gemini client — see the `.test.js` files next to those modules in
  `supabase/functions/generate-intelligence-report/`, run via
  `node --test`.
- RLS / Edge Function auth — see `tests/security/suites/13_intelligence.sh`.

## Notes on the mocks

`mock-supabase.js` routes every intercepted request by the actual
REST path segment (`new URL(url).pathname`), not a substring match
against the whole URL — a query's own `select=` clause can legitimately
embed another table's name (e.g. `report_insights`'s
`select=role,intelligence_reports(...)`), and naive substring matching
would misroute that request to the wrong handler. This bit a much
earlier, ad hoc version of this test and is worth preserving as the
correct pattern going forward.

`fixtures.js`'s three mock reports are ordered `r-3, r-2, r-1` in the
array, but the *true* "latest" (by `generated_at`) is `r-3` — 2 hours
old, versus `r-2`'s 26 hours and `r-1`'s 70 hours. Tests assert against
actual recency, not array position; keep that in mind when adding new
fixtures or assertions.
