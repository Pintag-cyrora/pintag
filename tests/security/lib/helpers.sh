#!/usr/bin/env bash
# Shared utilities for the Pintag security test suite.
# Source this file; do not execute it directly.
# Requires bash 4+ (associative arrays).

# ── bash version guard ────────────────────────────────────────────────────────
if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
  echo "ERROR: bash 4+ required (found ${BASH_VERSION}). On macOS: brew install bash"
  exit 1
fi

# ── Colour codes ──────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; DIM=''; RESET=''
fi

# ── Environment safety check ──────────────────────────────────────────────────
check_app_env() {
  local env="${APP_ENV:-}"
  if [[ "$env" == "production" ]]; then
    echo "SECURITY TESTS REFUSED ON PRODUCTION"
    exit 1
  fi
  if [[ -z "$env" ]]; then
    echo -e "${YELLOW}WARNING: APP_ENV not set. Assuming local. Set APP_ENV=local or APP_ENV=staging.${RESET}"
  elif [[ "$env" != "local" && "$env" != "staging" ]]; then
    echo -e "${YELLOW}WARNING: APP_ENV='${env}' is not 'local' or 'staging'. Proceeding with caution.${RESET}"
  fi
}

# ── UUID and timing ───────────────────────────────────────────────────────────
new_uuid() {
  local result
  result=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null) \
    && { echo "$result"; return; }
  [[ -r /proc/sys/kernel/random/uuid ]] \
    && { cat /proc/sys/kernel/random/uuid; return; }
  # Fallback: hex-RANDOM (not cryptographic, but unique enough for test IDs)
  printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \
    $RANDOM $RANDOM $RANDOM $(( (RANDOM & 0x0fff) | 0x4000 )) \
    $(( (RANDOM & 0x3fff) | 0x8000 )) $RANDOM $RANDOM $RANDOM
}

now_ms() {
  local result
  result=$(date +%s%3N 2>/dev/null)
  if [[ "$result" =~ ^[0-9]{13}$ ]]; then
    echo "$result"
  else
    # macOS fallback (date lacks %3N)
    echo $(( $(date +%s) * 1000 ))
  fi
}

ms_to_sec() {
  local ms="${1:-0}"
  printf "%d.%03d" "$((ms/1000))" "$((ms%1000))"
}

# Set run globals at source time (before any I/O that could fail)
RUN_ID=$(new_uuid)
RUN_ID_SHORT="${RUN_ID:0:8}"
RUN_START_MS=$(now_ms)
LAST_CHECK_MS=$RUN_START_MS
SUITE_START_MS=$RUN_START_MS

# ── Request logging ───────────────────────────────────────────────────────────
TOTAL_REQUESTS=0
PERF_WARNINGS=0
LOG_DIR="tests/security/output"
REQUEST_LOG="${LOG_DIR}/requests-${RUN_ID_SHORT}.log"
mkdir -p "${LOG_DIR}/reports"

_log_request() {
  local method="$1" url="$2" status="$3" duration_ms="$4"
  TOTAL_REQUESTS=$((TOTAL_REQUESTS+1))
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%dms\n" \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    "${CURRENT_SUITE:-?}" \
    "${CURRENT_TEST:-?}" \
    "$method" "$url" "$status" "$duration_ms" \
    >> "$REQUEST_LOG"
  if [[ "${DEBUG:-}" == "1" ]]; then
    echo -e "    ${DIM}[req] ${method} ${url} → ${status} (${duration_ms}ms)${RESET}" >&2
  fi
}

_check_perf() {
  local url="$1" duration_ms="$2"
  local budget=500
  if echo "$url" | grep -q "/functions/v1/"; then
    budget=2000
  elif echo "$url" | grep -q "/storage/v1/"; then
    budget=5000
  fi
  if [[ $duration_ms -gt $budget ]]; then
    echo -e "    ${YELLOW}PERF${RESET}  ${url##*/} took ${duration_ms}ms (budget: ${budget}ms)"
    PERF_WARNINGS=$((PERF_WARNINGS+1))
  fi
}

