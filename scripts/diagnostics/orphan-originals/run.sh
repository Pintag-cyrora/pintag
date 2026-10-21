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
rm -f preflight.txt diagnostic.txt reconcile.csv source-health.csv reconcile-objects.csv reconcile-summary.md   # never leave results from an earlier run lying around

if [ -z "${PINTAG_PROD_DB_URL:-}" ]; then
  read -rsp "Paste PINTAG_PROD_DB_URL (hidden), then press Enter: " PINTAG_PROD_DB_URL || true; echo
fi
[ -n "${PINTAG_PROD_DB_URL:-}" ] || { echo "No database URL supplied - nothing was run."; exit 1; }
export PINTAG_PROD_DB_URL
trap 'unset PINTAG_PROD_DB_URL; rm -f reconcile.csv source-health.csv' EXIT   # the raw per-object CSV never outlives the run
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

echo; echo "=== stage 3: reconciliation of the $expected objects (read-only) ==="
run_data 3-reconcile.sql --csv > reconcile.csv
run_data 4-source-health.sql --csv > source-health.csv
python3 summarize.py --objects reconcile.csv --health source-health.csv --expected "$expected"
cat reconcile-summary.md
echo; echo "Done. diagnostic.txt holds aggregate counts; reconcile-objects.csv holds the per-object report."
