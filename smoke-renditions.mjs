// smoke-renditions.mjs — production smoke test for the rendition delivery flag.
//
// Loads the LIVE site in a real Chromium and inspects what the browser actually
// received, because the only question that matters is whether a visitor sees a
// picture. Checking that a URL 200s is not the same thing: an <img> can fetch a
// valid response and still render nothing.
//
// READ ONLY. GETs against the public site and the public object endpoint. It
// never writes to Storage or the database.
import { chromium } from 'playwright';

const SITE = 'https://pintag.io';
const REF  = process.env.REF;
const OBJ  = `https://${REF}.supabase.co/storage/v1/object/public/property-images`;
let failures = 0;
const fail = (m) => { failures++; console.log(`  FAIL ${m}`); };
const ok   = (m) => console.log(`  ok   ${m}`);
const bust = () => `cb=${Date.now()}${Math.random().toString(36).slice(2)}`;

// ── 0. the deployed build must actually carry the flag ─────────────────────
// Pages sits behind a CDN, so an un-busted fetch can return a copy from before
// the deploy. Ask for a unique URL, and retry: propagation is not instant and a
// stale read must not be reported as a failed deploy.
console.log('── deployed flag state ───────────────────────────────');
let cfg = '', flagOn = false;
for (let attempt = 1; attempt <= 10; attempt++) {
  cfg = await (await fetch(`${SITE}/config.js?${bust()}`, { cache: 'no-store' })).text();
  flagOn = /renditionsEnabled:\s*true/.test(cfg);
  if (flagOn) { console.log(`  flag visible on attempt ${attempt}`); break; }
  console.log(`  attempt ${attempt}: not yet visible, waiting 20s`);
  await new Promise((r) => setTimeout(r, 20000));
}
flagOn ? ok('config.js on pintag.io has renditionsEnabled: true')
       : fail('config.js does NOT have renditionsEnabled: true — nothing below is meaningful');
console.log(`  env=${(/env:\s*'([^']+)'/.exec(cfg) || [])[1]}  isProduction=${/isProduction:\s*true/.test(cfg)}`);
// Which build do the PAGES reference? The deploy stamps ?v=<sha> into every
// first-party script tag, so this is the deployed commit as the browser sees it.
const html = await (await fetch(`${SITE}/listings.html?${bust()}`, { cache: 'no-store' })).text();
console.log(`  listings.html asset stamp: ${(/config\.js\?v=([0-9a-f]+)/.exec(html) || [])[1]}`);
const ANON = /anonKey:\s*'([^']+)'/.exec(cfg)[1];

// ── 1. a real listing slug, from the same REST surface a visitor uses ──────
const rows = await (await fetch(
  `https://${REF}.supabase.co/rest/v1/properties?status=in.(active,available)&select=slug&limit=1`,
  { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } })).json();
const SLUG = rows[0].slug;
console.log(`\n  sample listing: ${SLUG}`);

// ── helpers ────────────────────────────────────────────────────────────────
// An image is broken when the browser finished with it and it has no
// intrinsic size. That is the only reliable "the user sees nothing" signal.
const collect = (page) => page.evaluate(() => [...document.images]
  .filter((i) => i.currentSrc || i.src)
  .map((i) => ({
    src: i.currentSrc || i.src,
    broken: i.complete && i.naturalWidth === 0,
    pending: !i.complete,
    fellBack: i.hasAttribute('data-pt-original') && !/\/renditions\//.test(i.currentSrc || i.src),
    orig: i.getAttribute('data-pt-original') || ''
  })));

