#!/usr/bin/env bash
# Suite 10 — SQL Injection
#
# @suite    SQL Injection
# @purpose  Verify SQL injection payloads do not cause errors or data exposure through any input surface
# @covers   table:properties table:agents fn:generate-listing-content fn:smart-listing-importer
# @needs    none
# @runtime  ~30s
#
# Supabase PostgREST parameterises all inputs — these tests confirm that
# behaviour is preserved at every public input surface.

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

run_sql_injection_tests() {
  suite_start "SQL Injection"

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
  info "--- Edge Function JSON body injection ---"

  for payload in "${q}" "${q} OR ${q}1${q}=${q}1--" "${q}; SELECT pg_sleep(1)--"; do
    # generate-listing-content: listing_id is treated as a UUID
    r=$(fn_post "generate-listing-content" \
      "{\"listing_id\":\"${payload}\",\"lang\":\"en\"}")
    body=$(resp_body "$r")
    clean=$(_sqli_body_clean "$body")
    if [[ "$clean" != "ok" ]]; then
      fail_hard "generate-listing-content JSON inject: SQL error  [${payload:0:22}]" \
        "${clean#FAIL:}"
    else
      check "generate-listing-content JSON inject: no SQL error  [${payload:0:22}]" "." "ok"
    fi

    # smart-listing-importer: description is a text field
    r=$(fn_post "smart-listing-importer" \
      "{\"description\":\"${payload}\"}")
    body=$(resp_body "$r")
    clean=$(_sqli_body_clean "$body")
    if [[ "$clean" != "ok" ]]; then
      fail_hard "smart-listing-importer JSON inject: SQL error  [${payload:0:22}]" \
        "${clean#FAIL:}"
    else
      check "smart-listing-importer JSON inject: no SQL error  [${payload:0:22}]" "." "ok"
    fi
  done

  # ════════════════════════════════════
  # 5. RPC calls — malformed UUID args
  # ════════════════════════════════════
  info "--- RPC parameter injection ---"

  for payload in "${q}" "${q}; DROP TABLE properties--" "1 UNION SELECT NULL--"; do
    # JSON-encode the payload to avoid breaking the JSON body
    local json_payload="${payload//\\/\\\\}"
    json_payload="${json_payload//\"/\\\"}"
    r=$(api_post "rpc/increment_listing_view" \
      "{\"property_id\":\"${json_payload}\"}")
    body=$(resp_body "$r")
    status=$(resp_status "$r")
    # Should return 400 (invalid UUID), never 500 or SQL error
    check "RPC inject: no 500  [${payload:0:22}]" \
      "^[^5]|^5[^0]|^50[^0]" "$status"
    clean=$(_sqli_body_clean "$body")
    if [[ "$clean" != "ok" ]]; then
      fail_hard "RPC inject: SQL error  [${payload:0:22}]" \
        "${clean#FAIL:}"
    else
      check "RPC inject: no SQL error  [${payload:0:22}]" "." "ok"
    fi
  done

  # ════════════════════════════════════
  # 6. DB integrity — sentinel record still queryable
  # If any payload caused DDL execution, we would have lost data.
  # ════════════════════════════════════
  info "--- DB integrity check ---"
  r=$(api_get "properties?status=eq.active&select=id&limit=1")
  check "DB integrity: properties table still accessible after all injection attempts" \
    "^[^5]|^5[^0]|^50[^0]" "$(resp_status "$r")"

  r=$(api_get "agents?select=id&limit=1")
  check "DB integrity: agents table still accessible" \
    "^[^5]|^5[^0]|^50[^0]" "$(resp_status "$r")"

  suite_end
}
