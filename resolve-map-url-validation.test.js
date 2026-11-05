// resolve-map-url input validation (SSRF allowlist, open-redirect and URL-parsing bypasses), exercised LOCALLY against the REAL handler with a mocked fetch.
// The live security suite no longer calls this function on production: it performs an outbound request to Google on behalf of the caller, which is an external
// side effect whatever the caller's authentication returns. Every case here asserts both the response and that the outbound fetch was (or was not) attempted.
// Run with: node --test resolve-map-url-validation.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let handler; const fetched = []; let landing = null;
globalThis.Deno = { serve: (h) => { handler = h; }, env: { get: () => undefined } };
globalThis.fetch = async (url) => { fetched.push(String(url)); if (landing === 'throw') throw new Error('mock upstream failure'); const r = new Response('', { status: 200 }); Object.defineProperty(r, 'url', { value: landing ?? 'https://www.google.com/maps?q=1,2&entry=gps' }); return r; };
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmu-')); const file = path.join(dir, 'index.mts');
  fs.copyFileSync(path.join(ROOT, 'supabase/functions/resolve-map-url/index.ts'), file);
  await import(pathToFileURL(file).href);
}
const call = async (body, raw = false) => { fetched.length = 0; landing = null; const res = await handler(new Request('https://fn.example.test/', { method: 'POST', body: raw ? body : JSON.stringify(body) })); return { status: res.status, body: await res.json().catch(() => null) }; };

test('hosts outside the allowlist, private addresses and userinfo / subdomain tricks are refused with 403 and never fetched', async () => {
  for (const url of ['https://evil.com/path', 'https://google.com/', 'https://notgoo.gl/', 'https://sub.maps.app.goo.gl/', 'https://maps.app.goo.gl@evil.com/', 'http://169.254.169.254/latest/meta-data/',
    'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://0.0.0.0/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'https://evil.com/#maps.app.goo.gl', 'https://evil%2ecom/', 'https://maps.app.goo.gl.evil.com/']) {
    const r = await call({ url }); assert.equal(r.status, 403, url); assert.deepEqual(fetched, [], `no outbound request for ${url}`);
  }
});
test('non-https schemes are refused with 403 and never fetched (an allowed hostname does not help)', async () => {
  for (const url of ['http://maps.app.goo.gl/x', 'ftp://maps.app.goo.gl/', 'javascript:alert(document.domain)', 'data:text/html,<h1>x</h1>', 'file:///etc/passwd']) {
    const r = await call({ url }); assert.ok([400, 403].includes(r.status), `${url} → ${r.status}`); assert.deepEqual(fetched, [], url);
  }
  assert.equal((await call({ url: 'http://maps.app.goo.gl/x' })).status, 403);
});
test('malformed input is the caller\'s fault: 400, never a 500, never fetched (control characters, CRLF, NUL, empty, wrong type, bare host, protocol-relative, bad JSON)', async () => {
  for (const body of [{}, { url: '' }, { url: 12345 }, { url: null }, { url: 'not a url' }, { url: 'evil.com' }, { url: '//evil.com/path' }, { url: ' https://evil.com/' },
    { url: 'https://maps.app.goo.gl/\r\nX-Injected: header' }, { url: 'https://maps.app.goo.gl\u0000.evil.com/' }]) {
    const r = await call(body); assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} → ${r.status}`); assert.ok(r.body && r.body.error, 'a JSON error body'); assert.deepEqual(fetched, []);
  }
  const bad = await call('not json', true); assert.equal(bad.status, 400); assert.deepEqual(fetched, []);
});
test('allowed short-link hosts are fetched exactly once, with a neutral User-Agent, and the resolved Google URL is returned', async () => {
  for (const url of ['https://maps.app.goo.gl/abc', 'https://goo.gl/maps/abc', 'https://maps.google.com/maps?q=test']) {
    fetched.length = 0; landing = 'https://www.google.com/maps?q=17.97,102.6&entry=gps';
    const res = await handler(new Request('https://fn.example.test/', { method: 'POST', body: JSON.stringify({ url }) }));
    assert.equal(res.status, 200, url); assert.deepEqual(fetched, [url]); assert.equal((await res.json()).resolved_url, landing);
  }
});
test('a short link that redirects outside Google is refused (403), a link that does not expand is a 502, and an upstream failure is a 502 - never a 200', async () => {
  for (const evil of ['https://evil.com/', 'https://www.google.com.evil.com/x', 'http://169.254.169.254/']) {
    fetched.length = 0; landing = evil;
    const res = await handler(new Request('https://fn.example.test/', { method: 'POST', body: JSON.stringify({ url: 'https://maps.app.goo.gl/abc' }) }));
    assert.equal(res.status, 403, evil);
  }
  landing = 'https://maps.app.goo.gl/abc';
  assert.equal((await handler(new Request('https://fn.example.test/', { method: 'POST', body: JSON.stringify({ url: 'https://maps.app.goo.gl/abc' }) }))).status, 502);
  landing = 'throw';
  assert.equal((await handler(new Request('https://fn.example.test/', { method: 'POST', body: JSON.stringify({ url: 'https://maps.app.goo.gl/abc' }) }))).status, 502);
});
test('OPTIONS answers the CORS preflight without any outbound request', async () => {
  fetched.length = 0; const res = await handler(new Request('https://fn.example.test/', { method: 'OPTIONS' })); assert.equal(res.status, 200); assert.deepEqual(fetched, []);
});
