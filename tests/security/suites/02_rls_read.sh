#!/usr/bin/env bash
# Suite 02 (production) — RLS, read paths only
#
# @suite    RLS (read)
# @purpose  Verify what an anonymous visitor can and cannot READ. GET requests only: this suite creates, changes and deletes nothing.
# @covers   table:properties table:parties table:contacts table:lead_events table:listing_events
# @needs    none
# @runtime  ~10s
#
# Write-path policies (anonymous INSERT/UPDATE/DELETE denied on properties, parties, contacts, lead_events, listing_events, intelligence_*, report_insights;
# administrator AAL1 denied / AAL2 allowed; deduplication and ceilings) are NOT probed on production. They are asserted against a throwaway database in
# tests/security/regression/rls_regression.sql (sections H, L and M), and the full credentialed flow lives in tests/security/staging-suites/ (disabled until
# an isolated staging project exists). Production-side drift of write policies is therefore NOT detected by this live suite; see tests/security/README.md.

run_rls_read_tests() {
  suite_start "RLS (read)"

  local r body active_id active_contact_id

  r=$(api_get "properties?status=eq.active&select=id&limit=1")
  active_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  [[ -z "$active_id" ]] && info "No active listings found — the contact read test will be skipped"

  info "--- properties ---"
  r=$(api_get "properties?status=eq.active&select=id,status&limit=5")
  check "anon SELECT active properties → 200" "^200$" "$(resp_status "$r")"
  check "anon SELECT active properties → JSON array" '^\[' "$(resp_body "$r")"
  for st in draft sold inactive; do
    r=$(api_get "properties?status=eq.${st}&select=id,status")
    check_empty "anon SELECT ${st} properties → empty (RLS filter)" "$(resp_body "$r")"
  done

  info "--- parties ---"
  r=$(api_get "parties?select=id,name_en,type&limit=5")
  check "anon SELECT parties → 200 (intentionally public)" "^200$" "$(resp_status "$r")"
  check "anon SELECT parties → JSON array" '^\[' "$(resp_body "$r")"

  info "--- contacts ---"
  if [[ -n "$active_id" ]]; then
    r=$(api_get "properties?id=eq.${active_id}&select=contact_id&limit=1")
    active_contact_id=$(resp_body "$r" | grep -o '"contact_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
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
  check "anon SELECT contacts → JSON array (active-listing contacts are intentionally public)" '^\[' "$(resp_body "$r")"

  info "--- lead_events / listing_events ---"
  r=$(api_get "lead_events?limit=5")
  check_empty "anon SELECT lead_events → empty (no SELECT policy)" "$(resp_body "$r")"
  # Anon CAN read listing_events by design: prod policy "anon dedup read listing_events" (single-admin lockdown) is FOR SELECT TO anon USING (true).
  r=$(api_get "listing_events?limit=5")
  check "anon SELECT listing_events → readable (intentional anon dedup-read policy)" '^\[' "$(resp_body "$r")"

  skip "anonymous INSERT / UPDATE / DELETE refusals on properties, parties, contacts, lead_events, listing_events" \
    "write probes are never sent to production; asserted against a throwaway database (rls_regression.sql sections H, L, M) — production policy drift on write paths is not detected here"

  suite_end
}
