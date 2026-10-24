#!/bin/bash
# run.sh -- READ-ONLY diagnostic for the Image Integrity line "Originals referenced by nothing".
# stage 0: lint the SQL files; stage 1: preflight (stop unless both verdicts PASS and there is no WARN); stage 2: data
# diagnostic. Everything runs inside a READ ONLY transaction that psql opens on the command line (the SQL files contain
# no transaction control); that transaction is what the server enforces and what the preflight REQUIRES. The server-side
# default (PGOPTIONS below) is best effort only: a connection pooler drops startup options, so it is reported, not required.
# The URL comes from $PINTAG_PROD_DB_URL (GitHub Actions) or a hidden prompt / stdin (local). It is never printed or
# written to a file. Results next to this script: preflight.txt and diagnostic.txt (names and counts only) and, when the
# reconcile-schema verdict passed, stage 3: reconcile.csv (per object, names/sizes/dates/ids only), source-health.csv and the
# validated reconcile-objects.csv + reconcile-summary.md written by summarize.py. Nothing is ever written to the database.
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-diagnostic}"   # diagnostic = stages 1-4 (the reconciliation report); gallery = stages 1, 2 (cross-check) and 5 (Gallery Recovery vs listing galleries);
                          # probe = stages 1 and 6 (aggregate catalog/count probe of properties.updated_at; no object is enumerated)
                          # history = stages 1, 2 (cross-check) and 7 (gallery history vs listing_image_snapshots / import_records; aggregates only)
                          # provenance = stages 1, 2 (cross-check) and 8 (gallery 'assign' images vs the editor's photos_changed events; aggregates only)
                          # unusable = stages 1, 2 (cross-check) and 9 (only the objects stage 8 calls 'unusable': why, and what other records say; aggregates only)
