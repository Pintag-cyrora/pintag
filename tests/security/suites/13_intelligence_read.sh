#!/usr/bin/env bash
# Suite 13 (production) — Intelligence tables, read paths only
#
# @suite    Intelligence (read)
# @purpose  Verify the Intelligence tables expose nothing to an anonymous visitor. GET requests only.
# @covers   table:intelligence_reports table:intelligence_insights table:report_insights table:intelligence_sweep_lock
# @needs    none
# @runtime  ~5s
#
# Not probed on production: calls to generate-intelligence-report (Gemini-backed; any call is a potential external side effect and cost, whatever its
# authentication gate returns) and anonymous INSERT/UPDATE/DELETE on these tables. The functions' admin gate is exercised locally with a mocked network
# (edge-function-auth-gates.test.js) and the table write policies against a throwaway database (rls_regression.sql section M).

run_intelligence_read_tests() {
  suite_start "Intelligence (read)"

  local r
  for t in intelligence_reports intelligence_insights; do
    r=$(api_get "${t}?select=id&limit=5")
    check_empty "anon SELECT ${t} → empty (staff-only)" "$(resp_body "$r")"
  done
  r=$(api_get "report_insights?select=report_id&limit=5")
  check_empty "anon SELECT report_insights → empty (staff-only)" "$(resp_body "$r")"
  r=$(api_get "intelligence_sweep_lock?select=id")
  check_empty "anon SELECT intelligence_sweep_lock → empty (no policy for any role)" "$(resp_body "$r")"

  skip "generate-intelligence-report authentication gate and anonymous writes on the Intelligence tables" \
    "not sent to production (external side effects / writes); covered by edge-function-auth-gates.test.js and rls_regression.sql section M"

  suite_end
}
