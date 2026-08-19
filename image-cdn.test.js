// Unit tests for ptCdnImage() (components.js) — the render-time image-CDN
// rewrite (P1). Runs the REAL function, extracted from components.js into a vm,
// with a synthetic window.PINTAG. Same extract-the-real-function convention as
// the other node --test suites in this repo.
//
//   node --test image-cdn.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function extractFn(file, name) {
  const src = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

// The two module-level constants the helpers read, then the real functions.
vm.runInThisContext("var PT_IMAGE_CDN_ORIGIN='https://img.pintag.io'; var PT_PROPERTY_IMAGES_PATH='/storage/v1/object/public/property-images/';");
vm.runInThisContext(extractFn('components.js', '_ptStorageOrigin'));
vm.runInThisContext(extractFn('components.js', 'ptCdnImage'));
vm.runInThisContext(extractFn('components.js', 'ptCdnImageFallback'));
const { ptCdnImage, ptCdnImageFallback, _ptStorageOrigin } = globalThis;

// CustomEvent shim for the fallback's observability dispatch (node has no DOM).
globalThis.CustomEvent = globalThis.CustomEvent || function (type, opts) { this.type = type; this.detail = opts && opts.detail; };

const PROD = 'https://eoladhcljbpbhnrmmpev.supabase.co';
const DEV  = 'https://ebtgoqrywdywuqrvudcp.supabase.co';
const CDN  = 'https://img.pintag.io/storage/v1/object/public/property-images/';
const PUB  = PROD + '/storage/v1/object/public/property-images/';
const API_PROXY = 'https://api.pintag.io';

// Pre-cutover shape: storagePublicOrigin and supabaseUrl are the same host.
function setCdn(on, supabaseUrl) {
  const u = supabaseUrl || PROD;
  globalThis.window = { PINTAG: { imageCdn: on, supabaseUrl: u, storagePublicOrigin: u } };
}
// Post-cutover shape: the API host moved to the Cloudflare proxy while stored
// image URLs stayed on the direct Supabase origin.
function setCdnAfterCutover(on) {
  globalThis.window = { PINTAG: { imageCdn: on, supabaseUrl: API_PROXY, storagePublicOrigin: PROD } };
}

// ── Rewrites (flag ON, production) ────────────────────────────────────────
test('rewrites a public property-image URL to the CDN host', () => {
  setCdn(true);
  assert.equal(ptCdnImage(PUB + '1712-ab.jpg'), CDN + '1712-ab.jpg');
});

test('rewrites every image format (jpg/png/webp/jpeg)', () => {
  setCdn(true);
  ['a.jpg', 'b.png', 'c.webp', 'd.jpeg'].forEach((f) => {
    assert.equal(ptCdnImage(PUB + f), CDN + f);
  });
});

test('strips the query string so the cache key stays stable', () => {
  setCdn(true);
  assert.equal(ptCdnImage(PUB + 'a.jpg?width=100&x=1'), CDN + 'a.jpg');
});

// ── Never rewrites (flag ON) ──────────────────────────────────────────────
test('never rewrites agent-photos', () => {
  setCdn(true);
  const u = PROD + '/storage/v1/object/public/agent-photos/x.jpg';
  assert.equal(ptCdnImage(u), u);
});

test('never rewrites external / Facebook URLs', () => {
  setCdn(true);
  const fb = 'https://scontent.fbcdn.net/v/t1/abc.jpg';
  const ext = 'https://example.com/pic.jpg';
  assert.equal(ptCdnImage(fb), fb);
  assert.equal(ptCdnImage(ext), ext);
});

test('never rewrites data: URIs', () => {
  setCdn(true);
  const d = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(ptCdnImage(d), d);
});

test('never rewrites other Supabase paths (rest/auth/authenticated storage)', () => {
  setCdn(true);
  const rest = PROD + '/rest/v1/properties?id=eq.1';
  const auth = PROD + '/auth/v1/token';
  const authed = PROD + '/storage/v1/object/authenticated/property-images/x.jpg';
  assert.equal(ptCdnImage(rest), rest);
  assert.equal(ptCdnImage(auth), auth);
  assert.equal(ptCdnImage(authed), authed);
});

test('never rewrites a URL already on the CDN host', () => {
  setCdn(true);
  const already = CDN + 'a.jpg';
  assert.equal(ptCdnImage(already), already);
});

test('non-string / empty inputs are returned as-is', () => {
  setCdn(true);
  assert.equal(ptCdnImage(null), null);
  assert.equal(ptCdnImage(undefined), undefined);
  assert.equal(ptCdnImage(''), '');
  assert.equal(ptCdnImage(42), 42);
});

// ── Feature flag / rollback / environment ─────────────────────────────────
test('flag OFF (rollback) returns the original Supabase URL unchanged', () => {
  setCdn(false);
  assert.equal(ptCdnImage(PUB + 'a.jpg'), PUB + 'a.jpg');
});

test('dev (imageCdn default false) does not rewrite', () => {
  setCdn(false, DEV);
  const devPub = DEV + '/storage/v1/object/public/property-images/a.jpg';
  assert.equal(ptCdnImage(devPub), devPub);
});

test('no window / no PINTAG returns input unchanged', () => {
  delete globalThis.window;
  assert.equal(ptCdnImage(PUB + 'a.jpg'), PUB + 'a.jpg');
});

