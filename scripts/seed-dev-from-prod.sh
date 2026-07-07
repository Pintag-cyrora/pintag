#!/usr/bin/env bash
# seed-dev-from-prod.sh — refresh the pintag-dev database with a redacted,
# representative copy of production listing data, for realistic UI testing
# without exposing real customer interactions.
#
# Run from your own machine (needs network access to both Supabase Session
# Poolers — this cannot run from a sandboxed Claude Code session).
#
# Usage:
#   PINTAG_PROD_DB_URL="postgresql://postgres.<prod-ref>:<pw>@<pooler-host>:5432/postgres" \
#   PINTAG_DEV_DB_URL="postgresql://postgres.ebtgoqrywdywuqrvudcp:<pw>@<pooler-host>:5432/postgres" \
#   ./scripts/seed-dev-from-prod.sh [--dry-run] [--yes]
#
# --dry-run   Print row counts that would be copied; touches nothing.
# --yes       Skip the interactive confirmation before truncating dev tables.
#
# ── What this copies ─────────────────────────────────────────────────────
#   properties  — every column, EXCEPT view_count/views_week/price_previous
#                 are reset to 0/NULL (analytics, not representative sample
#                 data). images/amenities are plain array columns on this
#                 table (no separate tables exist for either), so they come
#                 along automatically. Same for district_en/lo/zh/village —
#                 there is no separate "districts" lookup table in this
#                 schema; district is just columns on properties.
#   parties     — every column (agent/owner/staff profiles, photos, bios),
#                 EXCEPT auth_user_id is set to NULL for every copied row —
#                 dev has its own, separate auth.users, so a production
#                 auth id would either dangle or (worse) accidentally alias
#                 a real dev account. The dev staff login is re-linked
#                 separately at the end so admin access keeps working.
#   contacts    — name/role kept (for realistic contact-card layout), but
#                 phone and whatsapp are replaced with an obvious fake
#                 placeholder ('0000000000') — no real phone number is ever
#                 copied into dev. created_by is set to NULL for the same
#                 cross-project auth reason as parties.auth_user_id.
#
# ── What this deliberately excludes ──────────────────────────────────────
#   lead_events, listing_events  — real buyer interaction/analytics data;
#                                  never copied, full stop.
#   contacts.phone / whatsapp    — replaced with a fake placeholder
#                                  ('0000000000'); no real phone number is
#                                  ever copied into dev.
#   auth_user_id / created_by    — nulled everywhere (see above) so no
#                                  production login/account is carried over.
#   view_count / views_week /
#   price_previous               — reset, not representative sample data,
#                                  just engagement noise.
#
# ── Safety ────────────────────────────────────────────────────────────────
# This TRUNCATEs parties/contacts/properties on the DESTINATION before
# reseeding — it is destructive to whatever is currently in dev. The
# destination is hard-checked against the known pintag-dev project ref
# below; the script refuses to run against anything else, especially
# production. The production connection is never written to.

set -euo pipefail

DEV_PROJECT_REF="ebtgoqrywdywuqrvudcp"
PROD_PROJECT_REF="eoladhcljbpbhnrmmpev"

DRY_RUN=false
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes) ASSUME_YES=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

: "${PINTAG_PROD_DB_URL:?Set PINTAG_PROD_DB_URL to the production Session Pooler connection string}"
: "${PINTAG_DEV_DB_URL:?Set PINTAG_DEV_DB_URL to the pintag-dev Session Pooler connection string}"

# ── Hard safety gate — refuses to run unless the destination is verifiably
# pintag-dev, and never the production project. Not a flag you can bypass;
# if these checks fail, fix the connection string, don't work around this. ──
if [[ "$PINTAG_DEV_DB_URL" == *"$PROD_PROJECT_REF"* ]]; then
  echo "REFUSING: PINTAG_DEV_DB_URL contains the PRODUCTION project ref ($PROD_PROJECT_REF)." >&2
  echo "This script truncates its destination. Aborting to protect production." >&2
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

psql_prod() { psql "$PINTAG_PROD_DB_URL" -v ON_ERROR_STOP=1 "$@"; }
psql_dev()  { psql "$PINTAG_DEV_DB_URL"  -v ON_ERROR_STOP=1 "$@"; }

