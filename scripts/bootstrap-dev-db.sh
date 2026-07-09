#!/usr/bin/env bash
# bootstrap-dev-db.sh — populate a fresh (empty public schema) pintag-dev
# project with production's current table/column/constraint/RLS structure,
# working around the fact that `properties` and `agents`/`parties` were
# created by hand in the Supabase dashboard years before this repo's
# migrations were tracked (see issue #37) — so `supabase db push` or running
# supabase/migrations/*.sql in order from nothing both fail immediately (the
# earliest tracked migration already assumes `properties`/`agents` exist).
# A schema-only dump of PRODUCTION'S CURRENT structure sidesteps that gap
# entirely: it reflects what the tables look like today, regardless of
# which migration (tracked or not) created them.
#
# Run from your own machine (needs network access to both Supabase Session
# Poolers — this cannot run from a sandboxed Claude Code session).
#
# Usage:
#   PINTAG_PROD_DB_URL="postgresql://postgres.<prod-ref>:<pw>@<pooler-host>:5432/postgres" \
#   PINTAG_DEV_DB_URL="postgresql://postgres.ebtgoqrywdywuqrvudcp:<pw>@<pooler-host>:5432/postgres" \
#   ./scripts/bootstrap-dev-db.sh
#
# ── What this does ────────────────────────────────────────────────────────
#   1. pg_dump --schema-only --no-owner --no-privileges --schema=public
#      against production.
#   2. Strips the dump's unconditional `CREATE SCHEMA public;` line — every
#      Supabase project already has a `public` schema (with its own default
#      anon/authenticated/service_role grants), so that line always fails
#      with "schema already exists" otherwise. This is the ONLY line
#      removed; --no-privileges already excludes GRANT statements, and
#      deliberately NOT using --clean/--if-exists means we never DROP the
#      schema either, so Supabase's default grants on it are never at risk.
#   3. Restores the filtered dump into pintag-dev.
#
# ── What this does NOT do ─────────────────────────────────────────────────
#   No data is copied (schema only, zero rows) — see seed-dev-from-prod.sh
#   for a redacted, representative data copy after this has run once.
#   Any migrations newer than production's current state (i.e. anything
#   still pending review/apply, like a not-yet-applied land-fields
#   migration) are NOT included — production's dump can only reflect what's
#   already live there. Apply those on top afterward, same as you would
#   against production, e.g.:
#     psql "$PINTAG_DEV_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/<newest>.sql
#
# ── Safety ────────────────────────────────────────────────────────────────
# Read-only against production (pg_dump only). Refuses to run if the
# destination looks like production, or doesn't look like the known
# pintag-dev project — same hard gate as seed-dev-from-prod.sh. This does
# NOT truncate or drop anything in the destination; if pintag-dev already
# has tables, the restore will fail loudly (and safely) on the first
# "already exists" rather than silently double-applying or losing data.

set -euo pipefail

DEV_PROJECT_REF="ebtgoqrywdywuqrvudcp"
PROD_PROJECT_REF="eoladhcljbpbhnrmmpev"

: "${PINTAG_PROD_DB_URL:?Set PINTAG_PROD_DB_URL to the production Session Pooler connection string}"
: "${PINTAG_DEV_DB_URL:?Set PINTAG_DEV_DB_URL to the pintag-dev Session Pooler connection string}"

# ── Hard safety gate — refuses to run unless the destination is verifiably
# pintag-dev, and never the production project. Not a flag you can bypass;
# if these checks fail, fix the connection string, don't work around this. ──
if [[ "$PINTAG_DEV_DB_URL" == *"$PROD_PROJECT_REF"* ]]; then
  echo "REFUSING: PINTAG_DEV_DB_URL contains the PRODUCTION project ref ($PROD_PROJECT_REF)." >&2
  echo "This script restores a schema dump into its destination. Aborting to protect production." >&2
  exit 1
fi
if [[ "$PINTAG_DEV_DB_URL" != *"$DEV_PROJECT_REF"* ]]; then
  echo "REFUSING: PINTAG_DEV_DB_URL does not contain the known pintag-dev project ref ($DEV_PROJECT_REF)." >&2
  echo "Refusing to guess — pass the exact pintag-dev Session Pooler connection string." >&2
  exit 1
fi
if [[ "$PINTAG_PROD_DB_URL" == *"$DEV_PROJECT_REF"* ]]; then
  echo "NOTE: PINTAG_PROD_DB_URL looks like it points at pintag-dev, not production." >&2
  echo "That's harmless (source is read-only here) but is probably a mistake — check your env vars." >&2
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
DUMP_FILE="$WORKDIR/pintag_schema.sql"

echo "== Dumping production schema (public only, no owner/privilege statements) =="
pg_dump --schema-only --no-owner --no-privileges --schema=public "$PINTAG_PROD_DB_URL" \
  | grep -v '^CREATE SCHEMA public;' \
  > "$DUMP_FILE"

echo "== Restoring into pintag-dev =="
psql "$PINTAG_DEV_DB_URL" -v ON_ERROR_STOP=1 -f "$DUMP_FILE"

echo "== Done. Tables now in pintag-dev =="
psql "$PINTAG_DEV_DB_URL" -c "\dt public.*"

echo
echo "Next steps:"
echo "  1. Apply any migrations newer than production's current state, e.g.:"
echo "     psql \"\$PINTAG_DEV_DB_URL\" -v ON_ERROR_STOP=1 -f supabase/migrations/<newest>.sql"
echo "  2. Create a dev staff auth user (Supabase dashboard) and seed its parties row, e.g.:"
echo "     INSERT INTO parties (type, auth_user_id, name_en) SELECT 'staff', id, 'Dev Staff' FROM auth.users WHERE email = '<dev-admin email>';"
echo "  3. Optionally run scripts/seed-dev-from-prod.sh for realistic sample listings."
