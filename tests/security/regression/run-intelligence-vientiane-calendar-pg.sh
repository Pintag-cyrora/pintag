#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Regression runner for supabase/migrations/
# 20260918000000_intelligence_vientiane_calendar.sql
#
#   bash tests/security/regression/run-intelligence-vientiane-calendar-pg.sh
#
# Spins up a THROWAWAY PostgreSQL cluster in a temp directory, loads
# schema_intelligence_vientiane_calendar.sql (a trimmed properties/leads/
# lead_events/listing_events/search_events/ui_events/daily_metrics_snapshot
# fixture with NO Vientiane conversion of its own), applies the migration
# TWICE in a row (proving it is idempotent), then runs the assertions in
# intelligence_vientiane_calendar_regression.sql. The cluster is destroyed
# on exit.
#
# Separate from run-ops-alert-and-image-sync-pg.sh/run-local-pg.sh so this
# fix's fixture cannot regress those already-passing suites, and vice versa.
#
# Requires: postgresql server binaries (Debian/Ubuntu: `postgresql`).
# Exit code: 0 = every assertion passed AND the migration applied cleanly twice.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260918000000_intelligence_vientiane_calendar.sql"
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

echo "Loading fixture (trimmed properties/leads/events tables, no Vientiane conversion)…"
"${PSQL[@]}" -q -f "$HERE/schema_intelligence_vientiane_calendar.sql"

echo "Applying supabase/migrations/$(basename "$MIGRATION") (1st time)…"
"${PSQL[@]}" -q -f "$MIGRATION"

echo "Applying it again (idempotency check — must not error)…"
"${PSQL[@]}" -q -f "$MIGRATION"

echo "Running assertions…"
if "${PSQL[@]}" -f "$HERE/intelligence_vientiane_calendar_regression.sql" 2>&1 | sed 's/^psql:.*NOTICE: *//'; then
  echo
  echo "PASS — every UTC/Vientiane boundary case buckets correctly, migration idempotent."
else
  echo
  echo "FAIL — a regression assertion did not hold, or the migration was not idempotent (see above)."
  exit 1
fi
