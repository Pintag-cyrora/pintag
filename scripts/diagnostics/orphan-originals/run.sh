#!/bin/bash
# run.sh -- READ-ONLY diagnostic for the Image Integrity line "Originals referenced by nothing".
# stage 0: lint the SQL files; stage 1: preflight (stop unless both verdicts PASS and there is no WARN); stage 2: data
# diagnostic. Everything runs inside a READ ONLY transaction that psql opens on the command line (the SQL files contain
# no transaction control), with the server-side default also set to read-only.
# The URL comes from $PINTAG_PROD_DB_URL (GitHub Actions) or a hidden prompt / stdin (local). It is never printed or
# written to a file. Results: preflight.txt and diagnostic.txt next to this script (names and counts only).
set -euo pipefail
cd "$(dirname "$0")"
command -v psql >/dev/null || { echo "psql not found - install it first (brew install libpq)"; exit 1; }
command -v perl >/dev/null || { echo "perl not found"; exit 1; }

lint() {   # refuse to run any file that is not exactly one plain read-only SELECT/WITH statement
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
rm -f preflight.txt diagnostic.txt   # never leave results from an earlier run lying around

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

echo; echo "=== stage 1: preflight (catalog only) ==="
run 1-preflight.sql -A -t -F ' | ' | tee preflight.txt
if [ "$(grep -c '^VERDICT | .* | PASS$' preflight.txt)" != 2 ]; then
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
run 2-diagnostic.sql | tee diagnostic.txt
echo; echo "Done. diagnostic.txt holds aggregate counts and a few storage object names."
echo "The preflight had no FAIL and no WARN, so section 1 can be compared with the 551 in the report."
