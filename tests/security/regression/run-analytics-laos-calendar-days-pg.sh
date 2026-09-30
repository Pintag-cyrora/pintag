#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Regression runner for supabase/migrations/
#   20260921030000_analytics_laos_calendar_days.sql
#   20260921040000_analytics_history_and_lead_drilldown.sql
#
#   bash tests/security/regression/run-analytics-laos-calendar-days-pg.sh
#   SKIP_SCALE=1 bash …                 # skip the (slower) scale probe
#   ANALYTICS_SCALE_BUDGET_MS=2000 …    # tighten the scale probe's per-RPC budget
#
# Spins up a THROWAWAY PostgreSQL cluster, loads
# schema_analytics_laos_calendar_days.sql (a trimmed analytics fixture with NO
# Laos-calendar logic), applies BOTH migrations TWICE each (idempotency), then
# runs analytics_laos_calendar_days_regression.sql. Unless SKIP_SCALE=1 it then
# builds a second database with ~30-40x production volume and runs
# analytics_laos_calendar_days_scale.sql. The cluster is destroyed on exit.
#
# Requires: postgresql server binaries. Exit 0 = every assertion passed.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIGRATIONS=(
  "$ROOT/supabase/migrations/20260921030000_analytics_laos_calendar_days.sql"
  "$ROOT/supabase/migrations/20260921040000_analytics_history_and_lead_drilldown.sql"
)
for m in "${MIGRATIONS[@]}"; do [[ -f "$m" ]] || { echo "FATAL: migration not found: $m"; exit 1; }; done

PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then
  for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /opt/homebrew/opt/postgresql@*/bin; do
    [[ -x "$d/initdb" ]] && PGBIN="$d"
  done
fi
if [[ -z "$PGBIN" ]]; then
  echo "SKIP: could not find initdb. Install PostgreSQL server binaries, or set PGBIN."
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

psql_db() { local db="$1"; shift; psql -h "$PGSOCK" -U postgres -d "$db" -v ON_ERROR_STOP=1 -X "$@"; }

apply_migrations() {
  local db="$1" m
  for pass in 1 2; do
    for m in "${MIGRATIONS[@]}"; do
      echo "Applying $(basename "$m") (pass $pass$([[ $pass -eq 2 ]] && echo ', idempotency check — must not error'))…"
      psql_db "$db" -q -f "$m"
    done
  done
}

echo "Loading fixture schema (trimmed analytics tables, no Laos-calendar logic)…"
psql_db postgres -q -f "$HERE/schema_analytics_laos_calendar_days.sql"
apply_migrations postgres

echo "Running assertions…"
if psql_db postgres -f "$HERE/analytics_laos_calendar_days_regression.sql" 2>&1 | sed 's/^psql:.*NOTICE: *//'; [[ "${PIPESTATUS[0]}" -eq 0 ]]; then
  echo
  echo "PASS — Laos-day bucketing, attribution, legacy/deleted handling, paging, invariants and ACLs all hold."
else
  echo
  echo "FAIL — a regression assertion did not hold (see above)."
  exit 1
fi

if [[ "${SKIP_SCALE:-0}" != "1" ]]; then
  echo
  echo "Scale probe: building a second database with ~30-40x production volume…"
  psql_db postgres -q -c "CREATE DATABASE analytics_scale"
  psql_db analytics_scale -q -f "$HERE/schema_analytics_laos_calendar_days.sql"
  apply_migrations analytics_scale >/dev/null
  if PGOPTIONS="-c analytics.scale_budget_ms=${ANALYTICS_SCALE_BUDGET_MS:-4000}" \
     psql_db analytics_scale -f "$HERE/analytics_laos_calendar_days_scale.sql" 2>&1 | sed 's/^psql:.*NOTICE: *//'; [[ "${PIPESTATUS[0]}" -eq 0 ]]; then
    echo
    echo "PASS — every all-time RPC is inside the latency budget and complete."
  else
    echo
    echo "FAIL — scale probe (see above)."
    exit 1
  fi
fi