# ── HTTP with retry ───────────────────────────────────────────────────────────
# Usage: http_request METHOD URL [curl_args...]
# Returns: BODY<newline>HTTP_STATUS
# Never retries: 401 403 404 422 (and any other 4xx except 429)
# Retries with exponential backoff: 000 429 500 502 503 504
http_request() {
  local method="$1" url="$2"
  shift 2
  local attempt=0 max_retries=3
  local response status body start_ms end_ms duration_ms

  while true; do
    start_ms=$(now_ms)
    response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" "$@" 2>/dev/null)
    end_ms=$(now_ms)
    duration_ms=$(( end_ms - start_ms ))

    status=$(echo "$response" | tail -1)
    body=$(echo "$response" | head -n -1)

    _log_request "$method" "$url" "${status:-000}" "$duration_ms"
    _check_perf "$url" "$duration_ms"

    # Retry only known-transient codes
    if [[ $attempt -lt $max_retries ]]; then
      case "${status:-000}" in
        000|429|500|502|503|504)
          attempt=$((attempt+1))
          local backoff=$(( 2 ** attempt ))
          echo -e "    ${YELLOW}RETRY${RESET}  ${method} ${url##*/} → ${status:-timeout} (attempt ${attempt}/${max_retries}, backoff ${backoff}s)" >&2
          sleep "$backoff"
          continue
          ;;
      esac
    fi
    break
  done

  printf '%s\n%s' "$body" "${status:-000}"
}

# ── Global counters ───────────────────────────────────────────────────────────
TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
declare -A SUITE_RESULTS   # [name]="pass fail skip duration_ms"
declare -A SUITE_XML       # [name]=accumulated JUnit testcase XML

# Per-suite counters (reset by suite_start)
SUITE_PASS=0; SUITE_FAIL=0; SUITE_SKIP=0
CURRENT_SUITE=""
CURRENT_TEST=""

# Failure log
FAILURE_LOG=""

# ── XML / JSON escaping ───────────────────────────────────────────────────────
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  s="${s//\"/&quot;}"; s="${s//\'/&apos;}"
  printf '%s' "$s"
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"; s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# ── Suite lifecycle ───────────────────────────────────────────────────────────
suite_start() {
  CURRENT_SUITE="$1"
  SUITE_PASS=0; SUITE_FAIL=0; SUITE_SKIP=0
  SUITE_XML["$1"]=""
  SUITE_START_MS=$(now_ms)
  LAST_CHECK_MS=$SUITE_START_MS
  echo -e "\n${BOLD}${CYAN}▸ $1${RESET}"
}

suite_end() {
  local suite_ms=$(( $(now_ms) - SUITE_START_MS ))
  local suite_sec
  suite_sec=$(ms_to_sec "$suite_ms")
  TOTAL_PASS=$((TOTAL_PASS + SUITE_PASS))
  TOTAL_FAIL=$((TOTAL_FAIL + SUITE_FAIL))
  TOTAL_SKIP=$((TOTAL_SKIP + SUITE_SKIP))
  SUITE_RESULTS["$CURRENT_SUITE"]="$SUITE_PASS $SUITE_FAIL $SUITE_SKIP $suite_ms"
  if [[ $SUITE_FAIL -eq 0 ]]; then
    echo -e "  ${GREEN}✓${RESET} ${DIM}$SUITE_PASS passed, $SUITE_SKIP skipped (${suite_sec}s)${RESET}"
  else
    echo -e "  ${RED}✗${RESET} ${RED}$SUITE_FAIL failed${RESET}${DIM}, $SUITE_PASS passed, $SUITE_SKIP skipped (${suite_sec}s)${RESET}"
  fi
}

