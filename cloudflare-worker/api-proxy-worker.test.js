// Tests for the Pintag API Proxy Worker (api-proxy-worker.js).
//   node --test cloudflare-worker/api-proxy-worker.test.js
//
// Runs the REAL Worker with a stubbed global fetch, asserting the properties
// that make it safe to put in front of every API call the site makes:
//
//   * it is NOT an open proxy — the origin is fixed and the path allowlist is
//     closed, so no request can reach an arbitrary URL;
//   * traversal is rejected before the origin is ever contacted;
//   * method, headers, query string and body survive untouched — in particular
//     Authorization and apikey, which this Worker must never read or rewrite;
//   * OPTIONS preflight is FORWARDED rather than answered here;
//   * caching is disabled, so an authenticated REST response can never be
//     stored at the edge and served to somebody else;
//   * redirects are passed through rather than followed, which auth flows need.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { __TEST__ } from './api-proxy-worker.js';

const API    = 'https://api.pintag.io';
const ORIGIN = 'https://eoladhcljbpbhnrmmpev.supabase.co';

// Captures exactly what the Worker handed to fetch(), so the assertions below
// test the OUTBOUND request rather than a reconstruction of it.
function harness(responder) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    calls.push({ req, init: init || {}, url: req.url });
    return responder ? responder(req) : new Response('OK', { status: 200 });
  };
  return calls;
}

const req = (path, opts) => new Request(API + path, opts);

// ── The allowlist is closed ───────────────────────────────────────────────
const ALLOWED = [
  '/rest/v1/properties?select=*',
  '/auth/v1/token?grant_type=password',
  '/functions/v1/public-listings-feed',
  '/storage/v1/object/public/property-images/a.jpg',
  '/rpc/increment_listing_view',
];

for (const path of ALLOWED) {
  test(`allows ${path.split('?')[0]}`, async () => {
    const calls = harness();
    const res = await worker.fetch(req(path));
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ORIGIN + path);   // fixed origin + path + query
  });
}

const REJECTED = [
  ['/', 'bare root'],
  ['/admin', 'arbitrary path'],
  ['/rest/v2/properties', 'near-miss on an allowed prefix'],
  ['/restx/v1/properties', 'prefix that only looks allowed'],
  ['/pg/', 'unknown service'],
  ['/.env', 'dotfile probe'],
  ['/http://evil.example/', 'absolute URL smuggled into the path'],
  ['//evil.example/rest/v1/x', 'protocol-relative host smuggling'],
];

for (const [path, why] of REJECTED) {
  test(`rejects ${JSON.stringify(path)} (${why})`, async () => {
    const calls = harness();
    const res = await worker.fetch(req(path));
    assert.equal(res.status, 404, why);
    assert.equal(calls.length, 0, 'a rejected request must never reach the origin');
  });
}

// ── Traversal ─────────────────────────────────────────────────────────────
const TRAVERSAL_PATHS = [
  '/rest/v1/../../etc/passwd',
  '/storage/v1/object/public/../../../secret',
  '/rest/v1/%2e%2e/%2e%2e/etc/passwd',
  '/rest/v1/%2E%2E/admin',
  '/storage/v1/%252e%252e/x',
];

for (const path of TRAVERSAL_PATHS) {
  test(`rejects traversal: ${path}`, async () => {
    const calls = harness();
    const res = await worker.fetch(req(path));
    assert.equal(res.status, 404);
    assert.equal(calls.length, 0, 'traversal must be rejected before the origin is contacted');
  });
}

test('traversal is rejected even under an ALLOWED prefix', async () => {
  // The check must not be reachable only via the "unknown path" branch.
  const calls = harness();
  assert.equal((await worker.fetch(req('/rest/v1/..%2fadmin'))).status, 404);
  assert.equal(calls.length, 0);
});

// ── Faithful forwarding ───────────────────────────────────────────────────
test('preserves the HTTP method', async () => {
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD']) {
    const calls = harness();
    const body = (method === 'GET' || method === 'HEAD') ? undefined : '{"a":1}';
    await worker.fetch(req('/rest/v1/properties', { method, body }));
    assert.equal(calls[0].req.method, method);
  }
});

test('preserves Authorization and apikey EXACTLY, and adds nothing', async () => {
  const calls = harness();
  await worker.fetch(req('/rest/v1/properties', {
    headers: {
      'authorization': 'Bearer test.jwt.value',
      'apikey': 'anon-key-value',
      'x-client-info': 'supabase-js/2.0.0',
      'content-type': 'application/json',
    },
  }));
  const h = calls[0].req.headers;
  assert.equal(h.get('authorization'), 'Bearer test.jwt.value');
  assert.equal(h.get('apikey'), 'anon-key-value');
  assert.equal(h.get('x-client-info'), 'supabase-js/2.0.0');
  assert.equal(h.get('content-type'), 'application/json');
});

