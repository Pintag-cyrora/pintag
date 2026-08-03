# scripts/

One-off, manually-run SQL/shell scripts — not `supabase/migrations/`, so
nothing here applies automatically via `supabase db push`. Each script is
self-contained; run it by hand against the connection string you intend,
after reading it.

---

## Legacy Price Range Repair

**Status:** Completed

**Purpose:** Repair records corrupted by the legacy digit-stripping parser
that converted `"$280-300"` → `280300`. The old structured-pricing backfill
stripped every non-digit character from a legacy price string before
casting it to a number, so a genuine range with no digit separator left
over (`"$280-300"` → strip `-` → `"280300"`) silently became one bogus
large number, indistinguishable from a real high-value price once stored.

**Scripts:**
- [`diagnose-legacy-price-ranges.sql`](diagnose-legacy-price-ranges.sql) — read-only. Finds candidate rows and classifies them HIGH / MEDIUM confidence (or excludes them entirely when nothing looks wrong).
- [`generate-legacy-price-range-repairs.sql`](generate-legacy-price-range-repairs.sql) — read-only. Prints guarded, compare-and-swap `UPDATE` statements (plus a paired verification `SELECT`) for HIGH confidence rows only.

**Execution order:**
1. Run `diagnose-legacy-price-ranges.sql`.
2. Review the HIGH confidence rows.
3. Run `generate-legacy-price-range-repairs.sql` to generate guarded `UPDATE` statements.
4. Execute each statement manually, one at a time, inside its own transaction.
5. Verify each `UPDATE` with its paired `SELECT` before committing.
6. Re-run the diagnostic until no HIGH confidence rows remain.

**Never run generated `UPDATE` statements without reviewing them first.**

Full design rationale, confidence-tier definitions, and the idempotency/
concurrency-safety guarantees live in the header comments of the two
scripts themselves — read those before touching either file.

---

## Listings Visibility Incident (2026-08-03)

**Status:** Fixed (commit `b4a45a4`), post-incident verification pending

**Purpose:** `listings.html` defaulted to `currentAvailOnly = true`, so on
first load — before a visitor touched any control — every listing whose
`market_status` was `reserved`/`rented`/`sold`/`fully_occupied`/`off_market`
was hidden client-side. Nothing was missing from the database and no
query/RLS/join changed; the rows were fetched and then discarded in the
browser. The fix restores "All Listings" as the default; "Available Only"
is opt-in, as it was before the regression was introduced. See
`tests/listings-visibility/` for the Playwright regression suite.

**Scripts:**
- [`verify-listings-count.sh`](verify-listings-count.sh) — confirms the exact query `listings.html` sends returns every non-draft row (not just the ones with a "nice" `market_status`). Needs network access to Supabase, so it cannot run from a sandboxed session — run it from a machine that has it.
- [`market-status-report.sql`](market-status-report.sql) — read-only. Breaks down every listing by `market_status`/`workflow_status`, and flags listings marked unavailable suspiciously soon after creation. This incident revealed that production's `market_status` distribution has likely never been reviewed by a human — run this once to confirm the values it contains are real, not a second, independent data bug.

**To do once run:** if `market-status-report.sql` shows an implausibly large share of listings marked unavailable, that's a separate bug from the one fixed here (client-side filtering vs. bad underlying data) and needs its own investigation.