# ── Core assertion ────────────────────────────────────────────────────────────
# check LABEL EXPECTED_PATTERN ACTUAL
#   EXPECTED_PATTERN is an ERE applied to ACTUAL via grep -qE
check() {
  local label="$1" pattern="$2" actual="$3"
  local now duration_ms duration_sec escaped_label escaped_suite
  now=$(now_ms)
  duration_ms=$(( now - LAST_CHECK_MS ))
  duration_sec=$(ms_to_sec "$duration_ms")
  LAST_CHECK_MS=$now
  CURRENT_TEST="$label"
  escaped_label=$(xml_escape "$label")
  escaped_suite=$(xml_escape "$CURRENT_SUITE")

  if echo "$actual" | grep -qE "$pattern"; then
    echo -e "    ${GREEN}PASS${RESET}  $label"
    SUITE_PASS=$((SUITE_PASS+1))
    SUITE_XML["$CURRENT_SUITE"]+="    <testcase name=\"${escaped_label}\" classname=\"${escaped_suite}\" time=\"${duration_sec}\"/>"$'\n'
  else
    echo -e "    ${RED}FAIL${RESET}  $label"
    echo -e "          ${DIM}expect:${RESET} $pattern"
    printf  "          ${DIM}actual:${RESET} %.160s\n" "$actual"
    SUITE_FAIL=$((SUITE_FAIL+1))
    local entry escaped_msg
    printf -v entry "  [%s] %s\n    expect: %s\n    actual: %.120s\n" \
      "$CURRENT_SUITE" "$label" "$pattern" "$actual"
    FAILURE_LOG+="$entry"$'\n'
    escaped_msg=$(xml_escape "expected: $pattern | actual: ${actual:0:200}")
    SUITE_XML["$CURRENT_SUITE"]+="    <testcase name=\"${escaped_label}\" classname=\"${escaped_suite}\" time=\"${duration_sec}\"><failure message=\"${escaped_msg}\"/></testcase>"$'\n'
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

# info — informational line (not a test result)
info() {
  echo -e "    ${DIM}INFO${RESET}  $1"
}

# skip LABEL REASON
skip() {
  local label="$1" reason="$2"
  echo -e "    ${YELLOW}SKIP${RESET}  $label — $reason"
  SUITE_SKIP=$((SUITE_SKIP+1))
  local escaped_label escaped_suite escaped_reason
  escaped_label=$(xml_escape "$label")
  escaped_suite=$(xml_escape "${CURRENT_SUITE:-unknown}")
  escaped_reason=$(xml_escape "$reason")
  SUITE_XML["${CURRENT_SUITE:-unknown}"]+="    <testcase name=\"${escaped_label}\" classname=\"${escaped_suite}\"><skipped message=\"${escaped_reason}\"/></testcase>"$'\n'
}

# fail_hard LABEL REASON — fail without a pattern check
fail_hard() {
  local label="$1" reason="$2"
  echo -e "    ${RED}FAIL${RESET}  $label"
  echo -e "          ${DIM}$reason${RESET}"
  SUITE_FAIL=$((SUITE_FAIL+1))
  FAILURE_LOG+="  [$CURRENT_SUITE] $label: $reason"$'\n\n'
  local escaped_label escaped_suite escaped_reason
  escaped_label=$(xml_escape "$label")
  escaped_suite=$(xml_escape "$CURRENT_SUITE")
  escaped_reason=$(xml_escape "$reason")
  SUITE_XML["$CURRENT_SUITE"]+="    <testcase name=\"${escaped_label}\" classname=\"${escaped_suite}\" time=\"0.001\"><failure message=\"${escaped_reason}\"/></testcase>"$'\n'
}

# ── JWT acquisition ───────────────────────────────────────────────────────────
# acquire_jwt EMAIL PASSWORD — prints access_token or empty string on failure
acquire_jwt() {
  local email="$1" password="$2"
  local resp
  resp=$(http_request POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${email}\",\"password\":\"${password}\"}")
  resp_body "$resp" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4
}

# ── HTTP API wrappers ─────────────────────────────────────────────────────────
# All wrappers return BODY<newline>HTTP_STATUS

# api_get PATH [JWT]
api_get() {
  local path="$1" jwt="${2:-}"
  http_request GET \
    "${SUPABASE_URL}/rest/v1/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"}
}

# api_post PATH BODY [JWT]
api_post() {
  local path="$1" body="$2" jwt="${3:-}"
  http_request POST \
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
  http_request PATCH \
    "${SUPABASE_URL}/rest/v1/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"} \
    -H "Content-Type: application/json" \
    -d "$body"
}

# api_delete PATH [JWT]
api_delete() {
  local path="$1" jwt="${2:-}"
  http_request DELETE \
    "${SUPABASE_URL}/rest/v1/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"}
}

# fn_post FUNCTION_NAME BODY [JWT]
fn_post() {
  local fn="$1" body="$2" jwt="${3:-}"
  http_request POST \
    "${SUPABASE_URL}/functions/v1/${fn}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"} \
    -H "Content-Type: application/json" \
    -d "$body"
}

# storage_upload BUCKET PATH CONTENT_TYPE BODY [JWT]
storage_upload() {
  local bucket="$1" path="$2" ctype="$3" body="$4" jwt="${5:-}"
  http_request POST \
    "${SUPABASE_URL}/storage/v1/object/${bucket}/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"} \
    -H "Content-Type: ${ctype}" \
    --data-binary "$body"
}

# storage_delete BUCKET PATH [JWT]
storage_delete() {
  local bucket="$1" path="$2" jwt="${3:-}"
  http_request DELETE \
    "${SUPABASE_URL}/storage/v1/object/${bucket}/${path}" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    ${jwt:+-H "Authorization: Bearer $jwt"}
}

# ── Response splitters ────────────────────────────────────────────────────────
resp_body()   { echo "$1" | head -n -1; }
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
CLEANUP_LISTING_IDS=()
CLEANUP_STORAGE_PATHS=()

register_cleanup_listing() { CLEANUP_LISTING_IDS+=("$1"); }
register_cleanup_storage()  { CLEANUP_STORAGE_PATHS+=("$1"); }

