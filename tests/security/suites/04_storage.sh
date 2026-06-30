#!/usr/bin/env bash
# Suite 04 — Storage
#
# @suite    Storage
# @purpose  Verify upload/delete policies, extension filtering, MIME disguise, and cross-user isolation
# @covers   bucket:property-images bucket:agent-photos
# @needs    optional:ADMIN_EMAIL,ADMIN_PASSWORD optional:TEST_USER_EMAIL,TEST_USER_PASSWORD
# @runtime  ~30s

run_storage_tests() {
  suite_start "Storage"

  local r status ts
  ts="${RUN_ID_SHORT}"

  for bucket in "property-images" "agent-photos"; do
    info "--- ${bucket} ---"

    # ── Anonymous upload ────────────────────────────────────────────────
    r=$(storage_upload "$bucket" "pentest-anon-${ts}.jpg" "image/jpeg" "FAKEJPEG")
    check_status "anon upload to ${bucket} → 4xx" "" "$(resp_status "$r")"
    # More specific: expect 400 (policy violation) or 403
    check "anon upload → 4xx" "^4[0-9][0-9]$" "$(resp_status "$r")"

    # ── Anonymous delete ────────────────────────────────────────────────
    r=$(storage_delete "$bucket" "does-not-exist-${ts}.jpg")
    check "anon DELETE from ${bucket} → 4xx" "^4[0-9][0-9]$" "$(resp_status "$r")"

    # ── Invalid extensions (no auth — blocked at auth layer, correct) ───
    for ext in "php" "js" "sh" "html" "exe"; do
      r=$(storage_upload "$bucket" "pentest-${ts}.${ext}" "application/octet-stream" "MALICIOUS")
      check "anon upload .${ext} to ${bucket} → 4xx" "^4[0-9][0-9]$" "$(resp_status "$r")"
    done

    if [[ -n "${ADMIN_JWT:-}" ]]; then
      # ── Admin upload with invalid extension (WITH CHECK policy) ────────
      r=$(storage_upload "$bucket" "pentest-admin-bad-${ts}.php" \
        "application/x-httpd-php" "<?php phpinfo(); ?>" "${ADMIN_JWT}")
      check "admin upload .php to ${bucket} → 4xx (extension denied by WITH CHECK)" \
        "^4[0-9][0-9]$" "$(resp_status "$r")"

      r=$(storage_upload "$bucket" "pentest-admin-bad-${ts}.js" \
        "application/javascript" "alert(1)" "${ADMIN_JWT}")
      check "admin upload .js to ${bucket} → 4xx (extension denied by WITH CHECK)" \
        "^4[0-9][0-9]$" "$(resp_status "$r")"

      r=$(storage_upload "$bucket" "pentest-admin-bad-${ts}.sh" \
        "application/x-sh" "#!/bin/bash" "${ADMIN_JWT}")
      check "admin upload .sh to ${bucket} → 4xx (extension denied by WITH CHECK)" \
        "^4[0-9][0-9]$" "$(resp_status "$r")"

      # ── Admin upload valid extension — should succeed ───────────────────
      local test_path="pentest-valid-${ts}.jpg"
      r=$(storage_upload "$bucket" "$test_path" "image/jpeg" "FAKEJPEG_PAYLOAD" "${ADMIN_JWT}")
      status="$(resp_status "$r")"
      check "admin upload valid .jpg to ${bucket} → 2xx" "^2[0-9][0-9]$" "$status"
      if [[ "$status" =~ ^2 ]]; then
        register_cleanup_storage "${bucket}/${test_path}"
      fi

      # ── MIME disguise: .jpg filename but PHP body ────────────────────────
      # The WITH CHECK policy only checks storage.extension(name) — not MIME.
      # This test documents the known limitation: extension passes, content is not validated.
      r=$(storage_upload "$bucket" "pentest-mime-disguise-${ts}.jpg" \
        "application/x-httpd-php" "<?php phpinfo(); ?>" "${ADMIN_JWT}")
      status="$(resp_status "$r")"
      info "MIME-disguise (.jpg name, PHP Content-Type, admin) → HTTP ${status}"
      info "  Known limitation: extension check passes; MIME validation requires platform config"
      if [[ "$status" =~ ^2 ]]; then
        register_cleanup_storage "${bucket}/pentest-mime-disguise-${ts}.jpg"
      fi

      # ── Double-extension: shell.php.jpg ──────────────────────────────────
      # storage.extension('shell.php.jpg') = 'jpg' — passes policy (known limitation).
      # Documented here to track if Supabase ever fixes this.
      r=$(storage_upload "$bucket" "pentest-dblext-${ts}.php.jpg" \
        "image/jpeg" "FAKEJPEG" "${ADMIN_JWT}")
      status="$(resp_status "$r")"
      info "Double-ext (.php.jpg, admin) → HTTP ${status}"
      info "  Known limitation: last-extension check passes; .php prefix is ignored"
      if [[ "$status" =~ ^2 ]]; then
        register_cleanup_storage "${bucket}/pentest-dblext-${ts}.php.jpg"
      fi

      # ── Reversed double-extension: image.jpg.php ─────────────────────────
      # storage.extension('image.jpg.php') = 'php' — should be blocked by policy.
      r=$(storage_upload "$bucket" "pentest-revdbl-${ts}.jpg.php" \
        "application/x-httpd-php" "<?php phpinfo(); ?>" "${ADMIN_JWT}")
      check "reversed double-ext (.jpg.php) → 4xx (extension blocked)" \
        "^4[0-9][0-9]$" "$(resp_status "$r")"

      # ── SVG with embedded JavaScript ─────────────────────────────────────
      # SVG is not in the allowlist — upload should be blocked regardless of content.
      r=$(storage_upload "$bucket" "pentest-xss-${ts}.svg" \
        "image/svg+xml" \
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' \
        "${ADMIN_JWT}")
      check "SVG with JS → 4xx (svg not in extension allowlist)" \
        "^4[0-9][0-9]$" "$(resp_status "$r")"

      # ── .htaccess upload ──────────────────────────────────────────────────
      r=$(storage_upload "$bucket" ".htaccess" \
        "text/plain" "Options -Indexes" "${ADMIN_JWT}")
      check ".htaccess upload → 4xx (no extension; not in allowlist)" \
        "^4[0-9][0-9]$" "$(resp_status "$r")"

      # ── Path traversal in object path ────────────────────────────────────
      # Supabase Storage normalises paths; this documents that traversal is not exploitable.
      r=$(storage_upload "$bucket" "../pentest-traversal-${ts}.jpg" \
        "image/jpeg" "FAKEJPEG" "${ADMIN_JWT}")
      status="$(resp_status "$r")"
      info "Path traversal (../file.jpg) → HTTP ${status}"
      if [[ "$status" =~ ^2 ]]; then
        # Normalised path likely stored without traversal; clean up defensively
        register_cleanup_storage "${bucket}/pentest-traversal-${ts}.jpg"
      fi

      # ── Cross-user: non-admin cannot overwrite admin-uploaded file ───────
      if [[ -n "${TEST_USER_JWT:-}" ]]; then
        r=$(storage_upload "$bucket" "pentest-valid-${ts}.jpg" \
          "image/jpeg" "OVERWRITE_ATTEMPT" "${TEST_USER_JWT}")
        check "non-admin overwrite of existing file → 4xx" \
          "^4[0-9][0-9]$" "$(resp_status "$r")"
      else
        skip "cross-user overwrite test for ${bucket}" "TEST_USER_EMAIL/TEST_USER_PASSWORD not set"
      fi
    else
      skip "Admin storage tests for ${bucket}" "ADMIN_EMAIL/ADMIN_PASSWORD not set"
    fi
  done

  suite_end
}
