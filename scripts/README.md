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

**Follow-up escalation (Admin also reported showing only 1 listing):** every
application-code path was re-audited and re-proven correct by executing it
live (47 synthetic rows fed to `admin.html`'s real `loadListings()` → 47
rendered; 78 rows fed to `listings.html` → 78 rendered — see git history for
the reproduction scripts). Admin and Public do not share any query, view, or
helper. No `.single()`/`maybeSingle()`/`limit(1)`/`range(0,...)` exists in
either page's listing-fetch code. This ruled out a code-level cause for the
Admin-side report; whatever is being observed in production requires
database access to isolate. See
[`production-diagnosis-runbook.md`](production-diagnosis-runbook.md) — a
copy-paste checklist (every SQL block verified against a local Postgres
replica) for whoever has that access to isolate the cause in under 10
minutes, and to safely repair every corrupted `price_amount` in one guarded
transaction.

---

## Image Rendition Backfill

**Status:** Ready to run — the workflow exists; the production run has not been made.

**Purpose:** Generate the pre-sized WebP delivery renditions
(`image-renditions.js`) for every image on an ACTIVE listing — the building
gallery *and* each unit type's own gallery. Production serves renditions
(`config.js` `renditionsEnabled`). An image with no rendition object still
displays, because every `<img>` carries `data-pt-original` and falls back to
the original on the first error, but it costs a 404 plus a full-size download
on every view. Unit-type photos were missed by the first backfill: it read the
`property_images` registry, which is synced from `properties.images` only, so
`unit_types.images` was never enumerated.

**Scripts:**
- [`backfill-renditions.mjs`](backfill-renditions.mjs) — resumable, idempotent.
  `--dry-run` reports scope and projects storage with no writes at all;
  `--apply` generates the missing objects. Every DB query runs under
  `SET default_transaction_read_only=on` and reads only the `public` schema;
  the only write is a `POST` under `renditions/`, and `upload()` re-checks its
  own destination so a miscomputed path cannot overwrite an original. There is
  no `DELETE`, `PUT` or `PATCH` in the file. Existing renditions are skipped,
  writes stop before crossing a 768 MB storage ceiling, and apply refuses to
  start (exit 4) if it cannot measure total storage to enforce that ceiling.
- [`../tests/backfill-renditions/e2e.mjs`](../tests/backfill-renditions/e2e.mjs)
  — run by hand (`node tests/backfill-renditions/e2e.mjs`). Boots a throwaway
  PostgreSQL cluster, a fake Storage server and a stub encoder, then runs the
  REAL script against them to prove: a dry run completes as a role with no
  `storage` schema access and writes nothing, discovery finds unit-type photos
  and deduplicates them, apply writes only under `renditions/` and leaves every
  original byte-identical, a second apply writes nothing new, and apply refuses
  to write when the ceiling cannot be enforced. Skips cleanly where `initdb` is
  unavailable, so it touches nothing and needs no credentials.

**Credentials — why the dry run needs none.** The production database role is
read-only and deliberately has no access to the `storage` schema, so
`SELECT ... FROM storage.objects` fails with *permission denied for schema
storage*. Discovery does not use it: `property-images` is a public-read bucket,
so an unauthenticated `HEAD` on an object's public URL returns its
`Content-Length`, or 404 when it is absent — the same request the site makes for
every photo. A dry run therefore needs only the read-only DB URL and
`SUPABASE_URL`. `SUPABASE_SERVICE_ROLE_KEY` is required for `--apply` alone, to
write renditions and to measure total storage for the ceiling.

**How to run it:** use the **Backfill Image Renditions** GitHub Actions
workflow (`.github/workflows/backfill-renditions.yml`) rather than running the
script by hand — it holds the production credentials so nobody has to. It is
`workflow_dispatch` only and defaults to `dry-run`, so a bare "Run workflow"
click reports and writes nothing. Choosing `mode: apply` additionally requires
typing `APPLY`, and the dry run always executes first so its storage verdict is
on the record before any object is written. `limit` caps an apply run for a
canary pass. Its safety properties are pinned by
`backfill-renditions-workflow.test.js`.

Running the script directly instead needs `PINTAG_DB_URL`, `SUPABASE_URL` and
(for `--apply`) `SUPABASE_SERVICE_ROLE_KEY` in the environment, plus `psql` and
ImageMagick on PATH.

**Resuming:** re-running is safe and picks up where the last run stopped — the
set of renditions that already exist is re-derived from `storage.objects` every
time, so resume does not depend on the `.rendition-backfill-state.json` the
script writes (that file records failures for inspection and is uploaded as a
workflow artifact).
