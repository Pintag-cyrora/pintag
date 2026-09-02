#!/usr/bin/env bash
# restore-production.sh — restore Pintag from a DR backup and emit a restore
# report. WRITES to the TARGET database/bucket — run ONLY against a restore
# target (a fresh/scratch Supabase project for a drill, or the real project in a
# genuine disaster). It never touches the backup source.
#
# Usage:
#   PINTAG_RESTORE_DB_URL="postgresql://postgres:<pw>@<target-host>:5432/postgres" \
#   ./scripts/restore-production.sh --backup ./backup-YYYY-MM-DD [--storage]
#
# Prereqs on the target: the migrations already applied (so RLS/functions/policies
# exist), OR restore schema.sql first. Decryption needs the age PRIVATE key at
# $AGE_KEY (default: ./backup-age-key.txt) — kept OFFLINE, never in CI.
set -euo pipefail

BACKUP="" ; DO_STORAGE=false ; SEED_STUB_AUTH=false
AGE_KEY="${AGE_KEY:-./backup-age-key.txt}"
while [[ $# -gt 0 ]]; do case "$1" in
  --backup) BACKUP="$2"; shift 2 ;;
  --storage) DO_STORAGE=true; shift ;;
  # DRILL ONLY: seed a disposable scratch auth.users with the ids the restored
  # public data references, so the real public->auth.users FK constraints can
  # validate against a genuine (if synthetic) reference set. Never use against a
  # real Supabase project — auth.users there is GoTrue-managed. See restore-drill.yml.
  --seed-stub-auth) SEED_STUB_AUTH=true; shift ;;
  *) echo "Unknown arg: $1" >&2; exit 1 ;;
esac; done
: "${BACKUP:?--backup <dir> required}"
: "${PINTAG_RESTORE_DB_URL:?Set PINTAG_RESTORE_DB_URL to the RESTORE TARGET (never the live prod URL during a drill)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== Decrypting encrypted artifacts (age) =="
for enc in "$BACKUP"/database/full.dump.age "$BACKUP"/database/relationships/*.age; do
  [[ -e "$enc" ]] || continue
  age -d -i "$AGE_KEY" -o "${enc%.age}" "$enc"
done

echo "== Restoring database (pg_restore, public schema) =="
DUMP="$BACKUP/database/full.dump"
if $SEED_STUB_AUTH; then
  # The public dump carries FK constraints to auth.users, but auth is
  # reference-only and never restored (GoTrue-managed; admin re-provisioned by
  # hand). Restore in SECTIONS so the disposable scratch auth.users can be seeded
  # with exactly the ids the restored public data references — letting the REAL FK
  # constraints validate legitimately. FKs are never disabled, dropped, deferred,
  # or suppressed. Fail-closed: --exit-on-error on every section, so ANY restore
  # error fails the drill.
  echo "-- pre-data (schema; FK constraints are added later in post-data)"
  pg_restore --no-owner --no-privileges --clean --if-exists --exit-on-error \
    --section=pre-data --dbname "$PINTAG_RESTORE_DB_URL" "$DUMP"
  echo "-- data (rows)"
  pg_restore --no-owner --no-privileges --exit-on-error \
    --section=data --dbname "$PINTAG_RESTORE_DB_URL" "$DUMP"
  echo "-- seed stub auth.users from ids referenced by public->auth.users FKs"
  # Discover every public FK -> auth.users straight from the dump's own post-data
  # DDL, so any out-of-band table (e.g. profiles) is covered automatically rather
  # than hard-coded. For each (table,column), insert the distinct non-null ids the
  # restored data references as stub auth.users rows (id only).
  PD="$(mktemp)"
  pg_restore --section=post-data -f "$PD" "$DUMP"
  awk '
    /^ALTER TABLE ONLY / { t=$0; sub(/^ALTER TABLE ONLY /,"",t); sub(/[[:space:]].*$/,"",t); sub(/;$/,"",t) }
    /ADD CONSTRAINT .* FOREIGN KEY .* REFERENCES auth\.users/ {
      c=$0; sub(/.*FOREIGN KEY \(/,"",c); sub(/\).*/,"",c); gsub(/"/,"",c);
      print t "|" c
    }' "$PD" | sort -u | while IFS='|' read -r tbl col; do
      [[ -n "$tbl" && -n "$col" ]] || continue
      echo "   seeding auth ids from ${tbl}.${col}"
      psql "$PINTAG_RESTORE_DB_URL" -v ON_ERROR_STOP=1 -X -c \
        "INSERT INTO auth.users (id) SELECT DISTINCT \"$col\" FROM $tbl WHERE \"$col\" IS NOT NULL ON CONFLICT (id) DO NOTHING;"
  done
  rm -f "$PD"
  echo "-- post-data (constraints incl. FKs, indexes) — FKs validate against seeded ids"
  pg_restore --no-owner --no-privileges --exit-on-error \
    --section=post-data --dbname "$PINTAG_RESTORE_DB_URL" "$DUMP"
