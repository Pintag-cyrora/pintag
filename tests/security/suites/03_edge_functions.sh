#!/usr/bin/env bash
# Suite 03 — Edge Functions
#
# @suite    Edge Functions
# @purpose  Verify auth gating, payload validation, and graceful error handling for all Edge Functions
# @covers   fn:generate-listing-content fn:smart-listing-importer fn:resolve-map-url
# @needs    optional:ADMIN_EMAIL,ADMIN_PASSWORD
# @runtime  ~20s

run_edge_functions_tests() {
  suite_start "Edge Functions"

  local r body status

  # ════════════════════════════════════
  # generate-listing-content
  # ════════════════════════════════════
  info "--- generate-listing-content ---"

  # Auth gating
  r=$(fn_post "generate-listing-content" '{"listing_id":"00000000-0000-0000-0000-000000000000","lang":"en"}')
  check_status "no token → 401" 401 "$(resp_status "$r")"
  check "error body is JSON object" '^\{' "$(resp_body "$r")"

  r=$(fn_post "generate-listing-content" \
    '{"listing_id":"00000000-0000-0000-0000-000000000000","lang":"en"}' \
    "${SUPABASE_ANON_KEY}")
  check_status "anon-role JWT → 401" 401 "$(resp_status "$r")"

  # Invalid payload accepted by auth but rejected gracefully (not a 500 crash)
  if [[ -n "${ADMIN_JWT:-}" ]]; then
    r=$(fn_post "generate-listing-content" '{}' "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    # Expect a 4xx or 5xx error — but NOT an unhandled exception with no JSON body
    check "empty payload → structured error response (not HTML crash)" '^\{' "$(resp_body "$r")"
    check "empty payload → 4xx or 5xx" "^[45]" "$status"

    # Malformed JSON
    r=$(curl -s -w "\n%{http_code}" -X POST \
      "${SUPABASE_URL}/functions/v1/generate-listing-content" \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${ADMIN_JWT}" \
      -H "Content-Type: application/json" \
      --data-raw "not json at all")
    check "malformed JSON body → structured error (not HTML crash)" '^\{' "$(resp_body "$r")"
  else
    skip "generate-listing-content payload validation tests" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  # ════════════════════════════════════
  # smart-listing-importer
  # ════════════════════════════════════
  info "--- smart-listing-importer ---"

  r=$(fn_post "smart-listing-importer" '{"description":"test villa"}')
  check_status "no token → 401" 401 "$(resp_status "$r")"

  r=$(fn_post "smart-listing-importer" '{"description":"test villa"}' "${SUPABASE_ANON_KEY}")
  check_status "anon-role JWT → 401" 401 "$(resp_status "$r")"

  if [[ -n "${ADMIN_JWT:-}" ]]; then
    # Empty body
    r=$(fn_post "smart-listing-importer" '{}' "${ADMIN_JWT}")
    check "empty payload → structured error response" '^\{' "$(resp_body "$r")"

    # image_urls field ignored if not array
    r=$(fn_post "smart-listing-importer" \
      '{"description":"test","image_urls":"not-an-array"}' "${ADMIN_JWT}")
    check "image_urls as string → handled gracefully (no 500 crash)" \
      "^[^5]|^5[^0]|^50[^0]" "$(resp_status "$r")"
  else
    skip "smart-listing-importer payload validation tests" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  # ════════════════════════════════════
  # resolve-map-url (public — no auth required)
  # ════════════════════════════════════
  info "--- resolve-map-url ---"

  # No URL provided
  r=$(fn_post "resolve-map-url" '{}')
  check "missing url field → 500 with error message" '^\{.*error' "$(resp_body "$r")"

  # Invalid URL string
  r=$(fn_post "resolve-map-url" '{"url":"not a url"}')
  check "invalid URL string → 500 with error message" '^\{.*error' "$(resp_body "$r")"

  # Disallowed domain → 403
  r=$(fn_post "resolve-map-url" '{"url":"https://evil.com/path"}')
  check_status "disallowed domain → 403" 403 "$(resp_status "$r")"

  # Google Maps domain → 2xx (actual resolution may time out in CI; accept 2xx or 5xx)
  r=$(fn_post "resolve-map-url" '{"url":"https://maps.app.goo.gl/test"}')
  status="$(resp_status "$r")"
  check "allowed domain (maps.app.goo.gl) → not 403" \
    "^[^4]|^4[^0]|^40[^3]" "$status"

  suite_end
}
