#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Pintag Security Regression Suite
# Usage:
#   bash tests/security/run.sh [suite...]
#
# Run all suites:
#   bash tests/security/run.sh
#
# Run specific suites:
#   bash tests/security/run.sh auth rls storage
#
# New suites are auto-discovered from tests/security/suites/*.sh — no changes
# to this file are needed when adding a new suite file.
#
# Required environment variables:
#   SUPABASE_URL        https://xxxxxxxx.supabase.co
#   SUPABASE_ANON_KEY   eyJ...
#
# Optional (enables additional tests):
#   APP_ENV             local|staging  (default: local; "production" is refused)
#   ADMIN_EMAIL         admin@pintag.io
#   ADMIN_PASSWORD      <admin password>
#   TEST_USER_EMAIL     agent@example.com
#   TEST_USER_PASSWORD  <test user password>
#   SITE_URL            https://pintag.io   (enables header checks)
#   DEBUG               1                   (print request/response bodies)
#
# Exit code: 0 = all tests passed, 1 = one or more failures
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
cd "$(dirname "$0")/../.."  # project root

# ── Load helpers ─────────────────────────────────────────────────────────────
# shellcheck source=tests/security/lib/helpers.sh
source tests/security/lib/helpers.sh

# ── Environment safety ────────────────────────────────────────────────────────
check_app_env

# ── Validate required env vars ────────────────────────────────────────────────
require_env SUPABASE_URL SUPABASE_ANON_KEY

# ── Auto-discover suites ──────────────────────────────────────────────────────
# Suite files are named NN_name.sh; suite name is derived from the filename.
# The expected function name is run_<name>_tests.
ALL_SUITES=()
declare -A SUITE_FUNC

for f in tests/security/suites/*.sh; do
  [[ -f "$f" ]] || continue
  # shellcheck source=/dev/null
  source "$f"
  local_name=$(basename "$f" .sh | sed 's/^[0-9]*_//')
  ALL_SUITES+=("$local_name")
  SUITE_FUNC["$local_name"]="run_${local_name}_tests"
done

# ── Acquire JWTs ──────────────────────────────────────────────────────────────
ADMIN_JWT=""
TEST_USER_JWT=""

if [[ -n "${ADMIN_EMAIL:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
  echo -e "${DIM}Authenticating as admin (${ADMIN_EMAIL})...${RESET}"
  ADMIN_JWT=$(acquire_jwt "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  if [[ -z "$ADMIN_JWT" ]]; then
    echo -e "${YELLOW}WARNING: Admin login failed — admin-only tests will be skipped.${RESET}"
    echo -e "${DIM}Check ADMIN_EMAIL and ADMIN_PASSWORD.${RESET}"
  else
    echo -e "${GREEN}✓${RESET} ${DIM}Admin authenticated${RESET}"
  fi
fi

if [[ -n "${TEST_USER_EMAIL:-}" && -n "${TEST_USER_PASSWORD:-}" ]]; then
  echo -e "${DIM}Authenticating as test user (${TEST_USER_EMAIL})...${RESET}"
  TEST_USER_JWT=$(acquire_jwt "$TEST_USER_EMAIL" "$TEST_USER_PASSWORD")
  if [[ -z "$TEST_USER_JWT" ]]; then
    echo -e "${YELLOW}WARNING: Test user login failed — cross-user tests will be skipped.${RESET}"
  else
    echo -e "${GREEN}✓${RESET} ${DIM}Test user authenticated${RESET}"
  fi
fi

export ADMIN_JWT TEST_USER_JWT

# ── Register cleanup on exit ──────────────────────────────────────────────────
trap run_cleanup EXIT

# ── Determine which suites to run ─────────────────────────────────────────────
if [[ $# -gt 0 ]]; then
  REQUESTED=("$@")
else
  REQUESTED=("${ALL_SUITES[@]}")
fi

# ── Print run banner ──────────────────────────────────────────────────────────
print_run_banner "${REQUESTED[@]}"

# ── Run suites ────────────────────────────────────────────────────────────────
for suite in "${REQUESTED[@]}"; do
  func="${SUITE_FUNC[$suite]:-}"
  if [[ -n "$func" ]] && declare -f "$func" >/dev/null 2>&1; then
    "$func"
  else
    echo -e "${YELLOW}Unknown suite: $suite${RESET}"
    echo "Available: ${ALL_SUITES[*]}"
  fi
done

# ── Final report ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════${RESET}"
echo -e "${BOLD} Summary${RESET}"
echo -e "${BOLD}════════════════════════════════════════${RESET}"

for suite in "${REQUESTED[@]}"; do
  if [[ -n "${SUITE_RESULTS[$suite]+_}" ]]; then
    read -r sp sf ss sdms <<< "${SUITE_RESULTS[$suite]}"
    sdur=$(ms_to_sec "${sdms:-0}")
    if [[ "$sf" -eq 0 ]]; then
      printf " ${GREEN}PASS${RESET}  %-20s ${DIM}(%d passed, %d skipped, %ss)${RESET}\n" \
        "$suite" "$sp" "${ss:-0}" "$sdur"
    else
      printf " ${RED}FAIL${RESET}  %-20s ${DIM}(%d passed, %d failed, %d skipped, %ss)${RESET}\n" \
        "$suite" "$sp" "$sf" "${ss:-0}" "$sdur"
    fi
  fi
done

echo ""
echo -e " ${BOLD}Overall:${RESET}"
echo -e "   ${GREEN}Passed:${RESET}   $TOTAL_PASS"
echo -e "   ${RED}Failed:${RESET}   $TOTAL_FAIL"
[[ $TOTAL_SKIP -gt 0 ]] && \
  echo -e "   ${YELLOW}Skipped:${RESET}  $TOTAL_SKIP ${DIM}(set env vars for full coverage)${RESET}"
echo -e "   ${DIM}Requests: $TOTAL_REQUESTS${RESET}"
[[ $PERF_WARNINGS -gt 0 ]] && \
  echo -e "   ${YELLOW}Perf:${RESET}     $PERF_WARNINGS warning(s) (see above for details)"

if [[ -n "$FAILURE_LOG" ]]; then
  echo ""
  echo -e "${BOLD}${RED}Failures:${RESET}"
  echo "$FAILURE_LOG"
fi

echo ""
generate_reports
generate_coverage_report
compare_perf_history

echo -e "${BOLD}════════════════════════════════════════${RESET}"

# ── Exit code ─────────────────────────────────────────────────────────────────
if [[ $TOTAL_FAIL -gt 0 ]]; then
  exit 1
else
  exit 0
fi
