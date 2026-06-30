#!/usr/bin/env bash
# Pintag Security Framework — Test Manifest Generator
# ─────────────────────────────────────────────────────────────────────────────
# Prints a static manifest showing every suite, its purpose, the resources it
# covers, and a cross-reference showing which resources have no test coverage.
#
# Usage:
#   bash tests/security/generate-manifest.sh          # human-readable
#   bash tests/security/generate-manifest.sh --json   # JSON output
#
# Reads: tests/security/resources.sh  (resource registry)
#        tests/security/suites/*.sh   (@suite / @purpose / @covers / @needs / @runtime tags)
#
# Does NOT run any tests; no network connections are made.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/../.."

source tests/security/resources.sh

JSON_MODE=0
[[ "${1:-}" == "--json" ]] && JSON_MODE=1

# ── Colour codes (only when writing to a terminal) ───────────────────────────
if [[ -t 1 && $JSON_MODE -eq 0 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; DIM=''; RESET=''
fi

# ── Parse suite metadata ──────────────────────────────────────────────────────
declare -A SUITE_DISPLAY    # name → display name
declare -A SUITE_PURPOSE
declare -A SUITE_COVERS
declare -A SUITE_NEEDS
declare -A SUITE_RUNTIME
declare -A SUITE_FILE
SUITE_ORDER=()

for f in tests/security/suites/*.sh; do
  [[ -f "$f" ]] || continue
  local_name=$(basename "$f" .sh | sed 's/^[0-9]*_//')
  SUITE_ORDER+=("$local_name")
  SUITE_FILE["$local_name"]="$f"

  SUITE_DISPLAY["$local_name"]=$(grep -m1 '^# @suite' "$f" \
    | sed 's/^# @suite *//' || echo "$local_name")
  SUITE_PURPOSE["$local_name"]=$(grep -m1 '^# @purpose' "$f" \
    | sed 's/^# @purpose *//' || echo "—")
  SUITE_COVERS["$local_name"]=$(grep -m1 '^# @covers' "$f" \
    | sed 's/^# @covers *//' || echo "")
  SUITE_NEEDS["$local_name"]=$(grep -m1 '^# @needs' "$f" \
    | sed 's/^# @needs *//' || echo "—")
  SUITE_RUNTIME["$local_name"]=$(grep -m1 '^# @runtime' "$f" \
    | sed 's/^# @runtime *//' || echo "—")
done

# ── Build coverage maps ───────────────────────────────────────────────────────
# For each resource, collect the suites that list it in @covers
declare -A FN_SUITES
declare -A TABLE_SUITES
declare -A BUCKET_SUITES
declare -A HEADER_SUITES

for fn in "${RESOURCE_FNS[@]}";     do FN_SUITES["$fn"]="";     done
for tbl in "${RESOURCE_TABLES[@]}"; do TABLE_SUITES["$tbl"]="";  done
for bkt in "${RESOURCE_BUCKETS[@]}"; do BUCKET_SUITES["$bkt"]=""; done
for hdr in "${RESOURCE_HEADERS[@]}"; do HEADER_SUITES["$hdr"]=""; done

for suite in "${SUITE_ORDER[@]}"; do
  covers="${SUITE_COVERS[$suite]:-}"
  for token in $covers; do
    type="${token%%:*}"
    name="${token#*:}"
    case "$type" in
      fn)     [[ -v "FN_SUITES[$name]" ]]     && FN_SUITES["$name"]+="${suite} " ;;
      table)  [[ -v "TABLE_SUITES[$name]" ]]  && TABLE_SUITES["$name"]+="${suite} " ;;
      bucket) [[ -v "BUCKET_SUITES[$name]" ]] && BUCKET_SUITES["$name"]+="${suite} " ;;
      header) [[ -v "HEADER_SUITES[$name]" ]] && HEADER_SUITES["$name"]+="${suite} " ;;
    esac
  done
done

# ── Helpers ───────────────────────────────────────────────────────────────────
git_commit=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# ── JSON output ───────────────────────────────────────────────────────────────
if [[ $JSON_MODE -eq 1 ]]; then
  python3 - <<PYEOF
import json, sys

suites = []
$(for suite in "${SUITE_ORDER[@]}"; do
  echo "suites.append({'name': '$(echo "${SUITE_DISPLAY[$suite]}" | sed "s/'/\\\\'/g")', 'key': '$suite', 'purpose': '$(echo "${SUITE_PURPOSE[$suite]}" | sed "s/'/\\\\'/g")', 'covers': '${SUITE_COVERS[$suite]:-}'.split(), 'needs': '$(echo "${SUITE_NEEDS[$suite]}" | sed "s/'/\\\\'/g")', 'runtime': '${SUITE_RUNTIME[$suite]}'})"
done)

coverage = {
  'edge_functions':  {fn:  sorted(set('${FN_SUITES[$fn]:-}'.split()))  for fn  in '${RESOURCE_FNS[*]}'.split()},
  'tables':          {tbl: sorted(set('${TABLE_SUITES[$tbl]:-}'.split())) for tbl in '${RESOURCE_TABLES[*]}'.split()},
  'storage_buckets': {bkt: sorted(set('${BUCKET_SUITES[$bkt]:-}'.split())) for bkt in '${RESOURCE_BUCKETS[*]}'.split()},
  'headers':         {hdr: sorted(set('${HEADER_SUITES[$hdr]:-}'.split())) for hdr in '${RESOURCE_HEADERS[*]}'.split()},
}