else
  # Real-disaster path: unchanged single-pass restore into the true target.
  pg_restore --no-owner --no-privileges --clean --if-exists \
    --dbname "$PINTAG_RESTORE_DB_URL" "$DUMP"
fi

if $DO_STORAGE; then
  echo "== Restoring Storage objects from the R2 pool by this backup's manifest =="
  echo "   (rclone copy pool -> property-images, names preserved; see DR doc §Restore)"
  # rclone copyto per manifest row; requires R2 read + Supabase Storage write creds.
  # Left as an explicit operator step in the runbook to avoid an unattended
  # bucket write from a script; see docs/BACKUP_AND_DISASTER_RECOVERY.md.
fi

echo "== Restore validation =="
REPORT="$(psql "$PINTAG_RESTORE_DB_URL" -v ON_ERROR_STOP=1 -X -Atq -f "$SCRIPT_DIR/restore-validation.sql")"
echo "$REPORT"

# Compare to expected counts recorded at backup time (metadata/backup.json).
META="$BACKUP/metadata/backup.json"
get_live() { awk -F'|' -v k="$1" '$1==k{print $2}' <<<"$REPORT"; }
# Presence check (non-count metrics: RLS policies / functions must be > 0).
pass_line() { # name  live
  local name="$1" live="$2"
  [[ -n "$live" && "$live" != "0" && "$live" != "n/a" ]] && echo "✓ $name ($live)" || echo "✗ $name ($live)"
}
# Expected row count for a table, read from backup.json's NESTED counts:
#   { "counts": { "<table>": {"live":N,"backup":M,"ok":bool}, ... } }
# Prints the integer, or "MISSING" when metadata/the count is unavailable, so the
# caller fails closed. The comparison uses the backup's captured row count.
expected_count() { # table
  [[ -f "$META" ]] || { echo MISSING; return; }
  python3 - "$META" "$1" <<'PY'
import json, sys
try:
    m = json.load(open(sys.argv[1]))
    v = (m.get("counts") or {}).get(sys.argv[2]) or {}
    n = v.get("backup")
    print(n if isinstance(n, int) else "MISSING")
except Exception:
    print("MISSING")
PY
}
# Strict row-count check: EXACT restored-vs-backup, and a MISSING expected count
# FAILS. No "non-zero" fallback — a restore that is short or unverifiable fails.
pass_db() { # name  live
  local name="$1" live="$2" want; want="$(expected_count "$name")"
  if [[ "$want" == MISSING ]]; then
    echo "✗ $name (no expected count in backup metadata — cannot verify)"
  elif [[ "$live" == "$want" ]]; then
    echo "✓ $name ($live)"
  else
    echo "✗ $name (restored $live, expected $want)"
  fi
}

echo
echo "================= PINTAG RESTORE REPORT ================="
DB_OK=1
for t in properties parties owners contacts leads lead_events; do
  line="$(pass_db "$t" "$(get_live "$t")")"; echo "$line"; [[ "$line" == ✗* ]] && DB_OK=0
done
STO="$(pass_line storage_objects "$(get_live storage_objects)")"; echo "$STO"
SEC_RLS="$(pass_line rls_policies_present "$(get_live rls_policies_present)")"; echo "$SEC_RLS"
SEC_FN="$(pass_line functions_present "$(get_live functions_present)")"; echo "$SEC_FN"
echo "migration_head: $(get_live migration_head)"
echo "--------------------------------------------------------"
[[ $DB_OK == 1 ]] && echo "✓ Database restored"      || echo "✗ Database restored"
[[ "$STO" == ✓* ]] && echo "✓ Storage restored"       || echo "• Storage restored (run with --storage / operator step)"
[[ $DB_OK == 1 ]] && echo "✓ Relationships restored"  || echo "✗ Relationships restored"
{ [[ "$SEC_RLS" == ✓* ]] && [[ "$SEC_FN" == ✓* ]]; } && echo "✓ Security restored" || echo "✗ Security restored"
if [[ $DB_OK == 1 && "$SEC_RLS" == ✓* && "$SEC_FN" == ✓* ]]; then
  echo "✓ Ready for production (verify storage + re-provision admin per single-admin runbook)"
else
  echo "✗ NOT ready — investigate the ✗ lines above."; exit 1
fi
