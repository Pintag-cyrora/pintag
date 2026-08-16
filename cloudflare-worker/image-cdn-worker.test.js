// Tests for the Pintag Image CDN Worker (image-cdn-worker.js).
//   node --test cloudflare-worker/image-cdn-worker.test.js
//
// Runs the REAL Worker with stubbed caches.default / fetch / ctx, asserting the
// security allowlist (only public property-images; everything else 404), the
// fixed origin, query-string stripping, MISS→origin, and second-request HIT.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './image-cdn-worker.js';

const CDN_HOST = 'https://img.pintag.io';
const ORIGIN   = 'https://eoladhcljbpbhnrmmpev.supabase.co';
const IMG_PATH = '/storage/v1/object/public/property-images/a.jpg';

// Minimal in-memory caches.default + a fetch spy + a ctx that lets us await puts.
function harness(originResponder) {
  const store = new Map();
  const fetchCalls = [];
  const pending = [];
  globalThis.caches = {
    default: {
      async match(req) { return store.get(req.url); },
      async put(req, resp) { store.set(req.url, resp); },
    },
  };
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return originResponder ? originResponder(String(url))
      : new Response('IMGBYTES', { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p)) };
  return { fetchCalls, ctx, settle: () => Promise.all(pending) };
}

function req(path, opts) { return new Request(CDN_HOST + path, opts); }

test('MISS: allowed path fetches the FIXED origin and returns the image', async () => {
  const h = harness();
  const res = await worker.fetch(req(IMG_PATH), {}, h.ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-pintag-cache'), 'MISS');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('content-type'), 'image/jpeg');           // Content-Type preserved
  assert.equal(await res.text(), 'IMGBYTES');                            // bytes preserved
  assert.deepEqual(h.fetchCalls, [ORIGIN + IMG_PATH]);                   // fixed origin, only this path
});

test('query string is dropped from the origin fetch and the cache key', async () => {
  const h = harness();
  const res = await worker.fetch(req(IMG_PATH + '?width=100&x=1'), {}, h.ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(h.fetchCalls, [ORIGIN + IMG_PATH]);                   // no query on origin request
});

test('HIT: second request is served from cache with no origin fetch', async () => {
  const h = harness();
  await worker.fetch(req(IMG_PATH), {}, h.ctx);   // MISS populates cache
  await h.settle();                                // let ctx.waitUntil(put) finish
  const res2 = await worker.fetch(req(IMG_PATH), {}, h.ctx);
  assert.equal(res2.headers.get('x-pintag-cache'), 'HIT');
  assert.equal(await res2.text(), 'IMGBYTES');
  assert.equal(h.fetchCalls.length, 1);           // origin fetched only once
});

test('blocks /agent-photos (cross-bucket) with 404 and no origin fetch', async () => {
  const h = harness();
  const res = await worker.fetch(req('/storage/v1/object/public/agent-photos/x.jpg'), {}, h.ctx);
  assert.equal(res.status, 404);
  assert.equal(h.fetchCalls.length, 0);
});

test('blocks /rest/v1 with 404', async () => {
  const h = harness();
  const res = await worker.fetch(req('/rest/v1/properties?id=eq.1'), {}, h.ctx);
  assert.equal(res.status, 404);
  assert.equal(h.fetchCalls.length, 0);
});

test('blocks authenticated storage and arbitrary paths with 404', async () => {
  const h = harness();
  for (const p of ['/', '/anything', '/storage/v1/object/authenticated/property-images/x.jpg', '/auth/v1/token']) {
    const res = await worker.fetch(req(p), {}, h.ctx);
    assert.equal(res.status, 404, p);
  }
  assert.equal(h.fetchCalls.length, 0);
});

test('blocks path traversal with 404', async () => {
  const h = harness();
  const res = await worker.fetch(req('/storage/v1/object/public/property-images/../../rest/v1/x'), {}, h.ctx);
  assert.equal(res.status, 404);
  assert.equal(h.fetchCalls.length, 0);
});

test('non-GET/HEAD is rejected 405 with no origin fetch', async () => {
  const h = harness();
  const res = await worker.fetch(req(IMG_PATH, { method: 'POST' }), {}, h.ctx);
  assert.equal(res.status, 405);
  assert.equal(h.fetchCalls.length, 0);
});

test('origin 404 is surfaced as 404 and not cached', async () => {
  const h = harness(() => new Response('nope', { status: 404 }));
  const res = await worker.fetch(req(IMG_PATH), {}, h.ctx);
  assert.equal(res.status, 404);
  await h.settle();
  const res2 = await worker.fetch(req(IMG_PATH), {}, h.ctx);   // still a MISS -> origin again
  assert.equal(res2.status, 404);
  assert.equal(h.fetchCalls.length, 2);
});
