#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Regression runner for
#   supabase/migrations/20260921020000_harden_is_admin_and_rls_auto_enable.sql
#
#   bash tests/security/regression/run-harden-is-admin-rls-auto-enable-pg.sh
#
# Spins up a THROWAWAY PostgreSQL cluster and:
#   1. loads schema_verify_production_security_checks.sql (unchanged) and, on
#      top of it, schema_harden_is_admin_rls_auto_enable.sql (the PRE-migration
#      production state of is_admin(), rls_auto_enable() and ensure_rls);
#   2. asserts that baseline, and runs the REAL, UNMODIFIED
#      scripts/verify-production-security.sql: both functions MUST be reported
#      by control 10 (so the post-migration result cannot pass vacuously);
#   3. applies the migration (twice: idempotency), asserts the required end
#      state, and re-runs the real verifier: neither function may be reported;
#   4. applies the ROLLBACK block from the migration file's own comments and
#      asserts the baseline is restored;
#   5. applies the migration to a database that has neither function and
#      asserts it skips instead of failing (dev / CI replay).
#
# The verifier is EXPECTED to exit non-zero: the shared fixture carries two
# deliberate negative controls (evil_table, fixture_ungated_rpc). Only the
# names it prints against control 10 are asserted on.
#
# Requires: postgresql server binaries (Debian/Ubuntu: `postgresql`).
# Exit code: 0 = every assertion held.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
VERIFIER="$ROOT/scripts/verify-production-security.sql"
MIGRATION="$ROOT/supabase/migrations/20260921020000_harden_is_admin_and_rls_auto_enable.sql"
BASE_FIXTURE="$HERE/schema_verify_production_security_checks.sql"
FIXTURE="$HERE/schema_harden_is_admin_rls_auto_enable.sql"
ASSERTIONS="$HERE/harden_is_admin_rls_auto_enable_regression.sql"
for f in "$VERIFIER" "$MIGRATION" "$BASE_FIXTURE" "$FIXTURE" "$ASSERTIONS"; do
  [[ -f "$f" ]] || { echo "FATAL: not found: $f"; exit 1; }
