#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Regression runner for the 2026-09-21 fixes to
# scripts/verify-production-security.sql (write-policy gate widened to
# recognize is_pintag_staff()/owned_party_ids() alongside is_pintag_admin(),
# and the SECURITY DEFINER anon-callable check excluding trigger-only
# functions by actual return type) TOGETHER WITH the companion migration
# 20260921010000_revoke_public_execute_analytics_and_ownership_rpcs.sql,
# exactly as production will experience both changes at once.
#
#   bash tests/security/regression/run-verify-production-security-checks-pg.sh
#
# Spins up a THROWAWAY PostgreSQL cluster, loads
# schema_verify_production_security_checks.sql (a fixture built to satisfy
# every one of the script's 13 controls except two deliberate negative
# controls — plus owned_party_ids(), still carrying its default PUBLIC
# execute grant until the migration below runs), applies the companion
# migration, then runs the REAL scripts/verify-production-security.sql — not
# a reimplementation of its checks — against it and asserts on its printed
# DRIFT REPORT text. The cluster is destroyed on exit.
#
# WHY TEXT-GREP INSTEAD OF A SEPARATE SQL ASSERTIONS FILE (the pattern every
# other *_regression.sql in this directory uses): the script under test
# raises an exception and (because it sets \set ON_ERROR_STOP on) aborts the
# whole psql invocation the moment any control fails — which this fixture
# deliberately makes happen (the two negative controls). Its `drift` table is
# a CREATE TEMP TABLE, scoped to that one psql session/connection, so a
# second, separate psql invocation cannot query it afterwards. The script's
# own final report (the "================ PRODUCTION SECURITY DRIFT
# REPORT ================" table) is therefore the only thing to assert
# against, exactly as a human reviewing a real CI run would.
#
# Requires: postgresql server binaries (Debian/Ubuntu: `postgresql`).
# Exit code: 0 = every assertion below held.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$ROOT/scripts/verify-production-security.sql"
MIGRATION="$ROOT/supabase/migrations/20260921010000_revoke_public_execute_analytics_and_ownership_rpcs.sql"
[[ -f "$SCRIPT" ]] || { echo "FATAL: script not found: $SCRIPT"; exit 1; }
[[ -f "$MIGRATION" ]] || { echo "FATAL: migration not found: $MIGRATION"; exit 1; }

PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then
  for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /opt/homebrew/opt/postgresql@*/bin; do
    [[ -x "$d/initdb" ]] && PGBIN="$d"
  done
fi
if [[ -z "$PGBIN" ]]; then
  echo "SKIP: could not find initdb. Install PostgreSQL server binaries, or set PGBIN."
  echo "  Ubuntu/Debian: sudo apt-get install -y postgresql"
  echo "  macOS:         brew install postgresql@16"
  exit 0
fi

RUN_AS=""
if [[ "$(id -u)" -eq 0 ]]; then
  id pgtest >/dev/null 2>&1 || useradd -m pgtest
  RUN_AS="pgtest"
  WORK="$(su pgtest -c 'mktemp -d')"
else
  WORK="$(mktemp -d)"
fi

