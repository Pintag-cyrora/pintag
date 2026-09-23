// Regression test for scripts/verify-production-http.sh's PASS / FAIL /
// UNVERIFIABLE classification of sections 8 (security headers) and 9 (XSS
// fix live-proof).
//
// Root cause this covers: the 2026-09 Bot Fight Mode investigation proved
// Cloudflare's Managed Challenge page -- served to this exact class of
// runner on the FIRST plain curl request to listing.html/admin.html, no
// custom headers or request volume involved -- carries its own HSTS,
// X-Content-Type-Options, Referrer-Policy, X-Frame-Options and even a
// `<meta http-equiv="Content-Security-Policy">` with a `connect-src`. Every
// header/content check in the script used to run unconditionally against
// whatever curl returned, so a challenge silently PASSED every one of those
// checks and then FAILED "listing.html has no escJs()" -- reporting
// Cloudflare's own interstitial as a deployment regression.
//
// This spawns the REAL script (not a reimplementation) as a child process
// against two local HTTP servers -- one standing in for Supabase (a single
// catch-all "permission denied" responder, since sections 1-7 aren't what
// this file tests) and one standing in for pintag.io, configurable per test
// to return genuine-looking HTML, a representative Cloudflare challenge, or
// other edge cases -- and asserts on the actual stdout classification.
//
//   node --test verify-production-http-classification.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-production-http.sh');

// The exact marker the script itself extracts from config.prod.js -- read the
// same way, so this test can never drift from what the script actually looks
// for even if the production Supabase project is ever rotated.
const CONFIG_PROD = fs.readFileSync(path.join(REPO_ROOT, 'config.prod.js'), 'utf8');
const SUPABASE_HOST = CONFIG_PROD.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0].replace('https://', '');

// The REAL escJs() shipped in listing.html/admin.html today (copied verbatim
// from listing.html's own escJs(), same fixture convention as
// verify-production-xss-headers.test.js).
const REAL_ESC_JS_SOURCE = [
  'function escJs(str){',
  "  if(str==null)return '';",
  '  return String(str)',
  "    .replace(/\\\\/g,'\\\\\\\\')",
  '    .replace(/\'/g,"\\\\\'")',
  "    .replace(/\\r/g,'\\\\r').replace(/\\n/g,'\\\\n')",
  "    .replace(/\\u2028/g,'\\\\u2028').replace(/\\u2029/g,'\\\\u2029')",
  "    .replace(/&/g,'&amp;')",
  '    .replace(/"/g,\'&quot;\')',
  "    .replace(/</g,'&lt;').replace(/>/g,'&gt;');",
  '}',
].join('\n');

// A genuine page: security headers, the CSP meta tag (with connect-src and
// the production Supabase host -- the marker the script checks for) and, for
// listing.html, escJs(); for admin.html, the escJs(p.title_en call site.
function genuinePage({ escJs = true, adminCallSite = false } = {}) {
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://${SUPABASE_HOST}">`,
    '<title>Pintag</title>',
    '</head><body>',
    escJs ? `<script>${REAL_ESC_JS_SOURCE}</script>` : '',
    adminCallSite ? `<button onclick="deleteListing('\${escJs(p.id)}','\${escJs(p.title_en||'')}')">` : '',
    '</body></html>',
  ].join('\n');
}

