#!/usr/bin/env bash
# Shared utilities for the Pintag security test suite.
# Source this file; do not execute it directly.

# ── Colour codes ──────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; DIM=''; RESET=''
fi

# ── Global counters ───────────────────────────────────────────────────────────
TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
declare -A SUITE_RESULTS   # SUITE_RESULTS[name]="pass_count fail_count"

# Per-suite counters (reset by suite_start)
SUITE_PASS=0
SUITE_FAIL=0
SUITE_SKIP=0
CURRENT_SUITE=""

# Failure log (accumulated across suites for final report)
FAILURE_LOG=""

# ── Suite bookkeeping ─────────────────────────────────────────────────────────

suite_start() {
  CURRENT_SUITE="$1"
  SUITE_PASS=0; SUITE_FAIL=0; SUITE_SKIP=0
  echo -e "\n${BOLD}${CYAN}▸ $1${RESET}"
}

suite_end() {
  TOTAL_PASS=$((TOTAL_PASS + SUITE_PASS))
  TOTAL_FAIL=$((TOTAL_FAIL + SUITE_FAIL))
  TOTAL_SKIP=$((TOTAL_SKIP + SUITE_SKIP))
  SUITE_RESULTS["$CURRENT_SUITE"]="$SUITE_PASS $SUITE_FAIL"
  if [[ $SUITE_FAIL -eq 0 ]]; then
    echo -e "  ${GREEN}✓${RESET} ${DIM}$SUITE_PASS passed, $SUITE_SKIP skipped${RESET}"
  else
    echo -e "  ${RED}✗${RESET} ${RED}$SUITE_FAIL failed${RESET}${DIM}, $SUITE_PASS passed, $SUITE_SKIP skipped${RESET}"
  fi
}

# ── Core assertion ────────────────────────────────────────────────────────────
# check LABEL EXPECTED_PATTERN ACTUAL
#   EXPECTED_PATTERN is an ERE applied to ACTUAL via grep -qE
check() {
  local label="$1" pattern="$2" actual="$3"
  if echo "$actual" | grep -qE "$pattern"; then
    echo -e "    ${GREEN}PASS${RESET}  $label"
    SUITE_PASS=$((SUITE_PASS+1))
  else
    echo -e "    ${RED}FAIL${RESET}  $label"
    echo -e "          ${DIM}expect:${RESET} $pattern"
    printf  "          ${DIM}actual:${RESET} %.160s\n" "$actual"
    SUITE_FAIL=$((SUITE_FAIL+1))
    local entry
    printf -v entry "  [%s] %s\n    expect: %s\n    actual: %.120s\n" \
      "$CURRENT_SUITE" "$label" "$pattern" "$actual"
    FAILURE_LOG+="$entry"$'\n'
  fi
}

# check_status LABEL EXPECTED_HTTP_CODE ACTUAL_HTTP_CODE
check_status() {
  check "$1" "^${2}$" "$3"
}

# check_empty LABEL ACTUAL_BODY  — asserts the body is exactly []
check_empty() {
  check "$1 → []" '^\[\]$' "$2"
}

# info — print an informational line (not a test result)
info() {
  echo -e "    ${DIM}INFO${RESET}  $1"
}

# skip LABEL REASON
skip() {
  echo -e "    ${YELLOW}SKIP${RESET}  $1 — $2"
  SUITE_SKIP=$((SUITE_SKIP+1))
  TOTAL_SKIP=$((TOTAL_SKIP+1))
}

# fail_hard LABEL REASON — fail without a pattern check
fail_hard() {
  echo -e "    ${RED}FAIL${RESET}  $1"
  echo -e "          ${DIM}$2${RESET}"
  SUITE_FAIL=$((SUITE_FAIL+1))
  FAILURE_LOG+="  [$CURRENT_SUITE] $1: $2"$'\n\n'
}

# ── JWT acquisition ───────────────────────────────────────────────────────────
# acquire_jwt EMAIL PASSWORD — prints access_token or empty string on failure
acquire_jwt() {
  local email="$1" password="$2"
  local resp
  resp=$(curl -sf -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${email}\",\"password\":\"${password}\"}" 2>/dev/null)
  echo "$resp" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4
}

