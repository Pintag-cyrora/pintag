// Image CDN fallback — WIRING test. Proves the global capturing 'error'
// listener (image error events don't bubble) actually catches a real <img>
// error and swaps the CDN src to the direct Supabase URL once, via the REAL
// ptCdnImageFallback extracted from components.js. Deterministic: we dispatch a
// real 'error' Event on an in-document <img> (no network needed).

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
function extractFn(file, name) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}
const fallbackFn = extractFn('components.js', 'ptCdnImageFallback');

const PROD = 'https://eoladhcljbpbhnrmmpev.supabase.co';
const CDN  = 'https://img.pintag.io/storage/v1/object/public/property-images/';
const PUB  = PROD + '/storage/v1/object/public/property-images/';

test('global capture listener swaps a failed CDN <img> to direct Supabase, once', async ({ page }) => {
  await page.route('**/blank-harness', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('http://localhost:8956/blank-harness');

  const r = await page.evaluate(({ fallbackFn, PROD, CDN, PUB }) => {
    window.PINTAG = { supabaseUrl: PROD, imageCdn: true };
    // Define the module constants GLOBALLY (indirect eval below runs in global
    // scope, so the extracted function must find them there — not as locals).
    (0, eval)("var PT_IMAGE_CDN_ORIGIN='https://img.pintag.io'; var PT_PROPERTY_IMAGES_PATH='/storage/v1/object/public/property-images/'; var PT_RENDITION_PREFIX_PATH='renditions/';");
    (0, eval)(fallbackFn);                       // real ptCdnImageFallback
    // Install the SAME global capturing listener production uses.
    document.addEventListener('error', function (e) { ptCdnImageFallback(e.target); }, true);

    var events = [];
    window.addEventListener('pintag:cdn-fallback', function (e) { events.push(e.detail); });

    // A CDN image that "fails" — dispatch a real, non-bubbling error event.
    var img = document.createElement('img');
    img.src = CDN + 'a.jpg';
    document.body.appendChild(img);
    img.dispatchEvent(new Event('error'));         // caught by the capture listener
    var afterFirst = { src: img.src, flag: img.dataset.cdnFallback, count: window.__ptCdnFallbacks };

    img.dispatchEvent(new Event('error'));         // 2nd error -> must NOT loop
    var afterSecond = { src: img.src, count: window.__ptCdnFallbacks };

    // A non-CDN image (agent photo) must be ignored entirely.
    var agent = document.createElement('img');
    agent.src = PROD + '/storage/v1/object/public/agent-photos/x.jpg';
    document.body.appendChild(agent);
    agent.dispatchEvent(new Event('error'));
    var agentAfter = { src: agent.src, flag: agent.dataset.cdnFallback, count: window.__ptCdnFallbacks };

    return { afterFirst, afterSecond, agentAfter, events };
  }, { fallbackFn, PROD, CDN, PUB });

  // First error -> swapped once to the direct Supabase URL, marked, observable.
  expect(r.afterFirst.src).toBe(PUB + 'a.jpg');
  expect(r.afterFirst.flag).toBe('1');
  expect(r.afterFirst.count).toBe(1);
  expect(r.events).toEqual([{ cdn: CDN + 'a.jpg', direct: PUB + 'a.jpg', count: 1 }]);
  // Second error on the same element -> no loop, no extra count.
  expect(r.afterSecond.src).toBe(PUB + 'a.jpg');
  expect(r.afterSecond.count).toBe(1);
  // Agent photo -> untouched, not counted.
  expect(r.agentAfter.src).toBe(PROD + '/storage/v1/object/public/agent-photos/x.jpg');
  expect(r.agentAfter.flag).toBeUndefined();
  expect(r.agentAfter.count).toBe(1);
});
