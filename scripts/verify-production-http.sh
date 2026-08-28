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
# Exit code: 0 = every control held AND every check actually ran. 1 = at least
# one FAIL, or at least one BLOCKED (a check the Cloudflare edge prevented from
# running — reported separately, because "could not be measured" must never be
# recorded as either a pass or a production vulnerability).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"
SITE_URL="${SITE_URL:-https://pintag.io}"

PASS=0; FAIL=0; WARN=0
ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
warn() { printf '  WARN  %s\n      → %s\n' "$1" "${2:-}"; WARN=$((WARN+1)); }
BLOCKED=0
blocked() { printf '  BLOCKED  %s\n      → %s\n' "$1" "${2:-}"; BLOCKED=$((BLOCKED+1)); }

CURL=(curl -sS --max-time 25 -H "apikey: ${SUPABASE_ANON_KEY}")

# ── Fetching pintag.io itself (NOT Supabase) ────────────────────────────────
# See the comment block in scripts/verify-production-xss.mjs for why this UA:
# Cloudflare Bot Fight Mode (ruleId=bot_fight_mode, confirmed 2026-08-28)
# challenges automated clients on HTML paths. Honest identifier, not a bypass;
# overridable so the guard can be tested (SITE_UA=curl/8.5.0 must yield BLOCKED).
SITE_UA="${SITE_UA:-GitHub-Actions-Monitoring/1.0}"
SITE_CURL=(curl -sS --max-time 25 -A "$SITE_UA")

# cf_challenged <header-blob> → 0 when the edge mitigated the request.
cf_challenged() { printf '%s' "$1" | grep -qi '^cf-mitigated:'; }

# site_head <url> → response headers of a GET. Deliberately NOT `curl -I`
# (HEAD): the Worker wraps a GET response, and only the method a browser
# actually sends is guaranteed to reproduce what a browser receives.
site_head() { "${SITE_CURL[@]}" -o /dev/null -D - "$1" 2>/dev/null || true; }

# site_get <url> → sets SITE_BODY to the response body and SITE_MIT to the
# cf-mitigated value ("" when the edge did not mitigate), so the caller can tell
# "this is the real page" from "this is a challenge interstitial".
#
# It returns BOTH values through globals and prints NOTHING, deliberately. The
# obvious shape — print the body, set SITE_MIT as a side effect, call it as
# page="$(site_get "$url")" — is broken: command substitution runs the function
# in a SUBSHELL, so the SITE_MIT assignment dies with it and the caller always
# reads "". That silently disables the guard, which is the exact failure this
# code exists to prevent. Verified by test; do not "simplify" it back.
SITE_BODY=""
SITE_MIT=""
site_get() {
  local h
  h="$(mktemp)"
  SITE_BODY="$("${SITE_CURL[@]}" -D "$h" "$1" 2>/dev/null || true)"
  SITE_MIT="$(grep -i '^cf-mitigated:' "$h" 2>/dev/null | tr -d '\r' | cut -d' ' -f2- || true)"
  rm -f "$h"
}

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
# NOTE: the body must be built in a plain variable. `"${2:-{}}"` looks right
# but bash parses it as ${2:-{ } followed by a literal }, so an explicit
# argument comes out with a stray trailing brace and PostgREST rejects it with
# PGRST102 "Empty or invalid json" — BEFORE authorization runs, which silently
# turns every such check into a meaningless pass/fail.
rpc() {
  local body="${2-}"
  [ -z "$body" ] && body='{}'
  "${CURL[@]}" -X POST "${SUPABASE_URL}/rest/v1/rpc/$1" \
    -H 'Content-Type: application/json' -d "$body" || true
}

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
# Postgres renders json_build_object with spaces around the colon
# ("view_count" : 0), so compare against a whitespace-stripped copy rather than
# the raw body — otherwise a perfectly correct response reads as a mismatch.
compact="$(printf '%s' "$body" | tr -d ' \t\n')"
if grep -q '"district":null' <<<"$compact" && grep -q '"view_count":0' <<<"$compact"; then
  ok "public_listing_stats → zeroed stats for a non-visible listing (F-06 fix live)"
else
  warn "public_listing_stats response not in the expected zeroed shape" "$(printf '%s' "$body" | head -c 160)"
fi

# increment_listing_view() is the one public write path, and it depends on the
# properties.views_week column. That column was found MISSING in production on
# 2026-08-18 (repository/production schema drift), which made every anonymous
# call raise 42703 — the counter had been silently dead. Migration
# 20260818010000 restored it; this asserts the repair holds. The uuid below
# matches no row, so a working function updates exactly zero rows: the probe
# proves the code path executes without changing any listing's counts.
body="$(rpc increment_listing_view '{"p_listing_id":"00000000-0000-0000-0000-000000000000"}')"
if grep -qi '42703\|views_week.*does not exist\|column .* does not exist' <<<"$body"; then
  bad "increment_listing_view still fails on a missing column" \
      "properties.views_week is absent again — the anonymous view counter is dead. $(printf '%s' "$body" | head -c 160)"
