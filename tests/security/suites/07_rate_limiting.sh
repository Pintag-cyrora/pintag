#!/usr/bin/env bash
# Suite 07 — Rate Limiting
# Verifies throttling on lead_events (30-second window per listing+event_type)
# and listing_events (30-minute dedup per session+property+event_type).

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

  local session="pentest-rl-$(date +%s)"

  # First request — should succeed
  r=$(api_post "lead_events" \
    "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp\",\"session_id\":\"${session}\"}")
  check_status "first lead_event insert → 201" 201 "$(resp_status "$r")"

  # Immediate repeat — same listing + event_type = blocked
  r=$(api_post "lead_events" \
    "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp\",\"session_id\":\"${session}\"}")
  check_status "duplicate lead_event within 30s → 403" 403 "$(resp_status "$r")"

  # Different event_type on same listing — allowed
  r=$(api_post "lead_events" \
    "{\"listing_id\":\"${active_id}\",\"event_type\":\"phone\",\"session_id\":\"${session}\"}")
  check_status "different event_type same session → 201 (not rate-limited)" 201 "$(resp_status "$r")"

  # Different session ID — allowed (rate limit is per listing+event_type, not global)
  local session2="pentest-rl2-$(date +%s)"
  r=$(api_post "lead_events" \
    "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp\",\"session_id\":\"${session2}\"}")
  check_status "different session, same listing+event → 201 (independent limit)" 201 "$(resp_status "$r")"

  # Flood: 5 rapid requests from same session — all should be blocked
  info "Flood test: 5 rapid repeated whatsapp events from session ${session}..."
  local blocked=0
  for i in 1 2 3 4 5; do
    r=$(api_post "lead_events" \
      "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp\",\"session_id\":\"${session}\"}")
    [[ "$(resp_status "$r")" == "403" ]] && blocked=$((blocked+1))
  done
  check "flood: all 5 rapid repeats blocked (rate limit holds)" "^5$" "$blocked"

  # ════════════════════════════════
  # listing_events: 30-minute dedup
  # ════════════════════════════════
  info "--- listing_events (30-minute dedup) ---"

  local ev_session="pentest-ev-rl-$(date +%s)"

  r=$(api_post "listing_events" \
    "{\"property_id\":\"${active_id}\",\"event_type\":\"view\",\"session_id\":\"${ev_session}\"}")
  check_status "first listing_event insert → 201" 201 "$(resp_status "$r")"

  r=$(api_post "listing_events" \
    "{\"property_id\":\"${active_id}\",\"event_type\":\"view\",\"session_id\":\"${ev_session}\"}")
  check_status "duplicate listing_event (same session+property+event) → 403" 403 "$(resp_status "$r")"

  # Different event_type — allowed
  r=$(api_post "listing_events" \
    "{\"property_id\":\"${active_id}\",\"event_type\":\"share\",\"session_id\":\"${ev_session}\"}")
  check_status "different event_type listing_event → 201 (not deduped)" 201 "$(resp_status "$r")"

  suite_end
}
