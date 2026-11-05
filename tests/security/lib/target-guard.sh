#!/usr/bin/env bash
# Target classification and request guard for the LIVE security suite. Sourced by helpers.sh; fails closed.
#
#   production-readonly  the project in config.prod.js. The live suite sends ONLY plain GET (and HEAD) requests: no request body, no login, no user token,
#                        no Edge Function (even a call that is expected to be rejected can run code, call an AI provider or fetch a third-party URL),
#                        no RPC, no Storage call, no authentication endpoint, and no host other than the project and the site. Nothing here relies on a
#                        production access-control policy to reject a dangerous request: such a request is never sent.
#   staging-full         a project listed in tests/security/staging-targets.txt AND confirmed by SECURITY_TARGET_CONFIRM. The credentialed and mutating suites in
#                        tests/security/staging-suites/ run only in this mode. The file is deliberately EMPTY: no isolated staging project exists yet.
#   refuse               anything else (unparseable URL, custom domain, unknown project, unreadable config): the run stops.
#
# The classification is derived from the project REFERENCE in SUPABASE_URL compared with config.prod.js, never from APP_ENV (a label the caller chooses).
# Scope: this guards tests/security/run.sh only. Other workflows (for example verify-production-security.yml, whose optional admin-lockdown matrix signs
# in with credentials when its secrets exist) are separate and are documented in tests/security/README.md.

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
      echo "SECURITY SUITE REFUSED: ${set[*]} are set but the target is the PRODUCTION project. Credentialed tests never run against production by this suite; unset them or point SUPABASE_URL at a listed staging project." >&2
      exit 1
    fi
  fi
}

# Stops the whole run (exit 97). http_request usually runs inside $(...); $$ is still the main shell, so the TERM trap in run.sh ends the run.
pt_abort_refused() {
  echo "FATAL: the live suite attempted a request that production-readonly forbids." >&2
  kill -TERM $$ 2>/dev/null
  exit 97
}

# pt_guard_request METHOD URL [curl args...]  -> returns 0 to allow, 1 to refuse (reason on stderr).
pt_guard_request() {
  local method="$1" url="$2"; shift 2
  # Fail closed: when nothing has classified the target (PT_MODE unset), assume production.
  [[ "${PT_MODE:-production-readonly}" == "production-readonly" ]] || return 0
  local why=""
  case "$method" in GET|HEAD) ;; *) why="method $method (only GET and HEAD may be sent to production)";; esac
  if [[ -z "$why" ]]; then
    local api="${SUPABASE_URL:-}" site="${SITE_URL:-}" ok=0; api="${api%/}"; site="${site%/}"
    if [[ -n "$api" && "$url" == "$api/rest/v1/"* ]]; then ok=1; fi
    if [[ -n "$site" && ( "$url" == "$site" || "$url" == "$site/"* ) ]]; then ok=1; fi
    [[ $ok -eq 1 ]] || why="host or path not allowed (only the project's /rest/v1/ and the site itself): ${url%%\?*}"
  fi
  if [[ -z "$why" ]]; then
    case "$url" in
      */rest/v1/rpc/*|*/functions/v1/*|*/auth/v1/*|*/storage/v1/*) why="rpc / edge function / auth / storage endpoints are never called on production: ${url%%\?*}";;
    esac
  fi
  if [[ -z "$why" ]]; then
    local a prev=""
    for a in "$@"; do
      case "$a" in
        -d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|-T|--upload-file|-b|--cookie|-K|--config|-u|--user) why="request body, upload, cookie or credential option $a";;
        -X|--request) ;;
      esac
      [[ "$prev" == "-X" || "$prev" == "--request" ]] && [[ "$a" != "GET" && "$a" != "HEAD" ]] && why="curl -X $a"
      if [[ "$a" =~ ^[Aa]uthorization:\ *(.+)$ ]]; then
        local cred="${BASH_REMATCH[1]}"
        # only the public anon key as a bearer; any other credential is refused
        [[ "$cred" == "Bearer ${SUPABASE_ANON_KEY:-}" ]] || why="an Authorization header other than the public anon key"
      fi
      prev="$a"
    done
  fi
  if [[ -n "$why" ]]; then echo "REFUSED in production-readonly: $why" >&2; return 1; fi
  return 0
}
