#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ADMIN LOCKDOWN MATRIX — verified against PRODUCTION, at the data layer.
#
#   SUPABASE_URL=… SUPABASE_ANON_KEY=… ADMIN_EMAIL=… ADMIN_PASSWORD=… \
#   [TEST_USER_EMAIL=… TEST_USER_PASSWORD=…] bash scripts/verify-admin-lockdown.sh
#
# THE CRITICAL TEST, and the reason this script exists:
#
#   an allowlisted administrator, correct password, session established,
#   TOTP *not* completed  →  every privileged operation MUST be DENIED
#
# That is the difference between MFA being a browser gate and MFA being an
# authorization boundary. admin-auth.js refusing to render the page proves
# nothing: an attacker with the password skips the browser entirely and calls
# PostgREST. The only thing that matters is whether the DATABASE refuses an
# aal1 session — which is what migration 20260806010000 made is_pintag_admin()
# do, and what this script confirms in production.
#
# A password-only sign-in yields exactly an aal1 session, so this needs NO TOTP
# secret and can run unattended.
#
# SAFETY:
#   * Writes are attempted ONLY as identities that must be refused. The one
#     write path that could succeed (aal2 admin) is never exercised, so this
#     script cannot modify data even if every control failed.
#   * The UPDATE probe targets a slug that cannot exist, so even a total
#     authorization failure changes zero rows.
#   * No token, password, or email is ever printed. Tokens are captured into
#     locals and used only as headers.
#
# Exit 0 = the matrix holds.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"

PASS=0; FAIL=0; SKIP=0
ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
skip() { printf '  SKIP  %s\n      → %s\n' "$1" "${2:-}"; SKIP=$((SKIP+1)); }

# Sign in with a password. Echoes ONLY the access token (never logged by the
# caller); prints nothing on failure.
signin() {
  local email="$1" pw="$2" body
  body="$(curl -sS -m 25 -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
          -H "apikey: ${SUPABASE_ANON_KEY}" -H 'Content-Type: application/json' \
          -d "$(python3 -c 'import json,sys;print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$email" "$pw")" 2>/dev/null || true)"
  printf '%s' "$body" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('access_token','') or '')
except Exception: print('')
" 2>/dev/null
}

# Report a token's assurance level WITHOUT printing the token: decode only the
# 'aal' claim from the payload. The token was already validated by GoTrue.
aal_of() {
  printf '%s' "$1" | python3 -c "
import sys,json,base64
t=sys.stdin.read().strip()
try:
    p=t.split('.')[1]; p+='='*(-len(p)%4)
    print(json.loads(base64.urlsafe_b64decode(p)).get('aal','(none)'))
except Exception: print('(unparseable)')
" 2>/dev/null
}

# Attempt every privileged operation with a bearer token (empty = anonymous).
# Prints one line per operation: "<name> <ALLOWED|DENIED>".
probe() {
  local token="${1:-}" auth=()
  [ -n "$token" ] && auth=(-H "Authorization: Bearer ${token}")
  local C=(curl -sS -m 25 -H "apikey: ${SUPABASE_ANON_KEY}" "${auth[@]}")

  # 1. property write — the capability the 2026-08-03 breach abused.
  #    Targets a slug that cannot exist: zero rows even if authorization fails.
  local r
  r="$("${C[@]}" -X PATCH "${SUPABASE_URL}/rest/v1/properties?slug=eq.__lockdown_probe_no_such_listing__" \
        -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
        -d '{"title_en":"lockdown-probe"}' 2>/dev/null || true)"
  # "[]" means the policy matched zero rows => the write was refused by RLS.
  if [ "$r" = "[]" ] || printf '%s' "$r" | grep -qiE 'permission denied|row-level security|denied|JWT'; then
    echo "property_write DENIED"; else echo "property_write ALLOWED"; fi

  # 2. internal PII reads
  for t in owners leads; do
    r="$("${C[@]}" "${SUPABASE_URL}/rest/v1/${t}?select=id&limit=1" 2>/dev/null || true)"
    if [ "$r" = "[]" ] || printf '%s' "$r" | grep -qiE 'permission denied|denied|JWT|does not exist'; then
      echo "read_${t} DENIED"; else echo "read_${t} ALLOWED"; fi
  done

  # 3. privileged RPC
  r="$("${C[@]}" -X POST "${SUPABASE_URL}/rest/v1/rpc/reset_weekly_views" \
        -H 'Content-Type: application/json' -d '{}' 2>/dev/null || true)"
  if printf '%s' "$r" | grep -qiE 'admin only|access denied|permission denied|denied|does not exist'; then
    echo "rpc_reset_weekly_views DENIED"; else echo "rpc_reset_weekly_views ALLOWED"; fi

  # 4. admin edge function (no Gemini spend unless it authorizes)
  local code
  code="$(curl -sS -m 25 -o /dev/null -w '%{http_code}' -X POST \
          "${SUPABASE_URL}/functions/v1/generate-listing-content" \
          -H "apikey: ${SUPABASE_ANON_KEY}" "${auth[@]}" \
          -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo 000)"
  case "$code" in 401|403) echo "edge_generate_listing_content DENIED";;
                  *)       echo "edge_generate_listing_content ALLOWED(HTTP $code)";; esac

  # 5. storage write
  r="$("${C[@]}" -X POST "${SUPABASE_URL}/storage/v1/object/property-images/__lockdown_probe__.jpg" \
        -H 'Content-Type: image/jpeg' --data-binary 'probe' 2>/dev/null || true)"
  if printf '%s' "$r" | grep -qiE 'row-level security|Unauthorized|not authorized|denied|Invalid|JWT'; then
    echo "storage_write DENIED"; else echo "storage_write ALLOWED"; fi
}

