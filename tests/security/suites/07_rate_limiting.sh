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
  # lead_events: per-session rate limit
  # ════════════════════════════════
  info "--- lead_events (per-session rate limit) ---"

  local session="pentest-rl-${RUN_ID_SHORT}"

  # lead_events intentionally has NO anon SELECT policy (only admins read leads),
  # so a return=representation POST fails its RETURNING read-back even when the
  # INSERT WITH CHECK passes — anon simply cannot read a lead back. We assert
  # exactly that denial. NOTE: this does NOT mean anon can't record leads — the
  # live app inserts with Prefer: return=minimal (listing.html postEvent), which
  # needs no read-back and succeeds; it means anon can't READ lead_events.
  r=$(api_post "lead_events" \
    "{\"listing_id\":\"${active_id}\",\"event_type\":\"whatsapp_click\",\"session_id\":\"${session}\"}")
  check "anon lead_events insert (return=representation) → denied read-back (401/403)" '^(401|403)$' "$(resp_status "$r")"

  # The per-session dedup / flood behaviour of check_lead_rate_limit is NOT
  # exercised over the anon HTTP path on purpose. A successful insert would fire
  # the create_lead_from_event trigger and materialise real rows in the
  # production leads CRM (this suite runs against production). The control is
  # enforced in the database (migration 20260811000000, check_lead_rate_limit)
  # and verified there rather than by writing test leads to a live agent's CRM.
  skip "lead_events per-session dedup (first insert / duplicate / different-session / flood)" \
    "would persist test leads to the production CRM; enforced + verified at the DB level (20260811000000)"

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
