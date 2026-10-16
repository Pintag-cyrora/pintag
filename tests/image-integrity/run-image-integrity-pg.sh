#!/usr/bin/env bash
# Runs the REAL scripts/image-integrity.py against a throwaway PostgreSQL with stand-in tables and asserts what it
# reports and whether it fails, for healthy and unhealthy storage layouts.
#   bash tests/image-integrity/run-image-integrity-pg.sh            (needs postgres server binaries + python3)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
SCRIPT="${IMAGE_INTEGRITY_SCRIPT:-$ROOT/scripts/image-integrity.py}"
PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin; do [[ -x "$d/initdb" ]] && PGBIN="$d"; done; fi
[[ -n "$PGBIN" ]] || { echo "SKIP: postgres server binaries not found"; exit 0; }
RUN_AS=""; if [[ "$(id -u)" -eq 0 ]]; then id pgtest >/dev/null 2>&1 || useradd -m pgtest; RUN_AS=pgtest; WORK="$(su pgtest -c 'mktemp -d')"; else WORK="$(mktemp -d)"; fi
as_pg() { if [[ -n "$RUN_AS" ]]; then su "$RUN_AS" -c "$1"; else bash -c "$1"; fi; }
cleanup() { as_pg "$PGBIN/pg_ctl -D '$WORK/data' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT
mkdir -p "$WORK/sock"; [[ -n "$RUN_AS" ]] && chown -R "$RUN_AS" "$WORK"
as_pg "$PGBIN/initdb -D '$WORK/data' -A trust -U postgres" >/dev/null
as_pg "$PGBIN/pg_ctl -D '$WORK/data' -o \"-k '$WORK/sock' -h ''\" -l '$WORK/log' -w start" >/dev/null
DB="host=$WORK/sock user=postgres dbname=postgres"
PSQL=(psql "$DB" -X -q -v ON_ERROR_STOP=1)
cp "$HERE/schema.sql" "$WORK/schema.sql"; chmod a+r "$WORK/schema.sql"

fail=0
check() { # name, expected_exit, expected-substring...
  local name="$1" want="$2"; shift 2
  set +e; out="$(PINTAG_PROD_DB_URL="$DB" python3 "$SCRIPT" 2>"$WORK/err")"; code=$?; set -e
  ok=1; [[ "$code" == "$want" ]] || ok=0
  for pat in "$@"; do grep -qE "$pat" <<<"$out$(cat "$WORK/err")" || ok=0; done
  if [[ $ok == 1 ]]; then echo "PASS  $name"; else echo "FAIL  $name (exit $code, wanted $want)"; echo "$out"; cat "$WORK/err"; fail=1; fi
}
reset() { "${PSQL[@]}" -c "DROP SCHEMA IF EXISTS storage CASCADE; DROP TABLE IF EXISTS unit_types, property_images, properties;" -f "$WORK/schema.sql"; }
URL='https://x.supabase.co/storage/v1/object/public/property-images/'
PROFILES="thumbnail card gallery hero"
# helper SQL generators
renditions() { for p in $PROFILES; do echo "INSERT INTO storage.objects VALUES ('renditions/$1/$p.webp','property-images');"; done; }

# ── 1. healthy: registered originals + 4 renditions each, a unit gallery original (URL with ?v=) + its renditions, a removed-row object
reset
{
  echo "INSERT INTO properties VALUES ('00000000-0000-0000-0000-000000000001','[]'),('00000000-0000-0000-0000-000000000002','[]');"
  echo "INSERT INTO property_images(property_id,storage_path,is_cover,display_order) VALUES ('00000000-0000-0000-0000-000000000001','a/one.jpg',true,0),('00000000-0000-0000-0000-000000000002','b/two.png',true,0);"
  echo "INSERT INTO property_images(property_id,storage_path,status) VALUES ('00000000-0000-0000-0000-000000000002','b/gone.jpg','removed');"
  echo "INSERT INTO storage.objects VALUES ('a/one.jpg','property-images'),('b/two.png','property-images'),('b/gone.jpg','property-images'),('u/unit1.jpg','property-images');"
  echo "INSERT INTO unit_types(property_id,images) VALUES ('00000000-0000-0000-0000-000000000001', ARRAY['${URL}u/unit1.jpg?v=3']);"
  renditions a/one; renditions b/two; renditions b/gone; renditions u/unit1
} | "${PSQL[@]}"
check "healthy layout: renditions + unit gallery are not orphans; HEALTHY, exit 0" 0 \
  'Orphaned files: +0$' 'derived renditions: +16$' 'unit gallery originals: +1$' 'STATUS: HEALTHY'

# ── 2. a rendition whose original nobody knows is still an orphan (fail-closed)
"${PSQL[@]}" -c "INSERT INTO storage.objects VALUES ('renditions/ghost/never/card.webp','property-images');"
check "rendition of an unknown original is still an orphan -> FAILED" 1 'Orphaned files: +1$' 'STATUS: FAILED' '1 orphaned object'

# ── 3. unrecognised file under renditions/ (wrong profile / not webp) is an orphan
reset
{
  echo "INSERT INTO properties VALUES ('00000000-0000-0000-0000-000000000001','[]');"
  echo "INSERT INTO property_images(property_id,storage_path,is_cover) VALUES ('00000000-0000-0000-0000-000000000001','a/one.jpg',true);"
  echo "INSERT INTO storage.objects VALUES ('a/one.jpg','property-images'),('renditions/a/one/huge.webp','property-images'),('renditions/a/one/card.jpg','property-images');"
} | "${PSQL[@]}"
check "unrecognised files under renditions/ are orphans -> FAILED" 1 'Orphaned files: +2$' 'STATUS: FAILED'

# ── 4. an unregistered original that no unit type references is an orphan
reset
{
  echo "INSERT INTO properties VALUES ('00000000-0000-0000-0000-000000000001','[]');"
  echo "INSERT INTO property_images(property_id,storage_path,is_cover) VALUES ('00000000-0000-0000-0000-000000000001','a/one.jpg',true);"
  echo "INSERT INTO storage.objects VALUES ('a/one.jpg','property-images'),('stray/unreferenced.jpg','property-images');"
} | "${PSQL[@]}"
check "stray unregistered, unreferenced file is an orphan -> FAILED" 1 'Orphaned files: +1$' 'STATUS: FAILED'

# ── 5. the rest of the fail-closed checks are untouched: a registered file missing from storage still fails
reset
{
  echo "INSERT INTO properties VALUES ('00000000-0000-0000-0000-000000000001','[]');"
  echo "INSERT INTO property_images(property_id,storage_path,is_cover) VALUES ('00000000-0000-0000-0000-000000000001','a/one.jpg',true);"
} | "${PSQL[@]}"
check "missing file still fails" 1 'Missing files: +1$' 'STATUS: FAILED' '1 missing file'

# ── 6. --allow-orphans still tolerates exactly N TRUE orphans
reset
{
  echo "INSERT INTO properties VALUES ('00000000-0000-0000-0000-000000000001','[]');"
  echo "INSERT INTO property_images(property_id,storage_path,is_cover) VALUES ('00000000-0000-0000-0000-000000000001','a/one.jpg',true);"
  echo "INSERT INTO storage.objects VALUES ('a/one.jpg','property-images'),('stray/x.jpg','property-images');"
} | "${PSQL[@]}"
set +e; PINTAG_PROD_DB_URL="$DB" python3 "$SCRIPT" --allow-orphans 1 >/dev/null 2>&1; code=$?; set -e
if [[ $code == 0 ]]; then echo "PASS  --allow-orphans 1 tolerates one true orphan"; else echo "FAIL  --allow-orphans (exit $code)"; fail=1; fi

[[ $fail == 0 ]] && echo "ALL IMAGE-INTEGRITY CHECKS PASSED" || { echo "IMAGE-INTEGRITY TESTS FAILED"; exit 1; }
