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
    # SITE_URL is a repository secret: it is trusted as a destination only after it passes the same validation as every request (see pt_site_origin).
    if [[ -n "${SITE_URL:-}" ]]; then
      local so; so="$(pt_site_origin)" || { echo "SECURITY SUITE REFUSED: SITE_URL is not an acceptable destination (expected https://<the project's own domain from CNAME, or www. of it>, with no port, userinfo, path or query)." >&2; exit 1; }
      SITE_URL="$so"; export SITE_URL
    fi
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

# ── The production request allowlist ──────────────────────────────────────────────────────────────────────────────────────────────────────
# Fail-closed ALLOWLIST (not a denylist of curl options): a request is sent to production only if it is EXACTLY one of these forms, and anything the guard does not
# recognise is refused, however harmless it looks.
#   project read   METHOD in {GET, HEAD}, URL  https://<production-ref>.supabase.co/rest/v1/<table>[?<query>]  and the ONLY curl arguments are  -H "apikey: <anon key>"
#   site read      METHOD in {GET, HEAD}, URL  <validated SITE_URL><path>  and NO curl arguments at all
# <table> is one of the tables below (exact match; no sub-path, no rpc/, no extra segment). The path part carries no percent-escape, no dot segment, no "//" and no
# character outside [A-Za-z0-9._-]; the query is limited to a conservative character set in which every "%" starts a valid escape and no character can start a
# second URL, a curl glob ([ ] { }), a fragment, a credential (@) or a shell/URL metacharacter. Every other curl option, in any spelling (separate, attached, long,
# short, abbreviated, upper case, @file), is refused simply because it is not the one permitted pair. Nothing relies on the server rejecting the request.
PT_READ_TABLES=(properties parties contacts lead_events listing_events intelligence_reports intelligence_insights report_insights intelligence_sweep_lock)

# Validates SITE_URL and prints it without a trailing slash; non-zero (nothing printed) when it is not acceptable.
# Accepted: https://<host> with a plain DNS host name that is the project's own domain (the CNAME file) or www. of it. No port, userinfo, path, query, fragment,
# IP address, localhost, upper case, whitespace or control character.
pt_site_origin() {
  local s="${SITE_URL:-}" host cname
  s="${s%/}"
  [[ "$s" =~ ^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$ ]] || return 1
  host="${BASH_REMATCH[1]}"
  [[ "$host" =~ ^[0-9.]+$ ]] && return 1
  cname="$(head -n 1 "${PT_ROOT:-.}/CNAME" 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$cname" && ( "$host" == "$cname" || "$host" == "www.$cname" ) ]] || return 1
  printf '%s' "$s"
}

# pt_guard_request METHOD URL [curl args...]  -> returns 0 to allow, 1 to refuse (reason on stderr).
pt_guard_request() {
  local method="$1" url="$2"; shift 2
  # Fail closed: when nothing has classified the target (PT_MODE unset), assume production.
  [[ "${PT_MODE:-production-readonly}" == "production-readonly" ]] || return 0
  local why="" api="${SUPABASE_URL:-}" site rest path query t found=0
  api="${api%/}"
  [[ "$method" == "GET" || "$method" == "HEAD" ]] || why="method '$method' (only the exact upper-case GET and HEAD may be sent to production)"
  # the whole URL: a conservative character set, https only, no ambiguity before the query
  if [[ -z "$why" ]]; then
    [[ "$url" =~ ^https://[A-Za-z0-9._/~?=\&,*\(\)%+\!\'-]+$ ]] || why="the URL contains a character or form that is not allowed: ${url%%\?*}"
  fi
  if [[ -z "$why" ]]; then
    if [[ "$api" =~ ^https://[a-z0-9]{20}\.supabase\.co$ && "$url" == "$api/rest/v1/"* ]]; then
      # ── project read: exactly one table, optional query, exactly the anon-key header ──
      rest="${url#"$api"/rest/v1/}"; path="${rest%%\?*}"; query=""
      [[ "$rest" == *\?* ]] && query="${rest#*\?}"
      for t in "${PT_READ_TABLES[@]}"; do [[ "$path" == "$t" ]] && found=1; done
      [[ $found -eq 1 ]] || why="not one of the permitted read tables (exact name, no sub-path): ${path}"
      if [[ -z "$why" && -n "$query" ]]; then
        [[ "$query" =~ ^[A-Za-z0-9._~:=\&,*\(\)%+\!\'-]*$ ]] || why="the query contains a character that is not allowed"
        [[ "$query" =~ %($|[^0-9A-Fa-f]|[0-9A-Fa-f]($|[^0-9A-Fa-f])) ]] && why="the query contains a malformed percent-escape"
      fi
      if [[ -z "$why" ]]; then
        # exactly: -H "apikey: <anon key>"   (nothing else; this also refuses Authorization, cookies, bodies, -X, redirects, proxies, extra URLs, @files, abbreviations)
        if [[ -z "${SUPABASE_ANON_KEY:-}" || $# -ne 2 || "$1" != "-H" || "$2" != "apikey: ${SUPABASE_ANON_KEY}" ]]; then
          why="the only permitted curl arguments are exactly: -H \"apikey: <the public anon key>\""
        fi
      fi
    elif site="$(pt_site_origin)" && [[ "$url" == "$site" || "$url" == "$site/"* ]]; then
      # ── site read: a plain path of one or more segments, no query, no curl arguments ──
      path="${url#"$site"}"
      if [[ -n "$path" && ! "$path" =~ ^(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*/?$ ]]; then why="the site path is not a plain path (no dot segment, empty segment, escape or query): ${path}"
      elif [[ "$path" == *..* ]]; then why="the site path contains '..'"
      elif [[ $# -ne 0 ]]; then why="no curl arguments may accompany a site request"; fi
    else
      why="the destination is neither the production project's /rest/v1/<table> nor the validated site: ${url%%\?*}"
    fi
  fi
  if [[ -n "$why" ]]; then echo "REFUSED in production-readonly: $why" >&2; return 1; fi
  return 0
}