case "$MODE" in diagnostic|gallery|probe|history|provenance|unusable) ;; *) echo "usage: run.sh [diagnostic|gallery|probe|history|provenance|unusable]"; exit 2;; esac
command -v psql >/dev/null || { echo "psql not found - install it first (brew install libpq)"; exit 1; }
command -v perl >/dev/null || { echo "perl not found"; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found"; exit 1; }

# The checks below end in `grep -q` / `head -c`, which exit early. Under `set -o pipefail` the writer on the left then dies
# with SIGPIPE and a SUCCESSFUL match looks like a failure (valid files rejected at random; a rejection could even be
# skipped). So the lint runs in a subshell with pipefail OFF, where each pipeline's status is its last command's.
lint() { ( set +o pipefail; lint_checks "$1" ); }

lint_checks() {   # refuse to run any file that is not exactly one plain read-only SELECT/WITH statement
  local f="$1" clean
  # one pass, left to right: strings, "--" comments and /* */ comments are each consumed whole, so a quote inside a
  # comment or "--" inside a string cannot confuse the stripping
  clean="$(perl -0777 -pe 's/\x27(?:[^\x27]|\x27\x27)*\x27|--[^\n]*|\/\*.*?\*\//\x20/gs' "$f")"
  case "$clean" in *\'*|*\"*) echo "LINT FAIL $f: stray or double quote (unbalanced string / quoted identifier)"; return 1;; esac
  printf '%s' "$clean" | grep -Eq '[$][A-Za-z0-9_]*[$]' && { echo "LINT FAIL $f: dollar-quoted string"; return 1; }
  printf '%s\n' "$clean" | grep -Eq '^[[:space:]]*\\' && { echo "LINT FAIL $f: psql meta-command"; return 1; }
  [ "$(printf '%s' "$clean" | tr -cd ';' | wc -c | tr -d ' ')" = 1 ] || { echo "LINT FAIL $f: must contain exactly one ';' (one statement)"; return 1; }
  printf '%s' "$clean" | tr -d '[:space:]' | grep -Eq ';$' || { echo "LINT FAIL $f: ';' must be the last character"; return 1; }
  printf '%s' "$clean" | tr '\n\t' '  ' | sed -E 's/^ +//' | head -c 6 | grep -Eiq '^(select|with)' || { echo "LINT FAIL $f: must start with SELECT or WITH"; return 1; }
  if printf '%s\n' "$clean" | grep -Eiw 'begin|start|commit|abort|rollback|savepoint|release|set|reset|do|call|execute|prepare|deallocate|insert|update|delete|merge|into|create|drop|alter|truncate|grant|revoke|copy|lock|vacuum|analyze|cluster|reindex|refresh|notify|listen|unlisten|discard|comment|security|import|load|checkpoint|declare|fetch|move|close|for'; then
    echo "LINT FAIL $f: forbidden keyword above"; return 1; fi
  if printf '%s\n' "$clean" | grep -Ei 'set_config|nextval|setval|lastval|pg_advisory|pg_terminate|pg_cancel|pg_reload|pg_rotate|pg_switch|pg_create|pg_drop|pg_read_|pg_ls_|pg_stat_reset|dblink|lo_(import|export|create|unlink|put|from)|txid_'; then
    echo "LINT FAIL $f: forbidden function above"; return 1; fi
  echo "lint ok: $f"
}
lint 1-preflight.sql
lint 2-diagnostic.sql
lint 3-reconcile.sql
lint 4-source-health.sql
lint 5-gallery-listing-state.sql
lint 6-properties-updated-at-probe.sql
lint 7-gallery-history-vs-snapshots.sql
lint 8-gallery-provenance-photos-changed.sql
lint 9-unusable-provenance-events.sql
rm -f unusable-events.txt provenance-events.txt history-vs-gallery.txt updated-at-probe.txt gallery-listing-detail.csv.tmp preflight.txt diagnostic.txt reconcile.csv source-health.csv reconcile-objects.csv reconcile-summary.md gallery-state.csv gallery-listing-detail.csv gallery-listing-summary.md   # never leave results from an earlier run lying around

if [ -z "${PINTAG_PROD_DB_URL:-}" ]; then
  read -rsp "Paste PINTAG_PROD_DB_URL (hidden), then press Enter: " PINTAG_PROD_DB_URL || true; echo
fi
[ -n "${PINTAG_PROD_DB_URL:-}" ] || { echo "No database URL supplied - nothing was run."; exit 1; }
export PINTAG_PROD_DB_URL
trap 'unset PINTAG_PROD_DB_URL; rm -f reconcile.csv source-health.csv gallery-state.csv' EXIT   # the raw per-object CSV never outlives the run
export PGOPTIONS='-c default_transaction_read_only=on'

run() {   # $1 = file, $2... = extra psql display options
  local f="$1"; shift
  psql "$PINTAG_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@" -c 'BEGIN READ ONLY' -f "$f" -c 'ROLLBACK'
}

run_data() {   # the data stages: psql error text can quote data, so it is withheld; only a 5-character SQLSTATE is shown
  local err rc=0; err="$(mktemp)"
  run "$@" -v VERBOSITY=sqlstate -v SHOW_CONTEXT=never 2>"$err" || rc=$?
  if [ "$rc" != 0 ]; then
    echo "psql failed (exit $rc); its error text is withheld because it could contain report data. SQLSTATE: $(grep -Eo '^ERROR: +[0-9A-Z]{5}$' "$err" | head -n 1 | tr -s ' ' || true)" >&2
  fi
  rm -f "$err"; return "$rc"
}

echo; echo "=== stage 1: preflight (catalog only) ==="
run 1-preflight.sql -A -t -F ' | ' | tee preflight.txt
if ! grep -qx 'VERDICT | schema | PASS' preflight.txt || ! grep -qx 'VERDICT | role+session | PASS' preflight.txt; then
  echo; echo "PREFLIGHT DID NOT PASS - stopping. The data diagnostic was NOT run."
  echo "See preflight.txt / the job summary (it contains only table/column names and counts)."
  exit 1
fi

if grep -q ' | WARN' preflight.txt; then
  echo; echo "PREFLIGHT HAD WARNINGS (see the WARN lines above) - stopping. The data diagnostic was NOT run."
  echo "A WARN means a total could be untrustworthy (for example: the role cannot bypass row-level security)."
  echo "See preflight.txt / the job summary (it contains only table/column names and counts)."
  exit 1
fi

if [ "$MODE" = probe ]; then
  # the probe reads gallery_assignments.listing_id / created_at, which the reconcile-schema verdict covers
  if ! grep -qx 'VERDICT | reconcile-schema | PASS' preflight.txt; then
    echo; echo "RECONCILE-SCHEMA VERDICT DID NOT PASS - the updated_at probe (stage 6) was NOT run. See the reconcile-schema lines in preflight.txt."
    exit 1
  fi
  echo; echo "=== stage 6: properties.updated_at probe (read-only; counts, dates and catalog facts only) ==="
  run_data 6-properties-updated-at-probe.sql > updated-at-probe.txt || { rm -f updated-at-probe.txt; exit 1; }
  cat updated-at-probe.txt
  echo; echo "Done. updated-at-probe.txt holds aggregates only."
  exit 0
fi

echo; echo "=== stage 2: data diagnostic (read-only) ==="
# stdout goes to the file first and is shown only after success: a failed run must not publish or print partial output
run_data 2-diagnostic.sql > diagnostic.txt || { rm -f diagnostic.txt; exit 1; }
cat diagnostic.txt
echo "The preflight had no FAIL and no WARN, so section 1 can be compared with the 551 in the report."

# stage 3 needs its own verdict: the history tables/columns it reads exist, are readable and are not hidden by RLS
if ! grep -qx 'VERDICT | reconcile-schema | PASS' preflight.txt; then
  echo; echo "RECONCILE-SCHEMA VERDICT DID NOT PASS - the reconciliation (stage 3) was NOT run. See the reconcile-schema lines in preflight.txt."
  exit 1
fi
expected="$(awk -F' [|] ' '/ 1 TOTAL/ { print $NF; exit }' diagnostic.txt | tr -d ' ')"
case "$expected" in ''|*[!0-9]*) echo "Could not read the stage-2 object total - stage 3 NOT run."; exit 1;; esac

