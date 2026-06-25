#!/usr/bin/env bash
# Suite 02 — Row Level Security
# Verifies RLS policies on every protected table:
#   properties, agents, lead_events, listing_events

run_rls_tests() {
  suite_start "RLS"

  local r body status active_id

  # ── Discover an active listing for tests that need one ──────────────────
  r=$(api_get "properties?status=eq.active&select=id&limit=1")
  active_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [[ -z "$active_id" ]]; then
    info "No active listings found — some lead/listing_events tests will be skipped"
  fi

  # ════════════════════════════════
  # TABLE: properties
  # ════════════════════════════════
  info "--- properties ---"

  # Anon reads
  r=$(api_get "properties?status=eq.active&select=id,status&limit=5")
  check "anon SELECT active properties → 200" "^200$" "$(resp_status "$r")"
  body="$(resp_body "$r")"
  # Active listings are returned (array is non-empty if any exist, but may be [] on fresh DB)
  check "anon SELECT active properties → JSON array" '^\[' "$body"

  r=$(api_get "properties?status=eq.draft&select=id,status")
  check_empty "anon SELECT draft properties → empty (RLS filter)" "$(resp_body "$r")"

  r=$(api_get "properties?status=eq.sold&select=id,status")
  check_empty "anon SELECT sold properties → empty (RLS filter)" "$(resp_body "$r")"

  r=$(api_get "properties?status=eq.inactive&select=id,status")
  check_empty "anon SELECT inactive properties → empty (RLS filter)" "$(resp_body "$r")"

  # Anon writes — all must be blocked
  r=$(api_post "properties" \
    '{"title_en":"PENTEST_INSERT","status":"active","slug":"pentest-rls-insert","transaction_type":"for_sale"}')
  check_status "anon INSERT properties → 403" 403 "$(resp_status "$r")"

  r=$(api_patch "properties?status=eq.active" '{"title_en":"HACKED"}')
  check_status "anon UPDATE properties → 403" 403 "$(resp_status "$r")"

  r=$(api_delete "properties?status=eq.active")
  check_status "anon DELETE properties → 403" 403 "$(resp_status "$r")"

  # Authenticated non-admin
  if [[ -n "${TEST_USER_JWT:-}" ]]; then
    r=$(api_post "properties" \
      '{"title_en":"PENTEST_INSERT","status":"active","slug":"pentest-user-insert","transaction_type":"for_sale"}' \
      "${TEST_USER_JWT}")
    check_status "non-admin INSERT properties → 403" 403 "$(resp_status "$r")"

    r=$(api_patch "properties?status=eq.active" '{"title_en":"HACKED"}' "${TEST_USER_JWT}")
    check_status "non-admin UPDATE properties → 403" 403 "$(resp_status "$r")"

    # Cross-user DELETE: a non-admin user should not be able to delete listings
    # where agent_id != their own uid.  The result is 0 rows deleted (204/empty),
    # not an error — RLS silently filters the target rows out.
    r=$(api_delete "properties?status=eq.active" "${TEST_USER_JWT}")
    status="$(resp_status "$r")"
    # Acceptable: 204 (deleted 0 rows) or 403; NOT 200 with rows returned
    check "non-admin DELETE other-user properties → no rows affected (204 or 403)" \
      "^(204|403)$" "$status"
  else
    skip "Non-admin INSERT/UPDATE/DELETE properties tests" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
  fi

  # Admin full access
  if [[ -n "${ADMIN_JWT:-}" ]]; then
    # Admin can see drafts
    r=$(api_get "properties?select=id,status&limit=100" "${ADMIN_JWT}")
    check "admin SELECT all properties (including drafts) → 200" "^200$" "$(resp_status "$r")"

    # Admin can INSERT and then DELETE a test listing
    local test_slug="pentest-rls-admin-${RUN_ID_SHORT}"
    r=$(api_post "properties" \
      "{\"title_en\":\"Pentest Admin RLS\",\"status\":\"draft\",\"slug\":\"${test_slug}\",\"transaction_type\":\"for_sale\"}" \
      "${ADMIN_JWT}")
    check_status "admin INSERT properties → 201" 201 "$(resp_status "$r")"
    local new_id
    new_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [[ -n "$new_id" ]]; then
      register_cleanup_listing "$new_id"
      r=$(api_patch "properties?id=eq.${new_id}" '{"title_en":"Pentest Admin RLS Updated"}' "${ADMIN_JWT}")
      check_status "admin UPDATE properties → 200 or 204" "(200|204)" "$(resp_status "$r")"
      r=$(api_delete "properties?id=eq.${new_id}" "${ADMIN_JWT}")
      check_status "admin DELETE properties → 204" 204 "$(resp_status "$r")"
      # Remove from cleanup since we just deleted it
      CLEANUP_LISTING_IDS=("${CLEANUP_LISTING_IDS[@]/$new_id}")
    fi
  else
    skip "Admin properties full-access tests" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  # ════════════════════════════════
  # TABLE: agents
  # ════════════════════════════════
  info "--- agents ---"

  # Anon reads (intentionally public — agents page needs this)
  r=$(api_get "agents?select=id,name_en&limit=5")
  check "anon SELECT agents → 200 (intentionally public)" "^200$" "$(resp_status "$r")"
  check "anon SELECT agents → JSON array" '^\[' "$(resp_body "$r")"

  # Anon writes — all blocked
  r=$(api_post "agents" '{"name_en":"PENTEST_AGENT","name_lo":"ທົດສອບ"}')
  check_status "anon INSERT agents → 403" 403 "$(resp_status "$r")"

  r=$(api_patch "agents?id=gt.00000000-0000-0000-0000-000000000000" '{"name_en":"HACKED"}')
  check_status "anon UPDATE agents → 403" 403 "$(resp_status "$r")"

  r=$(api_delete "agents?id=gt.00000000-0000-0000-0000-000000000000")
  check_status "anon DELETE agents → 403" 403 "$(resp_status "$r")"

  # Non-admin authenticated writes — blocked
  if [[ -n "${TEST_USER_JWT:-}" ]]; then
    r=$(api_post "agents" '{"name_en":"PENTEST_AGENT_USER"}' "${TEST_USER_JWT}")
    check_status "non-admin INSERT agents → 403" 403 "$(resp_status "$r")"

    r=$(api_patch "agents?id=gt.00000000-0000-0000-0000-000000000000" \
      '{"name_en":"HACKED"}' "${TEST_USER_JWT}")
    check_status "non-admin UPDATE agents → 403" 403 "$(resp_status "$r")"
  else
    skip "Non-admin write-to-agents tests" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
  fi

  # ════════════════════════════════
  # TABLE: lead_events
  # ════════════════════════════════
  info "--- lead_events ---"

  if [[ -n "$active_id" ]]; then
    local lead_session="pentest-lead-$(date +%s)"

    # Anon INSERT on active listing — allowed (rate limited, tested in suite 05)
    r=$(api_post "lead_events" \
      "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp\",\"session_id\":\"${lead_session}\"}")
    check_status "anon INSERT lead_events (active listing) → 201" 201 "$(resp_status "$r")"

    # Anon cannot SELECT lead_events
    r=$(api_get "lead_events?limit=5")
    check_empty "anon SELECT lead_events → empty (no SELECT policy)" "$(resp_body "$r")"
  else
    skip "lead_events INSERT test" "no active listing available"
    skip "lead_events SELECT test" "no active listing available"
  fi

  # Anon cannot INSERT lead_events for a non-existent listing
  r=$(api_post "lead_events" \
    '{"listing_id":"00000000-0000-0000-0000-000000000000","event_type":"whatsapp","session_id":"pentest-fake"}')
  check_status "anon INSERT lead_events (non-existent listing) → 403 (RLS)" 403 "$(resp_status "$r")"

  # ════════════════════════════════
  # TABLE: listing_events
  # ════════════════════════════════
  info "--- listing_events ---"

  if [[ -n "$active_id" ]]; then
    local ev_session="pentest-ev-$(date +%s)"

    r=$(api_post "listing_events" \
      "{\"property_id\":\"${active_id}\",\"event_type\":\"view\",\"session_id\":\"${ev_session}\"}")
    check_status "anon INSERT listing_events (active listing) → 201" 201 "$(resp_status "$r")"

    # Second identical event within 30 min should be blocked by dedup policy
    r=$(api_post "listing_events" \
      "{\"property_id\":\"${active_id}\",\"event_type\":\"view\",\"session_id\":\"${ev_session}\"}")
    check_status "anon INSERT listing_events (duplicate within window) → 403" 403 "$(resp_status "$r")"

    # Anon cannot SELECT listing_events
    r=$(api_get "listing_events?limit=5")
    check_empty "anon SELECT listing_events → empty (no SELECT policy)" "$(resp_body "$r")"
  else
    skip "listing_events tests" "no active listing available"
  fi

  suite_end
}
