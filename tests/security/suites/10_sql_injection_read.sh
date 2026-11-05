#!/usr/bin/env bash
# Suite 10 (production) — SQL injection through GET filters
#
# @suite    SQL Injection (read)
# @purpose  Verify SQL injection payloads do not cause errors or data exposure through any input surface
# @covers   table:properties table:parties table:contacts
# @needs    none
# @runtime  ~30s
#
# Supabase PostgREST parameterises all inputs — these tests confirm that
# behaviour is preserved at every public input surface that can be probed with a plain GET.
#
# NOT probed on production: the Edge Function JSON-body injections (external side effects) and the RPC injection. The old RPC probe sent
# {"property_id": ...} to increment_listing_view(p_listing_id uuid), so PostgREST could not find the function and the body was never reached: it did
# not test the function. A correct call would reach the function, and even a nil UUID would write a bookkeeping row (listing_view_throttle), so no RPC is
# sent to production. Invalid-UUID rejection is asserted locally (rls_regression.sql section N). That is a documented coverage gap on production.

_sqli_urlencode() {
  # URL-encode the characters most likely to affect query-string parsing.
  # Falls back to a pure-bash implementation if python3 is unavailable.
  python3 -c \
    "import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1],safe=''))" \
    "$1" 2>/dev/null && return
  local s="$1"
  s="${s// /%20}"; s="${s//\'/%27}"; s="${s//\"/%22}"
  s="${s//;/%3B}";  s="${s//&/%26}";  s="${s//#/%23}"
  s="${s//=/%3D}";  s="${s//+/%2B}";  s="${s//|/%7C}"
  printf '%s' "$s"
}

_sqli_body_clean() {
  # Returns "ok" if body contains no SQL error keywords, "FAIL:<excerpt>" otherwise.
  local body="$1"
  if echo "$body" | grep -qi \
      "pg_exception\|SQLSTATE\|42P01\|42601\|syntax error.*SQL\|relation.*does not exist\|ERROR.*column\|ERROR.*table"; then
    printf 'FAIL:%s' "${body:0:160}"
  else
    printf 'ok'
  fi
}

run_sql_injection_read_tests() {
  suite_start "SQL Injection (read)"

  local q="'"  # single-quote used to build payloads without escaping issues
  local payloads=(
    "${q}"
    "${q}--"
    "${q} OR ${q}1${q}=${q}1"
    "${q} UNION SELECT NULL,NULL,NULL --"
    "${q}; DROP TABLE properties--"
    "1; SELECT pg_sleep(1)--"
    "<script>alert(1)</script>"
  )

  local r status body enc clean

  # ════════════════════════════════════
  # 1. Slug filter (text column, eq.)
  # ════════════════════════════════════
  info "--- slug=eq. injection ---"
  for payload in "${payloads[@]}"; do
    enc=$(_sqli_urlencode "$payload")
    r=$(api_get "properties?slug=eq.${enc}&select=id&limit=1")
    status=$(resp_status "$r")
    body=$(resp_body "$r")
    check "slug inject: no 500  [${payload:0:22}]" \
      "^[^5]|^5[^0]|^50[^0]" "$status"
    clean=$(_sqli_body_clean "$body")
    if [[ "$clean" != "ok" ]]; then
      fail_hard "slug inject: SQL error in response  [${payload:0:22}]" \
        "${clean#FAIL:}"
    else
      check "slug inject: no SQL error  [${payload:0:22}]" "." "ok"
    fi
  done

  # ════════════════════════════════════
  # 2. ID filter (UUID column — invalid values must return 400, not 500)
  # ════════════════════════════════════
  info "--- id=eq. injection (UUID column) ---"
  for payload in "${q}" "${q} OR 1=1--" "${q}; DROP TABLE properties--" "1 UNION SELECT"; do
    enc=$(_sqli_urlencode "$payload")
    r=$(api_get "properties?id=eq.${enc}&select=id&limit=1")
    status=$(resp_status "$r")
    body=$(resp_body "$r")
    # PostgREST rejects non-UUID values with 400 — never 500
    check "id inject: 4xx (invalid UUID format)  [${payload:0:22}]" \
      "^4[0-9][0-9]$" "$status"
    clean=$(_sqli_body_clean "$body")
    if [[ "$clean" != "ok" ]]; then
      fail_hard "id inject: SQL error in response  [${payload:0:22}]" \
        "${clean#FAIL:}"
    else
      check "id inject: no SQL error  [${payload:0:22}]" "." "ok"
    fi
  done

  # ════════════════════════════════════
  # 3. Text search (ilike — most permissive filter)
  # ════════════════════════════════════
  info "--- title_en=ilike.* injection ---"
  for payload in "${q}" "${q} OR ${q}1${q}=${q}1" "${q}; DROP TABLE properties--"; do
    enc=$(_sqli_urlencode "*${payload}*")
    r=$(api_get "properties?title_en=ilike.${enc}&select=id&limit=5")
    status=$(resp_status "$r")
    body=$(resp_body "$r")
    check "ilike inject: no 500  [${payload:0:22}]" \
      "^[^5]|^5[^0]|^50[^0]" "$status"
    clean=$(_sqli_body_clean "$body")
    if [[ "$clean" != "ok" ]]; then
      fail_hard "ilike inject: SQL error in response  [${payload:0:22}]" \
        "${clean#FAIL:}"
    else
      check "ilike inject: no SQL error  [${payload:0:22}]" "." "ok"
    fi
  done

  # ════════════════════════════════════
  # 4. JSON body → Edge Functions
  # Edge functions use Supabase client internally (parameterised).
  # ════════════════════════════════════
  skip "Edge Function JSON-body injection (generate-listing-content, smart-listing-importer)" "not sent to production: external side effects; gate covered locally (edge-function-auth-gates.test.js)"
  skip "RPC parameter injection (increment_listing_view)" "not sent to production: coverage gap documented; invalid-UUID rejection asserted locally (rls_regression.sql section N)"

  info "--- DB integrity check ---"
  r=$(api_get "properties?status=eq.active&select=id&limit=1")
  check "DB integrity: properties table still accessible after all injection attempts" \
    "^[^5]|^5[^0]|^50[^0]" "$(resp_status "$r")"

  r=$(api_get "parties?select=id&limit=1")
  check "DB integrity: parties table still accessible" \
    "^[^5]|^5[^0]|^50[^0]" "$(resp_status "$r")"

  r=$(api_get "contacts?select=id&limit=1")
  check "DB integrity: contacts table still accessible" \
    "^[^5]|^5[^0]|^50[^0]" "$(resp_status "$r")"

  suite_end
}
