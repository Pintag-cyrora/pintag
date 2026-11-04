#!/usr/bin/env bash
# verify-site-exclusions.sh -- READ-ONLY post-deployment check of the deploy allowlist (site-manifest.txt).
#
#   OPERATOR="Name" SITE_URL=https://pintag.io [EXPECTED_SHA=<merge commit>] bash scripts/verify-site-exclusions.sh
#
# Sends GET requests only (no body, no credentials, no cookies, no Range header, no state change). Against the DEPLOYED site it checks:
#   1. every "-" (reviewed exclusion) path in site-manifest.txt returns 404;
#   2. a fixed list of sensitive repository paths (docs, runbooks, audit reports, SQL migrations, scripts, tests, workflows, worker source, config templates, the manifest) returns 404;
#   3. every published "+" page (*.html) and /config.js return 200 -- exactly 200, never 206 (partial content) -- with a COMPLETE body: the body is non-empty, its size equals
#      Content-Length when the server sent one, and an HTML page ends with </html>.
# Result per check: PASS / FAIL / UNVERIFIABLE. A Cloudflare challenge (header cf-mitigated: challenge, or a 403/503 challenge page) is UNVERIFIABLE, never a pass:
# the request was blocked before it reached the origin. There is no attempt to get around a challenge: run this from a network and identity the site allows.
# Exit status: 1 if anything FAILED, 2 if nothing failed but something was UNVERIFIABLE, 0 if every check passed.
# At the end it prints a RECORD block (operator, UTC date, site, expected commit, result, outstanding failures). Paste it into docs/DEPLOYMENT_VERIFICATION_RECORD.md.
# A record with OPERATOR unset is marked INVALID.
set -u
cd "$(dirname "$0")/.."
SITE_URL="${SITE_URL:-https://pintag.io}"
SITE_URL="${SITE_URL%/}"
pass=0; fail=0; unver=0
problems=()
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

fetch() {  # $1 = path -> sets code, headers file, body file, curl_rc
  rm -f "$TMP/h" "$TMP/b"
  code="$(curl -sS -o "$TMP/b" -D "$TMP/h" -w '%{http_code}' --max-time 20 "$SITE_URL/$1" 2>/dev/null)"; curl_rc=$?
  [ -f "$TMP/b" ] || : > "$TMP/b"; [ -f "$TMP/h" ] || : > "$TMP/h"
}
is_challenge() {  # Cloudflare challenge: cf-mitigated header, or a 403/503 whose body is the challenge page
  grep -qi '^cf-mitigated:' "$TMP/h" && return 0
  if [ "$code" = 403 ] || [ "$code" = 503 ]; then grep -qiE 'challenge-platform|cf-chl|Just a moment|cf-browser-verification' "$TMP/b" && return 0; fi
  return 1
}
record() {  # $1 = PASS|FAIL|UNVERIFIABLE, $2 = path, $3 = detail
  printf '  %-13s /%s  (%s)\n' "$1" "$2" "$3"
  case "$1" in PASS) pass=$((pass+1));; FAIL) fail=$((fail+1)); problems+=("FAIL /$2 ($3)");; UNVERIFIABLE) unver=$((unver+1)); problems+=("UNVERIFIABLE /$2 ($3)");; esac
}

check() {  # $1 = path, $2 = expected status (200|404)
  local path="$1" want="$2" size clen
  fetch "$path"
  if [ -z "$code" ] || [ "$code" = "000" ]; then record UNVERIFIABLE "$path" "no response (curl exit $curl_rc)"; return; fi
  if is_challenge; then record UNVERIFIABLE "$path" "HTTP $code, Cloudflare challenge: blocked before the origin"; return; fi
  if [ "$want" = 404 ]; then
    if [ "$code" = 404 ]; then record PASS "$path" "HTTP 404"; else record FAIL "$path" "HTTP $code, expected 404"; fi
    return
  fi
  # expected 200: exactly 200, never 206, and a complete body
  if [ "$code" = 206 ]; then record FAIL "$path" "HTTP 206 partial content, expected a complete 200 response"; return; fi
  if [ "$code" != 200 ]; then record FAIL "$path" "HTTP $code, expected 200"; return; fi
  if grep -qi '^content-range:' "$TMP/h"; then record FAIL "$path" "a Content-Range header on a 200 response (partial body)"; return; fi
  size="$(wc -c < "$TMP/b" | tr -d ' ')"
  if [ "${size:-0}" -eq 0 ]; then record FAIL "$path" "HTTP 200 with an empty body"; return; fi
  clen="$(grep -i '^content-length:' "$TMP/h" | tail -n 1 | tr -dc '0-9')"
  if [ -n "$clen" ] && [ "$clen" != "$size" ]; then record FAIL "$path" "body is $size bytes but Content-Length says $clen (truncated)"; return; fi
  case "$path" in
    *.html) if ! tail -c 400 "$TMP/b" | grep -qi '</html>'; then record FAIL "$path" "HTML does not end with </html> (incomplete)"; return; fi;;
  esac
  record PASS "$path" "HTTP 200, $size bytes, complete"
}

