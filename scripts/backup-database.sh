#!/usr/bin/env bash
# backup-database.sh — READ-ONLY logical backup of the Pintag production DB.
#
# Produces, under $OUT/database/:
#   full.dump           pg_dump -Fc of the public schema (schema+data) — primary restore artifact
#   schema.sql          pg_dump --schema-only (tables, functions, RLS policies, triggers, indexes)
#   extensions.txt      installed extensions (recreate list)
#   migrations.csv      applied migration head (supabase_migrations.schema_migrations)
#   rls_policies.csv    every RLS policy (pg_policies) — restore-validation cross-check
#   functions.csv       every public function (restore-validation cross-check)
#   relationships/*.csv one CSV per table that references a property/party/contact/owner
#   reference/auth_users.csv   id/email/created_at ONLY (auth is reference-only; see DR doc)
#
# Nothing is written to production. Requires: pg_dump, psql (client major version
# matching the server), PINTAG_PROD_DB_URL (use the backup_ro role, not superuser).
set -euo pipefail

: "${PINTAG_PROD_DB_URL:?Set PINTAG_PROD_DB_URL (backup_ro connection string)}"
OUT="${1:?Usage: backup-database.sh <output-dir>}"
DB="$OUT/database"
mkdir -p "$DB/relationships" "$DB/reference"

pg() { psql "$PINTAG_PROD_DB_URL" -v ON_ERROR_STOP=1 -X "$@"; }

echo "== pg_dump (custom format, public schema) =="
pg_dump "$PINTAG_PROD_DB_URL" --schema=public --format=custom --no-owner --no-privileges \
  --file "$DB/full.dump"
echo "== pg_dump (schema only, human-readable) =="
pg_dump "$PINTAG_PROD_DB_URL" --schema=public --schema-only --no-owner --no-privileges \
  --file "$DB/schema.sql"

echo "== extensions / migrations / policies / functions =="
pg -c "\copy (select extname, extversion from pg_extension order by 1) TO '$DB/extensions.txt' WITH (FORMAT csv, HEADER true)"
pg -c "\copy (select version, name from supabase_migrations.schema_migrations order by version) TO '$DB/migrations.csv' WITH (FORMAT csv, HEADER true)" \
  || echo "(no supabase_migrations schema — skipped)"
pg -c "\copy (select schemaname,tablename,policyname,cmd,roles,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname) TO '$DB/rls_policies.csv' WITH (FORMAT csv, HEADER true)"
pg -c "\copy (select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1) TO '$DB/functions.csv' WITH (FORMAT csv, HEADER true)"

echo "== reference-only exports (NOT directly restorable — see DR doc) =="
pg -c "\copy (select id, email, created_at, last_sign_in_at from auth.users order by created_at) TO '$DB/reference/auth_users.csv' WITH (FORMAT csv, HEADER true)"

# ── Dynamic relationship-table discovery ────────────────────────────────────
# Auto-includes ANY public table that (a) has a FK to properties/parties/
# contacts/owners, or (b) carries a *_id relationship column, plus an explicit
# core set. This keeps the backup current as the schema evolves (DR design pt 4).
echo "== discovering relationship tables =="
mapfile -t REL_TABLES < <(pg -Atq <<'SQL'
with fk_related as (
  select distinct c.conrelid::regclass::text as t
  from pg_constraint c
  where c.contype='f'
    and c.confrelid in (
      to_regclass('public.properties'), to_regclass('public.parties'),
      to_regclass('public.contacts'),   to_regclass('public.owners'))
),
name_related as (
  select distinct table_name as t
  from information_schema.columns
  where table_schema='public'
    and column_name ~* '^(property_id|listing_id|party_id|contact_id|owner_id|managed_by_party_id)$'
),
core(t) as (values
  ('properties'),('properties_removal_log'),('parties'),('contacts'),('owners'),
  ('leads'),('lead_events'),('unit_types'),('listing_events'),('admin_accounts'),('listings')
)
select distinct t from (
  select t from fk_related union select t from name_related union select t from core
) x
where t in (select table_name from information_schema.tables
            where table_schema='public' and table_type='BASE TABLE')
order by 1;
SQL
)

echo "   relationship tables: ${REL_TABLES[*]}"
for t in "${REL_TABLES[@]}"; do
  pg -c "\copy (select * from public.\"$t\") TO '$DB/relationships/$t.csv' WITH (FORMAT csv, HEADER true)"
done
# Record which tables were captured (so a restore knows the exact set).
printf '%s\n' "${REL_TABLES[@]}" > "$DB/relationships/_INCLUDED_TABLES.txt"

echo "== database backup complete → $DB =="