done

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
as_pg() { if [[ -n "$RUN_AS" ]]; then su "$RUN_AS" -c "$1"; else bash -c "$1"; fi; }
cleanup() {
  as_pg "$PGBIN/pg_ctl -D '$PGDATA' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$PGSOCK"
[[ -n "$RUN_AS" ]] && chown -R "$RUN_AS" "$WORK"

echo "Initialising throwaway PostgreSQL cluster…"
as_pg "$PGBIN/initdb -D '$PGDATA' -A trust -U postgres" >/dev/null
as_pg "$PGBIN/pg_ctl -D '$PGDATA' -o \"-k '$PGSOCK' -h ''\" -l '$PGDATA/server.log' -w start" >/dev/null

PSQL=(psql -h "$PGSOCK" -U postgres -d postgres -v ON_ERROR_STOP=1 -X)
fail=0
die() { echo "FATAL: $*"; exit 1; }
note() { sed 's/^psql:.*NOTICE: *//'; }

run_assertions() { # phase
  local out="$WORK/assert_$1.txt"
  if "${PSQL[@]}" -v phase="$1" -f "$ASSERTIONS" > "$out" 2>&1; then
    grep -E '^(psql:.*NOTICE|===|---)' "$out" | note
    echo "  → $1-phase assertions: all held"
  else
    echo "  FAIL  $1-phase assertions"; note < "$out" | sed 's/^/      /'; fail=1
  fi
}

verifier_control10_row() { # label -> prints the control-10 row of the REAL verifier
  local rep="$WORK/report_$1.txt"
  # Exit status is expected to be non-zero (the fixture's deliberate negative controls).
  psql -h "$PGSOCK" -U postgres -d postgres -X -f "$VERIFIER" > "$rep" 2>&1
  grep -F 'no UNEXPECTED ungated SECURITY DEFINER' "$rep" || true
}

assert_row() { # desc, row, must-contain|must-not-contain, name
  local desc="$1" row="$2" mode="$3" name="$4"
  if [[ -z "$row" ]]; then echo "  FAIL  $desc (could not locate control 10's row in the verifier report)"; fail=1; return; fi
  if grep -qF -- "$name" <<< "$row"; then found=1; else found=0; fi
  if { [[ $mode == contain && $found -eq 1 ]] || [[ $mode == not-contain && $found -eq 0 ]]; }; then
    echo "  PASS  $desc"
  else
    echo "  FAIL  $desc"; echo "      → control 10 row: $row"; fail=1
  fi
}

echo "Loading the shared verifier fixture (unchanged) + the pre-migration production state…"
"${PSQL[@]}" -q -f "$BASE_FIXTURE" || die "base fixture failed to load"
"${PSQL[@]}" -q -f "$FIXTURE"      || die "hardening fixture failed to load"

echo
echo "── 1. BASELINE (pre-migration) ─────────────────────────────────────────"
run_assertions pre
echo "  Real verifier, BEFORE the migration:"
row_before="$(verifier_control10_row before)"
assert_row "verifier control 10 reports is_admin() before the migration (test is not vacuous)" "$row_before" contain "is_admin"
assert_row "verifier control 10 reports rls_auto_enable() before the migration (test is not vacuous)" "$row_before" contain "rls_auto_enable"

echo
echo "── 2. APPLY THE MIGRATION ──────────────────────────────────────────────"
echo "Applying supabase/migrations/$(basename "$MIGRATION") (1st time)…"
"${PSQL[@]}" -q -f "$MIGRATION" || die "migration failed to apply"
echo "Applying it again (idempotency — must not error)…"
"${PSQL[@]}" -q -f "$MIGRATION" || die "migration was not idempotent"
run_assertions post
echo "  Real verifier, AFTER the migration:"
row_after="$(verifier_control10_row after)"
assert_row "verifier control 10 no longer reports is_admin()" "$row_after" not-contain "is_admin"
assert_row "verifier control 10 no longer reports rls_auto_enable()" "$row_after" not-contain "rls_auto_enable"
assert_row "verifier control 10 STILL reports the fixture's deliberate ungated function (negative control intact)" "$row_after" contain "fixture_ungated_rpc"
if grep -qF 'is_admin' "$WORK/report_after.txt" || grep -qF 'rls_auto_enable' "$WORK/report_after.txt"; then
  echo "  FAIL  neither function appears anywhere in the verifier's post-migration report"; fail=1
else
  echo "  PASS  neither function appears anywhere in the verifier's post-migration report"
fi

echo
echo "── 3. ROLLBACK (the block in the migration file's own comments) ────────"
ROLLBACK_SQL="$WORK/rollback.sql"
awk '/^--   BEGIN;/{f=1} f{sub(/^--   /,""); print} /^--   COMMIT;/{f=0}' "$MIGRATION" > "$ROLLBACK_SQL"
if [[ ! -s "$ROLLBACK_SQL" ]] || ! grep -q 'RESET search_path' "$ROLLBACK_SQL"; then
  echo "  FAIL  could not extract the rollback block from the migration file"; fail=1
else
  "${PSQL[@]}" -q -f "$ROLLBACK_SQL" || die "rollback SQL failed to apply"
  run_assertions pre
fi

echo
echo "── 4. RE-APPLY AFTER ROLLBACK, then a database with neither function ───"
"${PSQL[@]}" -q -f "$MIGRATION" || die "migration failed to re-apply after rollback"
run_assertions post

"${PSQL[@]}" -q -c "CREATE DATABASE empty_db" || die "could not create empty_db"
skip_out="$WORK/skip.txt"
if psql -h "$PGSOCK" -U postgres -d empty_db -v ON_ERROR_STOP=1 -X -f "$MIGRATION" > "$skip_out" 2>&1 \
   && grep -q 'skipping is_admin() (not present)' "$skip_out" \
   && grep -q 'skipping rls_auto_enable() (not present)' "$skip_out"; then
  echo "  PASS  on a database without either function the migration skips both (NOTICE) and does not fail"
else
  echo "  FAIL  the migration must skip, not fail, when the functions are absent"; sed 's/^/      /' "$skip_out"; fail=1
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "PASS — is_admin(): search_path pinned to public, pg_temp, PUBLIC/anon revoked, authenticated/service_role kept;"
  echo "       rls_auto_enable(): PUBLIC/anon/authenticated revoked, service_role/backup_ro/search_path unchanged, ensure_rls enabled, bound and still firing;"
  echo "       the real verifier reports neither function after the migration; migration idempotent, rollback restores the baseline."
  exit 0
else
  echo "FAIL — see above."
  for r in before after; do echo "── verifier report ($r) ──"; sed 's/^/    /' "$WORK/report_$r.txt" 2>/dev/null | tail -40; done
  exit 1
fi