async function audit(label, imgs) {
  const prop    = imgs.filter((i) => i.src.includes('/property-images/'));
  const rend    = prop.filter((i) => /\/renditions\//.test(i.src));
  const broken  = imgs.filter((i) => i.broken);
  const pending = imgs.filter((i) => i.pending);
  console.log(`  ${label}: ${imgs.length} images, ${prop.length} property images, `
            + `${rend.length} renditions, ${broken.length} broken, ${pending.length} still loading`);
  if (prop.length === 0) { fail(`${label}: no property images rendered at all`); return; }
  rend.length === prop.length
    ? ok(`${label}: every property image is a rendition`)
    : (prop.length - rend.length) === prop.filter((i) => i.fellBack).length
      ? ok(`${label}: ${prop.length - rend.length} fell back to originals (fallback working)`)
      : (() => {
          const stray = prop.filter((i) => !/\/renditions\//.test(i.src) && !i.fellBack);
          fail(`${label}: ${stray.length} property images are NOT renditions and did not fall back`);
          // Name them. "13 images still serve originals" is only actionable if
          // you know which surface produced them.
          for (const s of stray.slice(0, 6)) console.log(`       stray: ${s.src.split('/property-images/')[1]}`);
        })();
  broken.length === 0 ? ok(`${label}: no broken images`)
                      : fail(`${label}: ${broken.length} BROKEN — ${broken.slice(0,3).map(b=>b.src).join(' ')}`);
}

let SAMPLE_OBJECT = null;
const remember = (imgs) => {
  if (SAMPLE_OBJECT) return;
  const withOrig = imgs.find((x) => x.orig && x.orig.includes('/property-images/'));
  const src = withOrig ? withOrig.orig
    : (imgs.find((x) => x.src.includes('/property-images/') && !/\/renditions\//.test(x.src)) || {}).src;
  if (!src) return;
  SAMPLE_OBJECT = decodeURIComponent(src.split('/property-images/')[1].split('?')[0]);
};

const browser = await chromium.launch();

// ── 2. listings grid, fully scrolled (progressive rendering) ───────────────
console.log('\n── listings grid (desktop, scrolled to the end) ───────');
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${SITE}/listings.html?${bust()}`, { waitUntil: 'networkidle', timeout: 60000 });
  for (let i = 0; i < 12; i++) {                 // exhaust the IntersectionObserver pages
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(2500);
  const gridImgs = await collect(page); remember(gridImgs); await audit('grid', gridImgs);
  await page.close();
}

// ── 3. listing detail: desktop hero + thumbnails, unit cards, map cards ────
console.log('\n── listing detail (desktop: hero, thumbnails, unit cards) ──');
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${SITE}/listing.html?slug=${encodeURIComponent(SLUG)}&${bust()}`,
                  { waitUntil: 'networkidle', timeout: 60000 });
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(2000);
  const imgs = await collect(page); remember(imgs);
  await audit('detail-desktop', imgs);
  const hero = imgs.find((i) => /\/hero\.webp/.test(i.src));
  const thumb = imgs.filter((i) => /\/thumbnail\.webp/.test(i.src));
  const card = imgs.filter((i) => /\/card\.webp/.test(i.src));
  hero  ? ok(`hero uses the 1200px profile`)      : fail('no hero rendition on the detail page');
  thumb.length ? ok(`${thumb.length} thumbnails use the 200px profile`) : fail('no thumbnail renditions');
  console.log(`  unit/map cards using the 400px profile: ${card.length}`);
  await page.close();
}

// ── 4. mobile gallery (the windowed slide hydration) ──────────────────────
console.log('\n── listing detail (mobile gallery) ───────────────────');
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(`${SITE}/listing.html?slug=${encodeURIComponent(SLUG)}&${bust()}`,
                  { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  // Walk the gallery so the windowed hydration promotes data-src -> src.
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      const t = document.querySelector('.mobile-gallery, .mg-track, [class*="gallery"]');
      if (t && t.scrollWidth > t.clientWidth) t.scrollLeft += t.clientWidth;
    });
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
  const imgs = await collect(page);
  await audit('detail-mobile', imgs);
  const gal = imgs.filter((i) => /\/gallery\.webp/.test(i.src));
  gal.length ? ok(`${gal.length} gallery slides use the 800px profile`)
             : console.log('  note: no 800px gallery slide hydrated (listing may have a single photo)');
  await page.close();
}

await browser.close();

// ── 5. the delivery contract, straight from the object endpoint ───────────
console.log('\n── direct object checks ──────────────────────────────');
const enc = (n) => n.split('/').map(encodeURIComponent).join('/');
// The object name comes from an image the site actually rendered -- anon has no
// read on property_images, and a probe that invents a path proves nothing.
if (!SAMPLE_OBJECT) { fail('no property image was rendered, so there is nothing to probe'); }
const stem = SAMPLE_OBJECT;
const base = stem.replace(/\.[A-Za-z0-9]+$/, '');
console.log(`  probing object: ${stem}`);

for (const profile of ['thumbnail', 'card', 'gallery', 'hero']) {
  const r = await fetch(`${OBJ}/${enc(`renditions/${base}/${profile}.webp`)}`);
  const ct = r.headers.get('content-type'), cc = r.headers.get('cache-control');
  (r.status === 200 && ct === 'image/webp')
    ? ok(`${profile.padEnd(9)} GET ${r.status} ${ct}  cache-control: ${cc}`)
    : fail(`${profile} GET ${r.status} ${ct}`);
}

// The original must still be there and still serve — the whole design rests on
// it being an untouched fallback.
const o = await fetch(`${OBJ}/${enc(stem)}`);
o.status === 200 ? ok(`original still serves: ${o.status} ${o.headers.get('content-type')} `
                    + `${o.headers.get('content-length')} bytes`)
                 : fail(`ORIGINAL MISSING: ${o.status} for ${stem}`);

const miss = await fetch(`${OBJ}/renditions/definitely-not-a-real-object/card.webp`);
(miss.status >= 400 && miss.status < 500)
  ? ok(`missing rendition returns ${miss.status} — fallback stays meaningful`)
  : fail(`missing rendition returned ${miss.status}, expected 4xx`);

console.log(`\n${failures === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
