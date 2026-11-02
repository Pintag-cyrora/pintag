#!/usr/bin/env bash
# verify-site-exclusions.sh -- READ-ONLY post-deployment check of the deploy allowlist (site-manifest.txt).
#
#   SITE_URL=https://pintag.io bash scripts/verify-site-exclusions.sh
#
# Sends GET requests only (no body, no credentials, no state change). Checks, against the DEPLOYED site:
#   1. every "-" (reviewed exclusion) path in site-manifest.txt returns 404;
#   2. a fixed list of sensitive repository paths (docs, runbooks, audit reports, SQL migrations, scripts, tests, workflows, worker source,
#      config templates, the manifest itself) returns 404;
#   3. every published "+" page (*.html) returns 200, and CNAME-independent assets such as config.js return 200.
# Result per check: PASS / FAIL / UNVERIFIABLE. A Cloudflare challenge (HTTP 403 with cf-mitigated: challenge) is UNVERIFIABLE, never a pass:
# the request was blocked before it reached the origin. Exit 1 on any FAIL, 2 if anything was UNVERIFIABLE and nothing failed, else 0.
# Run it from a network that is allowed to reach the site, only after a deployment of the allowlist change.
set -u
cd "$(dirname "$0")/.."
SITE_URL="${SITE_URL:-https://pintag.io}"
SITE_URL="${SITE_URL%/}"
pass=0; fail=0; unver=0

check() {  # $1 = path, $2 = expected status
  local path="$1" want="$2" out code mitigated
  out="$(curl -sS -o /dev/null -D - -w '\nHTTPCODE:%{http_code}' --max-time 20 "$SITE_URL/$path" 2>/dev/null || true)"
  code="$(printf '%s' "$out" | sed -n 's/^HTTPCODE:\([0-9]*\)$/\1/p' | tail -n 1)"
  mitigated="$(printf '%s' "$out" | grep -i '^cf-mitigated:' | head -n 1 | tr -d '\r')"
  if [ -z "$code" ] || [ "$code" = "000" ]; then echo "  UNVERIFIABLE  /$path  (no response)"; unver=$((unver+1)); return; fi
  if [ -n "$mitigated" ]; then echo "  UNVERIFIABLE  /$path  (HTTP $code, $mitigated: blocked before the origin)"; unver=$((unver+1)); return; fi
  if [ "$code" = "$want" ]; then echo "  PASS          /$path  (HTTP $code)"; pass=$((pass+1)); else echo "  FAIL          /$path  (HTTP $code, expected $want)"; fail=$((fail+1)); fi
}

echo "== Reviewed exclusions from site-manifest.txt (must be 404) =="
while read -r p; do [ -n "$p" ] && check "$p" 404; done < <(grep -E '^-[[:space:]]' site-manifest.txt | sed -E 's/^-[[:space:]]+//; s/[[:space:]]*#.*$//')

echo "== Sensitive repository paths (must be 404) =="
for p in \
  SECURITY.md SECURITY_AUDIT_2026-08-04.md RECOVERY_RUNBOOK.md FIRST_ADMIN_ONBOARDING.md ARCHITECTURE.md PREVIEW.md database-migration.sql \
  docs/LOCATION_PRIVACY_AUDIT_AND_SPEC.md docs/SECURITY_BACKUP_EVIDENCE_2026-11-02.md docs/L1_PRODUCTION_SAFE_CERTIFICATION.md \
  docs/L1_SECURITY_BASELINE_2026-08-06.md docs/BACKUP_AND_DISASTER_RECOVERY.md docs/DOCUMENTATION_MAP.md docs/RATE_LIMITING.md \
  supabase/config.toml supabase/migrations/20260817000000_security_audit_hardening.sql supabase/migrations/20261012000000_intelligence_canonical_availability.sql \
  supabase/functions/resolve-map-url/index.ts scripts/verify-production-http.sh scripts/restore-production.sh scripts/build-site.mjs \
  tests/security/README.md tests/security/run.sh ops/README.md ops/backup.age.pub cloudflare-worker/og-listing-preview.js cloudflare-worker/wrangler.toml \
  pintag-studio/README.md .github/workflows/deploy-prod.yml .gitignore site-manifest.txt config.dev.js config.prod.js \
  currency.test.js session.test.js package.json; do
  check "$p" 404
done

echo "== Published pages and generated config (must be 200) =="
check "config.js" 200
while read -r p; do [ -n "$p" ] && check "$p" 200; done < <(grep -E '^\+[[:space:]]+[A-Za-z0-9_.-]+\.html' site-manifest.txt | sed -E 's/^\+[[:space:]]+//; s/[[:space:]]*#.*$//')

echo
echo "Summary: $pass passed, $fail failed, $unver unverifiable"
[ "$fail" -gt 0 ] && exit 1
[ "$unver" -gt 0 ] && exit 2
exit 0