if [ "$MODE" = provenance ] || [ "$MODE" = unusable ]; then
  # stage 8 / 9 read gallery_assignments / properties (gallery-schema), the snapshot tables (history-schema) and listing_provenance (provenance-schema)
  if [ "$MODE" = unusable ]; then STAGE=9; SQLF=9-unusable-provenance-events.sql; OUTF=unusable-events.txt; WHAT="the objects stage 8 calls unusable"
  else STAGE=8; SQLF=8-gallery-provenance-photos-changed.sql; OUTF=provenance-events.txt; WHAT="gallery 'assign' images vs the editor's photos_changed events"; fi
  for v in gallery-schema history-schema provenance-schema; do
    if ! grep -qx "VERDICT | $v | PASS" preflight.txt; then
      echo; echo "$(echo "$v" | tr a-z A-Z) VERDICT DID NOT PASS - the provenance-events stage ($STAGE) was NOT run. See the $v lines in preflight.txt."
      exit 1
    fi
  done
  if [ -n "${EXPECTED_OBJECTS:-}" ]; then
    case "$EXPECTED_OBJECTS" in *[!0-9]*) echo "expected_objects must be a number - stage $STAGE NOT run."; exit 1;; esac
    [ "$EXPECTED_OBJECTS" = "$expected" ] || { echo "Stage 2 counted $expected objects but expected_objects is $EXPECTED_OBJECTS - stage $STAGE NOT run."; exit 1; }
  fi
  echo; echo "=== stage $STAGE: $WHAT, for the $expected objects (read-only; aggregates only) ==="
  run_data "$SQLF" > "$OUTF" || { rm -f "$OUTF"; exit 1; }
  # the query rebuilds the population itself: it must equal the stage-2 total or the numbers are not about the same objects
  got="$(awk -F'|' '/^ *1 unreferenced originals/ { gsub(/[^0-9]/, "", $3); print $3; exit }' "$OUTF")"
  if [ "$got" != "$expected" ]; then
    rm -f "$OUTF"
    echo "Stage $STAGE rebuilt a population of '${got:-?}' objects but stage 2 counted $expected - the result was discarded."
    exit 1
  fi
  cat "$OUTF"
  echo; echo "Done. $OUTF holds aggregates only."
  exit 0
