#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Regression runner for supabase/migrations/
# 20260926000000_public_listing_stats_leads_source.sql
#
#   bash tests/security/regression/run-public-listing-stats-leads-source-pg.sh
#
# Spins up a THROWAWAY PostgreSQL cluster in a temp directory, loads
# schema_public_listing_stats_leads_source.sql (a trimmed properties/
# unit_types/contacts/parties/lead_events/leads fixture matching today's
# pre-migration shape, including the current create_lead_from_event()
# trigger and the current, pre-fix public_listing_stats()), runs the
# assertions in public_listing_stats_leads_source_regression.sql (which
# applies the real migration file mid-script via \i), then re-applies the
# migration alone at the end to confirm it (CREATE OR REPLACE, no DROP) is
# idempotent. The cluster is destroyed on exit.
#
# Separate from the other regression runners in this directory so this
# fix's fixture cannot regress those already-passing suites, and vice versa.
#
# Requires: postgresql server binaries (Debian/Ubuntu: `postgresql`).
# Exit code: 0 = every assertion passed on both runs.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260926000000_public_listing_stats_leads_source.sql"
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

echo "Loading fixture (trimmed pre-migration properties/leads/lead_events schema)…"
"${PSQL[@]}" -q -f "$HERE/schema_public_listing_stats_leads_source.sql"

echo "Running assertions (applies the real migration mid-script via \\i, cwd=$ROOT)…"
if (cd "$ROOT" && "${PSQL[@]}" -f "$HERE/public_listing_stats_leads_source_regression.sql" 2>&1 | sed 's/^psql:.*NOTICE: *//'); then
  echo
  echo "PASS — public_listing_stats() now sources inquiry counts from leads, matches admin.html's own query, zero case returns literal 0, visibility gate unaffected."
else
  echo
  echo "FAIL — a regression assertion did not hold (see above)."
  exit 1
fi

echo ""
echo "Re-running the migration alone against the now-migrated database (idempotency check — must not error)…"
"${PSQL[@]}" -q -f "$MIGRATION"
echo "PASS — migration is idempotent."
