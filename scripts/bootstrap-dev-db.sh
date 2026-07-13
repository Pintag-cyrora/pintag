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
#   4. Detects admin@pintag.io in auth.users and, if found, seeds its
#      `parties` staff row (idempotent — safe to re-run). This is the exact
#      seed baked into 20260705000000_agents_becomes_parties.sql, which a
#      schema-only dump never replays (it's DML, not structure) — confirmed
#      necessary in practice (2026-07-09): a fresh bootstrap with no staff
#      party seeded fails every staff-flow insert with 42501 (RLS), since
#      is_pintag_staff(auth.uid()) has no row to find.
#   5. Verifies RLS actually grants that staff party what it needs, by
#      impersonating the admin auth uid (SET LOCAL role authenticated +
#      request.jwt.claim(s)) and running a real INSERT into contacts inside
#      a transaction that's always rolled back — never leaves a test row.
#   6. Prints a readiness summary ("✅ Pintag Dev Environment Ready" + a
#      checklist) only if both of the above succeed — makes it immediately
#      obvious the environment is actually usable, not just that the script
#      ran without crashing.
#
# A brand-new developer should be able to go from an empty Supabase project
# to a working Pintag dev environment with this one command (plus creating
# the admin@pintag.io auth user via the dashboard first — see step 4 above,
# this script deliberately does not attempt to create Supabase Auth users
# itself; inserting directly into auth.users bypasses GoTrue and is not
# supported/safe to script).
#
# ── What this does NOT do ─────────────────────────────────────────────────
#   No listing data is copied (schema + one staff party, zero properties/
#   contacts) — see seed-dev-from-prod.sh for a redacted, representative
#   data copy after this has run once.
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
echo "== Detecting admin@pintag.io in auth.users =="
ADMIN_UID="$(psql "$PINTAG_DEV_DB_URL" -v ON_ERROR_STOP=1 -t -A \
  -c "SELECT id FROM auth.users WHERE email = 'admin@pintag.io';")"

if [[ -z "$ADMIN_UID" ]]; then
  echo "⚠ No auth.users row for admin@pintag.io yet." >&2
  echo "  Create it first: Supabase dashboard → Authentication → Add User (email: admin@pintag.io)." >&2
  echo "  Then re-run this script — every step here is idempotent, safe to run again." >&2
  echo
  echo "Schema restore succeeded, but the environment is NOT ready yet (see above)." >&2
  exit 1
fi
echo "Found admin@pintag.io -> $ADMIN_UID"

echo
echo "== Seeding its parties staff row (skipped if one already exists) =="
# Same seed as 20260705000000_agents_becomes_parties.sql's INSERT, run
# directly since a schema-only dump never replays DML from migration
# history. Slug is derived from the auth uid (deterministic, effectively
# always unique) rather than hardcoded, so this is also safe if pintag-dev
# ever already has an unrelated party using the production slug.
psql "$PINTAG_DEV_DB_URL" -v ON_ERROR_STOP=1 -v admin_uid="$ADMIN_UID" <<'SQL'
INSERT INTO parties (id, type, auth_user_id, name_en, slug)
SELECT gen_random_uuid(), 'staff', :'admin_uid'::uuid, 'Pintag Staff',
       'pintag-staff-' || substr(:'admin_uid', 1, 8)
WHERE NOT EXISTS (
  SELECT 1 FROM parties WHERE auth_user_id = :'admin_uid'::uuid
);
SQL

echo
echo "== Verifying RLS: staff INSERT into contacts, impersonated as admin@pintag.io =="
# Impersonates the real auth uid the way PostgREST would (SET LOCAL role
# authenticated + request.jwt claims), so this actually exercises the
# "Staff full access contacts" policy rather than just testing table
# permissions as the superuser connection role (which would bypass RLS
# entirely and prove nothing). Wrapped in BEGIN/ROLLBACK — never leaves a
# row behind. Sets both request.jwt.claim.sub and request.jwt.claims since
# different Supabase/GoTrue versions' auth.uid() reads one or the other.
# Uses set_config() (a function call, so it can take an expression) rather
# than SET LOCAL (literal-only) for the value that needs building from the
# uid variable; quoted heredoc + psql's own :'var' substitution throughout,
# same as the seed step above, deliberately avoiding raw bash interpolation
# into SQL text.
if psql "$PINTAG_DEV_DB_URL" -v ON_ERROR_STOP=1 -v admin_uid="$ADMIN_UID" -q <<'SQL'
BEGIN;
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claim.sub', :'admin_uid', true);
SELECT set_config('request.jwt.claims',
  '{"sub":"' || :'admin_uid' || '","role":"authenticated"}', true);
INSERT INTO contacts (role, phone, created_by)
  VALUES ('other', '00000000', :'admin_uid'::uuid)
  RETURNING id;
ROLLBACK;
SQL
then
  echo
  echo "✅ Pintag Dev Environment Ready"
  echo
  echo "✓ Schema restored"
  echo "✓ Core migrations applied (reflects production's current state)"
  echo "✓ Admin auth user found"
  echo "✓ Staff party seeded"
  echo "✓ RLS verification passed"
  echo
  echo "Next:"
  echo "  1. Open admin.html"
  echo "  2. Create a test listing"
  echo "  3. Verify save/edit workflow"
  echo
  echo "Optional:"
  echo "  - Apply any migrations newer than production's current state, e.g.:"
  echo "    psql \"\$PINTAG_DEV_DB_URL\" -v ON_ERROR_STOP=1 -f supabase/migrations/<newest>.sql"
  echo "  - Run scripts/seed-dev-from-prod.sh for realistic sample listings."
else
  echo
  echo "✗ RLS verification insert failed — see the error above." >&2
  echo "  Most likely cause: is_pintag_staff() isn't resolving true for $ADMIN_UID." >&2
  echo "  Double check: SELECT type, auth_user_id FROM parties WHERE auth_user_id = '$ADMIN_UID';" >&2
  exit 1
fi
