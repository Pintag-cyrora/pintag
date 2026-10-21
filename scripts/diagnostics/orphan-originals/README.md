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

   `--summary` cross-checks the category counts against the CSV (the run fails closed if they disagree); `--out` is optional.

The script prints **aggregates only** (counts, sizes, dates, ranges): no object name, path, record id, listing id or live-object name.
It analyzes the gallery-history matches and the eTag+size duplicate candidates, their overlap, evidence strength, the questions the
report cannot answer, and read-only review steps. It never says anything is safe to delete; do not delete or move storage objects
based on it. To investigate individual objects, work from the CSV on your own machine and keep identifiers out of tickets, logs and chats.
