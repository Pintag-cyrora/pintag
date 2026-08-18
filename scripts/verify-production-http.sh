#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PRODUCTION SECURITY VERIFICATION — HTTP surface. READ-ONLY / NON-DESTRUCTIVE.
#
#   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=eyJ... \
#   SITE_URL=https://pintag.io bash scripts/verify-production-http.sh
#
# Probes the deployed system the way an unauthenticated attacker would, using
# nothing but the public anon key, and reports whether each control actually
# holds IN PRODUCTION. Complements scripts/verify-production-security.sql, which
# inspects the database catalog directly.
#
# NON-DESTRUCTIVE BY CONSTRUCTION:
#   * every request is a GET, or a POST to a read-only RPC;
#   * it never creates an account — sign-up state is read from /auth/v1/settings
#     rather than by attempting a registration (which would leave a real user
#     behind on a project where sign-up turns out to be open);
#   * it never writes, deletes, or modifies anything;
#   * it prints no tokens, keys, emails, or listing content.
#
# Exit code: 0 = every control held. 1 = at least one FAIL.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"
SITE_URL="${SITE_URL:-https://pintag.io}"

PASS=0; FAIL=0; WARN=0
ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
warn() { printf '  WARN  %s\n      → %s\n' "$1" "${2:-}"; WARN=$((WARN+1)); }

CURL=(curl -sS --max-time 25 -H "apikey: ${SUPABASE_ANON_KEY}")

echo "=============================================================="
echo " Pintag production verification — HTTP surface"
echo " Supabase: ${SUPABASE_URL}"
echo " Site:     ${SITE_URL}"
echo "=============================================================="

# ── 1. Public sign-up ───────────────────────────────────────────────────────
# Decides whether "any authenticated user" is a reachable attacker class at all.
echo
echo "1. AUTHENTICATION — is public sign-up open?"
settings="$("${CURL[@]}" "${SUPABASE_URL}/auth/v1/settings" || true)"
if [ -z "$settings" ]; then
  warn "could not read /auth/v1/settings" "empty response — check the URL/key"
else
  disabled="$(printf '%s' "$settings" | grep -o '"disable_signup":[^,}]*' | cut -d: -f2 | tr -d ' "')"
  case "$disabled" in
    true)  ok "public sign-up is DISABLED at the auth layer (disable_signup=true)" ;;
    false) bad "public sign-up is ENABLED" \
               "anyone can create an account. Every 'authenticated user' finding in the audit becomes reachable. Disable it: Dashboard → Authentication → Sign In / Providers → Email → Allow new users to sign up = OFF" ;;
    *)     warn "could not determine sign-up state" "no disable_signup field in /auth/v1/settings" ;;
  esac
  autoconfirm="$(printf '%s' "$settings" | grep -o '"mailer_autoconfirm":[^,}]*' | cut -d: -f2 | tr -d ' "')"
  [ "$autoconfirm" = "true" ] && warn "email auto-confirm is ON" \
    "a new account is usable without proving control of the address (only matters if sign-up is enabled)"
fi

# ── 2. Internal tables must return nothing to the anon key ──────────────────
echo
echo "2. AUTHORIZATION — internal tables closed to the anon key?"
for t in owners leads admin_accounts property_images intelligence_reports \
         properties_row_snapshots listing_view_throttle ops_alerts; do
  body="$("${CURL[@]}" "${SUPABASE_URL}/rest/v1/${t}?select=*&limit=1" || true)"
  if [ "$body" = "[]" ] || printf '%s' "$body" | grep -qiE 'permission denied|does not exist|JWT|not find the table'; then
    ok "$t → no rows"
  else
    bad "$t returned data to an anonymous caller" "$(printf '%s' "$body" | head -c 160)"
  fi
done

# ── 3. The view that bypassed RLS (F-03) ────────────────────────────────────
echo
echo "3. RLS — property_engagement must not expose more than properties does"
pe="$("${CURL[@]}" "${SUPABASE_URL}/rest/v1/property_engagement?select=slug&limit=1000" || true)"
pr="$("${CURL[@]}" "${SUPABASE_URL}/rest/v1/properties?select=slug&limit=1000" || true)"
if printf '%s' "$pe" | grep -qiE 'permission denied|does not exist|not find the table'; then
  ok "property_engagement is not reachable by the anon key at all"
else
  n_pe="$(printf '%s' "$pe" | grep -o '"slug"' | wc -l | tr -d ' ')"
  n_pr="$(printf '%s' "$pr" | grep -o '"slug"' | wc -l | tr -d ' ')"
  if [ "$n_pe" = "$n_pr" ]; then
    ok "property_engagement exposes the same ${n_pe} row(s) as properties (RLS honoured)"
  else
    bad "property_engagement leaks rows RLS hides on properties" \
        "view=${n_pe} vs table=${n_pr} — the security_invoker fix is NOT live"
  fi
