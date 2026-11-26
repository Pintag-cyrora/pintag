// End-to-end tests of the REAL smart-listing-importer request handler.
//   node --test smart-listing-importer-handler.test.js   (runs with the root unit suites in CI)
//
// index.ts is loaded unchanged (Node type-stripping, as in request-deadline.test.mjs). Deno.serve and Deno.env are
// stubbed to capture the handler; global fetch is stubbed per test, so no request ever leaves the process. Every
// external call the handler makes is recorded, which is how these tests prove what it does and does NOT touch.
//
// Covers: pre-generated 'hero' renditions with original fallback (missing, 403, 404, network failure, non-image,
// non-storage URL, rendition URL), image formats, the timeout-vs-429/503 retry rules, the 504 + gemini_timeout
// response and its CORS headers, the body read under the timeout, and the image report (nothing omitted silently).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = here;
const SRC = fs.readFileSync(path.join(ROOT, 'supabase/functions/smart-listing-importer/index.ts'), 'utf8');
const RENDITIONS = createRequire(import.meta.url)(path.join(ROOT, 'image-renditions.js'));

const SB = 'https://abcdefghijklmnopqrst.supabase.co';
const PUB = `${SB}/storage/v1/object/public/property-images/`;
const ENV = { SUPABASE_URL: SB, SUPABASE_ANON_KEY: 'anon', GEMINI_API_KEY: 'test-key' };
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64url({ alg: 'none' })}.${b64url({ sub: 'u1', aal: 'aal2' })}.sig`;

// ── load the real handler ──────────────────────────────────────────────────
let handler = null;
globalThis.Deno = { serve: (h) => { handler = h; }, env: { get: (k) => ENV[k] } };
const mod = path.join(os.tmpdir(), `pintag-importer-handler-${process.pid}.mts`);
fs.writeFileSync(mod, SRC);
await import(pathToFileURL(mod).href);
assert.ok(typeof handler === 'function', 'Deno.serve received the handler');

const GEMINI_JSON = { title: 'House', description_en: 'A house', photo_analysis: [], recommended_order: [] };
const geminiOk = () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(GEMINI_JSON) }] } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } });
const timeoutErr = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const img = (bytes, type) => new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });

// Runs one request through the handler. `storage(url)` answers image GETs, `gemini(n)` answers the n-th Gemini call.
async function call({ urls, storage = () => new Response('missing', { status: 404 }), gemini = () => geminiOk(), onImage, nowShift } = {}) {
  const calls = [], sleeps = [], geminiBodies = [];
  const realFetch = globalThis.fetch, realSetTimeout = globalThis.setTimeout, realNow = Date.now;
  let geminiCalls = 0, shift = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    calls.push(`${method} ${u.replace(/key=[^&]+/, 'key=…')}`);
    if (u === `${SB}/auth/v1/user`) return new Response(JSON.stringify({ id: 'u1' }), { status: 200 });
    if (u === `${SB}/rest/v1/rpc/is_pintag_admin`) return new Response('true', { status: 200 });
    if (u.startsWith('https://generativelanguage.googleapis.com/')) { geminiBodies.push(opts.body); return gemini(++geminiCalls); }
    if (u.startsWith(SB + '/storage/')) { const r = await storage(u); if (onImage) shift = onImage(u, shift) ?? shift; return r; }
    throw new Error('unexpected fetch ' + u);
  };
  // Retry sleeps are recorded and skipped; AbortSignal.timeout uses internal timers and is unaffected.
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 1000) sleeps.push(ms); return realSetTimeout(fn, 0, ...a); };
  if (nowShift) Date.now = () => realNow() + shift;
  try {
    const res = await handler(new Request(`${SB}/functions/v1/smart-listing-importer`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Two-storey house', image_urls: urls, source: 'manual' }),
    }));
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { res, body, calls, sleeps, geminiCalls, geminiBodies };
  } finally { globalThis.fetch = realFetch; globalThis.setTimeout = realSetTimeout; Date.now = realNow; }
}
const sentParts = (geminiBody) => JSON.parse(geminiBody).contents[0].parts.filter((p) => p.inlineData);
const heroOf = (u) => RENDITIONS.renditionPublicUrl(u, 'hero', SB);

// ── 1. rendition path: identical to the shared client module ───────────────
test('the importer derives exactly the rendition URL image-renditions.js names (renditions/<stem>/hero.webp)', () => {
  const fn = /function buildRenditionUrl\([\s\S]*?\n\}/.exec(SRC)[0];
  const consts = ['RENDITION_BUCKET', 'RENDITION_PREFIX', 'RENDITION_PROFILE'].map((n) => new RegExp(`const ${n} = [^;]+;`).exec(SRC)[0]).join('\n');
  const buildRenditionUrl = new Function(`${consts}\n${fn.replace(/\(objectUrl: string\): string \| null/, '(objectUrl)')}\nreturn buildRenditionUrl;`)();
  const cases = ['1787301675902-4gcl6e.jpg', '1787301675902-4gcl6e.JPG', 'a.b.c.jpeg', 'photo.png', 'photo.webp', 'noext',
    'folder/sub/1787301675902-x.jpg', '1787301675902-x.jpg?v=3', 'renditions/abc/hero.webp'];
  for (const c of cases) assert.equal(buildRenditionUrl(PUB + c), heroOf(PUB + c), c);
  for (const other of ['https://scontent.xx.fbcdn.net/v/a.jpg', `${SB}/storage/v1/object/public/agent-photos/a.jpg`, '', null])
    assert.equal(buildRenditionUrl(other), null, String(other));
  assert.equal(buildRenditionUrl(PUB + '1787301675902-4gcl6e.jpg'), `${PUB}renditions/1787301675902-4gcl6e/hero.webp`);
  assert.equal(SRC.includes('/storage/v1/render/image/public/'), false, 'the paid render endpoint is never built any more');
});

// ── 2. rendition used, original fallback for every failure mode ────────────
test('an existing hero rendition is sent to Gemini and the original is never fetched', async () => {
  const urls = [PUB + '1-a.jpg', PUB + '2-b.jpg'];
  const r = await call({ urls, storage: (u) => u.endsWith('/hero.webp') ? img(new Uint8Array(1000), 'image/webp') : new Response('', { status: 500 }) });
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.calls.filter((c) => c.includes('/storage/')), urls.map((u) => 'GET ' + heroOf(u)));
  assert.deepEqual(sentParts(r.geminiBodies[0]).map((p) => p.inlineData.mimeType), ['image/webp', 'image/webp']);
  assert.equal(r.body.image_report.from_rendition, 2);
  assert.equal(r.body.image_report.from_original, 0);
});

for (const [label, rendition] of [
  ['404 (missing: older photo not backfilled, or no smaller rendition was made)', () => new Response('{"error":"not_found"}', { status: 404 })],
  ['403 (refused)', () => new Response('{"error":"denied"}', { status: 403 })],
  ['a network failure', () => { throw new TypeError('fetch failed'); }],
  ['a non-image response', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })],
]) {
  test(`a rendition that fails with ${label} falls back to the original`, async () => {
    const u = PUB + '3-c.jpg';
    const r = await call({ urls: [u], storage: (url) => url.endsWith('/hero.webp') ? rendition() : img(new Uint8Array(2000), 'image/jpeg') });
    assert.equal(r.res.status, 200);
    assert.deepEqual(r.calls.filter((c) => c.includes('/storage/')), ['GET ' + heroOf(u), 'GET ' + u]);
    assert.deepEqual(sentParts(r.geminiBodies[0]).map((p) => p.inlineData.mimeType), ['image/jpeg']);
    assert.equal(r.body.image_report.from_original, 1);
    assert.deepEqual(r.body.image_report.omitted, []);
  });
}

test('supported formats pass through with their own MIME type (JPEG, PNG, WebP, HEIC originals; WebP renditions)', async () => {
  const types = { 'a.jpg': 'image/jpeg', 'b.png': 'image/png', 'c.webp': 'image/webp', 'd.heic': 'image/heic' };
  const urls = Object.keys(types).map((n) => PUB + n);
  const r = await call({ urls, storage: (u) => u.endsWith('/hero.webp') ? new Response('', { status: 404 }) : img(new Uint8Array(500), types[u.slice(PUB.length)]) });
  assert.equal(r.res.status, 200);
  assert.deepEqual(sentParts(r.geminiBodies[0]).map((p) => p.inlineData.mimeType), Object.values(types));
});

test('a URL that is already a rendition, or not a property-images object, is fetched as-is (no rendition lookup)', async () => {
  const urls = [PUB + 'renditions/x/hero.webp', `${SB}/storage/v1/object/public/agent-photos/p.jpg`];
  const r = await call({ urls, storage: () => img(new Uint8Array(300), 'image/webp') });
  assert.deepEqual(r.calls.filter((c) => c.includes('/storage/')), urls.map((u) => 'GET ' + u));
  assert.equal(r.body.image_report.from_original, 2);
});

test('a photo that cannot be loaded at all is reported as unavailable, not dropped silently', async () => {
  const r = await call({ urls: [PUB + 'ok.jpg', PUB + 'gone.jpg'], storage: (u) => u.includes('ok') && !u.endsWith('hero.webp') ? img(new Uint8Array(100), 'image/jpeg') : new Response('', { status: 404 }) });
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.body.image_report.omitted, [{ index: 1, url: PUB + 'gone.jpg', reason: 'unavailable' }]);
  assert.equal(r.body.image_report.sent_to_gemini, 1);
});

// ── 3. image report: every omission named ──────────────────────────────────
test('photos beyond the 10-photo limit are reported as over_limit with their positions', async () => {
  const urls = Array.from({ length: 12 }, (_, i) => PUB + `p${i}.jpg`);
  const r = await call({ urls, storage: () => img(new Uint8Array(100), 'image/webp') });
  assert.equal(r.body.image_report.requested, 12);
  assert.equal(r.body.image_report.sent_to_gemini, 10);
  assert.deepEqual(r.body.image_report.omitted, [{ index: 10, url: urls[10], reason: 'over_limit' }, { index: 11, url: urls[11], reason: 'over_limit' }]);
  assert.equal(r.calls.filter((c) => c.includes('/storage/')).length, 10, 'photos over the limit are not even fetched');
});

const geminiWith = (obj) => () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ ...GEMINI_JSON, ...obj }) }] } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } });

for (const n of [12, 15]) {
  test(`all ${n} photos stay in images[] (only the first 10 are analysed), in upload order when no order is recommended`, async () => {
    const urls = Array.from({ length: n }, (_, i) => PUB + `q${i}.jpg`);
    const r = await call({ urls, storage: () => img(new Uint8Array(100), 'image/webp') });
    assert.equal(r.res.status, 200);
    assert.equal(sentParts(r.geminiBodies[0]).length, 10, 'Gemini still receives at most 10');
    assert.equal(r.body.image_report.sent_to_gemini, 10);
    assert.deepEqual(r.body.images.map((x) => x.storageUrl), urls, 'every uploaded photo, original order');
    assert.equal(r.body.images.filter((x) => x.primary).length, 1);
    assert.equal(r.body.images[0].primary, true);
  });

  test(`with ${n} photos, Gemini's order applies to the analysed 10 and the rest follow in upload order; stray indexes are ignored`, async () => {
    const urls = Array.from({ length: n }, (_, i) => PUB + `o${i}.jpg`);
    const order = [3, 0, 1, 3, 2, 4, 5, 6, 7, 8, 9, 0, 12, -1, 99, 1.5];   // repeats of 3 and 0; 12, -1, 99, 1.5 were never analysed / do not exist
    const r = await call({ urls, storage: () => img(new Uint8Array(100), 'image/webp'),
      gemini: geminiWith({ recommended_order: order, hero_index: 12, photo_analysis: [{ index: 3, room_type: 'kitchen', quality_score: 9 }, { index: 11, room_type: 'pool', quality_score: 10 }] }) });
    const got = r.body.images.map((x) => x.storageUrl);
    assert.deepEqual(got, [3, 0, 1, 2, 4, 5, 6, 7, 8, 9, ...Array.from({ length: n - 10 }, (_, k) => 10 + k)].map((i) => urls[i]));
    assert.equal(new Set(got).size, n, 'no photo duplicated or lost');
    assert.equal(r.body.images.some((x) => x.primary), false, 'a hero index outside the analysed photos marks nothing (the browser then uses the first)');
    assert.equal(r.body.images.find((x) => x.storageUrl === urls[3]).roomType, 'kitchen');
    assert.equal(r.body.images.find((x) => x.storageUrl === urls[11]).roomType, undefined, 'no analysis is attached to an unanalysed photo');
    assert.deepEqual(r.body.recommended_order, order, 'recommended_order is passed through unchanged');
  });
}

