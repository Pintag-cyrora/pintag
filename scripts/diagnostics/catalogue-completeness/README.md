# Catalogue completeness report

A manual, read-only, aggregate-only report on what the current catalogue contains
(`.github/workflows/catalogue-completeness.yml`, `workflow_dispatch` only). It exists because the figures
in `docs/LAUNCH_ROADMAP.md` are historical (they cover only the 91 listings deleted in the August 2026 incident)
and no completed workflow prints the published / photo / price / availability picture of the whole catalogue.

`run.sh` lints the two SQL files, runs a catalog-only preflight (stops on any FAIL or WARN), then runs one
`SELECT` inside `BEGIN READ ONLY ... ROLLBACK`. It writes nothing to the database, Storage, R2 or backups, uploads
no artifact, and uses the same protected `production-backup` environment and read-only secret as the other
diagnostics. It shares no file with `scripts/diagnostics/orphan-originals`.

**Output**: counts per fixed label. Never a listing id, title, description, village, phone, address, URL,
coordinate, price value, object name or payload. Small counts are possible (the catalogue is ~180 rows) but identify
nothing: no section groups by a person, contact, owner or party.

## Definitions

* **Published** = what the public read policy on `properties` shows an anonymous visitor: `deleted_at IS NULL AND status IN ('active','available')`
  (migration `20260806020000`). The editorial rule (`workflow_status = 'active'`) is reported beside it and any disagreement is counted (should be 0).
* Optional columns (prices, titles, descriptions, contact links, province, map link, `available_from`) are read
  through `to_jsonb(p)`, so a column that does not exist is counted as "absent" instead of failing the report.
  Only the columns listed in `1-preflight.sql` are required.
* **Price classes approximate the formatter** (`ptFormatPriceLine` in `components.js`): a completeness measure,
  not what a visitor sees. Unit-type patterns: 2+ priced units with differing prices (a "From" price), mixed
  currency or frequency ("Prices vary"), identical prices (exact).
* **Availability consistency** flags contradictions between `market_status`, unit-type availability and an
  `available_from` date in the past (Asia/Vientiane date). It does not decide which side is right.
* **Map link class** reports only the *precision class* of the link a listing stores (short link / coordinates with
  5+ decimals, about 1 m / 1-4 decimals / none). It supports the address-privacy decision; no link is printed.

## Sections

0 session guard · 1 row totals · 2 workflow_status · 3 market_status · 4 transaction_type · 5 property_type ·
6 gallery size · 7 gallery vs `property_images` registry · 8 price class · 9 currency · 10 unit-type price pattern ·
11 unit-type count · 12 availability consistency · 13 title languages · 14 description languages ·
15 party / contact / owner links · 16 province / district / village · 17 map-link precision class ·
18 duplicate English titles · 19 lead history · 20 listings by month created.

## Before dispatching (operator checklist)

1. Dispatch **only from `main`** (the job is skipped from any other ref). Confirm the run's commit is the reviewed merge commit.
2. In the repository settings, confirm the `production-backup` environment is restricted to the `main` branch (deployment branches) and
   has its required reviewers; this cannot be verified from the repository.
3. The secret must be the **read-only** database role. The preflight verifies the role cannot write and that row-level security cannot hide rows
   from it; any warning stops the run and also fails the `role+session` verdict. It cannot prove the URL points at **production** rather than another
   database: compare section 1 ("not soft-deleted") with an independent figure such as the latest monitoring run
   (`listings (not soft-deleted): N`), and read section 21 (advisory comparison with the catalogue's row estimate; statistics can lag).
4. Output is counts per fixed label only. Free text in a category column is printed as `other (not a plain code)`, never as the text.

## Limits

* `properties.updated_at` does not exist (probe of 2026-10-22), so staleness cannot be measured here.
* A gallery count says a listing has images, not that the images load or belong to it (see the image-integrity check).
* Counts depend on the role bypassing row-level security; the preflight stops the run if it cannot.

## Tests

`node --test catalogue-completeness-diagnostic.test.js` (repo root). Real-Postgres tests use synthetic data only;
`CI=true` makes a missing PostgreSQL a failure.