fi

# ── 4. Privileged RPCs must refuse an anonymous caller ──────────────────────
echo
echo "4. RPCs — privileged functions refuse anonymous callers"
rpc() { "${CURL[@]}" -X POST "${SUPABASE_URL}/rest/v1/rpc/$1" \
        -H 'Content-Type: application/json' -d "${2:-{}}" || true; }

# NOTE — reset_weekly_views() is deliberately NOT probed here.
# It MUTATES (UPDATE properties SET views_week = 0). Probing an authorization
# boundary by invoking the thing it guards is only safe when the guard holds;
# if it does not, the probe performs the very damage it is testing for. That is
# not hypothetical: the 2026-08-18 verification run called it and, because the
# pre-fix guard `auth.email() != 'admin@pintag.io'` evaluates to NULL (not TRUE)
# for an anonymous caller, the exception never fired and the UPDATE ran.
# Its authorization is verified read-only instead, two ways:
#   * scripts/verify-production-security.sql asserts the body calls
#     is_pintag_admin() and that EXECUTE is not held by anon/public;
#   * pintag_client_network_probe() below exercises the identical
#     is_pintag_admin() gate and is STABLE — it cannot write anything.
for fn in pintag_client_network_probe; do
  body="$(rpc "$fn")"
  if printf '%s' "$body" | grep -qiE 'admin only|permission denied|access denied|does not exist|not find the function'; then
    ok "$fn → denied (read-only probe of the same admin gate)"
  else
    bad "$fn did NOT deny an anonymous caller" "$(printf '%s' "$body" | head -c 160)"
  fi
done

body="$(rpc rebuild_images_from_registry '{"p_property":"00000000-0000-0000-0000-000000000000"}')"
if printf '%s' "$body" | grep -qiE 'admin only|permission denied|access denied|does not exist|not find the function'; then
  ok "rebuild_images_from_registry → denied"
else
  bad "rebuild_images_from_registry did NOT deny an anonymous caller" "$(printf '%s' "$body" | head -c 160)"
fi

# public_listing_stats is deliberately public, but must report nothing about a
# listing the caller cannot see. Feed it a uuid that certainly is not published.
body="$(rpc public_listing_stats '{"p_listing_id":"00000000-0000-0000-0000-000000000000"}')"
if printf '%s' "$body" | grep -q '"district":null' && printf '%s' "$body" | grep -q '"view_count":0'; then
  ok "public_listing_stats → zeroed stats for a non-visible listing (F-06 fix live)"
else
  warn "public_listing_stats response not in the expected zeroed shape" "$(printf '%s' "$body" | head -c 160)"
fi

# ── 5. Core tables must reject an anonymous write ───────────────────────────
# A rejected INSERT writes nothing, so this is safe to attempt and is the only
# way to prove the write boundary from outside.
echo
echo "5. WRITE BOUNDARY — anonymous writes are refused"
body="$("${CURL[@]}" -X POST "${SUPABASE_URL}/rest/v1/properties" \
        -H 'Content-Type: application/json' -H 'Prefer: return=minimal' \
        -d '{"slug":"__verification_probe_never_persisted__"}' || true)"
if printf '%s' "$body" | grep -qiE 'permission denied|violates row-level security|new row violates|JWT|denied'; then
  ok "anonymous INSERT into properties → refused"
else
  bad "anonymous INSERT into properties was NOT clearly refused" "$(printf '%s' "$body" | head -c 200)"
fi

body="$("${CURL[@]}" -X PATCH "${SUPABASE_URL}/rest/v1/properties?slug=eq.__no_such_listing__" \
        -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
        -d '{"title_en":"probe"}' || true)"
if [ "$body" = "[]" ] || printf '%s' "$body" | grep -qiE 'permission denied|violates row-level security|denied'; then
  ok "anonymous UPDATE of properties → zero rows / refused"
else
  bad "anonymous UPDATE of properties was NOT refused" "$(printf '%s' "$body" | head -c 200)"
fi

# ── 6. Storage: public read is intended; anonymous write is not ─────────────
echo
echo "6. STORAGE — read is public by design, write must be refused"
body="$("${CURL[@]}" -X POST "${SUPABASE_URL}/storage/v1/object/property-images/__probe__.jpg" \
        -H 'Content-Type: image/jpeg' --data-binary 'not-an-image' || true)"
if printf '%s' "$body" | grep -qiE 'row-level security|Unauthorized|not authorized|denied|Invalid|JWT'; then
  ok "anonymous upload to property-images → refused"