run_cleanup() {
  local has_work=0
  for id in "${CLEANUP_LISTING_IDS[@]}"; do [[ -n "$id" ]] && { has_work=1; break; }; done
  for p  in "${CLEANUP_STORAGE_PATHS[@]}"; do [[ -n "$p"  ]] && { has_work=1; break; }; done
  [[ $has_work -eq 0 ]] && return

  echo -e "\n${DIM}Cleaning up test data...${RESET}"
  for id in "${CLEANUP_LISTING_IDS[@]}"; do
    [[ -z "$id" ]] && continue
    api_delete "properties?id=eq.${id}" "${ADMIN_JWT:-}" >/dev/null 2>&1 || true
  done
  for p in "${CLEANUP_STORAGE_PATHS[@]}"; do
    [[ -z "$p" ]] && continue
    local bucket="${p%%/*}" objpath="${p#*/}"
    storage_delete "$bucket" "$objpath" "${ADMIN_JWT:-}" >/dev/null 2>&1 || true
  done
}

# ── Report generation ─────────────────────────────────────────────────────────
generate_reports() {
  local run_end_ms total_ms total_sec
  run_end_ms=$(now_ms)
  total_ms=$(( run_end_ms - RUN_START_MS ))
  total_sec=$(ms_to_sec "$total_ms")
  local report_dir="tests/security/output/reports"
  mkdir -p "$report_dir"

  if [[ $total_ms -gt 180000 ]]; then
    echo -e "${YELLOW}PERF WARNING: total suite took ${total_sec}s (budget: 180s)${RESET}"
    PERF_WARNINGS=$((PERF_WARNINGS+1))
  fi

  local total_tests=$(( TOTAL_PASS + TOTAL_FAIL + TOTAL_SKIP ))

  # ── JUnit XML ──────────────────────────────────────────────────────────────
  local xml_file="${report_dir}/junit-${RUN_ID_SHORT}.xml"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    printf '<testsuites name="Pintag Security Regression" time="%s" tests="%d" failures="%d" skipped="%d">\n' \
      "$total_sec" "$total_tests" "$TOTAL_FAIL" "$TOTAL_SKIP"
    for suite_name in "${!SUITE_RESULTS[@]}"; do
      local sp sf ss sdms sdur suite_tests esc_suite
      read -r sp sf ss sdms <<< "${SUITE_RESULTS[$suite_name]}"
      sdur=$(ms_to_sec "${sdms:-0}")
      suite_tests=$(( sp + sf + ${ss:-0} ))
      esc_suite=$(xml_escape "$suite_name")
      printf '  <testsuite name="%s" tests="%d" failures="%d" skipped="%d" time="%s">\n' \
        "$esc_suite" "$suite_tests" "$sf" "${ss:-0}" "$sdur"
      printf '%s' "${SUITE_XML[$suite_name]:-}"
      echo '  </testsuite>'
    done
    echo '</testsuites>'
  } > "$xml_file"
  echo -e "${DIM}  JUnit XML:    ${xml_file}${RESET}"

  # ── JSON summary ───────────────────────────────────────────────────────────
  local json_file="${report_dir}/summary-${RUN_ID_SHORT}.json"
  local suites_json="" first=1
  for suite_name in "${!SUITE_RESULTS[@]}"; do
    local sp sf ss sdms sdur esc_name
    read -r sp sf ss sdms <<< "${SUITE_RESULTS[$suite_name]}"
    sdur=$(ms_to_sec "${sdms:-0}")
    esc_name=$(json_escape "$suite_name")
    [[ $first -eq 0 ]] && suites_json+=","
    suites_json+="{\"name\":\"${esc_name}\",\"passed\":${sp},\"failed\":${sf},\"skipped\":${ss:-0},\"duration_sec\":${sdur}}"
    first=0
  done
  {
    printf '{\n'
    printf '  "run_id": "%s",\n'          "$RUN_ID"
    printf '  "environment": "%s",\n'     "$(json_escape "${APP_ENV:-unknown}")"
    printf '  "supabase_url": "%s",\n'    "$(json_escape "${SUPABASE_URL:-}")"
    printf '  "started_at": "%s",\n'      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '  "duration_sec": %s,\n'      "$total_sec"
    printf '  "total_tests": %d,\n'       "$total_tests"
    printf '  "passed": %d,\n'            "$TOTAL_PASS"
    printf '  "failed": %d,\n'            "$TOTAL_FAIL"
    printf '  "skipped": %d,\n'           "$TOTAL_SKIP"
    printf '  "total_requests": %d,\n'    "$TOTAL_REQUESTS"
    printf '  "perf_warnings": %d,\n'     "$PERF_WARNINGS"
    printf '  "suites": [%s]\n'           "$suites_json"
    printf '}\n'
  } > "$json_file"
  echo -e "${DIM}  JSON summary: ${json_file}${RESET}"
}