// ── ptCdnImageFallback (belt-and-suspenders on CDN load error) ────────────
function fakeWindow() {
  const events = [];
  globalThis.window = {
    PINTAG: { supabaseUrl: PROD, imageCdn: true },
    __ptCdnFallbacks: 0,
    dispatchEvent: (e) => { events.push(e); return true; },
  };
  return events;
}
function fakeImg(src) {
  return { tagName: 'IMG', currentSrc: src, src: src, dataset: {}, getAttribute(k) { return k === 'src' ? this.src : null; } };
}

test('fallback: a failed CDN image retries once from the direct Supabase URL', () => {
  const events = fakeWindow();
  const el = fakeImg(CDN + 'a.jpg');
  const did = ptCdnImageFallback(el);
  assert.equal(did, true);
  assert.equal(el.src, PUB + 'a.jpg');            // swapped to the ORIGINAL direct URL
  assert.equal(el.dataset.cdnFallback, '1');       // marked so it cannot loop
  assert.equal(globalThis.window.__ptCdnFallbacks, 1); // observable counter
  assert.equal(events.length, 1);                  // observable event
  assert.equal(events[0].type, 'pintag:cdn-fallback');
  assert.equal(events[0].detail.direct, PUB + 'a.jpg');
});

test('fallback: never loops — a second error on the same element is a no-op', () => {
  fakeWindow();
  const el = fakeImg(CDN + 'a.jpg');
  ptCdnImageFallback(el);                           // 1st: swaps + marks
  const before = el.src;
  const did2 = ptCdnImageFallback(el);              // 2nd: already marked
  assert.equal(did2, false);
  assert.equal(el.src, before);
  assert.equal(globalThis.window.__ptCdnFallbacks, 1); // not incremented again
});

test('fallback: ignores non-CDN images (agent/external/data/direct Supabase)', () => {
  fakeWindow();
  [
    PROD + '/storage/v1/object/public/agent-photos/x.jpg',
    'https://scontent.fbcdn.net/x.jpg',
    'data:image/png;base64,iVBORw0KGgo=',
    PUB + 'a.jpg',                                  // already a direct Supabase URL
  ].forEach((src) => {
    const el = fakeImg(src);
    assert.equal(ptCdnImageFallback(el), false);
    assert.equal(el.src, src);                      // untouched
    assert.equal(el.dataset.cdnFallback, undefined);
  });
  assert.equal(globalThis.window.__ptCdnFallbacks, 0);
});

test('fallback: ignores non-IMG elements and missing config', () => {
  fakeWindow();
  assert.equal(ptCdnImageFallback({ tagName: 'DIV', dataset: {} }), false);
  assert.equal(ptCdnImageFallback(null), false);
  globalThis.window.PINTAG = { imageCdn: true };    // no supabaseUrl
  assert.equal(ptCdnImageFallback(fakeImg(CDN + 'a.jpg')), false);
});


// ═══════════════════════════════════════════════════════════════════════
// api.pintag.io CUTOVER — the image CDN must survive the API host moving
// ═══════════════════════════════════════════════════════════════════════
// ptCdnImage() used to match on window.PINTAG.supabaseUrl. Once that value
// becomes the Cloudflare API proxy, every image URL ALREADY in the database
// still points at the direct Supabase origin -- so matching on supabaseUrl
// would return them all unchanged, silently routing every existing listing
// photo around img.pintag.io and straight at Supabase egress. No broken image,
// no console error, no alert: just the CDN quietly ceasing to do anything.
//
// These pin the fix: the match is against storagePublicOrigin, which stays on
// the Supabase origin because it describes STORED DATA, not delivery.

test('cutover: an EXISTING stored image URL is still rewritten to the CDN', () => {
  setCdnAfterCutover(true);
  assert.equal(ptCdnImage(PUB + 'a/b.jpg'), CDN + 'a/b.jpg');
});

test('cutover: a URL on the API proxy host is NOT treated as a stored image', () => {
  // Nothing should ever persist an api.pintag.io image URL (admin.html builds
  // the stored URL from storagePublicOrigin). If one appears, it is not one of
  // ours to rewrite -- returning it untouched is the safe direction.
  setCdnAfterCutover(true);
  const stray = API_PROXY + '/storage/v1/object/public/property-images/a/b.jpg';
  assert.equal(ptCdnImage(stray), stray);
});

test('cutover: the CDN fallback retries against the STORED origin, not the proxy', () => {
  // The object only exists at the Supabase origin. Falling back to the API
  // proxy would 404 and leave a permanently broken image.
  setCdnAfterCutover(true);
  const el = { tagName: 'IMG', src: CDN + 'a/b.jpg', dataset: {}, getAttribute: () => CDN + 'a/b.jpg' };
  assert.equal(ptCdnImageFallback(el), true);
  assert.equal(el.src, PUB + 'a/b.jpg');
});

test('cutover: rollback (imageCdn=false) still returns the stored URL untouched', () => {
  setCdnAfterCutover(false);
  assert.equal(ptCdnImage(PUB + 'a/b.jpg'), PUB + 'a/b.jpg');
});

test('_ptStorageOrigin: prefers storagePublicOrigin over supabaseUrl', () => {
  globalThis.window = { PINTAG: { supabaseUrl: API_PROXY, storagePublicOrigin: PROD } };
  assert.equal(_ptStorageOrigin(), PROD);
});

test('_ptStorageOrigin: falls back to supabaseUrl for a config predating the key', () => {
  globalThis.window = { PINTAG: { supabaseUrl: PROD } };
  assert.equal(_ptStorageOrigin(), PROD);
});

test('_ptStorageOrigin: null when there is no config at all', () => {
  globalThis.window = undefined;
  assert.equal(_ptStorageOrigin(), null);
  globalThis.window = { PINTAG: {} };
  assert.equal(_ptStorageOrigin(), null);
});
