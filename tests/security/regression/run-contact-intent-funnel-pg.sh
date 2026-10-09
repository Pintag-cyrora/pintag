#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Regression runner for supabase/migrations/20261008000000_analytics_contact_intent_funnel.sql
#                   and 20261009000000_analytics_contact_intent_resolution.sql
#
#   bash tests/security/regression/run-contact-intent-funnel-pg.sh
#
# Spins up a THROWAWAY PostgreSQL cluster, loads the analytics fixture
# (schema_analytics_laos_calendar_days.sql) plus the funnel addendum
# (schema_contact_intent_funnel.sql), applies the two Laos-calendar migrations
# (analytics_listing_labels) and the funnel migration TWICE (idempotency), then runs
# contact_intent_funnel_regression.sql: controlled fixtures for every funnel path,
# Laos-day boundaries, ACLs, search_path and read-only behaviour. Destroyed on exit.
#
# Requires: postgresql server binaries. Exit 0 = every assertion passed.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIGRATIONS=(
  "$ROOT/supabase/migrations/20260921030000_analytics_laos_calendar_days.sql"
  "$ROOT/supabase/migrations/20260921040000_analytics_history_and_lead_drilldown.sql"
  "$ROOT/supabase/migrations/20261008000000_analytics_contact_intent_funnel.sql"
  "$ROOT/supabase/migrations/20261009000000_analytics_contact_intent_resolution.sql"
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

echo "Loading fixture schema (analytics fixture + funnel addendum)…"
psql_db postgres -q -f "$HERE/schema_analytics_laos_calendar_days.sql"
psql_db postgres -q -f "$HERE/schema_contact_intent_funnel.sql"

for pass in 1 2; do
  for m in "${MIGRATIONS[@]}"; do
    echo "Applying $(basename "$m") (pass $pass$([[ $pass -eq 2 ]] && echo ', idempotency check — must not error'))…"
    psql_db postgres -q -f "$m"
  done
done

# The ORIGINAL funnel regression runs against the v2 function (both migrations applied): every v1 number
# must be unchanged, which proves v2 is backward compatible for rows that carry no resolution.
echo "Running assertions (v1 funnel regression against the v2 function)…"
if psql_db postgres -f "$HERE/contact_intent_funnel_regression.sql" 2>&1 | sed 's/^psql:.*NOTICE: *//'; [[ "${PIPESTATUS[0]}" -eq 0 ]]; then
  echo
  echo "PASS — funnel stages, normalisation, reconciliation, Laos days, edge cases and ACLs all hold."
else
  echo
  echo "FAIL — a regression assertion did not hold (see above)."
  exit 1
fi

echo
echo "Running assertions (Terms & utilities / Price & deposit resolution)…"
if psql_db postgres -f "$HERE/contact_intent_resolution_regression.sql" 2>&1 | sed 's/^psql:.*NOTICE: *//'; [[ "${PIPESTATUS[0]}" -eq 0 ]]; then
  echo
  echo "PASS — resolution handling (answer_on_site / escalate_to_agent, topics, escalation clicks) holds."
else
  echo
  echo "FAIL — a resolution regression assertion did not hold (see above)."
  exit 1
fi