# ── Curl wrappers ─────────────────────────────────────────────────────────────
# All wrappers return  BODY\nHTTP_STATUS  so callers can split on the last line.

# api_get PATH [JWT]
api_get() {
  local path="$1" jwt="${2:-}"
  local auth_header
  [[ -n "$jwt" ]] && auth_header="-H 'Authorization: Bearer $jwt'" || auth_header=""
  curl -s -w "\n%{http_code}" \
    "${SUPABASE_URL}/rest/v1/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"}
}

# api_post PATH BODY [JWT]
api_post() {
  local path="$1" body="$2" jwt="${3:-}"
  curl -s -w "\n%{http_code}" -X POST \
    "${SUPABASE_URL}/rest/v1/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"} \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d "$body"
}

# api_patch PATH BODY [JWT]
api_patch() {
  local path="$1" body="$2" jwt="${3:-}"
  curl -s -w "\n%{http_code}" -X PATCH \
    "${SUPABASE_URL}/rest/v1/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"} \
    -H "Content-Type: application/json" \
    -d "$body"
}

# api_delete PATH [JWT]
api_delete() {
  local path="$1" jwt="${2:-}"
  curl -s -w "\n%{http_code}" -X DELETE \
    "${SUPABASE_URL}/rest/v1/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"}
}

# fn_post FUNCTION_NAME BODY [JWT]
fn_post() {
  local fn="$1" body="$2" jwt="${3:-}"
  curl -s -w "\n%{http_code}" -X POST \
    "${SUPABASE_URL}/functions/v1/${fn}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"} \
    -H "Content-Type: application/json" \
    -d "$body"
}

# storage_upload BUCKET PATH CONTENT_TYPE BODY [JWT]
storage_upload() {
  local bucket="$1" path="$2" ctype="$3" body="$4" jwt="${5:-}"
  curl -s -w "\n%{http_code}" -X POST \
    "${SUPABASE_URL}/storage/v1/object/${bucket}/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"} \
    -H "Content-Type: ${ctype}" \
    --data-binary "$body"
}

# storage_delete BUCKET PATH [JWT]
storage_delete() {
  local bucket="$1" path="$2" jwt="${3:-}"
  curl -s -w "\n%{http_code}" -X DELETE \
    "${SUPABASE_URL}/storage/v1/object/${bucket}/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"}
}

# ── Response splitters ────────────────────────────────────────────────────────
# resp_body RESPONSE — everything before the last line
resp_body() { echo "$1" | head -n -1; }

# resp_status RESPONSE — the last line (HTTP status code)
resp_status() { echo "$1" | tail -1; }

# ── Env validation ────────────────────────────────────────────────────────────
require_env() {
  local missing=()
  for var in "$@"; do
    [[ -z "${!var:-}" ]] && missing+=("$var")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${RED}ERROR: Required environment variables not set: ${missing[*]}${RESET}"
    echo    "       See tests/security/README.md for setup instructions."
    exit 1
  fi
}

# ── Cleanup registry ──────────────────────────────────────────────────────────
# Register resources created during tests for cleanup on EXIT.
CLEANUP_LISTING_IDS=()
CLEANUP_STORAGE_PATHS=()  # "bucket/path" strings

register_cleanup_listing() { CLEANUP_LISTING_IDS+=("$1"); }
register_cleanup_storage() { CLEANUP_STORAGE_PATHS+=("$1"); }

run_cleanup() {
  [[ ${#CLEANUP_LISTING_IDS[@]} -eq 0 && ${#CLEANUP_STORAGE_PATHS[@]} -eq 0 ]] && return
  echo -e "\n${DIM}Cleaning up test data...${RESET}"
  for id in "${CLEANUP_LISTING_IDS[@]}"; do
    api_delete "properties?id=eq.${id}" "${ADMIN_JWT:-}" >/dev/null 2>&1
  done
  for path in "${CLEANUP_STORAGE_PATHS[@]}"; do
    local bucket="${path%%/*}"
    local objpath="${path#*/}"
    storage_delete "$bucket" "$objpath" "${ADMIN_JWT:-}" >/dev/null 2>&1
  done
}