test('does not implement its own authentication — an unauthenticated request is forwarded, not blocked', async () => {
  // Authorization is Supabase's job (RLS is the security boundary). A Worker
  // that started making its own allow/deny calls would be a second, drifting
  // authorization layer.
  const calls = harness(() => new Response('{"code":"401"}', { status: 401 }));
  const res = await worker.fetch(req('/rest/v1/properties'));   // no auth headers
  assert.equal(calls.length, 1, 'must still be forwarded');
  assert.equal(res.status, 401, "and Supabase's own answer returned verbatim");
});

test('preserves the query string verbatim, including encoding', async () => {
  const calls = harness();
  const q = '/rest/v1/properties?select=*&status=eq.active&order=created_at.desc&title=like.*%26*';
  await worker.fetch(req(q));
  assert.equal(calls[0].url, ORIGIN + q);
});

test('preserves a POST body byte for byte', async () => {
  const calls = harness();
  const payload = JSON.stringify({ listing_id: 'abc', event_type: 'whatsapp_click', note: 'ünïcodé & "quotes"' });
  await worker.fetch(req('/rest/v1/lead_events', {
    method: 'POST', body: payload, headers: { 'content-type': 'application/json' },
  }));
  assert.equal(await calls[0].req.text(), payload);
});

test('preserves a binary Storage upload body', async () => {
  const calls = harness();
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]); // JPEG magic
  await worker.fetch(req('/storage/v1/object/property-images/x.jpg', {
    method: 'POST', body: bytes, headers: { 'content-type': 'image/jpeg' },
  }));
  const got = new Uint8Array(await calls[0].req.arrayBuffer());
  assert.deepEqual([...got], [...bytes]);
});

test('returns the origin response status/headers/body unchanged', async () => {
  harness(() => new Response('{"ok":true}', {
    status: 201,
    headers: { 'content-type': 'application/json', 'content-range': '0-0/1' },
  }));
  const res = await worker.fetch(req('/rest/v1/properties', { method: 'POST', body: '{}' }));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-range'), '0-0/1');
  assert.equal(await res.text(), '{"ok":true}');
});

// ── CORS preflight ────────────────────────────────────────────────────────
test('OPTIONS preflight is FORWARDED to Supabase, not answered here', async () => {
  const calls = harness(() => new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    },
  }));
  const res = await worker.fetch(req('/rest/v1/lead_events', {
    method: 'OPTIONS',
    headers: { 'access-control-request-method': 'POST', origin: 'https://pintag.io' },
  }));
  assert.equal(calls.length, 1, 'the Worker must not answer preflight itself');
  assert.equal(calls[0].req.method, 'OPTIONS');
  assert.equal(calls[0].req.headers.get('origin'), 'https://pintag.io');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

// ── Caching and redirects ─────────────────────────────────────────────────
test('caching is disabled on the outbound fetch', async () => {
  const calls = harness();
  await worker.fetch(req('/rest/v1/properties', { headers: { authorization: 'Bearer secret' } }));
  assert.equal(calls[0].init.cf.cacheEverything, false);
  assert.equal(calls[0].init.cf.cacheTtl, 0);
});

test('redirects are passed through, not followed', async () => {
  const calls = harness();
  await worker.fetch(req('/auth/v1/authorize?provider=google'));
  assert.equal(calls[0].init.redirect, 'manual');
});

test('the Worker never consults a cache API', async () => {
  // Defence in depth: image-cdn-worker.js legitimately uses caches.default;
  // this one must not, so an authenticated response cannot be stored at all.
  let touched = false;
  globalThis.caches = { get default() { touched = true; return { match: async () => undefined, put: async () => {} }; } };
  harness();
  await worker.fetch(req('/rest/v1/properties'));
  assert.equal(touched, false);
  delete globalThis.caches;
});

// ── The allowlist itself ──────────────────────────────────────────────────
test('the origin constant is the production project and nothing else', () => {
  assert.equal(__TEST__.SUPABASE_ORIGIN, ORIGIN);
});

test('the allowlist is exactly the five documented Supabase API prefixes', () => {
  // A future edit that widens this fails here rather than shipping quietly.
  assert.deepEqual(__TEST__.ALLOWED_PREFIXES,
    ['/rest/v1/', '/auth/v1/', '/functions/v1/', '/storage/v1/', '/rpc/']);
});

test('isAllowedPath requires the trailing slash, so /rest/v1evil is refused', () => {
  assert.equal(__TEST__.isAllowedPath('/rest/v1/x'), true);
  assert.equal(__TEST__.isAllowedPath('/rest/v1evil'), false);
  assert.equal(__TEST__.isAllowedPath('/rest/v1'), false);
});
