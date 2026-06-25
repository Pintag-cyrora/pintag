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
# Available suites: auth, rls, edge_functions, storage, ssrf, xss,
#                   rate_limiting, headers
#
# Required environment variables:
#   SUPABASE_URL        https://xxxxxxxx.supabase.co
#   SUPABASE_ANON_KEY   eyJ...
#
# Optional (enables additional tests):
#   ADMIN_EMAIL         admin@pintag.io
#   ADMIN_PASSWORD      <admin password>
#   TEST_USER_EMAIL     agent@example.com
#   TEST_USER_PASSWORD  <test user password>
#   SITE_URL            https://pintag.io   (enables header checks)
#
# Exit code: 0 = all tests passed, 1 = one or more failures
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
cd "$(dirname "$0")/../.."  # project root

# ── Load helpers ─────────────────────────────────────────────────────────────
# shellcheck source=tests/security/lib/helpers.sh
source tests/security/lib/helpers.sh

# ── Validate required env vars ────────────────────────────────────────────────
require_env SUPABASE_URL SUPABASE_ANON_KEY

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

# ── Load all suites ───────────────────────────────────────────────────────────
for f in tests/security/suites/*.sh; do
  # shellcheck source=/dev/null
  source "$f"
done

# ── Determine which suites to run ─────────────────────────────────────────────
ALL_SUITES=(auth rls edge_functions storage ssrf xss rate_limiting headers)

if [[ $# -gt 0 ]]; then
  REQUESTED=("$@")
else
  REQUESTED=("${ALL_SUITES[@]}")
fi

# ── Print header ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Pintag Security Regression Suite     ║${RESET}"
echo -e "${BOLD}╚════════════════════════════════════════╝${RESET}"
echo -e "${DIM}Target: ${SUPABASE_URL}${RESET}"
[[ -n "${SITE_URL:-}" ]] && echo -e "${DIM}Site:   ${SITE_URL}${RESET}"
echo -e "${DIM}Admin:  ${ADMIN_JWT:+authenticated}${ADMIN_JWT:-not set}${RESET}"
echo -e "${DIM}User:   ${TEST_USER_JWT:+authenticated}${TEST_USER_JWT:-not set}${RESET}"

# ── Run suites ────────────────────────────────────────────────────────────────
for suite in "${REQUESTED[@]}"; do
  case "$suite" in
    auth)           run_auth_tests ;;
    rls)            run_rls_tests ;;
    edge_functions) run_edge_function_tests ;;
    storage)        run_storage_tests ;;
    ssrf)           run_ssrf_tests ;;
    xss)            run_xss_tests ;;
    rate_limiting)  run_rate_limiting_tests ;;
    headers)        run_headers_tests ;;
    *)
      echo -e "${YELLOW}Unknown suite: $suite${RESET}"
      echo "Available: ${ALL_SUITES[*]}"
      ;;
  esac
done

# ── Final report ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════${RESET}"
echo -e "${BOLD} Summary${RESET}"
echo -e "${BOLD}════════════════════════════════════════${RESET}"

for suite in "${REQUESTED[@]}"; do
  if [[ -n "${SUITE_RESULTS[$suite]+_}" ]]; then
    read -r sp sf <<< "${SUITE_RESULTS[$suite]}"
    if [[ "$sf" -eq 0 ]]; then
      printf " ${GREEN}PASS${RESET}  %-20s ${DIM}(%d passed)${RESET}\n" "$suite" "$sp"
    else
      printf " ${RED}FAIL${RESET}  %-20s ${DIM}(%d passed, %d failed)${RESET}\n" "$suite" "$sp" "$sf"
    fi
  fi
done

echo ""
echo -e " ${BOLD}Overall:${RESET}"
echo -e "   ${GREEN}Passed:${RESET}  $TOTAL_PASS"
echo -e "   ${RED}Failed:${RESET}  $TOTAL_FAIL"
[[ $TOTAL_SKIP -gt 0 ]] && echo -e "   ${YELLOW}Skipped:${RESET} $TOTAL_SKIP ${DIM}(set env vars for full coverage)${RESET}"

if [[ -n "$FAILURE_LOG" ]]; then
  echo ""
  echo -e "${BOLD}${RED}Failures:${RESET}"
  echo "$FAILURE_LOG"
fi

echo -e "${BOLD}════════════════════════════════════════${RESET}"

# ── Exit code ─────────────────────────────────────────────────────────────────
if [[ $TOTAL_FAIL -gt 0 ]]; then
  exit 1
else
  exit 0
fi