manifest = {
  'framework_version': '${FRAMEWORK_VERSION}',
  'generated_at': '${generated_at}',
  'git_commit': '${git_commit}',
  'suite_count': len(suites),
  'suites': suites,
  'resource_coverage': coverage,
}
print(json.dumps(manifest, indent=2))
PYEOF
  exit 0
fi

# ── Text output ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Pintag Security Framework — Test Manifest                   ║${RESET}"
printf  "${BOLD}║   v%-59s║${RESET}\n" "${FRAMEWORK_VERSION}  (commit: ${git_commit})"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════════╝${RESET}"
echo ""

# Suites
echo -e "${BOLD}Suites (${#SUITE_ORDER[@]}):${RESET}"
echo -e "  ${DIM}$(printf '%-6s  %-20s  %-12s  %s' 'KEY' 'DISPLAY NAME' 'RUNTIME' 'PURPOSE')${RESET}"
echo -e "  ${DIM}$(printf '%-6s  %-20s  %-12s  %s' '------' '--------------------' '--------' '-----------')${RESET}"
for suite in "${SUITE_ORDER[@]}"; do
  printf "  %-6s  ${CYAN}%-20s${RESET}  ${DIM}%-12s${RESET}  %s\n" \
    "$suite" \
    "${SUITE_DISPLAY[$suite]}" \
    "${SUITE_RUNTIME[$suite]}" \
    "${SUITE_PURPOSE[$suite]}"
done

echo ""
echo -e "${BOLD}Credential Requirements:${RESET}"
echo -e "  ${DIM}none${RESET}                  — anonymous tests only; no credentials needed"
for suite in "${SUITE_ORDER[@]}"; do
  needs="${SUITE_NEEDS[$suite]:-none}"
  [[ "$needs" == "none" ]] && continue
  printf "  %-22s — %s\n" "${SUITE_DISPLAY[$suite]}" "$needs"
done

echo ""
echo -e "${BOLD}Resource Coverage:${RESET}"
echo ""

# Edge Functions
echo -e "  ${BOLD}Edge Functions:${RESET}"
any_uncovered=0
for fn in "${RESOURCE_FNS[@]}"; do
  covered="${FN_SUITES[$fn]:-}"
  if [[ -n "$covered" ]]; then
    printf "    ${GREEN}✓${RESET}  %-35s  ${DIM}%s${RESET}\n" "fn:${fn}" "tested by: ${covered%% }"
  else
    printf "    ${RED}✗${RESET}  %-35s  ${YELLOW}NO TESTS${RESET}\n" "fn:${fn}"
    any_uncovered=1
  fi
done

echo ""
echo -e "  ${BOLD}Database Tables:${RESET}"
for tbl in "${RESOURCE_TABLES[@]}"; do
  covered="${TABLE_SUITES[$tbl]:-}"
  if [[ -n "$covered" ]]; then
    printf "    ${GREEN}✓${RESET}  %-35s  ${DIM}%s${RESET}\n" "table:${tbl}" "tested by: ${covered%% }"
  else
    printf "    ${RED}✗${RESET}  %-35s  ${YELLOW}NO TESTS${RESET}\n" "table:${tbl}"
    any_uncovered=1
  fi
done

echo ""
echo -e "  ${BOLD}Storage Buckets:${RESET}"
for bkt in "${RESOURCE_BUCKETS[@]}"; do
  covered="${BUCKET_SUITES[$bkt]:-}"
  if [[ -n "$covered" ]]; then
    printf "    ${GREEN}✓${RESET}  %-35s  ${DIM}%s${RESET}\n" "bucket:${bkt}" "tested by: ${covered%% }"
  else
    printf "    ${RED}✗${RESET}  %-35s  ${YELLOW}NO TESTS${RESET}\n" "bucket:${bkt}"
    any_uncovered=1
  fi
done

echo ""
echo -e "  ${BOLD}Security Headers:${RESET}"
for hdr in "${RESOURCE_HEADERS[@]}"; do
  covered="${HEADER_SUITES[$hdr]:-}"
  if [[ -n "$covered" ]]; then
    printf "    ${GREEN}✓${RESET}  %-35s  ${DIM}%s${RESET}\n" "header:${hdr}" "tested by: ${covered%% }"
  else
    printf "    ${RED}✗${RESET}  %-35s  ${YELLOW}NO TESTS (add to Suite 08 or a new suite)${RESET}\n" "header:${hdr}"
    any_uncovered=1
  fi
done

echo ""
if [[ $any_uncovered -eq 1 ]]; then
  echo -e "${YELLOW}WARNING: one or more resources have no test coverage.${RESET}"
  echo -e "${DIM}Add the resource to an existing suite's @covers list, or create a new suite.${RESET}"
else
  echo -e "${GREEN}All registered resources have test coverage.${RESET}"
fi

echo ""
echo -e "${DIM}Generated: ${generated_at}  |  Framework v${FRAMEWORK_VERSION}  |  commit ${git_commit}${RESET}"
echo ""