echo "== Row counts in production =="
psql_prod -c "SELECT
  (SELECT count(*) FROM parties)    AS parties,
  (SELECT count(*) FROM contacts)   AS contacts,
  (SELECT count(*) FROM properties) AS properties;"

if $DRY_RUN; then
  echo "--dry-run: not touching pintag-dev. Exiting."
  exit 0
fi

if ! $ASSUME_YES; then
  echo
  echo "This will TRUNCATE parties, contacts, and properties in pintag-dev"
  echo "and replace them with a redacted copy of the production data above."
  echo "Any listings you created by hand in admin.html against pintag-dev will be lost."
  read -r -p "Type 'seed dev' to continue: " confirm
  if [[ "$confirm" != "seed dev" ]]; then
    echo "Aborted, nothing changed."
    exit 1
  fi
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "== Exporting redacted data from production (read-only; nothing is written back) =="

psql_prod -c "
  CREATE TEMP TABLE _seed_parties AS SELECT * FROM parties;
  UPDATE _seed_parties SET auth_user_id = NULL;
  \copy _seed_parties TO '$WORKDIR/parties.csv' WITH (FORMAT csv, HEADER true)
"

psql_prod -c "
  CREATE TEMP TABLE _seed_contacts AS SELECT * FROM contacts;
  UPDATE _seed_contacts SET created_by = NULL, phone = '0000000000', whatsapp = '0000000000';
  \copy _seed_contacts TO '$WORKDIR/contacts.csv' WITH (FORMAT csv, HEADER true)
"

# images/amenities/district_* are plain columns on properties — no separate
# tables to handle. images stay pointing at production's *public* storage
# bucket (property-images / agent-photos are public-read), so photos render
# correctly in dev without copying any actual files between projects.
psql_prod -c "
  CREATE TEMP TABLE _seed_properties AS SELECT * FROM properties;
  UPDATE _seed_properties SET view_count = 0, views_week = 0, price_previous = NULL;
  \copy _seed_properties TO '$WORKDIR/properties.csv' WITH (FORMAT csv, HEADER true)
"

echo "== Reseeding pintag-dev =="

# CASCADE also clears dev's lead_events/listing_events rows that reference
# the properties being replaced (their property_id would otherwise dangle)
# — expected and fine, those rows are exactly the operational data this
# script deliberately never repopulates.
psql_dev -c "TRUNCATE properties, contacts, parties RESTART IDENTITY CASCADE;"

# Import order matters: parties and contacts are referenced by properties'
# foreign keys, so they must exist first.
psql_dev -c "\copy parties FROM '$WORKDIR/parties.csv' WITH (FORMAT csv, HEADER true)"
psql_dev -c "\copy contacts FROM '$WORKDIR/contacts.csv' WITH (FORMAT csv, HEADER true)"
psql_dev -c "\copy properties FROM '$WORKDIR/properties.csv' WITH (FORMAT csv, HEADER true)"

echo "== Re-linking the dev staff login =="
# The copied production "Pintag Staff" party (auth_user_id now NULL) is
# re-pointed at dev's own admin account, so admin.html login keeps working
# after every reseed. Falls back to inserting a fresh staff row only if no
# staff party came over from production at all.
psql_dev -c "
  UPDATE parties SET auth_user_id = (SELECT id FROM auth.users WHERE email = 'dev-admin@pintag.io')
  WHERE type = 'staff';

  INSERT INTO parties (type, auth_user_id, name_en, slug)
  SELECT 'staff', u.id, 'Dev Staff', 'pintag-staff-dev'
  FROM auth.users u WHERE u.email = 'dev-admin@pintag.io'
  AND NOT EXISTS (SELECT 1 FROM parties WHERE auth_user_id = u.id);
"

echo "== Done. Row counts in pintag-dev =="
psql_dev -c "SELECT
  (SELECT count(*) FROM parties)    AS parties,
  (SELECT count(*) FROM contacts)   AS contacts,
  (SELECT count(*) FROM properties) AS properties;"