fi

if [ "$MODE" = history ]; then
  # stage 7 reads gallery_assignments / properties (gallery-schema) and the snapshot / import tables (history-schema, reconcile-schema)
  for v in gallery-schema history-schema; do
    if ! grep -qx "VERDICT | $v | PASS" preflight.txt; then
      echo; echo "$(echo "$v" | tr a-z A-Z) VERDICT DID NOT PASS - the gallery history stage (7) was NOT run. See the $v lines in preflight.txt."
      exit 1
    fi
  done
  if [ -n "${EXPECTED_OBJECTS:-}" ]; then
    case "$EXPECTED_OBJECTS" in *[!0-9]*) echo "expected_objects must be a number - stage 7 NOT run."; exit 1;; esac
    [ "$EXPECTED_OBJECTS" = "$expected" ] || { echo "Stage 2 counted $expected objects but expected_objects is $EXPECTED_OBJECTS - stage 7 NOT run."; exit 1; }
  fi
  echo; echo "=== stage 7: gallery history vs listing_image_snapshots / import_records, for the $expected objects (read-only; aggregates only) ==="
  run_data 7-gallery-history-vs-snapshots.sql > history-vs-gallery.txt || { rm -f history-vs-gallery.txt; exit 1; }
  # the query rebuilds the population itself: it must equal the stage-2 total or the numbers are not about the same objects
  got="$(awk -F'|' '/^ *1 unreferenced originals/ { gsub(/[^0-9]/, "", $3); print $3; exit }' history-vs-gallery.txt)"
  if [ "$got" != "$expected" ]; then
    rm -f history-vs-gallery.txt
    echo "Stage 7 rebuilt a population of '${got:-?}' objects but stage 2 counted $expected - the result was discarded."
    exit 1
  fi
  cat history-vs-gallery.txt
  echo; echo "Done. history-vs-gallery.txt holds aggregates only."
  exit 0
fi

if [ "$MODE" = gallery ]; then
  # the stage-5 query reads gallery_assignments / properties columns that have their own verdict
  if ! grep -qx 'VERDICT | gallery-schema | PASS' preflight.txt; then
    echo; echo "GALLERY-SCHEMA VERDICT DID NOT PASS - the gallery listing-state stage (5) was NOT run. See the gallery-schema lines in preflight.txt."
    exit 1
  fi
  if [ -n "${EXPECTED_OBJECTS:-}" ]; then
    case "$EXPECTED_OBJECTS" in *[!0-9]*) echo "expected_objects must be a number - stage 5 NOT run."; exit 1;; esac
    [ "$EXPECTED_OBJECTS" = "$expected" ] || { echo "Stage 2 counted $expected objects but expected_objects is $EXPECTED_OBJECTS - stage 5 NOT run."; exit 1; }
  fi
  echo; echo "=== stage 5: Gallery Recovery records vs current listing galleries, for the $expected objects (read-only) ==="
  run_data 5-gallery-listing-state.sql --csv > gallery-state.csv
  # a failed or crashed summary must leave no detail file behind (the workflow also requires this step to have succeeded)
  python3 summarize_gallery.py --objects gallery-state.csv --expected "$expected" || { rm -f gallery-listing-detail.csv gallery-listing-detail.csv.tmp; exit 1; }
  cat gallery-listing-summary.md
  echo; echo "Done. gallery-listing-detail.csv is the PRIVATE per-object review file (it is never printed)."
  exit 0
fi

echo; echo "=== stage 3: reconciliation of the $expected objects (read-only) ==="
run_data 3-reconcile.sql --csv > reconcile.csv
run_data 4-source-health.sql --csv > source-health.csv
python3 summarize.py --objects reconcile.csv --health source-health.csv --expected "$expected"
cat reconcile-summary.md
echo; echo "Done. diagnostic.txt holds aggregate counts; reconcile-objects.csv holds the per-object report."