const GENUINE_HEADERS = {
  'Content-Type': 'text/html; charset=UTF-8',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

// Representative of the ACTUAL Cloudflare Managed Challenge captured during
// the 2026-09 investigation (run 35832585278, CF-Ray a3f7e1758c50c872-DFW):
// HTTP 403, cf-mitigated: challenge, and -- critically -- its OWN HSTS/
// nosniff/X-Frame-Options/CSP-with-connect-src, none of which reference
// Pintag's Supabase host.
const CHALLENGE_HEADERS = {
  'Content-Type': 'text/html; charset=UTF-8',
  'cf-mitigated': 'challenge',
  'CF-Ray': 'a3f7e1758c50c872-DFW',
  'Server': 'cloudflare',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
};
const CHALLENGE_BODY = [
  '<!doctype html><html><head>',
  '<meta http-equiv="content-security-policy" content="default-src \'none\'; script-src \'nonce-x\' \'unsafe-eval\' https://challenges.cloudflare.com; connect-src \'self\' https://challenges.cloudflare.com">',
  '<title>Just a moment...</title>',
  '</head><body></body></html>',
].join('\n');

function startSupabaseStub() {
  // Every check in sections 1-7 that matters here only greps the body for a
  // denial-shaped substring, or (edge functions) reads the HTTP status code
  // -- a single "permission denied" 403 satisfies every one of those regexes
  // at once. This intentionally is NOT a faithful Supabase mock: sections
  // 1-7 are not what this file tests (see verify-admin-lockdown.sh and the
  // security-regression suites for that).
  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"message":"permission denied for table","code":"42501"}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// pages: { 'listing.html': {status, headers, body}, 'admin.html': {...} }
function startPintagStub(pages) {
  const server = http.createServer((req, res) => {
    const key = req.url.replace(/^\//, '');
    const page = pages[key];
    if (!page) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(page.status, page.headers);
    res.end(page.body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function run(pages) {
  const supabase = await startSupabaseStub();
  const pintag = await startPintagStub(pages);
  const supabaseUrl = `http://127.0.0.1:${supabase.address().port}`;
  const siteUrl = `http://127.0.0.1:${pintag.address().port}`;
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('bash', [SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY: 'test-anon-key',
        SITE_URL: siteUrl,
      },
    }));
  } catch (e) {
    // The script legitimately exits non-zero when any section reports FAIL
    // (including the generic Supabase-stub noise in sections 1-7) -- that is
    // not what this file checks. Only stdout content matters here.
    stdout = e.stdout || '';
  } finally {
    supabase.close();
    pintag.close();
  }
  return stdout;
}

test('genuine HTML for both pages: headers and XSS-fix checks run normally and PASS', async () => {
  const stdout = await run({
    'listing.html': { status: 200, headers: GENUINE_HEADERS, body: genuinePage({ escJs: true }) },
    'admin.html': { status: 200, headers: GENUINE_HEADERS, body: genuinePage({ adminCallSite: true }) },
  });

  assert.match(stdout, /PASS {2}listing\.html: Strict-Transport-Security present/);
  assert.match(stdout, /PASS {2}listing\.html: framing protection present/);
  assert.match(stdout, /PASS {2}admin\.html: Strict-Transport-Security present/);
  assert.match(stdout, /PASS {2}deployed listing\.html carries the CSP meta tag/);
  assert.match(stdout, /PASS {2}listing\.html on .* contains escJs\(\) \(F-02 fix deployed\)/);
  assert.match(stdout, /PASS {2}admin\.html on .* escapes the listing title.*\(F-01 fix deployed\)/);
  assert.doesNotMatch(stdout, /UNVERIFIABLE/);
});

test('Cloudflare Managed Challenge on listing.html: UNVERIFIABLE, never PASS, never a false escJs FAIL', async () => {
  const stdout = await run({
    'listing.html': { status: 403, headers: CHALLENGE_HEADERS, body: CHALLENGE_BODY },
    'admin.html': { status: 200, headers: GENUINE_HEADERS, body: genuinePage({ adminCallSite: true }) },
  });

  assert.match(stdout, /UNVERIFIABLE {2}listing\.html: security headers\s*\n\s*→ Cloudflare Bot Fight Mode returned a Managed Challenge \(HTTP 403, cf-mitigated: challenge\)/);
  assert.match(stdout, /UNVERIFIABLE {2}listing\.html CSP meta tag/);
  assert.match(stdout, /UNVERIFIABLE {2}listing\.html escJs\(\) \(F-02\)/);
  // The challenge must never be scored as if it were the real page.
  assert.doesNotMatch(stdout, /PASS {2}listing\.html: Strict-Transport-Security/);
  assert.doesNotMatch(stdout, /listing\.html on .* has NO escJs\(\)/);
  assert.doesNotMatch(stdout, /listing\.html carries NO CSP/);
  // admin.html was never challenged and must still be evaluated normally.
  assert.match(stdout, /PASS {2}admin\.html: Strict-Transport-Security present/);
  assert.match(stdout, /PASS {2}admin\.html on .* escapes the listing title.*\(F-01 fix deployed\)/);
});

test('Cloudflare Managed Challenge on BOTH pages: both UNVERIFIABLE independently', async () => {
  const stdout = await run({
    'listing.html': { status: 403, headers: CHALLENGE_HEADERS, body: CHALLENGE_BODY },
    'admin.html': { status: 403, headers: CHALLENGE_HEADERS, body: CHALLENGE_BODY },
  });

  assert.match(stdout, /UNVERIFIABLE {2}listing\.html: security headers/);
  assert.match(stdout, /UNVERIFIABLE {2}admin\.html: security headers/);
  assert.match(stdout, /UNVERIFIABLE {2}listing\.html escJs\(\) \(F-02\)/);
  assert.match(stdout, /UNVERIFIABLE {2}admin\.html escJs\(p\.title_en\) \(F-01\)/);
  assert.doesNotMatch(stdout, /PASS {2}(listing|admin)\.html: Strict-Transport-Security/);
});

test('genuine HTTP 200 missing escJs() is a real FAIL, not swallowed as UNVERIFIABLE', async () => {
  const stdout = await run({
    'listing.html': { status: 200, headers: GENUINE_HEADERS, body: genuinePage({ escJs: false }) },
    'admin.html': { status: 200, headers: GENUINE_HEADERS, body: genuinePage({ adminCallSite: true }) },
  });

  assert.match(stdout, /FAIL {2}listing\.html on .* has NO escJs\(\)/);
  assert.match(stdout, /the deployed build predates the XSS fix — F-02 is still live/);
  assert.doesNotMatch(stdout, /UNVERIFIABLE {2}listing\.html escJs/);
});

test('2xx response without the expected Pintag marker is UNVERIFIABLE, not evaluated as the real page', async () => {
  const unrecognizedBody = '<!doctype html><html><head><title>Some other 200</title></head><body>not pintag</body></html>';
  const stdout = await run({
    'listing.html': { status: 200, headers: GENUINE_HEADERS, body: unrecognizedBody },
    'admin.html': { status: 200, headers: GENUINE_HEADERS, body: genuinePage({ adminCallSite: true }) },
  });

  assert.match(stdout, /UNVERIFIABLE {2}listing\.html: security headers\s*\n\s*→ HTTP 200 but the response body did not contain the expected production marker/);
  assert.match(stdout, /UNVERIFIABLE {2}listing\.html escJs\(\) \(F-02\)/);
  assert.doesNotMatch(stdout, /has NO escJs\(\)/);
});

test('final RESULT line reports the unverifiable tally separately from passed/failed/warnings', async () => {
  const stdout = await run({
    'listing.html': { status: 403, headers: CHALLENGE_HEADERS, body: CHALLENGE_BODY },
    'admin.html': { status: 200, headers: GENUINE_HEADERS, body: genuinePage({ adminCallSite: true }) },
  });
  assert.match(stdout, /RESULT: \d+ passed, \d+ failed, \d+ warning\(s\), [1-9]\d* unverifiable/);
});
