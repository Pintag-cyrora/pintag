#!/usr/bin/env bash
# Suite 12 — Open Redirect
#
# @suite    Open Redirect
# @purpose  Verify resolve-map-url rejects open-redirect bypass payloads and validates resolved_url domain
# @covers   fn:resolve-map-url
# @needs    none
# @runtime  ~15s
#
# Tests Pintag's only URL-accepting endpoint, resolve-map-url, for open redirect
# vulnerabilities.
#
# Architecture note:
#   resolve-map-url validates the INPUT URL's hostname against an allowlist, then
#   fetches with redirect:follow, and returns {"resolved_url": <final URL>}.
#   The function does NOT re-validate the resolved URL after following redirects.
#   This means a goo.gl short-URL that redirects to evil.com would return
#   resolved_url=https://evil.com — an open redirect if callers use this value
#   directly for browser navigation.  This is documented as a known limitation;
#   these tests verify the surrounding controls.
#
# Tests:
#   - Protocol-relative URL (//)  → blocked
#   - Leading-whitespace URL      → blocked
#   - javascript: / data: / file: → blocked (also covered in SSRF suite)
#   - CRLF header injection        → blocked
#   - URL fragment attack          → blocked or harmless
#   - Null-byte hostname           → blocked
#   - For an allowed domain, resolved_url is not an attacker domain
#   - Empty / malformed URLs       → structured error (not crash)