test('photos that do not fit the 18 MB request limit are reported as payload_limit', async () => {
  const big = new Uint8Array(7 * 1024 * 1024);   // 7 MB raw = ~9.3 MB base64; two do not fit under 18 MB
  const urls = [PUB + 'big1.jpg', PUB + 'big2.jpg', PUB + 'small.jpg'];
  const r = await call({ urls, storage: (u) => u.endsWith('hero.webp') ? new Response('', { status: 404 }) : img(u.includes('small') ? new Uint8Array(1000) : big, 'image/jpeg') });
  assert.equal(r.res.status, 200);
  const om = r.body.image_report.omitted;
  assert.equal(om.length, 1);
  assert.equal(om[0].reason, 'payload_limit');
  assert.ok([0, 1].includes(om[0].index));
  assert.equal(r.body.image_report.sent_to_gemini, 2);
  assert.ok(r.body.image_report.inline_bytes <= 18 * 1024 * 1024);
});

test('the report carries the measurements: counts, bytes sent to Gemini and preparation time', async () => {
  const r = await call({ urls: [PUB + 'm.jpg'], storage: () => img(new Uint8Array(3000), 'image/webp') });
  const rep = r.body.image_report;
  for (const k of ['requested', 'sent_to_gemini', 'from_rendition', 'from_original', 'inline_bytes', 'preparation_ms', 'gemini_request_bytes']) assert.equal(typeof rep[k], 'number', k);
  assert.equal(rep.inline_bytes, Buffer.from(new Uint8Array(3000)).toString('base64').length);
  assert.equal(rep.gemini_request_bytes, r.geminiBodies[0].length);
});