echo "== Reviewed exclusions from site-manifest.txt (must be 404) =="
while read -r p; do [ -n "$p" ] && check "$p" 404; done < <(grep -E '^-[[:space:]]' site-manifest.txt | sed -E 's/^-[[:space:]]+//; s/[[:space:]]*#.*$//')

echo "== Sensitive repository paths (must be 404) =="
for p in \
  SECURITY.md SECURITY_AUDIT_2026-08-04.md RECOVERY_RUNBOOK.md FIRST_ADMIN_ONBOARDING.md ARCHITECTURE.md PREVIEW.md database-migration.sql \
  docs/LOCATION_PRIVACY_AUDIT_AND_SPEC.md docs/SECURITY_BACKUP_EVIDENCE_2026-11-02.md docs/L1_PRODUCTION_SAFE_CERTIFICATION.md \
  docs/L1_SECURITY_BASELINE_2026-08-06.md docs/BACKUP_AND_DISASTER_RECOVERY.md docs/DOCUMENTATION_MAP.md docs/DEPLOYMENT_ALLOWLIST.md docs/RATE_LIMITING.md \
  supabase/config.toml supabase/migrations/20260817000000_security_audit_hardening.sql supabase/migrations/20261012000000_intelligence_canonical_availability.sql \
  supabase/functions/resolve-map-url/index.ts scripts/verify-production-http.sh scripts/restore-production.sh scripts/build-site.mjs scripts/verify-site-exclusions.sh \
  tests/security/README.md tests/security/run.sh ops/README.md ops/backup.age.pub cloudflare-worker/og-listing-preview.js cloudflare-worker/wrangler.toml \
  pintag-studio/README.md .github/workflows/deploy-prod.yml .gitignore site-manifest.txt config.dev.js config.prod.js \
  currency.test.js site-allowlist.test.js session.test.js package.json; do
  check "$p" 404
done

echo "== Published pages and generated config (must be exactly 200 and complete) =="
check "config.js" 200
while read -r p; do [ -n "$p" ] && check "$p" 200; done < <(grep -E '^\+[[:space:]]+[A-Za-z0-9_.-]+\.html' site-manifest.txt | sed -E 's/^\+[[:space:]]+//; s/[[:space:]]*#.*$//')

if [ "$fail" -gt 0 ]; then result="FAILED"; rc=1
elif [ "$unver" -gt 0 ]; then result="INCOMPLETE (some checks were unverifiable)"; rc=2
else result="PASSED"; rc=0; fi
echo
echo "Summary: $pass passed, $fail failed, $unver unverifiable"
echo "---------------- RECORD (paste into docs/DEPLOYMENT_VERIFICATION_RECORD.md) ----------------"
if [ -z "${OPERATOR:-}" ]; then echo "Operator:         NOT SET -- this record is INVALID (set OPERATOR=\"Name\" and run again)"; else echo "Operator:         ${OPERATOR}"; fi
echo "Date (UTC):       $(date -u '+%Y-%m-%d %H:%M:%S')"
echo "Site:             $SITE_URL"
echo "Expected commit:  ${EXPECTED_SHA:-not given}"
echo "Result:           $result  ($pass passed, $fail failed, $unver unverifiable)"
if [ "${#problems[@]}" -gt 0 ]; then echo "Outstanding:"; for x in "${problems[@]}"; do echo "  - $x"; done; else echo "Outstanding:      none"; fi
echo "---------------------------------------------------------------------------------------------"
[ -z "${OPERATOR:-}" ] && [ "$rc" -eq 0 ] && rc=2
exit $rc
