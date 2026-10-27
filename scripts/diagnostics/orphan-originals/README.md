# Orphan originals diagnostic

A manual, read-only diagnostic (`.github/workflows/diagnose-orphan-originals.yml`, `workflow_dispatch` only) for the Image
Integrity line "Originals referenced by nothing". `run.sh` lints the SQL, runs a catalog-only preflight, then the data stages inside
`BEGIN READ ONLY ... ROLLBACK`, and `summarize.py` validates the per-object reconciliation. It never deletes or moves anything.

## Analyzing the downloaded artifact locally (read-only, offline)

The run publishes an artifact `orphan-originals-reconciliation` containing `reconcile-objects.csv` (one row per object: names,
sizes, dates, record and listing ids) and `reconcile-summary.md` (aggregates only). Artifact **12313874351** from run **39527790224**
expires on **2026-10-28**. Treat the CSV as sensitive: keep it **outside the repository** (it is git-ignored anyway) and do not share it.

1. Use the real GitHub CLI (`gh auth login` as an account that can read the repository) in a new, empty folder outside the repo:

       mkdir -p ~/orphan-artifact && cd ~/orphan-artifact
       gh api repos/Pintag-cyrora/pintag/actions/artifacts/12313874351/zip > artifact.zip

2. Verify the download before unzipping (macOS: `shasum -a 256 artifact.zip`; Linux: `sha256sum artifact.zip`). It must print exactly

       26a60cf742f5c8a0a45e16e1db4ffdb8ae10bace691b1f25cffb2895d5605afa

   If it differs, stop and do not unzip.

3. `unzip artifact.zip` (gives `reconcile-objects.csv` and `reconcile-summary.md`).

4. From a checkout of this repository (Python 3 only, no packages, no database, no network, no credentials):

       python3 -I -B scripts/diagnostics/orphan-originals/analyze_report.py \
         --objects ~/orphan-artifact/reconcile-objects.csv \
         --summary ~/orphan-artifact/reconcile-summary.md \
         --out ~/orphan-artifact/analysis.txt

   `--summary` cross-checks the category counts against the CSV (the run fails closed if they disagree). `--out` is optional and must be a
   **new** file: the script refuses to write over either input file (including via symlinks or hard links) and over any existing file
   unless you pass `--overwrite` (which still never replaces an input file, a symlink or a directory).

The script prints **aggregates only** (counts, sizes, dates, ranges): no object name, path, record id, listing id or live-object name.
It analyzes the gallery-history matches and the eTag+size duplicate candidates, their overlap, evidence strength, the questions the
report cannot answer, and read-only review steps. It never says anything is safe to delete; do not delete or move storage objects
based on it. To investigate individual objects, work from the CSV on your own machine and keep identifiers out of tickets, logs and chats.

## Gallery Recovery records vs current listing galleries (`reconcile-gallery-listings.yml`)

A second manual, read-only workflow (`workflow_dispatch` only, same protected `production-backup` environment and read-only secret) runs
`run.sh gallery`: lint, the same preflight (plus the `gallery-schema` verdict), a stage-2 cross-check, then
`5-gallery-listing-state.sql` (one SELECT inside `BEGIN READ ONLY ... ROLLBACK`). It does not run stages 3 and 4 again.

For each unreferenced original it takes the LATEST `gallery_assignments` record (records that disagree on listing or operation at the same
instant make the object `ambiguous`; no listing is picked) and reports whether that record's listing is **missing**, **soft-deleted**, or
**active with a gallery that no longer references the photo**. "Photo present in the gallery" is zero by construction (the population is
defined as referenced by no listing) and is checked as a consistency probe: a non-zero value fails the run.

* Job log / summary: aggregate counts, sizes and distinct-listing counts only. No object name, path, listing id or record id.
* Private artifact `gallery-listing-state-private` (kept **3 days**, only after a fully reconciled run): `gallery-listing-detail.csv`
  (objects WITH history only: `object_name`, `latest_op`, `outcome`, `listing_id`, `record_id`, `record_date`, `tied_records`, `tied_listings`,
  `listing_gallery_size`, `listing_changed_after_record`, `confidence`, `recorded_via`, `size_bytes`) and `gallery-listing-summary.md`.
  Download it only on your own computer, keep it outside the repository, and never paste it into chats, tickets or logs.
* `properties.deleted_at` (timestamptz) is required by the `gallery-schema` verdict: if it is missing or of another type the run stops before the query, so a listing is never called active when its deletion state is unknown.
* The private artifact is uploaded only if the reconciliation step succeeded AND the detail file exists.
* Optional input `expected_objects` (e.g. 551): the run stops if stage 2 counts a different number.

## `properties.updated_at` probe (`probe-properties-updated-at.yml`)

A third manual, read-only workflow (`workflow_dispatch` only, same protected environment and read-only secret, **no artifact**) runs `run.sh probe`:
lint, the same preflight, then `6-properties-updated-at-probe.sql` (one SELECT inside `BEGIN READ ONLY ... ROLLBACK`). It prints catalog facts, counts and
dates only: whether `properties.updated_at` exists (type, default), whether `trg_properties_updated_at` exists and is enabled, how many rows have a value
(earliest/latest date, per-month counts), and for listings with Gallery Recovery records how many changed after their latest record. No object is
enumerated and no listing id, record id, title or object name is printed.

