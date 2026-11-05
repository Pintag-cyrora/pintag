#!/usr/bin/env bash
# Target classification and request guard for the LIVE security suite. Sourced by helpers.sh; fails closed.
#
#   production-readonly  the project in config.prod.js. Anonymous probes only. No login, no user token, no request that
#                        can create, change or delete a real row. Admin / test-user credentials are never used here,
#                        whether or not they are set.
#   staging-full         a project listed in tests/security/staging-targets.txt AND confirmed by SECURITY_TARGET_CONFIRM.
#                        That file is deliberately EMPTY: no isolated staging project exists yet, so credentialed tests are disabled everywhere.
#   refuse               anything else (unparseable URL, custom domain, unknown project): the run stops.
#
# The classification is derived from the project REFERENCE in SUPABASE_URL compared with config.prod.js, never from
# APP_ENV (a label the caller chooses). The nil UUID is the only target a mutating probe may name in production-readonly mode.

PT_NIL_UUID='00000000-0000-0000-0000-000000000000'

pt_target_ref() { sed -nE 's#^https://([a-z0-9]{20})\.supabase\.co/?$#\1#p' <<<"${SUPABASE_URL:-}"; }
pt_production_ref() { sed -nE "s#.*supabaseUrl: *'https://([a-z0-9]{20})\.supabase\.co'.*#\1#p" "${PT_ROOT:-.}/config.prod.js" | head -n 1; }
pt_staging_refs() { [[ -f "${PT_ROOT:-.}/tests/security/staging-targets.txt" ]] && sed -E 's/#.*$//; s/[[:space:]]//g; /^$/d' "${PT_ROOT:-.}/tests/security/staging-targets.txt"; true; }

# Prints production-readonly | staging-full | refuse:<reason>
pt_classify_target() {
  local ref prod
  ref="$(pt_target_ref)"; prod="$(pt_production_ref)"
  [[ -n "$prod" ]] || { echo "refuse:cannot read the production project reference from config.prod.js"; return; }
  [[ -n "$ref" ]]  || { echo "refuse:SUPABASE_URL is not https://<20-character-ref>.supabase.co, so it cannot be classified"; return; }
  if [[ "$ref" == "$prod" ]]; then echo "production-readonly"; return; fi
  if pt_staging_refs | grep -qx "$ref"; then
    if [[ "${SECURITY_TARGET_CONFIRM:-}" == "$ref" ]]; then echo "staging-full"
    else echo "refuse:staging target needs SECURITY_TARGET_CONFIRM=<project ref>"; fi
    return
  fi
  echo "refuse:project is neither production nor a listed staging target"
}

# Called once, before any request. Exits the run unless the target is understood; refuses credentials against production.
pt_enforce_target() {
  local c; c="$(pt_classify_target)"
  case "$c" in
    refuse:*) echo "SECURITY SUITE REFUSED: ${c#refuse:}" >&2; exit 1;;
  esac
  PT_MODE="$c"; export PT_MODE
  if [[ "$PT_MODE" == "production-readonly" ]]; then
    local set=()
    [[ -n "${ADMIN_EMAIL:-}${ADMIN_PASSWORD:-}" ]] && set+=(ADMIN_EMAIL/ADMIN_PASSWORD)
    [[ -n "${TEST_USER_EMAIL:-}${TEST_USER_PASSWORD:-}" ]] && set+=(TEST_USER_EMAIL/TEST_USER_PASSWORD)
    if [[ ${#set[@]} -gt 0 ]]; then
      echo "SECURITY SUITE REFUSED: ${set[*]} are set but the target is the PRODUCTION project. Credentialed tests never run against production; unset them or point SUPABASE_URL at a listed staging project." >&2
      exit 1
    fi
  fi
}

# true when every UUID-shaped string in $1 is the nil UUID
pt_only_nil_uuids() {
  local u
  while read -r u; do [[ -z "$u" || "$u" == "$PT_NIL_UUID" ]] || return 1; done < <(grep -Eoi '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' <<<"$1")
  return 0
}

# pt_guard_request METHOD URL [curl args...]  -> returns 0 to allow, 1 to refuse (reason on stderr).
# Defence in depth: even if a future test is written carelessly, production-readonly cannot send it.
pt_guard_request() {
  local method="$1" url="$2"; shift 2
  # Fail closed: when nothing has classified the target (PT_MODE unset), assume production.
  [[ "${PT_MODE:-production-readonly}" == "production-readonly" ]] || return 0
  local a body="" bearer="" prev=""
  for a in "$@"; do
    [[ "$prev" == "-d" || "$prev" == "--data-raw" || "$prev" == "--data-binary" ]] && body="$a"
    [[ "$a" =~ ^[Aa]uthorization:\ Bearer\ (.+)$ ]] && bearer="${BASH_REMATCH[1]}"
    prev="$a"
  done
  # A bearer that is a well-formed JWT other than the public anon key is a user session and is never sent to production. Deliberately malformed
  # tokens ("not.a.valid.jwt.at.all") are the authentication-rejection probes and carry no identity, so they are allowed.
  if [[ -n "$bearer" && "$bearer" != "${SUPABASE_ANON_KEY:-}" && "$bearer" =~ ^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
    echo "REFUSED in production-readonly: a user token is attached to $method ${url##*/}" >&2; return 1
  fi
  [[ "$url" == *"/auth/v1/token"* || "$url" == *"/auth/v1/signup"* || "$url" == *"/auth/v1/admin"* ]] && { echo "REFUSED in production-readonly: auth endpoint $method ${url##*/}" >&2; return 1; }
  case "$method" in GET|HEAD|OPTIONS) return 0;; esac
  case "$url" in
    */functions/v1/*) return 0;;                       # anonymous edge-function probes (expected 401/403/4xx; no user token)
    */rest/v1/rpc/*) pt_only_nil_uuids "$body" && return 0
                     echo "REFUSED in production-readonly: rpc call names an id other than the nil UUID" >&2; return 1;;
    */rest/v1/*)
      if [[ "$method" == "POST" ]]; then
        # an insert must name the nil UUID (a listing that cannot exist), or be a table that has no anonymous insert at all
        case "$url" in
          */rest/v1/listing_events*|*/rest/v1/lead_events*) [[ "$body" == *"$PT_NIL_UUID"* ]] && pt_only_nil_uuids "$body" && return 0
            echo "REFUSED in production-readonly: $method to ${url##*/rest/v1/} must name the nil UUID" >&2; return 1;;
        esac
        return 0
      fi
      [[ "$url" == *"id=eq.${PT_NIL_UUID}"* ]] && return 0
      echo "REFUSED in production-readonly: $method ${url##*/rest/v1/} must filter on the nil UUID only" >&2; return 1;;
    */storage/v1/*) return 0;;                          # anonymous upload/delete attempts, expected 4xx; no user token (checked above)
  esac
  echo "REFUSED in production-readonly: unclassified $method $url" >&2; return 1
}
