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

# ── classify_uptime <http_code> <body> <cf_mitigated>  → prints a status line;
#    return 0 = healthy (live, intentional maintenance, or an expected
#    Cloudflare bot challenge), 1 = incident.
#    KEEP IDENTICAL to .github/workflows/monitoring.yml
#    "Uptime — public HTML surface (secondary)".
classify_uptime() {
  code="$1"; body="$2"; mit="${3:-}"
  echo "pintag.io → $code (cf-mitigated: ${mit:-none})"
  case "$code" in
    2*|3*)
      echo "Public site is live."; return 0 ;;
    403)
      if [ -n "$mit" ]; then
        echo "::warning::HTML surface returned 403 with cf-mitigated=$mit — expected Cloudflare Bot Fight Mode challenge for an automated client. Origin and production build were independently verified by the asset check. Not an incident."; return 0
      else
        echo "::error::Public site returned 403 with no cf-mitigated header — genuine failure"; return 1
      fi ;;
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
# The real Cloudflare managed-challenge interstitial, as measured against
# production (HTTP 403, 5.3–5.6 KB, title "Just a moment...",
# cf-mitigated: challenge).
CHL_BODY='<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-challenge-running"></div></body></html>'

pass=0; fail=0
check() { # <desc> <expected_return> <code> <body> [cf_mitigated]
  desc="$1"; want="$2"; code="$3"; body="$4"; mit="${5:-}"
  classify_uptime "$code" "$body" "$mit" >/dev/null 2>&1; got=$?
  if [ "$got" -eq "$want" ]; then printf 'PASS  %-42s (return %d)\n' "$desc" "$got"; pass=$((pass+1))
  else printf 'FAIL  %-42s (want %d, got %d)\n' "$desc" "$want" "$got"; fail=$((fail+1)); fi
}

echo "── monitoring uptime classifier ──"
check "200 → live"                          0 200 ""
check "301 → live (redirect)"               0 301 ""
check "503 + maintenance page → OK"         0 503 "$MAINT_BODY"
check "503 without maintenance → incident"  1 503 "$CF_503_BODY"
check "500 → incident"                      1 500 ""
check "403 without cf-mitigated → incident" 1 403 ""
check "000 (dns/timeout) → incident"        1 000 ""

# ── Bot Fight Mode (ruleId=bot_fight_mode) — the challenge escape hatch ──────
# Safe ONLY because the asset/build check runs first and halts the job on
# failure. These cases pin the hatch to 403 alone: any other status stays an
# incident regardless of headers, so a future edit cannot widen it quietly.
check "403 + cf-mitigated → expected challenge" 0 403 "$CHL_BODY" "challenge"
check "503 + cf-mitigated, no maint → incident" 1 503 "$CF_503_BODY" "challenge"
check "500 + cf-mitigated → still incident"     1 500 ""            "challenge"
check "429 + cf-mitigated → still incident"     1 429 ""            "challenge"
echo "── $pass passed, $fail failed ──"
[ "$fail" -eq 0 ]
