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
vm.runInThisContext("var PT_IMAGE_CDN_ORIGIN='https://img.pintag.io'; var PT_PROPERTY_IMAGES_PATH='/storage/v1/object/public/property-images/'; var PT_RENDITION_PREFIX_PATH='renditions/';");
vm.runInThisContext(extractFn('components.js', 'ptCdnImage'));
vm.runInThisContext(extractFn('components.js', 'ptCdnImageFallback'));
const { ptCdnImage, ptCdnImageFallback } = globalThis;

// CustomEvent shim for the fallback's observability dispatch (node has no DOM).
globalThis.CustomEvent = globalThis.CustomEvent || function (type, opts) { this.type = type; this.detail = opts && opts.detail; };

const PROD = 'https://eoladhcljbpbhnrmmpev.supabase.co';
const DEV  = 'https://ebtgoqrywdywuqrvudcp.supabase.co';
const CDN  = 'https://img.pintag.io/storage/v1/object/public/property-images/';
const PUB  = PROD + '/storage/v1/object/public/property-images/';

function setCdn(on, supabaseUrl) { globalThis.window = { PINTAG: { imageCdn: on, supabaseUrl: supabaseUrl || PROD } }; }

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

// ── Card composition: rendition FIRST, CDN SECOND ─────────────────────────
// renditionPublicUrl() only recognises the Supabase origin, so CDN-rewriting
// the original before deriving the rendition returned the full-size original
// through the CDN and no rendition was ever requested once imageCdn flipped.
vm.runInThisContext(fs.readFileSync(new URL('./image-renditions.js', import.meta.url), 'utf8'), { filename: 'image-renditions.js' });
vm.runInThisContext("var PT_IMAGE_PROFILES = { thumbnail: { width: 200 }, card: { width: 400 }, gallery: { width: 800 }, hero: { width: 1200 } };");
['_ptEsc', 'ptImageUrl', 'ptImageFallbackAttrs', 'ptCardImageSrc', 'ptCardImageFallbackAttrs']
  .forEach((n) => vm.runInThisContext(extractFn('components.js', n)));
const { ptCardImageSrc, ptCardImageFallbackAttrs } = globalThis;

test('with the CDN and renditions both on, a card src is the CDN-routed RENDITION and the fallback the CDN-routed original', () => {
  globalThis.window = { PINTAG: { imageCdn: true, renditionsEnabled: true, supabaseUrl: PROD } };
  const src = ptCardImageSrc(PUB + '1787301675902-4gcl6e.jpg', 'card');
  assert.equal(src, CDN + 'renditions/1787301675902-4gcl6e/card.webp');
  assert.equal(ptCardImageFallbackAttrs(PUB + '1787301675902-4gcl6e.jpg'),
    ' data-pt-original="' + CDN + '1787301675902-4gcl6e.jpg" onerror="ptImageFallback(this)"');
});

test('renditions on, CDN off: plain Supabase rendition; both off: the original untouched', () => {
  globalThis.window = { PINTAG: { imageCdn: false, renditionsEnabled: true, supabaseUrl: PROD } };
  assert.equal(ptCardImageSrc(PUB + 'a.jpg', 'card'), PUB + 'renditions/a/card.webp');
  globalThis.window = { PINTAG: { imageCdn: false, renditionsEnabled: false, supabaseUrl: PROD } };
  assert.equal(ptCardImageSrc(PUB + 'a.jpg', 'card'), PUB + 'a.jpg');
  assert.equal(ptCardImageSrc('https://scontent.fbcdn.net/x.jpg', 'card'), 'https://scontent.fbcdn.net/x.jpg');
});

test('a missing CDN RENDITION is not a CDN outage: the listener defers to the element\'s own ptImageFallback', () => {
  setCdn(true);
  const el = { tagName: 'IMG', dataset: {}, currentSrc: CDN + 'renditions/a/card.webp', src: CDN + 'renditions/a/card.webp', getAttribute() { return this.src; }, setAttribute(k, v) { this[k] = v; } };
  assert.equal(ptCdnImageFallback(el), false);
  assert.equal(el.src, CDN + 'renditions/a/card.webp', 'untouched');
  assert.equal(el.dataset.cdnFallback, undefined, 'the once-only marker is not spent on a rendition miss');
});