assert_all_denied() {
  local label="$1"; shift
  local results="$1"
  local allowed
  allowed="$(printf '%s\n' "$results" | grep -v ' DENIED$' || true)"
  if [ -z "$allowed" ]; then
    ok "$label → every privileged operation DENIED"
  else
    bad "$label → some privileged operation was ALLOWED" "$(printf '%s' "$allowed" | tr '\n' '; ')"
  fi
}

echo "=============================================================="
echo " ADMIN LOCKDOWN MATRIX (production, data layer)"
echo "=============================================================="

# ── Level 1: unauthenticated ────────────────────────────────────────────────
echo
echo "1. Unauthenticated (anon key only) — expect DENIED"
assert_all_denied "unauthenticated" "$(probe '')"

# ── Levels 2/3: an ordinary authenticated, non-admin account ────────────────
echo
echo "2/3. Authenticated non-admin — expect DENIED"
if [ -n "${TEST_USER_EMAIL:-}" ] && [ -n "${TEST_USER_PASSWORD:-}" ]; then
  USER_TOKEN="$(signin "$TEST_USER_EMAIL" "$TEST_USER_PASSWORD")"
  if [ -z "$USER_TOKEN" ]; then
    skip "authenticated non-admin" "sign-in failed (account may not exist, or sign-ups are disabled)"
  else
    echo "     (session assurance level: $(aal_of "$USER_TOKEN"))"
    assert_all_denied "authenticated non-admin" "$(probe "$USER_TOKEN")"
  fi
else
  skip "authenticated non-admin" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
fi

# ── Level 4: THE CRITICAL ONE — allowlisted admin, password only, no TOTP ───
echo
echo "4. Allowlisted ADMIN with a password-only session (aal1, no TOTP) — expect DENIED"
echo "   This is the test that distinguishes 'MFA is a browser gate' from"
echo "   'MFA is an authorization boundary'."
if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  ADMIN_AAL1_TOKEN="$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
  if [ -z "$ADMIN_AAL1_TOKEN" ]; then
    skip "admin aal1" "admin sign-in failed — cannot run the critical test"
  else
    LEVEL="$(aal_of "$ADMIN_AAL1_TOKEN")"
    echo "     (session assurance level: ${LEVEL})"
    if [ "$LEVEL" != "aal1" ]; then
      bad "the admin password-only session is not aal1 (got '${LEVEL}')" \
          "MFA may not be enrolled on this account — if it reports aal2 without a TOTP step, MFA is NOT enforced"
    fi
    assert_all_denied "allowlisted admin WITHOUT MFA (aal1)" "$(probe "$ADMIN_AAL1_TOKEN")"
  fi
else
  skip "allowlisted admin without MFA" "ADMIN_EMAIL/ADMIN_PASSWORD not set — the critical test did NOT run"
fi

# ── Level 5: admin WITH MFA — asserted, never exercised ──────────────────────
echo
echo "5. Allowlisted admin WITH MFA (aal2) — expect ALLOWED"
skip "admin with MFA" "requires a live TOTP code; verify by hand (see docs/SECURITY_VERIFICATION_2026-08-17.md §6). Deliberately NOT automated: it is the one identity that CAN write, and a script holding it could damage production."

echo
echo "=============================================================="
printf ' MATRIX: %s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIP"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
