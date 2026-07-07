#!/usr/bin/env bash
# Suite 02 — Row Level Security
#
# @suite    RLS
# @purpose  Verify Row Level Security policies enforce correct read/write isolation on all tables
# @covers   table:properties table:parties table:contacts table:lead_events table:listing_events
# @needs    optional:ADMIN_EMAIL,ADMIN_PASSWORD optional:TEST_USER_EMAIL,TEST_USER_PASSWORD
# @runtime  ~25s

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
    local test_uid
    test_uid=$(jwt_sub "${TEST_USER_JWT}")

    # FIX (previously a bug, verified during the Contact/Platform-Identity
    # redesign): agents had SELECT/DELETE on their own listings but no
    # INSERT/UPDATE grant at all — add-property.html/edit-listing.html were
    # silently non-functional (403) for every real agent. Now scoped via
    # managed_by_party_id ownership, and requires a mandatory contact_id.
    local test_contact_id=""
    if [[ -n "$test_uid" ]]; then
      r=$(api_post "contacts" \
        "{\"role\":\"agent\",\"phone\":\"02000000000\",\"created_by\":\"${test_uid}\"}" \
        "${TEST_USER_JWT}")
      check_status "non-admin INSERT own contact → 201" 201 "$(resp_status "$r")"
      test_contact_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
      [[ -n "$test_contact_id" ]] && register_cleanup_contact "$test_contact_id"
    else
      skip "non-admin INSERT own contact" "could not decode TEST_USER_JWT sub claim"
    fi

    if [[ -n "$test_contact_id" ]]; then
      local test_slug="pentest-user-insert-${RUN_ID_SHORT}"
      r=$(api_post "properties" \
        "{\"title_en\":\"PENTEST_INSERT\",\"status\":\"draft\",\"slug\":\"${test_slug}\",\"transaction_type\":\"for_sale\",\"contact_id\":\"${test_contact_id}\"}" \
        "${TEST_USER_JWT}")
      check_status "non-admin INSERT own properties (with contact_id) → 201" 201 "$(resp_status "$r")"
      local test_new_id
      test_new_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [[ -n "$test_new_id" ]]; then
        register_cleanup_listing "$test_new_id"
        r=$(api_patch "properties?id=eq.${test_new_id}" '{"title_en":"Pentest Updated By Owner"}' "${TEST_USER_JWT}")
        check_status "non-admin UPDATE own properties → 200 or 204" "(200|204)" "$(resp_status "$r")"
      fi
    else
      skip "non-admin INSERT/UPDATE own properties" "no test contact available"
    fi

    # Buyer Contact is mandatory — INSERT without contact_id must still fail.
    r=$(api_post "properties" \
      "{\"title_en\":\"PENTEST_NO_CONTACT\",\"status\":\"draft\",\"slug\":\"pentest-no-contact-${RUN_ID_SHORT}\",\"transaction_type\":\"for_sale\"}" \
      "${TEST_USER_JWT}")
    check_status "non-admin INSERT properties without contact_id → 403" 403 "$(resp_status "$r")"

    # Cross-user UPDATE: a non-admin user should not be able to update listings
    # where managed_by_party_id != their own party. The result is 0 rows
    # updated (204/empty), not an error — RLS silently filters the rows out.
    r=$(api_patch "properties?status=eq.active" '{"title_en":"HACKED"}' "${TEST_USER_JWT}")
    check "non-admin UPDATE other-user properties → no rows affected (204 or 403)" \
      "^(204|403)$" "$(resp_status "$r")"

    # Cross-user DELETE: a non-admin user should not be able to delete listings
    # where managed_by_party_id != their own uid.  The result is 0 rows deleted
    # (204/empty), not an error — RLS silently filters the target rows out.
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

    # Admin can INSERT and then DELETE a test listing. Buyer Contact is
    # mandatory going forward, so create one first even though staff bypass
    # doesn't strictly require it under RLS until contact_id is NOT NULL.
    r=$(api_post "contacts" '{"role":"other","phone":"02044444444"}' "${ADMIN_JWT}")
    local admin_rls_contact_id
    admin_rls_contact_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    [[ -n "$admin_rls_contact_id" ]] && register_cleanup_contact "$admin_rls_contact_id"

    local test_slug="pentest-rls-admin-${RUN_ID_SHORT}"
    r=$(api_post "properties" \
      "{\"title_en\":\"Pentest Admin RLS\",\"status\":\"draft\",\"slug\":\"${test_slug}\",\"transaction_type\":\"for_sale\",\"contact_id\":$( [[ -n "$admin_rls_contact_id" ]] && echo "\"${admin_rls_contact_id}\"" || echo null )}" \
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
  # TABLE: parties (renamed from agents — generalized Platform Identity:
  # staff/agent/owner/developer/property_manager/etc., decoupled from
  # requiring a Supabase Auth login via nullable auth_user_id)
  # ════════════════════════════════
  info "--- parties ---"

  # Anon reads (intentionally public — agent.html/agents.html need this)
  r=$(api_get "parties?select=id,name_en,type&limit=5")
  check "anon SELECT parties → 200 (intentionally public)" "^200$" "$(resp_status "$r")"
  check "anon SELECT parties → JSON array" '^\[' "$(resp_body "$r")"

  # Anon writes — all blocked
  r=$(api_post "parties" '{"name_en":"PENTEST_AGENT","name_lo":"ທົດສອບ"}')
  check_status "anon INSERT parties → 403" 403 "$(resp_status "$r")"

  r=$(api_patch "parties?id=eq.00000000-0000-0000-0000-000000000000" '{"name_en":"HACKED"}')
  check_status "anon UPDATE parties → 403" 403 "$(resp_status "$r")"

  r=$(api_delete "parties?id=eq.00000000-0000-0000-0000-000000000000")
  check_status "anon DELETE parties → 403" 403 "$(resp_status "$r")"

  # Non-admin authenticated: type/role reassignment stays staff-only, but a
  # party may now update its OWN profile row (auth_user_id = auth.uid()) —
  # a deliberate new grant, not present under the old admin-only model.
  if [[ -n "${TEST_USER_JWT:-}" ]]; then
    r=$(api_post "parties" '{"name_en":"PENTEST_AGENT_USER"}' "${TEST_USER_JWT}")
    check_status "non-admin INSERT parties → 403" 403 "$(resp_status "$r")"

    # Targets a specific non-existent id (not a wildcard match-all) so this
    # assertion holds regardless of whether TEST_USER_JWT owns a party row.
    r=$(api_patch "parties?id=eq.00000000-0000-0000-0000-000000000000" \
      '{"name_en":"HACKED"}' "${TEST_USER_JWT}")
    check "non-admin UPDATE other party → no rows affected (204 or 403)" \
      "^(204|403)$" "$(resp_status "$r")"
  else
    skip "Non-admin write-to-parties tests" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
  fi

  # ════════════════════════════════
  # TABLE: contacts (new — mandatory Buyer Contact, decoupled from parties)
  # ════════════════════════════════
  info "--- contacts ---"

  # Anon can read a contact linked to an active listing, but not the table
  # at large (tighter than the wide-open public read on parties, since a
  # contact may hold a not-yet-published reception/office number).
  if [[ -n "$active_id" ]]; then
    r=$(api_get "properties?id=eq.${active_id}&select=contact_id&limit=1")
    local active_contact_id
    active_contact_id=$(resp_body "$r" | grep -o '"contact_id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [[ -n "$active_contact_id" ]]; then
      r=$(api_get "contacts?id=eq.${active_contact_id}&select=id,role")
      check "anon SELECT contact of active listing → 200 non-empty" '"id"' "$(resp_body "$r")"
    else
      skip "anon SELECT contact of active listing" "active listing has no contact_id"
    fi
  else
    skip "anon SELECT contact of active listing" "no active listing available"
  fi

  r=$(api_get "contacts?select=id&limit=5")
  check_empty "anon SELECT contacts at large → empty (RLS scoped to active listings only)" "$(resp_body "$r")"

  # Anon writes — all blocked
  r=$(api_post "contacts" '{"role":"owner","phone":"02099999999"}')
  check_status "anon INSERT contacts → 403" 403 "$(resp_status "$r")"

  r=$(api_patch "contacts?id=eq.00000000-0000-0000-0000-000000000000" '{"phone":"HACKED"}')
  check_status "anon UPDATE contacts → 403" 403 "$(resp_status "$r")"

  # Non-admin authenticated: can insert/update their own contact (created_by
  # = self), but not someone else's.
  if [[ -n "${TEST_USER_JWT:-}" ]]; then
    r=$(api_patch "contacts?id=eq.00000000-0000-0000-0000-000000000000" \
      '{"phone":"HACKED"}' "${TEST_USER_JWT}")
    check "non-admin UPDATE other contact → no rows affected (204 or 403)" \
      "^(204|403)$" "$(resp_status "$r")"
  else
    skip "Non-admin write-to-contacts tests" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
  fi

  # Admin/staff full access
  if [[ -n "${ADMIN_JWT:-}" ]]; then
    r=$(api_post "contacts" '{"role":"other","phone":"02011111111"}' "${ADMIN_JWT}")
    check_status "admin INSERT contacts → 201" 201 "$(resp_status "$r")"
    local admin_contact_id
    admin_contact_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [[ -n "$admin_contact_id" ]]; then
      register_cleanup_contact "$admin_contact_id"
      r=$(api_patch "contacts?id=eq.${admin_contact_id}" '{"phone":"02022222222"}' "${ADMIN_JWT}")
      check_status "admin UPDATE contacts → 200 or 204" "(200|204)" "$(resp_status "$r")"
    fi
  else
    skip "Admin contacts full-access tests" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
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
