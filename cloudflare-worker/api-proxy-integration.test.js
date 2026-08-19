// LOCAL integration test for the API proxy Worker.
//   node --test cloudflare-worker/api-proxy-integration.test.js
//
//   test client  ->  worker.fetch()  ->  REAL http server standing in for Supabase
//
// This is the browser -> api.pintag.io -> Worker -> Supabase chain with the two
// pieces this sandbox cannot have (DNS and the live Supabase project) replaced
// by a local origin, and NOTHING else stubbed. Unlike
// api-proxy-worker.test.js — which captures the outbound Request object — this
// exercises the Worker over a real socket, so it catches the class of bug a
// fetch stub structurally cannot:
//
//   * a request body that is a stream rather than a string (Storage uploads),
//     which only fails when something actually has to read it off the wire;
//   * response streaming and content-length/transfer-encoding handling;
//   * header casing and hop-by-hop header behaviour through a real HTTP client;
//   * a large body that would be silently truncated by buffering.
//
// The Worker module pins its origin as a constant, so the test rewrites that one
// constant to the local server's address and imports the result. Everything
// else — the allowlist, the traversal guard, the forwarding logic — is the
// shipped code, unmodified.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let server, base, worker, received = [];

before(async () => {
  // A stand-in Supabase: records what it was sent, echoes enough to assert on.
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
          'access-control-allow-methods': 'POST, OPTIONS',
        });
        return res.end();
      }
      if (req.url.startsWith('/auth/v1/token')) {
        res.writeHead(302, { location: 'https://pintag.io/after-auth' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-origin-saw': String(body.length) });
      res.end(JSON.stringify({ ok: true, method: req.method, url: req.url, bytes: body.length }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Rewrite ONLY the origin constant, then import the real module.
  const src = fs.readFileSync(new URL('./api-proxy-worker.js', import.meta.url), 'utf8');
  const patched = src.replace(
    /const SUPABASE_ORIGIN = '[^']+'/,
    `const SUPABASE_ORIGIN = '${base}'`
  );
  assert.ok(patched.includes(base), 'origin constant rewrite failed');
  const tmp = path.join(os.tmpdir(), `pintag-api-proxy-${process.pid}.mjs`);
  fs.writeFileSync(tmp, patched);
  worker = (await import(pathToFileURL(tmp).href)).default;
});

after(() => new Promise((r) => server.close(r)));

const call = (p, opts) => worker.fetch(new Request('https://api.pintag.io' + p, opts));

test('integration: a REST GET reaches the origin and the JSON comes back', async () => {
  received.length = 0;
  const res = await call('/rest/v1/properties?select=id&limit=1');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.url, '/rest/v1/properties?select=id&limit=1');   // path + query intact
  assert.equal(received.length, 1);
});

test('integration: Authorization and apikey arrive at the origin unmodified', async () => {
  received.length = 0;
  await call('/rest/v1/properties', {
    headers: { authorization: 'Bearer real.jwt.here', apikey: 'anon-key', 'x-client-info': 'supabase-js/2' },
  });
  const h = received[0].headers;
  assert.equal(h.authorization, 'Bearer real.jwt.here');
  assert.equal(h.apikey, 'anon-key');
  assert.equal(h['x-client-info'], 'supabase-js/2');
});

test('integration: a JSON POST body arrives byte-identical', async () => {
  received.length = 0;
  const payload = JSON.stringify({ note: 'ünïcodé & "quotes"   edge', n: 12345 });
  const res = await call('/rest/v1/lead_events', {
    method: 'POST', body: payload, headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].body.toString('utf8'), payload);
});

test('integration: a LARGE binary upload streams through without truncation', async () => {
  // 2 MiB — well past any accidental single-chunk buffer, and representative of
  // a real property photo going to Storage.
  received.length = 0;
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const res = await call('/storage/v1/object/property-images/big.jpg', {
    method: 'POST', body: bytes, headers: { 'content-type': 'image/jpeg' },
  });
  assert.equal(res.status, 200);
  assert.equal(received[0].body.length, bytes.length, 'upload was truncated');
  assert.ok(received[0].body.equals(bytes), 'upload bytes were altered');
});

test('integration: OPTIONS preflight is answered by the ORIGIN, with its CORS headers', async () => {
  received.length = 0;
  const res = await call('/rest/v1/lead_events', {
    method: 'OPTIONS',
    headers: { origin: 'https://pintag.io', 'access-control-request-method': 'POST' },
  });
  assert.equal(received.length, 1, 'preflight must reach the origin');
  assert.equal(received[0].method, 'OPTIONS');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers'), /apikey/);
});

test('integration: a 302 from the auth endpoint is passed through, not followed', async () => {
  received.length = 0;
  const res = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: '{}' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://pintag.io/after-auth');
  assert.equal(received.length, 1, 'the Worker must not have chased the redirect');
});

test('integration: a rejected path never reaches the origin at all', async () => {
  received.length = 0;
  for (const p of ['/', '/admin', '/.env', '/rest/v2/x', '/rest/v1/../../etc/passwd']) {
    const res = await call(p);
    assert.equal(res.status, 404, p);
  }
  assert.equal(received.length, 0, 'the stand-in origin was contacted by a request that should have been refused');
});

test('integration: every allowed prefix round-trips end to end', async () => {
  received.length = 0;
  const paths = [
    '/rest/v1/properties',
    '/auth/v1/user',
    '/functions/v1/public-listings-feed',
    '/storage/v1/object/public/property-images/a.jpg',
    '/rpc/increment_listing_view',
  ];
  for (const p of paths) {
    const res = await call(p);
    assert.equal(res.status, 200, p);
  }
  assert.deepEqual(received.map(r => r.url), paths);
});
