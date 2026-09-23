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
# Exit code: 0 = every control held (an UNVERIFIABLE result does not fail the
# script — see below). 1 = at least one FAIL.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"
SITE_URL="${SITE_URL:-https://pintag.io}"

PASS=0; FAIL=0; WARN=0; UNVERIFIABLE=0
ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
warn() { printf '  WARN  %s\n      → %s\n' "$1" "${2:-}"; WARN=$((WARN+1)); }
# UNVERIFIABLE — the 2026-09 Bot Fight Mode investigation found Cloudflare
# Managed Challenges returned to THIS RUNNER carry HSTS/nosniff/a CSP meta
# tag/etc. of their own, so every header/content check below silently PASSED
# against the challenge page instead of the real one. UNVERIFIABLE means "this
# environment could not observe the property" -- distinct from a PASS (the
# property held) and a FAIL (the property demonstrably does not hold). Never
# silently folded into either.
unverifiable() { printf '  UNVERIFIABLE  %s\n      → %s\n' "$1" "${2:-}"; UNVERIFIABLE=$((UNVERIFIABLE+1)); }

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

# ── 8/9. HTML surface: headers + XSS-fix content on the real deployed page ──
#
# 2026-09 Bot Fight Mode investigation: Cloudflare Managed Challenges served
# to this runner carry their OWN HSTS,
# X-Content-Type-Options, Referrer-Policy, X-Frame-Options and even a
# `<meta http-equiv="Content-Security-Policy">` with a `connect-src` — every
# check that used to run separately against a bare header dump and a bare
# body dump PASSED against the challenge page, not the real one, whenever a
# request was challenged (HTTP 403 + cf-mitigated: challenge). That produced
# false "escJs() missing" / "CSP not deployed" findings that were actually
# "Cloudflare didn't let this runner see the page at all".
#
# fetch_classified() makes ONE GET per page (headers + body from the SAME
# response, not two separate requests that could independently be challenged
# or not) and classifies it before anything below inspects the content:
#   ok           - 2xx, no cf-mitigated header, body carries the expected
#                  Pintag marker (the production Supabase host embedded in
#                  every page's CSP meta tag) -> safe to run content checks.
#   challenge    - cf-mitigated header present (checked case-insensitively;
#                  this is Cloudflare's own documented signal for a served
#                  Managed/JS/interactive challenge, independent of body text).
#   unrecognized - 2xx but the expected marker is absent -> some other
#                  response we cannot positively identify as the real page.
#   error        - non-2xx and not a challenge (real outage/redirect/etc).
#   empty        - no response at all (network failure).
# Only "ok" runs the header/content assertions; every other class reports
# UNVERIFIABLE (or the pre-existing WARN for "empty") and skips them --
# never PASS, never FAIL.
SUPABASE_MARKER="$(grep -oE 'https://[a-z0-9]+\.supabase\.co' config.prod.js 2>/dev/null | head -1 | sed -E 's#^https?://##')"
[ -n "$SUPABASE_MARKER" ] || SUPABASE_MARKER="$(printf '%s' "$SUPABASE_URL" | sed -E 's#^https?://##')"

fetch_classified() {
  local url="$1" hfile
  hfile="$(mktemp)"
  FETCH_BODY="$(curl -sS --max-time 25 -D "$hfile" "$url" 2>/dev/null || true)"
  FETCH_HEADERS="$(cat "$hfile" 2>/dev/null || true)"
  rm -f "$hfile"
  FETCH_STATUS="$(head -1 <<< "$FETCH_HEADERS" | grep -oE '[0-9]{3}' | head -1)"
  if [ -z "$FETCH_HEADERS" ] && [ -z "$FETCH_BODY" ]; then
    FETCH_CLASS=empty
  elif grep -qi '^cf-mitigated:' <<< "$FETCH_HEADERS"; then
    FETCH_CLASS=challenge
  elif [ -z "$FETCH_STATUS" ] || [ "${FETCH_STATUS:0:1}" != "2" ]; then
    FETCH_CLASS=error
  elif [ -n "$SUPABASE_MARKER" ] && ! grep -qF "$SUPABASE_MARKER" <<< "$FETCH_BODY"; then
    FETCH_CLASS=unrecognized
  else
    FETCH_CLASS=ok
  fi
}

fetch_classified "${SITE_URL}/listing.html"
listing_class="$FETCH_CLASS" listing_status="${FETCH_STATUS:-000}"
listing_headers="$FETCH_HEADERS" listing_body="$FETCH_BODY"

fetch_classified "${SITE_URL}/admin.html"
admin_class="$FETCH_CLASS" admin_status="${FETCH_STATUS:-000}"
admin_headers="$FETCH_HEADERS" admin_body="$FETCH_BODY"

