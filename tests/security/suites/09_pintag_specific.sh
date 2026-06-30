#!/usr/bin/env bash
# Suite 09 — Pintag-Specific Security
#
# @suite    Pintag Specific
# @purpose  Error format (no leaks), Smart Import edge cases, listing isolation, resolve-map-url edge cases
# @covers   fn:generate-listing-content fn:smart-listing-importer fn:resolve-map-url table:properties
# @needs    optional:ADMIN_EMAIL,ADMIN_PASSWORD optional:TEST_USER_EMAIL,TEST_USER_PASSWORD
# @runtime  ~25s

run_pintag_specific_tests() {
  suite_start "Pintag Specific"

  local r body status

  # ════════════════════════════════════
  # Error response format
  # ════════════════════════════════════
  info "--- Error response format (unauthenticated) ---"

  # Unauthenticated 401 must return JSON, not HTML or plain text
  CURRENT_TEST="error format: generate-listing-content 401 is JSON"
  r=$(fn_post "generate-listing-content" '{"listing_id":"00000000-0000-0000-0000-000000000000","lang":"en"}')
  body="$(resp_body "$r")"
  check "generate-listing-content: 401 error body is JSON" '^\{' "$body"

  # No stack traces exposed in error responses
  if echo "$body" | grep -qi "at Object\.\|at Function\.\|stacktrace\|stack_trace\|\"stack\""; then
    fail_hard "generate-listing-content: 401 must not expose stack traces" \
      "Stack trace keywords found in error body: ${body:0:120}"
  else
    check "generate-listing-content: 401 no stack trace exposed" "." "no-stack-trace"
  fi

  # No SQL errors exposed
  if echo "$body" | grep -qi "pg_exception\|SQLSTATE\|relation.*does not exist\|syntax error.*SQL\|42P01\|42601"; then
    fail_hard "generate-listing-content: 401 must not expose SQL errors" \
      "SQL error keywords found in error body: ${body:0:120}"
  else
    check "generate-listing-content: 401 no SQL error exposed" "." "no-sql-error"
  fi

  # No environment variable names exposed
  if echo "$body" | grep -qi "SUPABASE_URL\|SUPABASE_ANON_KEY\|SERVICE_ROLE_KEY\|GEMINI_API_KEY\|POSTGRES_PASSWORD"; then
    fail_hard "generate-listing-content: 401 must not expose env var names" \
      "Environment variable name found in error body: ${body:0:120}"
  else
    check "generate-listing-content: 401 no env vars exposed" "." "no-env-vars"
  fi

  # smart-listing-importer: same checks on 401
  CURRENT_TEST="error format: smart-listing-importer 401 is JSON"
  r=$(fn_post "smart-listing-importer" '{"description":"test"}')
  body="$(resp_body "$r")"
  check "smart-listing-importer: 401 error body is JSON" '^\{' "$body"

  if echo "$body" | grep -qi "at Object\.\|stacktrace\|SUPABASE_URL\|GEMINI_API_KEY\|pg_exception"; then
    fail_hard "smart-listing-importer: 401 must not expose internals" \
      "Internal details found in 401 body: ${body:0:120}"
  else
    check "smart-listing-importer: 401 no internals exposed" "." "no-internals"
  fi

  # resolve-map-url 403: disallowed domain returns JSON error
  CURRENT_TEST="error format: resolve-map-url 403 is JSON"
  r=$(fn_post "resolve-map-url" '{"url":"https://evil.com/"}')
  body="$(resp_body "$r")"
  check "resolve-map-url: 403 error body is JSON" '^\{' "$body"

  if echo "$body" | grep -qi "at Object\.\|stacktrace\|Deno\.\|node_modules\|SUPABASE"; then
    fail_hard "resolve-map-url: 403 must not expose internals" \
      "Internal details found in 403 body: ${body:0:120}"
  else
    check "resolve-map-url: 403 no internals exposed" "." "no-internals"
  fi

  # Admin-authenticated structured error checks
  if [[ -n "${ADMIN_JWT:-}" ]]; then
    info "--- Error response format (admin-authenticated) ---"

    CURRENT_TEST="error format: generate-listing-content empty body"
    r=$(fn_post "generate-listing-content" '{}' "${ADMIN_JWT}")
    body="$(resp_body "$r")"
    status="$(resp_status "$r")"
    check "generate-listing-content empty body → structured error (4xx/5xx)" "^[45]" "$status"
    check "generate-listing-content empty body → JSON error body" '^\{' "$body"
    if echo "$body" | grep -qi "at Object\.\|stacktrace\|pg_exception"; then
      fail_hard "generate-listing-content empty body: no internals in error" \
        "Internals found: ${body:0:120}"
    else
      check "generate-listing-content empty body: no stack/SQL in error" "." "confirmed"
    fi

    CURRENT_TEST="error format: smart-listing-importer empty body"
    r=$(fn_post "smart-listing-importer" '{}' "${ADMIN_JWT}")
    body="$(resp_body "$r")"
    check "smart-listing-importer empty body → JSON error body" '^\{' "$body"
    if echo "$body" | grep -qi "at Object\.\|stacktrace\|GEMINI_API_KEY"; then
      fail_hard "smart-listing-importer empty body: no internals in error" \
        "Internals found: ${body:0:120}"
    else
      check "smart-listing-importer empty body: no stack/key in error" "." "confirmed"
    fi
  else
    skip "Admin-authenticated error format checks" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
    skip "Admin-authenticated error format checks (smart-listing-importer)" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  # ════════════════════════════════════
  # Smart Import extended payload validation
  # ════════════════════════════════════
  info "--- Smart Import extended validation ---"

  if [[ -n "${ADMIN_JWT:-}" ]]; then
    # image_urls as object (wrong type) — should not crash
    CURRENT_TEST="smart-import: image_urls wrong type"
    r=$(fn_post "smart-listing-importer" \
      '{"description":"test villa in Vientiane","image_urls":{"key":"value"}}' "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    check "image_urls as object (not array) → no 500 crash" \
      "^[^5]|^5[^0]|^50[^0]" "$status"

    # image_urls as string (wrong type)
    CURRENT_TEST="smart-import: image_urls as string"
    r=$(fn_post "smart-listing-importer" \
      '{"description":"test villa","image_urls":"http://example.com/img.jpg"}' "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    check "image_urls as string (not array) → no 500 crash" \
      "^[^5]|^5[^0]|^50[^0]" "$status"

    # 12 disallowed image URLs (> cap of 10) — disallowed URLs are silently skipped,
    # verifying the function handles more than 10 entries without crashing
    CURRENT_TEST="smart-import: >10 image_urls"
    local many_urls
    many_urls='["http://evil.com/1.jpg","http://evil.com/2.jpg","http://evil.com/3.jpg","http://evil.com/4.jpg","http://evil.com/5.jpg","http://evil.com/6.jpg","http://evil.com/7.jpg","http://evil.com/8.jpg","http://evil.com/9.jpg","http://evil.com/10.jpg","http://evil.com/11.jpg","http://evil.com/12.jpg"]'
    r=$(fn_post "smart-listing-importer" \
      "{\"description\":\"3BR villa\",\"image_urls\":${many_urls}}" "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    check "12 image_urls (all disallowed/skipped) → no 500 crash" \
      "^[^5]|^5[^0]|^50[^0]" "$status"
    info "  All 12 URLs were disallowed (non-supabase) so silently skipped"

    # Null description with valid image_urls
    CURRENT_TEST="smart-import: null description"
    r=$(fn_post "smart-listing-importer" \
      '{"description":null,"image_urls":[]}' "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    check "null description → no 500 crash (should be 4xx or 2xx)" \
      "^[^5]|^5[^0]|^50[^0]" "$status"
  else
    skip "Smart Import extended validation" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
    skip "Smart Import extended validation (image_urls wrong type)" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
    skip "Smart Import extended validation (12 URLs)" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
    skip "Smart Import extended validation (null description)" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  # ════════════════════════════════════
  # Listing data isolation
  # ════════════════════════════════════
  info "--- Listing data isolation ---"

  if [[ -n "${ADMIN_JWT:-}" ]]; then
    # Create a draft listing with a unique slug
    local test_slug="pentest-iso-${RUN_ID_SHORT}"
    CURRENT_TEST="listing isolation: create draft"
    r=$(api_post "properties" \
      "{\"title_en\":\"Pentest Isolation ${RUN_ID_SHORT}\",\"status\":\"draft\",\"slug\":\"${test_slug}\",\"transaction_type\":\"for_sale\"}" \
      "${ADMIN_JWT}")
    status="$(resp_status "$r")"

    if [[ "$status" =~ ^2 ]]; then
      local draft_id
      draft_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
      [[ -n "$draft_id" ]] && register_cleanup_listing "$draft_id"

      # Anon cannot see this draft via direct ID query
      CURRENT_TEST="listing isolation: draft invisible to anon (direct ID)"
      r=$(api_get "properties?id=eq.${draft_id}&select=id,status")
      check_empty "draft invisible to anon via direct ID query (RLS)" "$(resp_body "$r")"

      # Anon cannot see draft via slug query either
      CURRENT_TEST="listing isolation: draft invisible to anon (slug)"
      r=$(api_get "properties?slug=eq.${test_slug}&select=id,status")
      check_empty "draft invisible to anon via slug query (RLS)" "$(resp_body "$r")"

      # Anon cannot promote draft to active
      CURRENT_TEST="listing isolation: anon cannot promote draft"
      r=$(api_patch "properties?id=eq.${draft_id}" '{"status":"active"}')
      check_status "anon cannot promote draft to active → 403 (RLS)" 403 "$(resp_status "$r")"

      # Anon cannot promote via slug
      CURRENT_TEST="listing isolation: anon cannot update via slug"
      r=$(api_patch "properties?slug=eq.${test_slug}" '{"status":"active"}')
      check_status "anon cannot update draft via slug → 403 (RLS)" 403 "$(resp_status "$r")"

      # Non-admin cannot see draft either
      if [[ -n "${TEST_USER_JWT:-}" ]]; then
        CURRENT_TEST="listing isolation: draft invisible to non-admin"
        r=$(api_get "properties?id=eq.${draft_id}&select=id,status" "${TEST_USER_JWT}")
        check_empty "draft invisible to non-admin user (RLS)" "$(resp_body "$r")"
      else
        skip "Draft isolation: non-admin user visibility" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
      fi

      # Cleanup now (don't leave a draft in the DB)
      api_delete "properties?id=eq.${draft_id}" "${ADMIN_JWT}" >/dev/null 2>&1 || true
      # Remove from cleanup registry since already deleted
      CLEANUP_LISTING_IDS=("${CLEANUP_LISTING_IDS[@]/$draft_id}")
    else
      info "Could not create test draft listing (status: $status) — skipping isolation tests"
      skip "Draft isolation tests" "failed to create test listing"
    fi
  else
    skip "Listing data isolation tests" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  # ════════════════════════════════════
  # resolve-map-url edge cases
  # ════════════════════════════════════
  info "--- resolve-map-url edge cases ---"

  # Empty url field → should return structured error
  CURRENT_TEST="resolve-map-url: empty url"
  r=$(fn_post "resolve-map-url" '{"url":""}')
  body="$(resp_body "$r")"
  check "empty url string → JSON error (not crash)" '^\{' "$body"

  # Numeric url field (wrong type) → should not crash
  CURRENT_TEST="resolve-map-url: numeric url"
  r=$(fn_post "resolve-map-url" '{"url":12345}')
  status="$(resp_status "$r")"
  check "numeric url (wrong type) → no 500 crash" \
    "^[^5]|^5[^0]|^50[^0]" "$status"

  # data: URI — should be blocked (not in allowlist)
  CURRENT_TEST="resolve-map-url: data URI"
  r=$(fn_post "resolve-map-url" '{"url":"data:text/html,<script>alert(1)</script>"}')
  check_status "data: URI → 403 (blocked by allowlist)" 403 "$(resp_status "$r")"

  # file: URI — should be blocked
  CURRENT_TEST="resolve-map-url: file URI"
  r=$(fn_post "resolve-map-url" '{"url":"file:///etc/passwd"}')
  check_status "file: URI → 403 (blocked by allowlist)" 403 "$(resp_status "$r")"

  suite_end
}
