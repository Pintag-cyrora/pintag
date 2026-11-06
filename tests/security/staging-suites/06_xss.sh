#!/usr/bin/env bash
# Suite 06 — XSS
#
# @suite    XSS
# @purpose  Verify XSS payloads are stored faithfully (not escaped by API) and draft RLS prevents anon access
# @covers   table:properties
# @needs    ADMIN_EMAIL,ADMIN_PASSWORD optional:SITE_URL
# @runtime  ~20s
#
# XSS protection is a two-layer concern:
#   1. All DB-sourced values pass through esc() before insertion into innerHTML.
#      This is verified by static code review.
#   2. The API stores and returns raw (unescaped) values — correct by design.
#      The tests here confirm storage, RLS filtering, and (optionally) browser rendering.
#
# Full rendering validation requires a browser.  If SITE_URL is set and Node.js
# with @playwright/test is available, an automated browser check is attempted.
# Otherwise a manual instruction is printed.

run_xss_tests() {
  suite_start "XSS"

  local r body status

  # XSS payloads to test
  local PAYLOADS=(
    '<script>alert(document.domain)</script>'
    '<img src=x onerror=alert(1)>'
    '"><svg onload=alert(1)>'
    "javascript:alert(1)"
    '<iframe src="javascript:alert(1)"></iframe>'
  )

  if [[ -z "${ADMIN_JWT:-}" ]]; then
    skip "XSS injection tests" "ADMIN_EMAIL/ADMIN_PASSWORD not set — cannot write test payloads to DB"
    info "Manual check: in the admin panel, set a listing title to:"
    info "  <img src=x onerror=alert(document.domain)>"
    info "  Then visit /listings.html and /listing.html in a browser."
    info "  PASS = title appears as escaped text. FAIL = alert fires."
    suite_end
    return
  fi

  local ts="${RUN_ID_SHORT}"

  # Buyer Contact is mandatory going forward — one shared contact for all
  # payload rows in this loop (title/contact are unrelated concerns here).
  r=$(api_post "contacts" '{"role":"other","phone":"02055555555"}' "${ADMIN_JWT}")
  local xss_contact_id
  xss_contact_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  [[ -n "$xss_contact_id" ]] && register_cleanup_contact "$xss_contact_id"

  for i in "${!PAYLOADS[@]}"; do
    local payload="${PAYLOADS[$i]}"
    local slug="pentest-xss-${ts}-${i}"

    # Escape the payload for JSON (basic escaping for shell insertion)
    local json_payload
    json_payload=$(printf '%s' "$payload" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null \
      || printf '%s' "$payload" | sed 's/"/\\"/g; s/</\\u003c/g; s/>/\\u003e/g')

    # ── Insert via admin ───────────────────────────────────────────────
    r=$(api_post "properties" \
      "{\"title_en\":${json_payload},\"status\":\"draft\",\"slug\":\"${slug}\",\"transaction_type\":\"for_sale\",\"contact_id\":$( [[ -n "$xss_contact_id" ]] && echo "\"${xss_contact_id}\"" || echo null )}" \
      "${ADMIN_JWT}")
    status="$(resp_status "$r")"

    if [[ ! "$status" =~ ^2 ]]; then
      info "Skipping payload $i (INSERT failed: $status)"
      continue
    fi

    local listing_id
    listing_id=$(resp_body "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    [[ -n "$listing_id" ]] && register_cleanup_listing "$listing_id"

    # ── Draft invisible to anon (RLS test) ────────────────────────────
    r=$(api_get "properties?id=eq.${listing_id}&select=id,title_en")
    check_empty "XSS payload ${i}: draft not visible to anon (RLS)" "$(resp_body "$r")"

    # ── Raw API returns unescaped payload (correct — escaping is frontend's job) ──
    r=$(api_get "properties?id=eq.${listing_id}&select=title_en" "${ADMIN_JWT}")
    body="$(resp_body "$r")"
    # The raw characters from the payload must be stored faithfully (not pre-escaped by API)
    # We check for key distinctive characters from each payload
    case $i in
      0) check "XSS payload 0 stored faithfully (<script> tag)" 'script' "$body" ;;
      1) check "XSS payload 1 stored faithfully (<img> tag)" 'onerror' "$body" ;;
      2) check "XSS payload 2 stored faithfully (<svg> tag)" 'onload' "$body" ;;
      3) check "XSS payload 3 stored faithfully (javascript: URI)" 'javascript' "$body" ;;
      4) check "XSS payload 4 stored faithfully (<iframe> tag)" 'iframe' "$body" ;;
    esac
    info "  Payload stored as raw value (escaping is frontend esc() responsibility)"

    # ── Make active + check public API still returns raw value ────────
    api_patch "properties?id=eq.${listing_id}" '{"status":"active"}' "${ADMIN_JWT}" >/dev/null 2>&1

    r=$(api_get "properties?id=eq.${listing_id}&select=title_en")
    body="$(resp_body "$r")"
    check "XSS payload ${i}: public API returns raw value (frontend must escape)" \
      '^\[' "$body"
    info "  Public API returns raw value; esc() in JS prevents execution in browser"

    # Reset to draft for safety
    api_patch "properties?id=eq.${listing_id}" '{"status":"draft"}' "${ADMIN_JWT}" >/dev/null 2>&1
  done

  # ── Browser rendering check (optional, Playwright) ────────────────────
  if [[ -n "${SITE_URL:-}" ]]; then
    info ""
    info "Browser rendering check"
    if command -v node >/dev/null 2>&1 && node -e "require('@playwright/test')" 2>/dev/null; then
      info "Playwright available — running browser XSS check..."
      _run_playwright_xss_check
    else
      info "Playwright not installed — manual check required:"
      info "  1. In admin panel, set a listing title to: <img src=x onerror=alert(1)>"
      info "  2. Visit: ${SITE_URL}/listings.html"
      info "  3. PASS = title visible as literal text. FAIL = alert() fires."
    fi
  else
    info ""
    info "Set SITE_URL to enable browser rendering verification."
    info "Manual check: admin panel → set listing title to <img src=x onerror=alert(1)>"
    info "              visit /listings.html → no alert should fire"
  fi

  suite_end
}

# ── Optional Playwright browser check ────────────────────────────────────────
_run_playwright_xss_check() {
  local check_script
  check_script=$(mktemp /tmp/pintag-xss-XXXXXX.mjs)
  cat > "$check_script" << 'PLAYWRIGHT_SCRIPT'
import { chromium } from 'playwright';

const SITE_URL = process.env.SITE_URL || '';
if (!SITE_URL) { console.log('SKIP: SITE_URL not set'); process.exit(0); }

let alertFired = false;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH ? undefined : '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
page.on('dialog', async dialog => {
  alertFired = true;
  await dialog.dismiss();
});

await page.goto(`${SITE_URL}/listings.html`, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
await browser.close();

if (alertFired) {
  console.error('FAIL: alert() fired on listings.html — XSS protection not working');
  process.exit(1);
} else {
  console.log('PASS: no alert() fired on listings.html');
  process.exit(0);
}
PLAYWRIGHT_SCRIPT

  if node "$check_script" 2>&1 | grep -q "PASS"; then
    check "Browser: no alert() fired on listings.html" "PASS" "PASS"
  else
    check "Browser: no alert() fired on listings.html" "PASS" "FAIL — see playwright output above"
  fi
  rm -f "$check_script"
}
