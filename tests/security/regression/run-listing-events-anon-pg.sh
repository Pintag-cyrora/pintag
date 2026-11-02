#!/usr/bin/env bash
# Regression runner for supabase/migrations/20261104010000_listing_events_no_anon_select.sql
#   bash tests/security/regression/run-listing-events-anon-pg.sh
# Throwaway PostgreSQL cluster; loads schema_listing_events_anon.sql; FIRST proves the finding on the pre-migration fixture (anon can read events), applies the migration TWICE (idempotency),
# then runs listing_events_anon_regression.sql. Reads no real data and needs no credentials. Exit 0 = everything held.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261104010000_listing_events_no_anon_select.sql"
[[ -f "$MIGRATION" ]] || { echo "FATAL: migration not found: $MIGRATION"; exit 1; }
PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /opt/homebrew/opt/postgresql@*/bin; do [[ -x "$d/initdb" ]] && PGBIN="$d"; done; fi
if [[ -z "$PGBIN" ]]; then echo "SKIP: could not find initdb. Install PostgreSQL server binaries, or set PGBIN."; exit 0; fi
RUN_AS=""
if [[ "$(id -u)" -eq 0 ]]; then id pgtest >/dev/null 2>&1 || useradd -m pgtest; RUN_AS="pgtest"; WORK="$(su pgtest -c 'mktemp -d')"; else WORK="$(mktemp -d)"; fi
PGDATA="$WORK/data"; PGSOCK="$WORK/sock"
as_pg() { if [[ -n "$RUN_AS" ]]; then su "$RUN_AS" -c "$1"; else bash -c "$1"; fi; }
cleanup() { as_pg "$PGBIN/pg_ctl -D '$PGDATA' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT
mkdir -p "$PGSOCK"; [[ -n "$RUN_AS" ]] && chown -R "$RUN_AS" "$WORK"
echo "Initialising throwaway PostgreSQL cluster…"
as_pg "$PGBIN/initdb -D '$PGDATA' -A trust -U postgres" >/dev/null
as_pg "$PGBIN/pg_ctl -D '$PGDATA' -o \"-k '$PGSOCK' -h ''\" -l '$PGDATA/server.log' -w start" >/dev/null
PSQL=(psql -h "$PGSOCK" -U postgres -d postgres -v ON_ERROR_STOP=1 -X)
echo "Loading fixture (listing_events, policies, grants and guards as they exist today)…"
"${PSQL[@]}" -q -f "$HERE/schema_listing_events_anon.sql"
echo "Proving the finding on the PRE-migration fixture (anon must be able to read events)…"
N="$("${PSQL[@]}" -qAt -c "SET ROLE anon; SELECT count(*) FROM listing_events;")"
[[ "$N" =~ ^[0-9]+$ && "$N" -ge 3 ]] || { echo "FAIL: the fixture does not reproduce the finding (anon read $N rows)"; exit 1; }
echo "  pre-migration: anon reads $N events (finding reproduced)"
echo "Applying supabase/migrations/$(basename "$MIGRATION") (1st time)…"; "${PSQL[@]}" -q -f "$MIGRATION"
echo "Applying it again (idempotency check — must not error)…"; "${PSQL[@]}" -q -f "$MIGRATION"
echo "Running assertions…"
if "${PSQL[@]}" -f "$HERE/listing_events_anon_regression.sql" 2>&1 | sed 's/^psql:.*NOTICE: *//'; then
  echo; echo "PASS — anon cannot read or enumerate listing_events; public insertion and 30-minute dedup still work; administrator reads; migration idempotent."
else
  echo; echo "FAIL — a regression assertion did not hold, or the migration was not idempotent (see above)."; exit 1
fi
