#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Data-layer security regression runner — fully local, zero production contact.
#
#   bash tests/security/regression/run-local-pg.sh
#
# Spins up a THROWAWAY PostgreSQL cluster in a temp directory, loads the
# fixture (schema.sql — production-shaped roles, policies and pre-fix function
# bodies), applies the hardening migration, then runs the assertions in
# rls_regression.sql. The cluster is destroyed on exit either way.
#
# This is deliberately separate from tests/security/run.sh: that suite probes a
# LIVE Supabase project over HTTP and needs credentials, so it cannot run on an
# untrusted PR. This one needs nothing but a local PostgreSQL binary, so it can
# gate every push and every pull request.
#
# Requires: postgresql server binaries (Debian/Ubuntu: `postgresql`).
# Exit code: 0 = every assertion passed.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# Every security migration this suite exercises, applied in order.
MIGRATIONS=(
  "$ROOT/supabase/migrations/20260817000000_security_audit_hardening.sql"
  "$ROOT/supabase/migrations/20260817010000_authz_identity_and_abuse_bounds.sql"
  "$ROOT/supabase/migrations/20260818000000_revoke_public_execute.sql"
  "$ROOT/supabase/migrations/20260818010000_restore_views_week_column.sql"
)
for m in "${MIGRATIONS[@]}"; do
  [[ -f "$m" ]] || { echo "FATAL: security migration not found: $m"; exit 1; }
done

# Locate the server binaries (they are not on PATH in Debian/Ubuntu packaging).
PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then
  for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /opt/homebrew/opt/postgresql@*/bin; do
    [[ -x "$d/initdb" ]] && PGBIN="$d"
  done
fi
if [[ -z "$PGBIN" ]]; then
  echo "FATAL: could not find initdb. Install PostgreSQL server binaries, or set PGBIN."
  echo "  Ubuntu/Debian: sudo apt-get install -y postgresql"
  echo "  macOS:         brew install postgresql@16"
  exit 1
fi

# PostgreSQL refuses to run as root. When invoked as root (containers, CI
# images), do the work as an unprivileged helper account instead.
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

echo "Loading fixture (production-shaped schema, policies, PRE-FIX functions)…"
"${PSQL[@]}" -q -f "$HERE/schema.sql"

for m in "${MIGRATIONS[@]}"; do
  echo "Applying supabase/migrations/$(basename "$m")…"
  "${PSQL[@]}" -q -f "$m"
done

echo "Running assertions…"
if "${PSQL[@]}" -f "$HERE/rls_regression.sql" 2>&1 | sed 's/^psql:.*NOTICE: *//'; then
  echo
  echo "PASS — data-layer security regressions all held."
else
  echo
  echo "FAIL — a security regression assertion did not hold (see above)."
  exit 1
fi