run_open_redirect_tests() {
  suite_start "Open Redirect"

  local r body status resolved_url

  # ════════════════════════════════════
  # Protocol-relative and scheme-less URLs
  # ════════════════════════════════════
  info "--- Protocol-relative and scheme-less URLs ---"

  CURRENT_TEST="open-redirect: protocol-relative //evil.com"
  r=$(fn_post "resolve-map-url" '{"url":"//evil.com/path"}')
  status=$(resp_status "$r")
  check "protocol-relative //evil.com → 4xx (no scheme; allowlist rejects)" \
    "^4[0-9][0-9]$" "$status"

  CURRENT_TEST="open-redirect: leading space before https"
  r=$(fn_post "resolve-map-url" '{"url":" https://evil.com/"}')
  status=$(resp_status "$r")
  check "leading-space URL → 4xx (not in allowlist)" \
    "^4[0-9][0-9]$" "$status"

  CURRENT_TEST="open-redirect: no-scheme hostname only"
  r=$(fn_post "resolve-map-url" '{"url":"evil.com"}')
  status=$(resp_status "$r")
  check "bare hostname (no scheme) → 4xx (rejected)" \
    "^4[0-9][0-9]$" "$status"

  # ════════════════════════════════════
  # Header injection via CRLF in URL
  # A URL containing \r\n could split an HTTP response if reflected verbatim.
  # ════════════════════════════════════
  info "--- CRLF / header injection ---"

  CURRENT_TEST="open-redirect: CRLF in URL"
  r=$(fn_post "resolve-map-url" "$(printf '{"url":"https://maps.app.goo.gl/\\r\\nX-Injected: header"}')")
  status=$(resp_status "$r")
  body=$(resp_body "$r")
  check "CRLF injection in URL → 4xx (allowlist rejects or URL parse error)" \
    "^4[0-9][0-9]$" "$status"

  CURRENT_TEST="open-redirect: encoded CRLF %0d%0a in URL"
  r=$(fn_post "resolve-map-url" '{"url":"https://maps.app.goo.gl/%0d%0aX-Injected: header"}')
  status=$(resp_status "$r")
  check "encoded CRLF (%0d%0a) → does not 500" \
    "^[^5]|^5[^0]|^50[^0]" "$status"

  # ════════════════════════════════════
  # Null-byte hostname confusion
  # ════════════════════════════════════
  info "--- Null-byte injection ---"

  CURRENT_TEST="open-redirect: null byte in URL"
  r=$(fn_post "resolve-map-url" "$(printf '{"url":"https://maps.app.goo.gl\\x00.evil.com/"}')")
  status=$(resp_status "$r")
  check "null-byte in URL → does not 500" \
    "^[^5]|^5[^0]|^50[^0]" "$status"

  # ════════════════════════════════════
  # Fragment-based bypass attempts
  # URL#evil.com — fragment is ignored by URL parser for hostname resolution
  # ════════════════════════════════════
  info "--- Fragment bypass ---"

  CURRENT_TEST="open-redirect: evil.com in URL fragment"
  r=$(fn_post "resolve-map-url" '{"url":"https://evil.com/#maps.app.goo.gl"}')
  status=$(resp_status "$r")
  check "evil.com with allowed-domain fragment → 4xx (hostname is evil.com)" \
    "^4[0-9][0-9]$" "$status"

  # ════════════════════════════════════
  # Encoded hostnames
  # ════════════════════════════════════
  info "--- Encoded hostname bypass ---"

  CURRENT_TEST="open-redirect: percent-encoded dot in hostname"
  # maps.app.goo%2egl — URL constructor normalises %2e to '.'
  r=$(fn_post "resolve-map-url" '{"url":"https://evil%2ecom/"}')
  status=$(resp_status "$r")
  check "percent-encoded hostname (evil%2ecom) → 4xx" \
    "^4[0-9][0-9]$" "$status"

  # ════════════════════════════════════
  # Verify resolved_url is on a safe domain for a legitimate input
  # We use maps.google.com which is in the allowlist.
  # The test verifies the returned resolved_url is not an attacker domain.
  # (Note: this does a live network request; may be skipped in offline environments.)
  # ════════════════════════════════════
  info "--- resolved_url domain verification ---"

  CURRENT_TEST="open-redirect: legitimate URL returns safe resolved_url"
  r=$(fn_post "resolve-map-url" '{"url":"https://maps.google.com/"}')
  status=$(resp_status "$r")
  body=$(resp_body "$r")

  if [[ "$status" =~ ^2 ]]; then
    resolved_url=$(echo "$body" | grep -o '"resolved_url":"[^"]*"' | cut -d'"' -f4)
    if [[ -n "$resolved_url" ]]; then
      # Extract hostname from resolved_url
      local resolved_host
      resolved_host=$(echo "$resolved_url" | grep -oE 'https?://[^/]+' \
        | sed 's|https\?://||; s|:[0-9]*$||')
      # Allow google.com and its subdomains
      if echo "$resolved_host" | grep -qE '(^|\.)google\.com$|^maps\.google\.com$'; then
        check "resolved_url stays on google.com domain" "." "ok"
      else
        fail_hard "resolved_url points to unexpected domain" \
          "resolved_url=${resolved_url} host=${resolved_host}"
      fi
    else
      info "No resolved_url in response body — skipping domain check"
      skip "resolved_url domain verification" "resolved_url not returned"
    fi
  else
    info "maps.google.com request returned ${status} — network may be restricted"
    skip "resolved_url domain verification" "live network request returned ${status:-000}"
  fi

  # ════════════════════════════════════
  # javascript: and data: (belt-and-suspenders; also in SSRF suite)
  # ════════════════════════════════════
  info "--- Protocol confusion ---"

  CURRENT_TEST="open-redirect: javascript: URL"
  r=$(fn_post "resolve-map-url" '{"url":"javascript:alert(document.domain)"}')
  check_status "javascript: URL → 403" 403 "$(resp_status "$r")"

  CURRENT_TEST="open-redirect: data: URL"
  r=$(fn_post "resolve-map-url" '{"url":"data:text/html,<h1>redirect</h1>"}')
  check_status "data: URL → 403" 403 "$(resp_status "$r")"

  # ════════════════════════════════════
  # Known limitation note
  # ════════════════════════════════════
  info "Known limitation: resolve-map-url follows HTTP redirects."
  info "  If a permitted shortlink (goo.gl) redirects to evil.com, the returned"
  info "  resolved_url will be https://evil.com. Client code MUST NOT use this"
  info "  value directly for browser navigation without re-validating the domain."

  suite_end
}