// ── 4. Gemini timeout vs 429/503 ───────────────────────────────────────────
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
function assertTimeoutResponse(r) {
  assert.equal(r.res.status, 504);
  assert.equal(r.body.code, 'gemini_timeout');
  assert.equal(r.body.retryable, true);
  assert.equal(r.body.retry_after_seconds, 60);
  assert.match(r.body.error, /^Gemini did not respond within the available time\. Try again in a minute, or generate with fewer photos\.$/);
  for (const [h, v] of Object.entries(CORS)) assert.equal(r.res.headers.get(h), v, h);
  assert.equal(r.res.headers.get('content-type'), 'application/json');
  assert.equal(r.res.headers.get('retry-after'), '60');
}

test('a Gemini timeout is NOT retried: one attempt, then 504 gemini_timeout with CORS headers and the image report', async () => {
  const r = await call({ urls: [PUB + 't.jpg'], storage: () => img(new Uint8Array(100), 'image/webp'), gemini: () => { throw timeoutErr(); } });
  assertTimeoutResponse(r);
  assert.equal(r.geminiCalls, 1, 'no second attempt after a timeout');
  assert.deepEqual(r.sleeps, [], 'no retry sleep');
  assert.equal(r.body.image_report.sent_to_gemini, 1);
});

test('a timeout while READING the response body is the same 504 (the body read is inside the timeout handling)', async () => {
  const slowBody = { ok: true, status: 200, json: () => Promise.reject(timeoutErr()), text: () => Promise.reject(timeoutErr()) };
  const r = await call({ urls: [], gemini: () => slowBody });
  assertTimeoutResponse(r);
  assert.equal(r.geminiCalls, 1);
});

