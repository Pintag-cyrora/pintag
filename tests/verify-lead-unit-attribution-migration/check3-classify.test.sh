#!/usr/bin/env bash
# ============================================================================
# Test for Check 3's classify()/verdict logic in
# .github/workflows/verify-lead-unit-attribution-migration.yml
# ("Check 3 — PostgREST schema-cache recognition (GET only, no INSERT)").
#
# Check 3 sends two anon-key, read-only select probes (lead_events, leads)
# and must land on exactly one of THREE outcomes, never silently upgrading
# an inconclusive result to a pass:
#   * RESOLVED          — HTTP 200. Decisive proof PostgREST executed the
#                          query (which requires every requested column to
#                          already be in its schema cache).
#   * SCHEMA_CACHE_MISS  — not 200, body carries an explicit missing-column
#                          signature (PGRST204 / "does not exist" / 42703).
#                          Decisive proof the column is NOT recognized.
#   * UNVERIFIED         — neither of the above (an unrelated 401/403/5xx,
#                          a timeout, a malformed/empty body). Proves
#                          nothing either way about the schema cache, so it
#                          must never be treated as a pass.
#
# Overall verdict, across the two probes:
#   * either probe SCHEMA_CACHE_MISS  → FAIL (explicit evidence of a miss)
#   * else either probe UNVERIFIED    → FAIL, reported as UNVERIFIED (fails
#                                        closed, distinct message from the
#                                        explicit-miss FAIL above)
#   * else (both RESOLVED)            → PASS
#
# The workflow has no `actions/checkout` step of its own reusable by a test,
# so classify()/verdict() below are kept byte-identical to the inline
# snippets in that workflow step (same convention as
# tests/monitoring/uptime-classify.test.sh) — change both together.
# ============================================================================
set -u

# ── classify <http_code> <body> → prints RESOLVED | SCHEMA_CACHE_MISS |
#    UNVERIFIED. KEEP IDENTICAL to the workflow's own classify().
classify() {
  local http_code="$1"
  local body="$2"
  if [ "$http_code" = "200" ]; then
    echo "RESOLVED"
  elif echo "$body" | grep -qiE 'does not exist|PGRST204|42703'; then
    echo "SCHEMA_CACHE_MISS"
  else
    echo "UNVERIFIED"
  fi
}

# ── verdict <le_class> <l_class> → prints PASS | FAIL | UNVERIFIED and
#    returns 0 for PASS, 1 otherwise. KEEP IDENTICAL to the workflow's own
#    if/elif precedence (explicit miss checked before UNVERIFIED).
verdict() {
  local le="$1" l="$2"
  if [ "$le" = "SCHEMA_CACHE_MISS" ] || [ "$l" = "SCHEMA_CACHE_MISS" ]; then
    echo "FAIL"; return 1
  fi
  if [ "$le" = "UNVERIFIED" ] || [ "$l" = "UNVERIFIED" ]; then
    echo "UNVERIFIED"; return 1
  fi
  echo "PASS"; return 0
}

# Representative bodies for each of the three per-probe categories.
EMPTY_ARRAY_BODY='[]'
DATA_BODY='[{"unit_type_id":null,"unit_id":null}]'
PGRST204_BODY='{"code":"PGRST204","message":"Could not find the '"'"'unit_type_id'"'"' column of '"'"'lead_events'"'"' in the schema cache"}'
DOES_NOT_EXIST_BODY='{"code":"42703","message":"column lead_events.unit_type_id does not exist"}'
GATEWAY_401_BODY='{"message":"Invalid API key","hint":"Only the `service_role` API key can be used for this endpoint."}'
CF_5XX_BODY='<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>'
MALFORMED_BODY=''
RLS_PERMISSION_BODY='{"code":"42501","message":"permission denied for table lead_events"}'

pass=0; fail=0
check() { # <desc> <expected_output> <code> <body>
  desc="$1"; want="$2"; code="$3"; body="$4"
  got="$(classify "$code" "$body")"
  if [ "$got" = "$want" ]; then printf 'PASS  %-58s (classify → %s)\n' "$desc" "$got"; pass=$((pass+1))
  else printf 'FAIL  %-58s (want %s, got %s)\n' "$desc" "$want" "$got"; fail=$((fail+1)); fi
}
check_verdict() { # <desc> <expected_output> <le_class> <l_class>
  desc="$1"; want="$2"; le="$3"; l="$4"
  got="$(verdict "$le" "$l")"
  if [ "$got" = "$want" ]; then printf 'PASS  %-58s (verdict → %s)\n' "$desc" "$got"; pass=$((pass+1))
  else printf 'FAIL  %-58s (want %s, got %s)\n' "$desc" "$want" "$got"; fail=$((fail+1)); fi
}

echo "── per-probe classify(): category 1 — HTTP 200 → RESOLVED ──"
check "200 + empty array"                                  RESOLVED 200 "$EMPTY_ARRAY_BODY"
check "200 + real row data"                                RESOLVED 200 "$DATA_BODY"
check "200 with a body that ACCIDENTALLY mentions PGRST204" RESOLVED 200 "$PGRST204_BODY"

echo ""
echo "── per-probe classify(): category 2 — explicit schema-cache miss → SCHEMA_CACHE_MISS ──"
check "PGRST204 code, non-200"                              SCHEMA_CACHE_MISS 400 "$PGRST204_BODY"
check "42703 code, non-200"                                 SCHEMA_CACHE_MISS 404 "$DOES_NOT_EXIST_BODY"
check "\"does not exist\" text, non-200"                    SCHEMA_CACHE_MISS 400 "column unit_id does not exist"

echo ""
echo "── per-probe classify(): category 3 — unrelated failure → UNVERIFIED, never PASS ──"
check "401 gateway/API-key error (not a schema-cache signature)" UNVERIFIED 401 "$GATEWAY_401_BODY"
check "403 RLS/permission-denied (not a missing-column signature)" UNVERIFIED 403 "$RLS_PERMISSION_BODY"
check "502 Cloudflare gateway error"                        UNVERIFIED 502 "$CF_5XX_BODY"
check "500 empty body"                                      UNVERIFIED 500 "$MALFORMED_BODY"
check "000 (curl timeout/DNS failure), empty body"          UNVERIFIED 000 "$MALFORMED_BODY"

echo ""
echo "── overall verdict(): combining both probes ──"
check_verdict "both RESOLVED → PASS"                        PASS  RESOLVED RESOLVED
check_verdict "one SCHEMA_CACHE_MISS, one RESOLVED → FAIL"  FAIL  SCHEMA_CACHE_MISS RESOLVED
check_verdict "both SCHEMA_CACHE_MISS → FAIL"                FAIL  SCHEMA_CACHE_MISS SCHEMA_CACHE_MISS
check_verdict "one UNVERIFIED, one RESOLVED → UNVERIFIED, not PASS" UNVERIFIED RESOLVED UNVERIFIED
check_verdict "one SCHEMA_CACHE_MISS, one UNVERIFIED → FAIL (miss takes precedence)" FAIL SCHEMA_CACHE_MISS UNVERIFIED
check_verdict "both UNVERIFIED → UNVERIFIED"                UNVERIFIED UNVERIFIED UNVERIFIED

echo ""
echo "── $pass passed, $fail failed ──"
[ "$fail" -eq 0 ]
