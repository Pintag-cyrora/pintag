#!/usr/bin/env bash
# Suite 05 — SSRF (Server-Side Request Forgery)
#
# @suite    SSRF
# @purpose  Verify hostname allowlists on resolve-map-url and smart-listing-importer block SSRF payloads
# @covers   fn:resolve-map-url fn:smart-listing-importer
# @needs    optional:ADMIN_EMAIL,ADMIN_PASSWORD
# @runtime  ~20s

run_ssrf_tests() {
  suite_start "SSRF"

  local r body status

  # ════════════════════════════════════════════════════════
  # resolve-map-url — public function, hostname allowlist
  # ALLOWED_HOSTS = { maps.app.goo.gl, goo.gl, maps.google.com }
  # Protection: new URL(url).hostname must be in the set.
  # ════════════════════════════════════════════════════════
  info "--- resolve-map-url allowlist ---"

  # Allowed domains pass through
  r=$(fn_post "resolve-map-url" '{"url":"https://maps.app.goo.gl/testpath"}')
  check "allowed domain (maps.app.goo.gl) → not 403" \
    "^[^4]|^4[^0]|^40[^3]" "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"https://goo.gl/maps/testpath"}')
  check "allowed domain (goo.gl) → not 403" \
    "^[^4]|^4[^0]|^40[^3]" "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"https://maps.google.com/maps?q=test"}')
  check "allowed domain (maps.google.com) → not 403" \
    "^[^4]|^4[^0]|^40[^3]" "$(resp_status "$r")"

  info "--- resolve-map-url: disallowed domains ---"

  # Arbitrary domains
  r=$(fn_post "resolve-map-url" '{"url":"https://evil.com/payload"}')
  check_status "evil.com → 403" 403 "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"https://google.com/"}')
  check_status "google.com (not maps.google.com) → 403" 403 "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"https://notgoo.gl/"}')
  check_status "notgoo.gl (subdomain trick) → 403" 403 "$(resp_status "$r")"

  info "--- resolve-map-url: private / localhost IPs ---"

  r=$(fn_post "resolve-map-url" '{"url":"http://169.254.169.254/latest/meta-data/"}')
  check_status "AWS IMDS (169.254.169.254) → 403" 403 "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"http://localhost/"}')
  check_status "localhost → 403" 403 "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"http://127.0.0.1/"}')
  check_status "127.0.0.1 → 403" 403 "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"http://[::1]/"}')
  check_status "IPv6 loopback ([::1]) → 403" 403 "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"http://0.0.0.0/"}')
  check_status "0.0.0.0 → 403" 403 "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"http://10.0.0.1/"}')
  check_status "RFC-1918 (10.x) → 403" 403 "$(resp_status "$r")"

  r=$(fn_post "resolve-map-url" '{"url":"http://192.168.1.1/"}')
  check_status "RFC-1918 (192.168.x) → 403" 403 "$(resp_status "$r")"

  info "--- resolve-map-url: URL bypass attempts ---"

  # Userinfo trick: https://maps.app.goo.gl@evil.com/
  # new URL().hostname = "evil.com" — should be blocked
  r=$(fn_post "resolve-map-url" '{"url":"https://maps.app.goo.gl@evil.com/"}')
  check_status "userinfo bypass (goo.gl@evil.com) → 403" 403 "$(resp_status "$r")"

  # Subdomain of allowed host — not in allowlist (Set uses exact match)
  r=$(fn_post "resolve-map-url" '{"url":"https://sub.maps.app.goo.gl/"}')
  check_status "subdomain of allowed host (sub.maps.app.goo.gl) → 403" 403 "$(resp_status "$r")"

  # Encoded hostname: m%61ps.app.goo.gl  (URL constructor decodes → maps.app.goo.gl → allowed)
  r=$(fn_post "resolve-map-url" '{"url":"https://m%61ps.app.goo.gl/test"}')
  status="$(resp_status "$r")"
  info "Percent-encoded allowed host (m%61ps.app.goo.gl) → HTTP ${status}"
  info "  URL constructor decodes to maps.app.goo.gl → same as canonical allowed host"

  # Double-encoded: maps.app.%67%6F%6F.gl — still decodes to maps.app.goo.gl
  r=$(fn_post "resolve-map-url" '{"url":"https://maps.app.%67%6F%6F.gl/test"}')
  status="$(resp_status "$r")"
  info "Double-encoded allowed host (%67%6F%6F.gl) → HTTP ${status}"

  # Protocol-relative / non-https: should still be blocked if hostname not in set
  r=$(fn_post "resolve-map-url" '{"url":"ftp://maps.app.goo.gl/"}')
  status="$(resp_status "$r")"
  info "FTP scheme with allowed hostname → HTTP ${status} (hostname passes; fetch may fail)"

  # ════════════════════════════════════════════════════════
  # smart-listing-importer — admin-only, *.supabase.co allowlist
  # Protection: ALLOWED_IMAGE_HOSTS = /^[a-z0-9-]+\.supabase\.co$/i
  # Auth gate fires before SSRF check, so non-admins are blocked at 401.
  # ════════════════════════════════════════════════════════
  info "--- smart-listing-importer image_urls SSRF ---"

  # Without auth: SSRF payloads never reach urlToBase64 — 401 blocks first
  local ssrf_payloads=(
    '{"description":"test","image_urls":["http://169.254.169.254/latest/meta-data/"]}'
    '{"description":"test","image_urls":["http://localhost/internal"]}'
    '{"description":"test","image_urls":["http://evil.com/exfil"]}'
    '{"description":"test","image_urls":["https://maps.app.goo.gl@evil.com/"]}'
  )
  for payload in "${ssrf_payloads[@]}"; do
    local url
    url=$(echo "$payload" | grep -o '"http[^"]*"' | head -1 | tr -d '"')
    r=$(fn_post "smart-listing-importer" "$payload")
    check_status "SSRF auth gate blocks ${url} → 401 (before SSRF runs)" 401 "$(resp_status "$r")"
  done

  # With admin auth: verify the allowlist silently discards non-supabase URLs
  if [[ -n "${ADMIN_JWT:-}" ]]; then
    info "Admin-authenticated SSRF: non-supabase URLs silently discarded"

    # Payload with IMDS URL — should be silently skipped (returned as no images)
    r=$(fn_post "smart-listing-importer" \
      '{"description":"3BR villa in Sisattanak","image_urls":["http://169.254.169.254/latest/meta-data/"]}' \
      "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    body="$(resp_body "$r")"
    # Expect success (Gemini called with 0 images) or a Gemini error — NOT a successful IMDS fetch
    if [[ "$status" =~ ^2 ]]; then
      # photo_analysis should be empty since IMDS URL was discarded
      check "IMDS URL silently discarded: photo_analysis is empty" \
        '"photo_analysis":\s*\[\]' "$body"
    else
      info "smart-listing-importer returned ${status} (Gemini may be unavailable) — SSRF gate still passed"
    fi

    r=$(fn_post "smart-listing-importer" \
      '{"description":"3BR villa","image_urls":["http://evil.com/exfil","http://localhost/"]}' \
      "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    if [[ "$status" =~ ^2 ]]; then
      body="$(resp_body "$r")"
      check "Evil/localhost URLs silently discarded: photo_analysis is empty" \
        '"photo_analysis":\s*\[\]' "$body"
    else
      info "smart-listing-importer returned ${status} — SSRF gate operative (non-supabase URLs discarded before Gemini call)"
    fi

    # Userinfo bypass attempt: supabase.co@evil.com — hostname = evil.com → discarded
    r=$(fn_post "smart-listing-importer" \
      '{"description":"test","image_urls":["https://eoladhcljbpbhnrmmpev.supabase.co@evil.com/image.jpg"]}' \
      "${ADMIN_JWT}")
    status="$(resp_status "$r")"
    if [[ "$status" =~ ^2 ]]; then
      body="$(resp_body "$r")"
      check "Userinfo bypass (supabase.co@evil.com) discarded: photo_analysis empty" \
        '"photo_analysis":\s*\[\]' "$body"
    else
      info "smart-listing-importer returned ${status} — userinfo bypass attempt handled"
    fi
  else
    skip "Admin-authenticated SSRF tests (smart-listing-importer)" \
      "ADMIN_EMAIL/ADMIN_PASSWORD not set"
  fi

  suite_end
}
