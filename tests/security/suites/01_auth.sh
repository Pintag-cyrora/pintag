#!/usr/bin/env bash
# Suite 01 — Authentication
#
# @suite    Authentication
# @purpose  Verify all admin Edge Functions reject unauthenticated, anon-role, and non-admin callers
# @covers   fn:generate-listing-content fn:smart-listing-importer
# @needs    optional:ADMIN_EMAIL,ADMIN_PASSWORD optional:TEST_USER_EMAIL,TEST_USER_PASSWORD
# @runtime  ~15s

run_auth_tests() {
  suite_start "Authentication"

  local r body status

  # ── No token at all ──────────────────────────────────────────────────────
  r=$(fn_post "generate-listing-content" '{"listing_id":"00000000-0000-0000-0000-000000000000","lang":"en"}')
  check_status "generate-listing-content: no Bearer token → 401" 401 "$(resp_status "$r")"

  r=$(fn_post "smart-listing-importer" '{"description":"test"}')
  check_status "smart-listing-importer: no Bearer token → 401" 401 "$(resp_status "$r")"

  # ── Anon JWT used as Bearer (role:anon, no email claim) ──────────────────
  r=$(fn_post "generate-listing-content" '{"listing_id":"00000000-0000-0000-0000-000000000000","lang":"en"}' \
    "${SUPABASE_ANON_KEY}")
  check_status "generate-listing-content: anon-role JWT as Bearer → 401" 401 "$(resp_status "$r")"

  r=$(fn_post "smart-listing-importer" '{"description":"test"}' "${SUPABASE_ANON_KEY}")
  check_status "smart-listing-importer: anon-role JWT as Bearer → 401" 401 "$(resp_status "$r")"

  # ── Invalid / garbage JWT ────────────────────────────────────────────────
  r=$(fn_post "generate-listing-content" '{"listing_id":"00000000-0000-0000-0000-000000000000","lang":"en"}' \
    "not.a.valid.jwt.at.all")
  check_status "generate-listing-content: garbage JWT → 401" 401 "$(resp_status "$r")"

  r=$(fn_post "smart-listing-importer" '{"description":"test"}' "not.a.valid.jwt.at.all")
  check_status "smart-listing-importer: garbage JWT → 401" 401 "$(resp_status "$r")"

  # ── Non-admin authenticated user ─────────────────────────────────────────
  if [[ -n "${TEST_USER_JWT:-}" ]]; then
    r=$(fn_post "generate-listing-content" \
      '{"listing_id":"00000000-0000-0000-0000-000000000000","lang":"en"}' \
      "${TEST_USER_JWT}")
    check_status "generate-listing-content: non-admin JWT → 401" 401 "$(resp_status "$r")"

    r=$(fn_post "smart-listing-importer" '{"description":"test"}' "${TEST_USER_JWT}")
    check_status "smart-listing-importer: non-admin JWT → 401" 401 "$(resp_status "$r")"
  else
    skip "Non-admin JWT rejection" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
    skip "Non-admin JWT rejection (smart-listing-importer)" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
  fi

  # ── Admin can reach the functions (gets 2xx/4xx/5xx, not 401) ────────────
  if [[ -n "${ADMIN_JWT:-}" ]]; then
    r=$(fn_post "generate-listing-content" \
      '{"listing_id":"00000000-0000-0000-0000-000000000000","lang":"en"}' \
      "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    # Any non-401 means auth passed — 5xx (listing not found) is acceptable
    check "generate-listing-content: admin JWT → auth accepted (not 401)" \
      "^[^4]|^4[^0]|^40[^1]" "$status"

    r=$(fn_post "smart-listing-importer" '{"description":"4BR villa in Sisattanak"}' \
      "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    check "smart-listing-importer: admin JWT → auth accepted (not 401)" \
      "^[^4]|^4[^0]|^40[^1]" "$status"
  else
    skip "Admin JWT acceptance (generate-listing-content)" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
    skip "Admin JWT acceptance (smart-listing-importer)"   "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  suite_end
}