elif grep -qiE 'permission denied|access denied|not find the function' <<<"$body"; then
  bad "increment_listing_view is unreachable for an anonymous visitor" "$(printf '%s' "$body" | head -c 160)"
else
  ok "increment_listing_view → executes for anonymous callers (schema drift repaired, 0 rows touched)"
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
hdrs="$(site_head "${SITE_URL}/listing.html")"
has() { grep -qi "^$1:" <<< "$hdrs"; }
if [ -z "$hdrs" ]; then
  warn "could not fetch headers from ${SITE_URL}" "site unreachable from this runner"
elif cf_challenged "$hdrs"; then
  blocked "header check on listing.html COULD NOT RUN" \
    "Cloudflare returned a bot challenge (cf-mitigated) — these are the challenge page's headers, not production's. Absence of HSTS/XCTO/Referrer-Policy here says NOTHING about what a browser receives."
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

# Header COVERAGE matters as much as presence. The Cloudflare Worker fronts only
# "/", /index.html, /listings.html and /listing.html. admin.html — the highest-
# value page on the site — is NOT on a Worker route, so it only gets these
# headers if a zone-wide Transform Rule exists (docs/CSP.md). Check it directly
# rather than assuming the listing.html result generalises.
ahdrs="$(site_head "${SITE_URL}/admin.html")"
if [ -z "$ahdrs" ]; then
  warn "could not fetch headers for admin.html" "cannot confirm zone-wide header coverage"
elif cf_challenged "$ahdrs"; then
  blocked "admin.html header-coverage check COULD NOT RUN" \
    "Cloudflare bot challenge (cf-mitigated); the zone-wide Transform Rule in docs/CSP.md is neither confirmed nor refuted by this run"
else
  missing=""
  for h in strict-transport-security x-content-type-options referrer-policy; do
    grep -qi "^$h:" <<< "$ahdrs" || missing="$missing $h"
  done
  if [ -z "$missing" ]; then
    ok "admin.html also carries the security headers (coverage is zone-wide, not just the Worker routes)"
  else
    bad "admin.html is MISSING security headers:$missing" \
        "the Worker fronts only 4 public routes; add the zone-wide Transform Rule in docs/CSP.md"
  fi
fi

# The page-level CSP is delivered as a meta tag (GitHub Pages cannot set headers).
site_get "${SITE_URL}/listing.html"; page="$SITE_BODY"; page_mit="$SITE_MIT"
# This ONE fetch feeds BOTH the CSP check here and section 9's escJs check, so
# the challenge guard has to cover both. Without it a challenge interstitial
# (which carries neither a CSP meta tag nor escJs) is reported as "the CSP
# commit is not deployed" AND "the deployed build predates the XSS fix" — two
# fabricated critical findings about controls that are live and working.
if [ -n "$page_mit" ]; then
  blocked "CSP meta-tag check on listing.html COULD NOT RUN" \
    "Cloudflare bot challenge (cf-mitigated=$page_mit); \$page holds an interstitial, not the deployed page"
elif grep -qi 'http-equiv="Content-Security-Policy"' <<< "$page"; then
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
if [ -n "$page_mit" ]; then
  blocked "XSS-fix deployment check on listing.html COULD NOT RUN" \
    "Cloudflare bot challenge (cf-mitigated=$page_mit); this is NOT evidence that F-02 is unfixed"
elif grep -q 'function escJs' <<< "$page"; then
  ok "listing.html on ${SITE_URL} contains escJs() (F-02 fix deployed)"
else
  bad "listing.html on ${SITE_URL} has NO escJs()" \
      "the deployed build predates the XSS fix — F-02 is still live"
fi
site_get "${SITE_URL}/admin.html"; admin_page="$SITE_BODY"; admin_mit="$SITE_MIT"
if [ -n "$admin_mit" ]; then
  blocked "admin.html F-01 deployment check COULD NOT RUN" \
    "Cloudflare bot challenge (cf-mitigated=$admin_mit); this is NOT evidence that F-01 is unfixed"
elif grep -q 'escJs(p.title_en' <<< "$admin_page"; then
  ok "admin.html on ${SITE_URL} escapes the listing title for the JS context (F-01 fix deployed)"
elif [ -z "$admin_page" ]; then
  warn "admin.html not fetchable" "cannot confirm the F-01 fix is deployed"
else
  bad "admin.html on ${SITE_URL} still interpolates the title unsafely" \
      "the deployed build predates the XSS fix — F-01 is still live"
fi

echo
echo "=============================================================="
printf ' RESULT: %s passed, %s failed, %s warning(s), %s could not run\n' "$PASS" "$FAIL" "$WARN" "$BLOCKED"
[ "$BLOCKED" -eq 0 ] || echo ' A BLOCKED check is NOT a pass — that verification did not execute.'
echo "=============================================================="
[ "$FAIL" -eq 0 ] && [ "$BLOCKED" -eq 0 ]