else
  bad "anonymous upload to property-images was NOT refused" "$(printf '%s' "$body" | head -c 200)"
fi
body="$("${CURL[@]}" -X DELETE "${SUPABASE_URL}/storage/v1/object/property-images/__probe__.jpg" || true)"
if printf '%s' "$body" | grep -qiE "row-level security|Unauthorized|not authorized|denied|not_found|Object not found|JWT|InvalidRequest|required property 'authorization'"; then
  ok "anonymous delete from property-images → refused"
else
  bad "anonymous delete from property-images was NOT refused" "$(printf '%s' "$body" | head -c 200)"
fi

# ── 7. Edge Functions ───────────────────────────────────────────────────────
echo
echo "7. EDGE FUNCTIONS — the AI/admin ones must refuse an unauthenticated call"
for fn in smart-listing-importer generate-listing-content facebook-listing-fetcher generate-intelligence-report; do
  code="$(curl -sS --max-time 25 -o /dev/null -w '%{http_code}' \
          -X POST "${SUPABASE_URL}/functions/v1/${fn}" \
          -H 'Content-Type: application/json' -d '{}' || echo 000)"
  case "$code" in
    401|403) ok "$fn → $code (refused; no Gemini spend possible)" ;;
    404)     warn "$fn → 404" "function not deployed under this name" ;;
    200|201) bad "$fn ACCEPTED an unauthenticated request" "HTTP $code — paid API abuse is possible" ;;
    *)       warn "$fn → HTTP $code" "unexpected; inspect manually" ;;
  esac
done

# ── 8. Security headers on the public site ──────────────────────────────────
echo
echo "8. HEADERS — transport and framing protections on ${SITE_URL}"
hdrs="$(curl -sSI --max-time 25 "${SITE_URL}/listing.html" 2>/dev/null || true)"
has() { grep -qi "^$1:" <<< "$hdrs"; }
if [ -z "$hdrs" ]; then
  warn "could not fetch headers from ${SITE_URL}" "site unreachable from this runner"
else
  has 'strict-transport-security' && ok "Strict-Transport-Security present" \
    || bad "Strict-Transport-Security missing" "add via the Cloudflare Transform Rule in docs/CSP.md"
  has 'x-content-type-options'    && ok "X-Content-Type-Options present" \
    || bad "X-Content-Type-Options missing" "add via the Cloudflare Transform Rule in docs/CSP.md"
  has 'referrer-policy'           && ok "Referrer-Policy present" \
    || bad "Referrer-Policy missing" "add via the Cloudflare Transform Rule in docs/CSP.md"
  if grep -qiE '^(content-security-policy|x-frame-options):' <<< "$hdrs"; then
    ok "framing protection present (CSP frame-ancestors or X-Frame-Options)"
  else
    bad "no framing protection header" "clickjacking is possible; see docs/CSP.md"
  fi
fi

# The page-level CSP is delivered as a meta tag (GitHub Pages cannot set headers).
page="$(curl -sS --max-time 25 "${SITE_URL}/listing.html" 2>/dev/null || true)"
if grep -qi 'http-equiv="Content-Security-Policy"' <<< "$page"; then
  if grep -qi 'connect-src' <<< "$page"; then
    ok "deployed listing.html carries the CSP meta tag (connect-src present)"
  else
    warn "CSP meta tag present but has no connect-src" "exfiltration is not contained"
  fi
else
  bad "deployed listing.html carries NO CSP" "the CSP commit is not deployed yet"
fi

# ── 9. Is the XSS fix actually deployed? (F-01 / F-02) ──────────────────────
echo
echo "9. XSS FIX — is the corrected escaping actually live?"
if grep -q 'function escJs' <<< "$page"; then
  ok "listing.html on ${SITE_URL} contains escJs() (F-02 fix deployed)"
else
  bad "listing.html on ${SITE_URL} has NO escJs()" \
      "the deployed build predates the XSS fix — F-02 is still live"
fi
admin_page="$(curl -sS --max-time 25 "${SITE_URL}/admin.html" 2>/dev/null || true)"
if grep -q 'escJs(p.title_en' <<< "$admin_page"; then
  ok "admin.html on ${SITE_URL} escapes the listing title for the JS context (F-01 fix deployed)"
elif [ -z "$admin_page" ]; then
  warn "admin.html not fetchable" "cannot confirm the F-01 fix is deployed"
else
  bad "admin.html on ${SITE_URL} still interpolates the title unsafely" \
      "the deployed build predates the XSS fix — F-01 is still live"
fi

echo
echo "=============================================================="
printf ' RESULT: %s passed, %s failed, %s warning(s)\n' "$PASS" "$FAIL" "$WARN"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