PGDATA="$WORK/data"
PGSOCK="$WORK/sock"
cleanup() {
  as_pg "$PGBIN/pg_ctl -D '$PGDATA' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

as_pg() { if [[ -n "$RUN_AS" ]]; then su "$RUN_AS" -c "$1"; else bash -c "$1"; fi; }

mkdir -p "$PGSOCK"
[[ -n "$RUN_AS" ]] && chown -R "$RUN_AS" "$WORK"

echo "Initialising throwaway PostgreSQL cluster…"
as_pg "$PGBIN/initdb -D '$PGDATA' -A trust -U postgres" >/dev/null
as_pg "$PGBIN/pg_ctl -D '$PGDATA' -o \"-k '$PGSOCK' -h ''\" -l '$PGDATA/server.log' -w start" >/dev/null

PSQL=(psql -h "$PGSOCK" -U postgres -d postgres -v ON_ERROR_STOP=1 -X)

echo "Loading fixture (satisfies every control except two deliberate negative controls)…"
if ! "${PSQL[@]}" -q -f "$HERE/schema_verify_production_security_checks.sql"; then
  echo "FATAL: fixture failed to load"; exit 1
fi

echo "Applying supabase/migrations/$(basename "$MIGRATION") (1st time)…"
if ! "${PSQL[@]}" -q -f "$MIGRATION"; then
  echo "FATAL: migration failed to apply"; exit 1
fi

echo "Applying it again (idempotency check — must not error)…"
if ! "${PSQL[@]}" -q -f "$MIGRATION"; then
  echo "FATAL: migration was not idempotent"; exit 1
fi

echo "Running the REAL scripts/verify-production-security.sql against it…"
REPORT="$WORK/report.txt"
# The script is EXPECTED to exit non-zero here (the two negative controls
# are real, deliberate FAILs) — that is not what this runner is checking.
psql -h "$PGSOCK" -U postgres -d postgres -X -f "$SCRIPT" > "$REPORT" 2>&1
SCRIPT_EXIT=$?

fail=0
assert_contains() {
  local desc="$1" pattern="$2"
  if grep -qF -- "$pattern" "$REPORT"; then
    echo "  PASS  $desc"
  else
    echo "  FAIL  $desc"
    echo "      → expected to find: $pattern"
    fail=1
  fi
}
assert_not_contains() {
  local desc="$1" pattern="$2"
  if grep -qF -- "$pattern" "$REPORT"; then
    echo "  FAIL  $desc"
    echo "      → did NOT expect to find: $pattern"
    fail=1
  else
    echo "  PASS  $desc"
  fi
}

echo
echo "Assertions against the printed DRIFT REPORT:"

# Control 4 — the widened write-policy gate.
assert_contains  "control 4 header renamed to the widened wording" \
  "no write policy bypasses a legitimate identity-bound gate"
assert_not_contains "property_contacts' Staff/Party policies are NOT reported as offenders (the false positive is fixed)" \
  "property_contacts"
assert_contains  "evil_table's genuinely ungated write policy is STILL caught (negative control)" \
  "evil_table"

# Control 10 — the trigger-function structural exclusion.
assert_contains  "control 10 wording documents the trigger exclusion" \
  "trigger-only functions excluded"
assert_not_contains "the trigger-type function is NOT reported as an unexpected ungated function (structural exclusion works)" \
  "fixture_trigger_fn"
control10_row="$(grep -F 'no UNEXPECTED ungated SECURITY DEFINER' "$REPORT" || true)"
# (the control-10 ROW, not the whole report -- "owned_party_ids" also
# legitimately appears in control 4's "expected" wording elsewhere in the
# report, which a whole-file grep would false-positive against)
if [[ -z "$control10_row" ]]; then
  echo "  FAIL  could not locate control 10's result row in the report"
  fail=1
elif grep -qF 'owned_party_ids' <<< "$control10_row"; then
  echo "  FAIL  owned_party_ids is NOT reported once the companion migration has revoked its PUBLIC/anon grant"
  echo "      → found in control 10's row: $control10_row"
  fail=1
else
  echo "  PASS  owned_party_ids is NOT reported once the companion migration has revoked its PUBLIC/anon grant"
fi
assert_contains  "the plain ungated function is STILL caught (negative control)" \
  "fixture_ungated_rpc"

# Every other control must still PASS — only the two negative controls
# (evil_table, fixture_ungated_rpc) should ever fail. "17 |      3" would be
# 2 negative controls + 1 unrelated fixture gap; exactly 2 failures is the
# correct end state once the fixture and migration are both right.
assert_contains "exactly 2 controls fail overall (the two negative controls, nothing else)" \
  "|      2 |"

echo
if [[ $fail -eq 0 ]]; then
  echo "PASS — write-policy gate recognizes is_pintag_staff()/owned_party_ids(), evil_table still caught; trigger-only functions excluded, fixture_ungated_rpc still caught."
  echo "(script exit code was $SCRIPT_EXIT — expected non-zero, since the two negative controls are real, deliberate drift)"
  exit 0
else
  echo "FAIL — see above. Full captured report: $REPORT"
  sed 's/^/    /' "$REPORT"
  exit 1
fi