## Gallery history vs recorded gallery states (`gallery-history-vs-snapshots.yml`)

A fourth manual, read-only workflow (`workflow_dispatch` only, same protected environment and read-only secret, **no artifact**) runs `run.sh history`: lint,
the same preflight (plus the `history-schema` verdict), the aggregate stage-2 cross-check, then `7-gallery-history-vs-snapshots.sql` (one SELECT inside
`BEGIN READ ONLY ... ROLLBACK`). It asks whether `listing_image_snapshots` / `import_records` can bound WHEN the Gallery Recovery `assign` / `unassign`
images left their listings' galleries. A snapshot is a record of a gallery STATE as the admin editor saved it, not of a removal: a removal is only BOUNDED when
the first state recorded AFTER the Gallery Recovery record demonstrably EXCLUDES that specific image (looked up by its normalized name), and then that state is
only an UPPER bound on when the image left. An image still present in the first later state is reported separately as not yet bounded; removal windows are computed for `assign` records only (an `unassign` record is itself the removal, so its rows are labelled and never carry a window). Image names are compared exactly, as stored or percent-decoded, using the full path from the snapshot's URL (the editor stores only the last URL segment as `storage_path`), and galleries are compared with one normalization on both sides (external URLs included), and "no later state" means the history cannot bound it (the editor writes no
snapshot when a save empties a gallery, and Gallery Recovery writes none). The output is counts and date ranges only; the run fails if the population it
rebuilds differs from the stage-2 total.

## Gallery Recovery images vs the editor's change log (`gallery-provenance-events.yml`)

A fifth manual, read-only workflow (`workflow_dispatch` only, same protected environment and read-only secret, **no artifact**) runs `run.sh provenance`: lint,
the same preflight (plus the `provenance-schema` verdict), the aggregate stage-2 cross-check, then `8-gallery-provenance-photos-changed.sql` (one SELECT inside
`BEGIN READ ONLY ... ROLLBACK`). It asks whether the admin listing editor's `listing_provenance` `photos_changed` events can explain why the Gallery Recovery
`assign` images (the ones whose first later gallery state excludes them) are missing. Each such event stores the gallery BEFORE and AFTER the edit, so it can show
direct before/after membership for one image; but it is written BEFORE the save (a failed save leaves it behind), its timestamp is the browser clock, and the
`actor` is the single shared admin login. So an event counts as direct, confirmed evidence only when a snapshot linked to its id proves the save; an event whose
before-list already lacks the image shows that edit did NOT remove it; and an event that only falls inside the time window is circumstantial and is never called a
cause. Gallery Recovery itself writes no `photos_changed` events, and events are best-effort, so "no event" is not "no edit". The output is counts and fixed labels
only; the run fails if the population it rebuilds differs from the stage-2 total. It never shows that any object is safe to delete.

## Registry activation boundary vs the unregistered originals (`gallery-registry-boundary.yml`)

A manual, read-only workflow (`workflow_dispatch` only, same protected environment and read-only secret, **no artifact**) runs `run.sh registry`: lint, the same
preflight (plus the `registry-schema` verdict: `property_images.created_at` / `status` / `property_id`, `import_images.listing_id` / `storage_url`, and readable trigger
catalogs), the stage-2 cross-check, then `10-registry-activation-boundary.sql` (one SELECT inside `BEGIN READ ONLY ... ROLLBACK`). The registry was applied to production by
apply-migration run 32142932661 at **2026-08-18 13:32:37 UTC** (the migration file's 2026-08-13 version is only its name). It reports, as counts and fixed labels only:

* for the unregistered originals (the same population as stage 2; the run fails if the count differs, or if the evidence buckets do not add up to it), the strongest
  evidence that each was **in a gallery** before or on/after that instant. Direct: a Gallery Recovery `assign` record, a recorded snapshot state, the before-list of a saved
  editor edit (server time); the before-list of an unsaved edit (browser clock, compared with a one-day margin on each side, never as exact). Circumstantial, never
  promoted to membership: `unassign` records, unconfirmed after-lists, `import_images` rows. A null, missing, empty or non-array side is neither presence nor removal;
  a JSON string is not parsed. "Removed before activation" needs a recorded state before it that already excludes the object;
* the September/October uploads (same month rule as stage 2) and the uploads on/after the instant, by strongest evidence;
* registry history: earliest / latest row time, rows by status, rows before the instant (expected 0), the backfill minute, the trigger period;
* trigger `trg_property_images_sync` from the catalog: present, table, enabled mode, AFTER ... FOR EACH ROW, INSERT / UPDATE / UPDATE OF images, function, error handler;
* `properties.images` shapes (SQL NULL and JSON null apart, string / object / number / boolean, empty vs non-empty arrays, entries that are not non-empty strings);
* unregistered originals that match a registry row only under another (percent-encoded) spelling.

An object is only "expected to have a row" when direct evidence puts it in a gallery at or after the instant (the one-time backfill or the trigger would have registered
it); this diagnostic reports that, it never claims a sync failure on timing alone and never says anything is safe to delete.