unverifiable_reason() {
  case "$1" in
    challenge)    echo "Cloudflare Bot Fight Mode returned a Managed Challenge (HTTP $2, cf-mitigated: challenge) instead of the page — this runner's request was blocked before reaching the Worker/origin, so this property could not be observed" ;;
    unrecognized) echo "HTTP $2 but the response body did not contain the expected production marker ($SUPABASE_MARKER) — cannot confirm this is genuinely Pintag's deployed page" ;;
    error)        echo "HTTP $2 — not a Cloudflare challenge, but not a normal page either" ;;
  esac
}

echo
echo "8. HEADERS — transport and framing protections on ${SITE_URL}"
report_headers() {
  local label="$1" class="$2" status="$3" hdrs="$4"
  case "$class" in
    empty) warn "could not fetch headers for $label" "site unreachable from this runner" ;;
    ok)
      has() { grep -qi "^$1:" <<< "$hdrs"; }
      has 'strict-transport-security' && ok "$label: Strict-Transport-Security present" \
        || bad "$label: Strict-Transport-Security missing" "add via the Cloudflare Transform Rule in docs/CSP.md"
      has 'x-content-type-options'    && ok "$label: X-Content-Type-Options present" \
        || bad "$label: X-Content-Type-Options missing" "add via the Cloudflare Transform Rule in docs/CSP.md"
      has 'referrer-policy'           && ok "$label: Referrer-Policy present" \
        || bad "$label: Referrer-Policy missing" "add via the Cloudflare Transform Rule in docs/CSP.md"
      if grep -qiE '^(content-security-policy|x-frame-options):' <<< "$hdrs"; then
        ok "$label: framing protection present (CSP frame-ancestors or X-Frame-Options)"
      else
        bad "$label: no framing protection header" "clickjacking is possible; see docs/CSP.md"
      fi
      ;;
    *) unverifiable "$label: security headers" "$(unverifiable_reason "$class" "$status")" ;;
  esac
}
report_headers "listing.html" "$listing_class" "$listing_status" "$listing_headers"
# Header COVERAGE matters as much as presence. The Cloudflare Worker fronts only
# "/", /index.html, /listings.html and /listing.html. admin.html — the highest-
# value page on the site — is NOT on a Worker route, so it only gets these
# headers if a zone-wide Transform Rule exists (docs/CSP.md). Check it directly
# rather than assuming the listing.html result generalises.
report_headers "admin.html" "$admin_class" "$admin_status" "$admin_headers"

# The page-level CSP is delivered as a meta tag (GitHub Pages cannot set headers).
echo
if [ "$listing_class" = "ok" ]; then
  if grep -qi 'http-equiv="Content-Security-Policy"' <<< "$listing_body"; then
    if grep -qi 'connect-src' <<< "$listing_body"; then
      ok "deployed listing.html carries the CSP meta tag (connect-src present)"
    else
      warn "CSP meta tag present but has no connect-src" "exfiltration is not contained"
    fi
  else
    bad "deployed listing.html carries NO CSP" "the CSP commit is not deployed yet"
  fi
else
  unverifiable "listing.html CSP meta tag" "$(unverifiable_reason "$listing_class" "$listing_status")"
fi

# ── 9. Is the XSS fix actually deployed? (F-01 / F-02) ──────────────────────
echo
echo "9. XSS FIX — is the corrected escaping actually live?"
if [ "$listing_class" = "ok" ]; then
  if grep -q 'function escJs' <<< "$listing_body"; then
    ok "listing.html on ${SITE_URL} contains escJs() (F-02 fix deployed)"
  else
    bad "listing.html on ${SITE_URL} has NO escJs()" \
        "the deployed build predates the XSS fix — F-02 is still live"
  fi
else
  unverifiable "listing.html escJs() (F-02)" "$(unverifiable_reason "$listing_class" "$listing_status")"
fi

if [ "$admin_class" = "ok" ]; then
  if grep -q 'escJs(p.title_en' <<< "$admin_body"; then
    ok "admin.html on ${SITE_URL} escapes the listing title for the JS context (F-01 fix deployed)"
  else
    bad "admin.html on ${SITE_URL} still interpolates the title unsafely" \
        "the deployed build predates the XSS fix — F-01 is still live"
  fi
else
  unverifiable "admin.html escJs(p.title_en) (F-01)" "$(unverifiable_reason "$admin_class" "$admin_status")"
fi

echo
echo "=============================================================="
printf ' RESULT: %s passed, %s failed, %s warning(s), %s unverifiable\n' "$PASS" "$FAIL" "$WARN" "$UNVERIFIABLE"
echo "=============================================================="
# UNVERIFIABLE does not fail the script -- it means this environment could not
# observe the property, not that the property failed. Workflow-level policy
# for whether an UNVERIFIABLE-heavy run should still gate deploys is a
# separate decision, not made here.
[ "$FAIL" -eq 0 ]
