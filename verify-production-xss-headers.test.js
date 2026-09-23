// Regression test for scripts/verify-production-xss.mjs's HTTP client
// identity fix.
//
// Root cause this covers: in the 2026-09-21 Verify Production Security
// investigation, this script's bare Node fetch() (no User-Agent/Accept)
// received HTTP 403 from production while scripts/verify-production-http.sh's
// curl-based probe fetched the exact same two pages successfully seconds
// earlier in the same CI job — the most likely explanation being a WAF/bot-
// management layer treating an unidentified client differently. The fix adds
// a real, self-identifying User-Agent/Accept pair (VERIFIER_HEADERS) to the
// script's one fetch() call site.
//
// This test does NOT touch production or any network beyond localhost: it
// spawns the REAL script (not a reimplementation) as a child process, points
// SITE_URL at a local HTTP server this test controls, and asserts on the
// actual request headers the server received — proving the fix by
// observation, not by re-reading the source.
//
//   node --test verify-production-xss-headers.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'verify-production-xss.mjs');

// The REAL escJs() shipped in listing.html/admin.html today (copied
// verbatim, not reimplemented -- see listing.html's own escJs() and its
// header comment on why each step is ordered the way it is). The script
// under test only ever extracts and evaluates this one function; nothing
// else about the fetched page's markup matters to it.
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

const REAL_ESC_JS_PAGE = `<!doctype html><html><body><script>\n${REAL_ESC_JS_SOURCE}\n</script></body></html>`;

function startCapturingServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(REAL_ESC_JS_PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

test('verify-production-xss.mjs sends a real, self-identifying User-Agent and Accept header', async () => {
  const { server, requests } = await startCapturingServer();
  const port = server.address().port;
  try {
    await execFileAsync('node', [SCRIPT], {
      env: { ...process.env, SITE_URL: `http://127.0.0.1:${port}` },
    });
  } catch (e) {
    // The script may legitimately exit non-zero if the fixture page's escJs
    // doesn't neutralise every payload -- that is not what this test checks.
    // We only care that requests were made with the right headers.
    void e;
  } finally {
    server.close();
  }

  assert.equal(requests.length, 2, 'expected one fetch for listing.html and one for admin.html');
  for (const r of requests) {
    assert.ok(r.headers['user-agent'], `request to ${r.url} had no User-Agent header at all`);
    assert.notEqual(r.headers['user-agent'], '', `request to ${r.url} had an empty User-Agent`);
    assert.match(r.headers['user-agent'], /Pintag-Production-Security-Verifier/,
      `request to ${r.url} did not carry the expected self-identifying User-Agent`);
    assert.ok(r.headers['accept'], `request to ${r.url} had no Accept header at all`);
    assert.match(r.headers['accept'], /text\/html/,
      `request to ${r.url} did not Accept text/html`);
  }
});

test('verify-production-xss.mjs prints full response-header diagnostics for a non-2xx listing.html, and stays silent for admin.html', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/listing.html') {
      res.writeHead(403, 'Forbidden', {
        'CF-Ray': '8f00000000000000-SJC',
        'CF-Cache-Status': 'DYNAMIC',
        'Cache-Control': 'private, max-age=0',
        'Age': '0',
        'Server': 'cloudflare',
        'Retry-After': '5',
        'X-RateLimit-Remaining': '0',
      });
      res.end('blocked');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(REAL_ESC_JS_PAGE);
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('node', [SCRIPT], {
      env: { ...process.env, SITE_URL: `http://127.0.0.1:${port}` },
    }));
  } catch (e) {
    // Expected: the script exits non-zero because listing.html 403s.
    stdout = e.stdout || '';
  } finally {
    server.close();
  }

  assert.match(stdout, /DIAG {2}listing\.html: non-2xx response diagnostics/);
  assert.match(stdout, /status:\s+403 Forbidden/);
  assert.match(stdout, new RegExp(`final URL:\\s+http://127\\.0\\.0\\.1:${port}/listing\\.html`));
  assert.match(stdout, /cf-ray: 8f00000000000000-SJC/);
  assert.match(stdout, /cf-cache-status: DYNAMIC/);
  assert.match(stdout, /cache-control: private, max-age=0/);
  assert.match(stdout, /age: 0/);
  assert.match(stdout, /server: cloudflare/);
  assert.match(stdout, /retry-after: 5/);
  assert.match(stdout, /x-ratelimit-remaining: 0/);

  // admin.html succeeds (200) in this fixture, so it must never trigger the
  // diagnostic block -- it is scoped to the failing listing.html request only.
  assert.doesNotMatch(stdout, /DIAG {2}admin\.html/);
});

test('verify-production-xss.mjs still exits 0 against a page whose real escJs() neutralises every payload', async () => {
  const { server, requests } = await startCapturingServer();
  const port = server.address().port;
  try {
    const { stdout } = await execFileAsync('node', [SCRIPT], {
      env: { ...process.env, SITE_URL: `http://127.0.0.1:${port}` },
    });
    assert.match(stdout, /RESULT: \d+ passed, 0 failed/, 'expected every payload to be neutralised against the real escJs()');
  } finally {
    server.close();
    void requests;
  }
});
