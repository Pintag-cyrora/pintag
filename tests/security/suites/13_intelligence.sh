#!/usr/bin/env bash
# Suite 13 — Intelligence Layer
#
# @suite    Intelligence
# @purpose  Verify RLS isolation on the Intelligence tables and auth gating on generate-intelligence-report
# @covers   fn:generate-intelligence-report table:intelligence_reports table:intelligence_insights table:report_insights table:intelligence_sweep_lock
# @needs    optional:ADMIN_EMAIL,ADMIN_PASSWORD optional:TEST_USER_EMAIL,TEST_USER_PASSWORD
# @runtime  ~15s

run_intelligence_tests() {
  suite_start "Intelligence"

  local r body

  # ════════════════════════════════════
  # generate-intelligence-report — auth gating only.
  #
  # Deliberately NOT tested here: a successful invocation with a valid staff
  # JWT or the service-role key. Unlike the other Edge Functions in Suite 03
  # (which can be probed with a garbage payload that fails gracefully after
  # auth passes), this function has no dry-run mode — any request that clears
  # requireStaffOrService() proceeds to call Gemini and write real rows to
  # intelligence_reports/intelligence_insights. Running that on every CI push
  # would mean a real Gemini charge (and real data) per run, so this suite
  # only exercises the boundary that must reject before any of that happens.
  # ════════════════════════════════════
  info "--- generate-intelligence-report ---"

  r=$(fn_post "generate-intelligence-report" '{"report_type":"daily"}')
  check_status "no token → 401" 401 "$(resp_status "$r")"
  body="$(resp_body "$r")"
  check "no token: error body is JSON" '^\{' "$body"
  if echo "$body" | grep -qi "at Object\.\|stacktrace\|SUPABASE_URL\|SUPABASE_SERVICE_ROLE_KEY\|GEMINI_API_KEY\|pg_exception\|SQLSTATE"; then
    fail_hard "generate-intelligence-report: 401 must not expose internals" \
      "Internal details found in 401 body: ${body:0:120}"
  else
    check "no token: no internals exposed in error body" "." "no-internals"
  fi

  r=$(fn_post "generate-intelligence-report" '{"report_type":"daily"}' "${SUPABASE_ANON_KEY}")
  check_status "anon-role JWT → 401" 401 "$(resp_status "$r")"

  # A syntactically-invalid bearer token must also be rejected, not crash
  # into a 500 (requireStaffOrService's /auth/v1/user lookup should just
  # report "Invalid token").
  r=$(fn_post "generate-intelligence-report" '{"report_type":"daily"}' "not-a-real-jwt")
  check "garbage bearer token → 4xx (not a 500 crash)" "^4" "$(resp_status "$r")"

  # ════════════════════════════════════
  # TABLE: intelligence_reports (staff-only SELECT + DELETE; every write is
  # performed by the Edge Function's service-role key, which bypasses RLS —
  # no client role, including staff, has an INSERT/UPDATE policy at all)
  # ════════════════════════════════════
  info "--- intelligence_reports ---"

  r=$(api_get "intelligence_reports?select=id&limit=5")
  check_empty "anon SELECT intelligence_reports → empty (staff-only)" "$(resp_body "$r")"

  r=$(api_post "intelligence_reports" '{"report_type":"daily","period_start":"2026-01-01","period_end":"2026-01-01"}')
  check_status "anon INSERT intelligence_reports → 403" 403 "$(resp_status "$r")"

  r=$(api_patch "intelligence_reports?id=eq.00000000-0000-0000-0000-000000000000" '{"title":"HACKED"}')
  check_status "anon UPDATE intelligence_reports → 403" 403 "$(resp_status "$r")"

  r=$(api_delete "intelligence_reports?id=eq.00000000-0000-0000-0000-000000000000")
  check_status "anon DELETE intelligence_reports → 403" 403 "$(resp_status "$r")"

  if [[ -n "${TEST_USER_JWT:-}" ]]; then
    r=$(api_get "intelligence_reports?select=id&limit=5" "${TEST_USER_JWT}")
    check_empty "non-admin SELECT intelligence_reports → empty (not staff)" "$(resp_body "$r")"

    r=$(api_post "intelligence_reports" '{"report_type":"daily","period_start":"2026-01-01","period_end":"2026-01-01"}' "${TEST_USER_JWT}")
    check_status "non-admin INSERT intelligence_reports → 403" 403 "$(resp_status "$r")"
  else
    skip "non-admin intelligence_reports tests" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
  fi

  if [[ -n "${ADMIN_JWT:-}" ]]; then
    r=$(api_get "intelligence_reports?select=id,report_type,status&limit=5" "${ADMIN_JWT}")
    check_status "admin SELECT intelligence_reports → 200" 200 "$(resp_status "$r")"
    check "admin SELECT intelligence_reports → JSON array (possibly empty)" '^\[' "$(resp_body "$r")"

    # DELETE against a non-existent id exercises the staff DELETE policy
    # itself (grants access, matches 0 rows) without touching any real
    # report — RLS returns 204 whether or not a row matched.
    r=$(api_delete "intelligence_reports?id=eq.00000000-0000-0000-0000-000000000000" "${ADMIN_JWT}")
    check_status "admin DELETE intelligence_reports (no matching row) → 204" 204 "$(resp_status "$r")"

    # Staff has no INSERT/UPDATE grant either — only the service-role key
    # (used exclusively by the Edge Function) can write these tables.
    r=$(api_post "intelligence_reports" '{"report_type":"daily","period_start":"2026-01-01","period_end":"2026-01-01"}' "${ADMIN_JWT}")
    check_status "admin INSERT intelligence_reports → 403 (no client-role write policy, by design)" 403 "$(resp_status "$r")"
  else
    skip "Admin intelligence_reports tests" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  # ════════════════════════════════════
  # TABLE: intelligence_insights (staff-only SELECT; no client-role write at all)
  # ════════════════════════════════════
  info "--- intelligence_insights ---"

  r=$(api_get "intelligence_insights?select=id&limit=5")
  check_empty "anon SELECT intelligence_insights → empty (staff-only)" "$(resp_body "$r")"

  r=$(api_post "intelligence_insights" \
    '{"type":"demand_spike","metric_key":"test","title":"PENTEST","evidence":{},"first_seen":"2026-01-01","last_seen":"2026-01-01"}')
  check_status "anon INSERT intelligence_insights → 403" 403 "$(resp_status "$r")"

  r=$(api_patch "intelligence_insights?id=eq.00000000-0000-0000-0000-000000000000" '{"title":"HACKED"}')
  check_status "anon UPDATE intelligence_insights → 403" 403 "$(resp_status "$r")"

  if [[ -n "${TEST_USER_JWT:-}" ]]; then
    r=$(api_get "intelligence_insights?select=id&limit=5" "${TEST_USER_JWT}")
    check_empty "non-admin SELECT intelligence_insights → empty (not staff)" "$(resp_body "$r")"
  else
    skip "non-admin intelligence_insights SELECT test" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
  fi

  if [[ -n "${ADMIN_JWT:-}" ]]; then
    r=$(api_get "intelligence_insights?select=id,type,severity&limit=5" "${ADMIN_JWT}")
    check_status "admin SELECT intelligence_insights → 200" 200 "$(resp_status "$r")"
    check "admin SELECT intelligence_insights → JSON array (possibly empty)" '^\[' "$(resp_body "$r")"

    r=$(api_post "intelligence_insights" \
      '{"type":"demand_spike","metric_key":"test","title":"PENTEST","evidence":{},"first_seen":"2026-01-01","last_seen":"2026-01-01"}' \
      "${ADMIN_JWT}")
    check_status "admin INSERT intelligence_insights → 403 (no client-role write policy, by design)" 403 "$(resp_status "$r")"
  else
    skip "Admin intelligence_insights tests" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  # ════════════════════════════════════
  # TABLE: report_insights (staff-only SELECT; no client-role write at all)
  # ════════════════════════════════════
  info "--- report_insights ---"

  r=$(api_get "report_insights?select=report_id&limit=5")
  check_empty "anon SELECT report_insights → empty (staff-only)" "$(resp_body "$r")"

  r=$(api_post "report_insights" \
    '{"report_id":"00000000-0000-0000-0000-000000000000","insight_id":"00000000-0000-0000-0000-000000000000","role":"mentioned"}')
  check_status "anon INSERT report_insights → 403" 403 "$(resp_status "$r")"

  if [[ -n "${ADMIN_JWT:-}" ]]; then
    r=$(api_get "report_insights?select=report_id,insight_id,role&limit=5" "${ADMIN_JWT}")
    check_status "admin SELECT report_insights → 200" 200 "$(resp_status "$r")"
    check "admin SELECT report_insights → JSON array (possibly empty)" '^\[' "$(resp_body "$r")"
  else
    skip "Admin report_insights tests" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  # ════════════════════════════════════
  # TABLE: intelligence_sweep_lock — internal coordination primitive only.
  # RLS is enabled with ZERO policies for ANY role, including staff — this
  # table exists purely for the Edge Function's own service-role-key writes
  # (which bypass RLS) to serialize concurrent daily sweeps. Nobody, not
  # even an authenticated staff member, should be able to read or write it
  # via the REST API. This is intentional and matches the migration's own
  # comment ("not data anyone has a reason to read via the API").
  # ════════════════════════════════════
  info "--- intelligence_sweep_lock ---"

  r=$(api_get "intelligence_sweep_lock?select=id")
  check_empty "anon SELECT intelligence_sweep_lock → empty (no policy for any role)" "$(resp_body "$r")"

  if [[ -n "${ADMIN_JWT:-}" ]]; then
    r=$(api_get "intelligence_sweep_lock?select=id" "${ADMIN_JWT}")
    check_empty "admin SELECT intelligence_sweep_lock → empty (no SELECT policy even for staff, by design)" "$(resp_body "$r")"
  else
    skip "Admin intelligence_sweep_lock test" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  suite_end
}
