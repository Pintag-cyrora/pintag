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
* Optional input `expected_objects` (e.g. 551): the run stops if stage 2 counts a different number.
