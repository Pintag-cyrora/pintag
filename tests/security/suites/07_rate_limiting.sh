#!/usr/bin/env bash
# Suite 07 — Rate Limiting
#
# @suite    Rate Limiting
# @purpose  Verify 30-second dedup on lead_events and 30-minute dedup on listing_events
# @covers   table:properties table:lead_events table:listing_events
# @needs    none
# @runtime  ~15s

run_rate_limiting_tests() {
  suite_start "Rate Limiting"

  local r body status active_id

  # Discover an active listing
  r=$(api_get "properties?status=eq.active&select=id&limit=1")
  active_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [[ -z "$active_id" ]]; then
    skip "All rate limiting tests" "no active listing found"
    suite_end
    return
  fi
  info "Using active listing: $active_id"

  # ════════════════════════════════
  # lead_events: 30-second window
  # ════════════════════════════════
  info "--- lead_events (30-second dedup) ---"

  local session="pentest-rl-${RUN_ID_SHORT}"

  # First request — should succeed
  r=$(api_post "lead_events" \
    "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp_click\",\"session_id\":\"${session}\"}")
  check_status "first lead_event insert → 201" 201 "$(resp_status "$r")"

  # Immediate repeat — same listing + event_type = blocked.
  # Accept 401 or 403: this Supabase project surfaces an RLS WITH CHECK denial
  # (the per-session dedup in check_lead_rate_limit) as 401, same convention as
  # the Group A anon-write assertions. Either status means the write was denied.
  r=$(api_post "lead_events" \
    "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp_click\",\"session_id\":\"${session}\"}")
  check "duplicate lead_event within 30s → denied (401/403)" '^(401|403)$' "$(resp_status "$r")"

  # Different event_type on same listing — allowed
  r=$(api_post "lead_events" \
    "{\"listing_id\":\"${active_id}\",\"event_type\":\"call_click\",\"session_id\":\"${session}\"}")
  check_status "different event_type same session → 201 (not rate-limited)" 201 "$(resp_status "$r")"

  # Different session ID — allowed. The lead limit is scoped PER SESSION
  # (check_lead_rate_limit(listing_id, event_type, session_id) in migration
  # 20260811000000), so one visitor's clicks never block another visitor's.
  local session2="pentest-rl2-${RUN_ID_SHORT}"
  r=$(api_post "lead_events" \
    "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp_click\",\"session_id\":\"${session2}\"}")
  check_status "different session, same listing+event → 201 (independent limit)" 201 "$(resp_status "$r")"

  # Flood: 5 rapid requests from same session — all should be blocked
  info "Flood test: 5 rapid repeated whatsapp events from session ${session}..."
  local blocked=0
  for i in 1 2 3 4 5; do
    r=$(api_post "lead_events" \
      "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp_click\",\"session_id\":\"${session}\"}")
    # 401 or 403 both mean the dedup/rate-limit denied the write (see above).
    [[ "$(resp_status "$r")" =~ ^(401|403)$ ]] && blocked=$((blocked+1))
  done
  check "flood: all 5 rapid repeats blocked (rate limit holds)" "^5$" "$blocked"

  # ════════════════════════════════
  # listing_events: 30-minute dedup
  # ════════════════════════════════
  info "--- listing_events (30-minute dedup) ---"

  local ev_session="pentest-ev-rl-${RUN_ID_SHORT}"

  r=$(api_post "listing_events" \
    "{\"property_id\":\"${active_id}\",\"event_type\":\"view\",\"session_id\":\"${ev_session}\"}")
  check_status "first listing_event insert → 201" 201 "$(resp_status "$r")"

  # Accept 401 or 403: the per-session dedup (check_listing_event_dedup) denial
  # surfaces as 401 on this project, same as Group A.
  r=$(api_post "listing_events" \
    "{\"property_id\":\"${active_id}\",\"event_type\":\"view\",\"session_id\":\"${ev_session}\"}")
  check "duplicate listing_event (same session+property+event) → denied (401/403)" '^(401|403)$' "$(resp_status "$r")"

  # Different event_type — allowed
  r=$(api_post "listing_events" \
    "{\"property_id\":\"${active_id}\",\"event_type\":\"share\",\"session_id\":\"${ev_session}\"}")
  check_status "different event_type listing_event → 201 (not deduped)" 201 "$(resp_status "$r")"

  suite_end
}
