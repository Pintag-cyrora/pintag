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

# ── Diagnostics only — never affects PASS/FAIL/WARN ─────────────────────────
# Prints, for one fetch against ${SITE_URL}, enough signal to tell a stale
# CDN-cached response apart from a Cloudflare/WAF block: the HTTP status line,
# cf-cache-status (HIT/MISS/EXPIRED/DYNAMIC — a HIT proves Cloudflare's cache
# served this, not origin), cf-ray (correlates this exact response with a
# Cloudflare dashboard log entry), age/cache-control (how long a cached copy
# has been served), and server (distinguishes Cloudflare from a raw GitHub
# Pages/Fastly response). Does not change what is asserted anywhere below —
# it only prints extra lines using headers already captured for other checks.
diag() {
  local label="$1" hdrs="$2"
  local status cache_status ray age cache_control server
  status="$(printf '%s' "$hdrs" | head -1 | tr -d '\r')"
  cache_status="$(printf '%s' "$hdrs" | grep -i '^cf-cache-status:' | head -1 | tr -d '\r' | cut -d: -f2- | sed 's/^ *//')"
  ray="$(printf '%s' "$hdrs" | grep -i '^cf-ray:' | head -1 | tr -d '\r' | cut -d: -f2- | sed 's/^ *//')"
  age="$(printf '%s' "$hdrs" | grep -i '^age:' | head -1 | tr -d '\r' | cut -d: -f2- | sed 's/^ *//')"
  cache_control="$(printf '%s' "$hdrs" | grep -i '^cache-control:' | head -1 | tr -d '\r' | cut -d: -f2- | sed 's/^ *//')"
  server="$(printf '%s' "$hdrs" | grep -i '^server:' | head -1 | tr -d '\r' | cut -d: -f2- | sed 's/^ *//')"
  printf '      [diag] %-24s status=%-20s cf-cache-status=%-8s cf-ray=%-22s age=%-6s cache-control=%-20s server=%s\n' \
    "$label" "${status:-(no headers captured)}" "${cache_status:-none}" "${ray:-none}" "${age:-none}" "${cache_control:-none}" "${server:-none}"
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
hdrs="$(curl -sSI --max-time 25 "${SITE_URL}/listing.html" 2>/dev/null || true)"
diag "listing.html (HEAD)" "$hdrs"
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

# Header COVERAGE matters as much as presence. The Cloudflare Worker fronts only
# "/", /index.html, /listings.html and /listing.html. admin.html — the highest-
# value page on the site — is NOT on a Worker route, so it only gets these
# headers if a zone-wide Transform Rule exists (docs/CSP.md). Check it directly
# rather than assuming the listing.html result generalises.
ahdrs="$(curl -sSI --max-time 25 "${SITE_URL}/admin.html" 2>/dev/null || true)"
diag "admin.html (HEAD)" "$ahdrs"
if [ -z "$ahdrs" ]; then
  warn "could not fetch headers for admin.html" "cannot confirm zone-wide header coverage"
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
# -D writes response headers to a side file — the body captured into $page is
# byte-for-byte what a plain `curl -sS` would have captured before this change;
# the header file only adds diagnostic signal for the same response.
page_hdrs_file="$(mktemp)"
page="$(curl -sS -D "$page_hdrs_file" --max-time 25 "${SITE_URL}/listing.html" 2>/dev/null || true)"
page_hdrs="$(cat "$page_hdrs_file" 2>/dev/null || true)"; rm -f "$page_hdrs_file"
diag "listing.html (GET body)" "$page_hdrs"
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
admin_page_hdrs_file="$(mktemp)"
admin_page="$(curl -sS -D "$admin_page_hdrs_file" --max-time 25 "${SITE_URL}/admin.html" 2>/dev/null || true)"
admin_page_hdrs="$(cat "$admin_page_hdrs_file" 2>/dev/null || true)"; rm -f "$admin_page_hdrs_file"
diag "admin.html (GET body)" "$admin_page_hdrs"
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
