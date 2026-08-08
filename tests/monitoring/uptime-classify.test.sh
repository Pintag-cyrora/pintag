#!/usr/bin/env bash
# ============================================================================
# Test for the "Uptime — public site" classifier in
# .github/workflows/monitoring.yml.
#
# pintag.io is fronted by a Cloudflare Worker. While MAINTENANCE_MODE is on
# (cloudflare-worker/og-listing-preview.js), the public browsing pages are
# served an "Under Maintenance" page as HTTP 503 + Retry-After — an
# INTENTIONAL, healthy state. The monitor must NOT treat that as an incident,
# while STILL alerting on a genuine unexpected 503 (or any other 4xx/5xx).
#
# The monitoring workflow has no `actions/checkout`, so its step cannot source
# this file. classify_uptime() below is kept byte-identical to the inline
# snippet in that workflow step — change both together.
# ============================================================================
set -u

# ── classify_uptime <http_code> <body>  → prints a status line;
#    return 0 = healthy (live or intentional maintenance), 1 = incident.
#    KEEP IDENTICAL to .github/workflows/monitoring.yml "Uptime — public site".
classify_uptime() {
  code="$1"; body="$2"
  echo "pintag.io → $code"
  case "$code" in
    2*|3*)
      echo "Public site is live."; return 0 ;;
    503)
      if printf '%s' "$body" | grep -qi 'maintenance'; then
        echo "Public site is in INTENTIONAL maintenance (503 + maintenance page). Not an incident."; return 0
      else
        echo "::error::Public site returned 503 without the maintenance page — unexpected outage"; return 1
      fi ;;
    *)
      echo "::error::Public site returned $code"; return 1 ;;
  esac
}

# Representative bodies. The maintenance body only needs to contain the marker
# the real Worker page carries (title "… / Under Maintenance", "scheduled
# maintenance"); a Cloudflare/origin 503 carries neither.
MAINT_BODY='<!doctype html><title>Pintag — ບຳລຸງຮັກສາລະບົບ / Under Maintenance</title><p>Pintag is temporarily offline for scheduled maintenance.</p>'
CF_503_BODY='<html><head><title>503 Service Temporarily Unavailable</title></head><body><center>cloudflare</center></body></html>'

pass=0; fail=0
check() { # <desc> <expected_return> <code> <body>
  desc="$1"; want="$2"; code="$3"; body="$4"
  classify_uptime "$code" "$body" >/dev/null 2>&1; got=$?
  if [ "$got" -eq "$want" ]; then printf 'PASS  %-42s (return %d)\n' "$desc" "$got"; pass=$((pass+1))
  else printf 'FAIL  %-42s (want %d, got %d)\n' "$desc" "$want" "$got"; fail=$((fail+1)); fi
}

echo "── monitoring uptime classifier ──"
check "200 → live"                          0 200 ""
check "301 → live (redirect)"               0 301 ""
check "503 + maintenance page → OK"         0 503 "$MAINT_BODY"
check "503 without maintenance → incident"  1 503 "$CF_503_BODY"
check "500 → incident"                      1 500 ""
check "403 → incident"                      1 403 ""
check "000 (dns/timeout) → incident"        1 000 ""
echo "── $pass passed, $fail failed ──"
[ "$fail" -eq 0 ]
