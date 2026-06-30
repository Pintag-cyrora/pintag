#!/usr/bin/env bash
# Suite 08 — Security Headers
#
# @suite    Headers
# @purpose  Verify HTTP security response headers are present on all frontend pages
# @covers   header:Content-Security-Policy header:X-Frame-Options header:X-Content-Type-Options header:Referrer-Policy header:Permissions-Policy header:Strict-Transport-Security
# @needs    SITE_URL
# @runtime  ~20s
#
# Note: Pintag uses CSP <meta> tags, not HTTP response headers.
# The HTTP header layer (X-Frame-Options, Referrer-Policy etc.) must be
# configured at the CDN/host level.  This suite reports what is present and
# warns clearly about what is missing.

run_headers_tests() {
  suite_start "Security Headers"

  if [[ -z "${SITE_URL:-}" ]]; then
    skip "All header checks" "SITE_URL not set (e.g. SITE_URL=https://pintag.io)"
    suite_end
    return
  fi

  # Pages to check
  local PAGES=(
    "/"
    "/listings.html"
    "/listing.html"
    "/agents.html"
    "/admin.html"
  )

  for page in "${PAGES[@]}"; do
    local url="${SITE_URL}${page}"
    local headers
    headers=$(curl -sIL --max-time 10 "$url" 2>/dev/null)

    if [[ -z "$headers" ]]; then
      skip "Headers for ${page}" "request failed or timed out"
      continue
    fi

    info "--- ${page} ---"

    # ── CSP (may be in response header OR in <meta> tag) ──────────────
    if echo "$headers" | grep -qi "content-security-policy:"; then
      local csp_header
      csp_header=$(echo "$headers" | grep -i "content-security-policy:" | head -1)
      check "${page}: CSP response header present" "." "$csp_header"
      check "${page}: CSP has object-src 'none'" "object-src 'none'" "$csp_header"
      # unsafe-eval should not be present
      if echo "$csp_header" | grep -q "unsafe-eval"; then
        fail_hard "${page}: CSP contains unsafe-eval" \
          "Remove unsafe-eval to block script injection via eval()/setTimeout(string)"
      else
        check "${page}: CSP has no unsafe-eval" "." "no-unsafe-eval-confirmed"
      fi
    else
      # Check for meta CSP in HTML body
      local body
      body=$(curl -sL --max-time 10 "$url" 2>/dev/null | head -50)
      if echo "$body" | grep -qi "Content-Security-Policy"; then
        check "${page}: CSP meta tag present in HTML" "Content-Security-Policy" "$body"
        info "  CSP is in <meta> tag only — HTTP header layer not set (add at CDN/host)"
      else
        fail_hard "${page}: No CSP found (neither HTTP header nor meta tag)" \
          "Add <meta http-equiv='Content-Security-Policy' ...> or configure CDN/host to send CSP header"
      fi
    fi

    # ── X-Frame-Options (or frame-ancestors in CSP) ────────────────────
    if echo "$headers" | grep -qi "x-frame-options:"; then
      local xfo
      xfo=$(echo "$headers" | grep -i "x-frame-options:" | head -1)
      check "${page}: X-Frame-Options present" "DENY\|SAMEORIGIN" "$xfo"
    else
      # Accept frame-ancestors in CSP header as equivalent
      local csp_hdr
      csp_hdr=$(echo "$headers" | grep -i "content-security-policy:" | head -1)
      if echo "$csp_hdr" | grep -qi "frame-ancestors"; then
        check "${page}: frame-ancestors in CSP (equivalent to X-Frame-Options)" "frame-ancestors" "$csp_hdr"
      else
        fail_hard "${page}: Missing X-Frame-Options and frame-ancestors" \
          "Configure CDN/host to send X-Frame-Options: DENY or add frame-ancestors to CSP"
      fi
    fi

    # ── X-Content-Type-Options ─────────────────────────────────────────
    if echo "$headers" | grep -qi "x-content-type-options:"; then
      check "${page}: X-Content-Type-Options: nosniff" "nosniff" \
        "$(echo "$headers" | grep -i "x-content-type-options:" | head -1)"
    else
      fail_hard "${page}: Missing X-Content-Type-Options" \
        "Configure CDN/host: X-Content-Type-Options: nosniff — prevents MIME-sniffing attacks"
    fi

    # ── Referrer-Policy ────────────────────────────────────────────────
    if echo "$headers" | grep -qi "referrer-policy:"; then
      local rp
      rp=$(echo "$headers" | grep -i "referrer-policy:" | head -1)
      check "${page}: Referrer-Policy present" "." "$rp"
      # Warn if set to unsafe-url or no-referrer-when-downgrade (leaks full URL)
      if echo "$rp" | grep -qi "unsafe-url\|no-referrer-when-downgrade"; then
        fail_hard "${page}: Referrer-Policy leaks full URL" \
          "Use 'strict-origin-when-cross-origin' or 'no-referrer' to prevent URL leakage"
      fi
    else
      fail_hard "${page}: Missing Referrer-Policy" \
        "Configure CDN/host: Referrer-Policy: strict-origin-when-cross-origin"
    fi

    # ── Permissions-Policy ─────────────────────────────────────────────
    if echo "$headers" | grep -qi "permissions-policy:"; then
      check "${page}: Permissions-Policy present" "." \
        "$(echo "$headers" | grep -i "permissions-policy:" | head -1)"
    else
      fail_hard "${page}: Missing Permissions-Policy" \
        "Configure CDN/host: Permissions-Policy: camera=(), microphone=(), geolocation=()"
    fi

    # ── Strict-Transport-Security ──────────────────────────────────────
    if echo "$headers" | grep -qi "strict-transport-security:"; then
      local hsts
      hsts=$(echo "$headers" | grep -i "strict-transport-security:" | head -1)
      check "${page}: HSTS header present" "max-age=" "$hsts"
    else
      fail_hard "${page}: Missing Strict-Transport-Security" \
        "Configure CDN/host: Strict-Transport-Security: max-age=31536000; includeSubDomains"
    fi

    # ── Server header should not leak technology ───────────────────────
    if echo "$headers" | grep -qi "^server:"; then
      local srv
      srv=$(echo "$headers" | grep -i "^server:" | head -1)
      info "Server header: ${srv} (consider removing or masking)"
    fi
  done

  suite_end
}
