#!/bin/bash
# run.sh -- READ-ONLY, AGGREGATE-ONLY catalogue completeness diagnostic.
# stage 0: lint the two SQL files (each exactly one plain read-only SELECT/WITH; the lint is the same as the orphan-originals one);
# stage 1: catalog-only preflight (stop unless BOTH verdicts PASS and no row says WARN);
# stage 2: the aggregate query, inside a READ ONLY transaction that psql opens on the command line (the SQL files contain no transaction control).
# The URL comes from $PINTAG_PROD_DB_URL (GitHub Actions) or a hidden prompt (local). It is never printed or written to a file. Results next to
# this script: preflight.txt and catalogue.txt (counts per fixed label only). Nothing is written to the database and no artifact is produced.
# Independent of scripts/diagnostics/orphan-originals (it shares no file with it).
set -euo pipefail
cd "$(dirname "$0")"
command -v psql >/dev/null || { echo "psql not found - install it first (brew install libpq)"; exit 1; }
command -v perl >/dev/null || { echo "perl not found"; exit 1; }

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
lint 2-catalogue.sql
rm -f preflight.txt catalogue.txt   # never leave results from an earlier run lying around

if [ -z "${PINTAG_PROD_DB_URL:-}" ]; then
  read -rsp "Paste PINTAG_PROD_DB_URL (hidden), then press Enter: " PINTAG_PROD_DB_URL || true; echo
fi
[ -n "${PINTAG_PROD_DB_URL:-}" ] || { echo "No database URL supplied - nothing was run."; exit 1; }
export PINTAG_PROD_DB_URL
trap 'unset PINTAG_PROD_DB_URL' EXIT
export PGOPTIONS='-c default_transaction_read_only=on'

run() {   # $1 = file, $2... = extra psql display options
  local f="$1"; shift
  psql "$PINTAG_PROD_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@" -c 'BEGIN READ ONLY' -f "$f" -c 'ROLLBACK'
}

run_data() {   # psql error text can quote data, so it is withheld; only a 5-character SQLSTATE is shown
  local err rc=0; err="$(mktemp)"
  run "$@" -v VERBOSITY=sqlstate -v SHOW_CONTEXT=never 2>"$err" || rc=$?
  if [ "$rc" != 0 ]; then
    echo "psql failed (exit $rc); its error text is withheld because it could contain report data. SQLSTATE: $(grep -Eo '^ERROR: +[0-9A-Z]{5}$' "$err" | head -n 1 | tr -s ' ' || true)" >&2
  fi
  rm -f "$err"; return "$rc"
}

echo; echo "=== stage 1: preflight (catalog only) ==="
run_data 1-preflight.sql -A -t -F ' | ' > preflight.txt || { rm -f preflight.txt; exit 1; }
cat preflight.txt
if ! grep -qx 'VERDICT | catalogue-schema | PASS' preflight.txt || ! grep -qx 'VERDICT | role+session | PASS' preflight.txt; then
  echo; echo "PREFLIGHT DID NOT PASS - stopping. The catalogue query was NOT run."
  exit 1
fi
if grep -q ' | WARN' preflight.txt; then
  echo; echo "PREFLIGHT HAD WARNINGS (see the WARN lines above) - stopping. The catalogue query was NOT run."
  echo "A WARN means a count could be untrustworthy (for example: the role cannot bypass row-level security)."
  exit 1
fi

echo; echo "=== stage 2: catalogue completeness (read-only; counts per fixed label only) ==="
# stdout goes to the file first and is shown only after success: a failed run must not publish or print partial output
run_data 2-catalogue.sql > catalogue.txt || { rm -f catalogue.txt; exit 1; }
cat catalogue.txt
echo; echo "Done. catalogue.txt holds aggregates only."
