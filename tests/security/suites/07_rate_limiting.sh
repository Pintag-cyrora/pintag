#!/usr/bin/env bash
# Suite 07 — Rate Limiting
#
# @suite    Rate Limiting
# @purpose  Production-safe checks on the analytics insert paths (rejection of invalid references, no anonymous read of leads).
#           The behaviour that needs a SUCCESSFUL insert (deduplication, per-listing ceilings) runs in rls_regression.sql against a throwaway database.
# @covers   table:properties table:lead_events table:listing_events
# @needs    none
# @runtime  ~5s

run_rate_limiting_tests() {
  suite_start "Rate Limiting"

  local r

  # This suite targets PRODUCTION. It therefore creates nothing: no analytics event, no lead. What it can prove over anonymous HTTP without a
  # successful insert is that invalid references are rejected. It does NOT prove that a legitimate event is accepted or that deduplication or the
  # per-listing ceiling work; those need a successful insert and are asserted in tests/security/regression/rls_regression.sql
  # (sections H and L) against a throwaway PostgreSQL database that gates every pull request.
  info "--- lead_events ---"
  r=$(api_post "lead_events" \
    '{"listing_id":"00000000-0000-0000-0000-000000000000","event_type":"whatsapp_click","session_id":"pentest-rl-nil-reference"}')
  check "anon lead_events insert (nil-UUID listing reference) → rejected (401/403)" '^(401|403)$' "$(resp_status "$r")"

  info "--- listing_events ---"
  r=$(api_post "listing_events" \
    '{"property_id":"00000000-0000-0000-0000-000000000000","event_type":"view","session_id":"pentest-rl-nil-reference"}')
  check "anon listing_events insert (nil-UUID property reference) → rejected (401/403)" '^(401|403)$' "$(resp_status "$r")"
  r=$(api_post "listing_events" \
    '{"property_id":"00000000-0000-0000-0000-000000000000","event_type":"share","session_id":"pentest-rl-nil-reference"}')
  check "anon listing_events insert, other event type (nil-UUID reference) → rejected (401/403)" '^(401|403)$' "$(resp_status "$r")"

  skip "listing_events first insert accepted / duplicate refused / different type accepted / ceiling" \
    "needs a successful insert; verified against a throwaway PostgreSQL database (rls_regression.sql section L), never against production"
  skip "lead_events per-session deduplication and flood ceiling" \
    "needs a successful insert; verified against a throwaway PostgreSQL database (rls_regression.sql section H), never against production"

  suite_end
}