test('503 is still retried within the budget and can recover', async () => {
  const r = await call({ urls: [], gemini: (n) => n === 1 ? new Response('busy', { status: 503 }) : geminiOk() });
  assert.equal(r.res.status, 200);
  assert.equal(r.geminiCalls, 2);
  assert.deepEqual(r.sleeps, [2000]);
});

test('429 is retried at most 3 times (2 s, 5 s, 10 s), then a 500 "busy" error, not a timeout', async () => {
  const r = await call({ urls: [], gemini: () => new Response('rate', { status: 429 }) });
  assert.equal(r.geminiCalls, 4);
  assert.deepEqual(r.sleeps, [2000, 5000, 10000]);
  assert.equal(r.res.status, 500);
  assert.match(r.body.error, /Gemini is busy right now \(HTTP 429\)/);
  assert.equal(r.body.code, undefined);
  assert.equal(r.res.headers.get('access-control-allow-origin'), '*');
});

test('a 503 followed by a timeout stops at the timeout: 504, no further attempt', async () => {
  const r = await call({ urls: [], gemini: (n) => { if (n === 1) return new Response('busy', { status: 503 }); throw timeoutErr(); } });
  assertTimeoutResponse(r);
  assert.equal(r.geminiCalls, 2);
  assert.deepEqual(r.sleeps, [2000]);
});

