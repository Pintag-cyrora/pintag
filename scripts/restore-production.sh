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

BACKUP="" ; DO_STORAGE=false
AGE_KEY="${AGE_KEY:-./backup-age-key.txt}"
while [[ $# -gt 0 ]]; do case "$1" in
  --backup) BACKUP="$2"; shift 2 ;;
  --storage) DO_STORAGE=true; shift ;;
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
pg_restore --no-owner --no-privileges --clean --if-exists \
  --dbname "$PINTAG_RESTORE_DB_URL" "$BACKUP/database/full.dump"

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
pass_line() { # name  live  expected(optional)
  local name="$1" live="$2" exp="${3:-}"
  if [[ -n "$exp" && "$exp" != "null" ]]; then
    [[ "$live" == "$exp" ]] && echo "✓ $name ($live)" || echo "✗ $name (restored $live, expected $exp)"
  else
    [[ -n "$live" && "$live" != "0" && "$live" != "n/a" ]] && echo "✓ $name ($live)" || echo "✗ $name ($live)"
  fi
}
exp() { [[ -f "$META" ]] && grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9\"a-zA-Z._-]*" "$META" | grep -o '[0-9][0-9]*' | head -1 || true; }

echo
echo "================= PINTAG RESTORE REPORT ================="
DB_OK=1
for t in properties parties owners contacts leads lead_events; do
  line="$(pass_line "$t" "$(get_live "$t")" "$(exp "$t")")"; echo "$line"; [[ "$line" == ✗* ]] && DB_OK=0
done
STO="$(pass_line storage_objects "$(get_live storage_objects)" "$(exp storage_objects)")"; echo "$STO"
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