test('a non-retryable Gemini error stays a 500 with its status, one attempt', async () => {
  const r = await call({ urls: [], gemini: () => new Response('bad request', { status: 400 }) });
  assert.equal(r.res.status, 500);
  assert.match(r.body.error, /^Gemini API 400: bad request/);
  assert.equal(r.geminiCalls, 1);
});

test('when the photos used up the request budget, the answer is the same 504 (budget exhausted before any attempt)', async () => {
  // Each photo load advances the clock by 60 s: the image phase then ends at its cap and nothing is left for Gemini.
  const urls = [PUB + 'slow1.jpg', PUB + 'slow2.jpg', PUB + 'slow3.jpg'];
  const r = await call({ urls, storage: () => img(new Uint8Array(100), 'image/webp'), onImage: (_u, s) => s + 60_000, nowShift: true });
  assertTimeoutResponse(r);
  assert.equal(r.geminiCalls, 0);
  assert.ok(r.body.image_report.omitted.some((o) => o.reason === 'time_limit'), 'photos skipped for time are reported');
});

// ── 5. writes nothing anywhere ─────────────────────────────────────────────
test('success, timeout and error paths make only the expected read calls: no database row, no Storage write', async () => {
  const scenarios = [
    await call({ urls: [PUB + 'w.jpg'], storage: () => img(new Uint8Array(10), 'image/webp') }),
    await call({ urls: [PUB + 'w.jpg'], storage: () => img(new Uint8Array(10), 'image/webp'), gemini: () => { throw timeoutErr(); } }),
    await call({ urls: [PUB + 'w.jpg'], storage: () => img(new Uint8Array(10), 'image/webp'), gemini: () => new Response('x', { status: 500 }) }),
  ];
  for (const s of scenarios) {
    for (const c of s.calls) {
      const ok = c === `GET ${SB}/auth/v1/user` || c === `POST ${SB}/rest/v1/rpc/is_pintag_admin`
        || /^GET https:\/\/abcdefghijklmnopqrst\.supabase\.co\/storage\/v1\/object\/public\//.test(c)
        || c.startsWith('POST https://generativelanguage.googleapis.com/');
      assert.ok(ok, `unexpected call: ${c}`);
    }
  }
});

// ── 6. budgets are unchanged ───────────────────────────────────────────────
test('no deadline or Gemini timeout was increased', () => {
  const v = (n) => Number(new RegExp(`const ${n}\\s*=\\s*([0-9_]+)`).exec(SRC)[1].replace(/_/g, ''));
  assert.deepEqual(
    { REQUEST_BUDGET_MS: v('REQUEST_BUDGET_MS'), RESPONSE_RESERVE_MS: v('RESPONSE_RESERVE_MS'), IMAGE_PHASE_MAX_MS: v('IMAGE_PHASE_MAX_MS'), IMAGE_FETCH_MAX_MS: v('IMAGE_FETCH_MAX_MS'), GEMINI_ATTEMPT_MAX_MS: v('GEMINI_ATTEMPT_MAX_MS'), GEMINI_MIN_ATTEMPT_MS: v('GEMINI_MIN_ATTEMPT_MS'), MAX_IMAGES: v('MAX_IMAGES'), MAX_TOTAL_INLINE_BYTES: 18 * 1024 * 1024 },
    { REQUEST_BUDGET_MS: 110000, RESPONSE_RESERVE_MS: 5000, IMAGE_PHASE_MAX_MS: 45000, IMAGE_FETCH_MAX_MS: 15000, GEMINI_ATTEMPT_MAX_MS: 45000, GEMINI_MIN_ATTEMPT_MS: 5000, MAX_IMAGES: 10, MAX_TOTAL_INLINE_BYTES: 18 * 1024 * 1024 });
  assert.match(SRC, /const MAX_TOTAL_INLINE_BYTES = 18 \* 1024 \* 1024;/);
  assert.match(SRC, /const RETRY_DELAYS = \[2000, 5000, 10000\];/);
});
