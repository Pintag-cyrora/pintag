// The one-time swipe hint on the mobile photo gallery of listing.html (ptStartGallerySwipeHint). The REAL page, a stubbed
// supabase, real images from this suite's static server. What is pinned:
//   * shown only for 2+ photos, on the initial view, at most once per browser SESSION (sessionStorage); never for one photo / no photos / reduced motion
//   * it demonstrates the REAL swipe: the real slides move left and reveal the start of the next real photo
//   * any interaction cancels it at once; it also ends by itself; it never comes back (reload, unit re-render, more swipes)
//   * native swiping, dots, and navigation are untouched; gallery order / sources / image requests / layout are identical
const { test, expect } = require('@playwright/test');
const { contact, BASE, openListing } = require('./fixtures');

const IMG = (n) => 'http://localhost:8949/' + n;
const PHOTOS = [IMG('pintag-hero.png'), IMG('pintag-villa.png'), IMG('pintag-interior.png'), IMG('pintag-balcony.png'), IMG('pintag-exterior.png')];
const MULTI = Object.assign({}, BASE, { slug: 'swipe-multi', images: PHOTOS, contacts: contact({}) });
const SINGLE = Object.assign({}, BASE, { slug: 'swipe-single', images: [PHOTOS[0]], contacts: contact({}) });
const NONE = Object.assign({}, BASE, { slug: 'swipe-none', images: [], contacts: contact({}) });
const TWO_UNITS = Object.assign({}, BASE, { slug: 'swipe-units', images: PHOTOS, contacts: contact({}), unit_types: [
  { id: 'u1', name_en: 'Studio', bedrooms: 0, bathrooms: 1, sqm: 30, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 1, total_units: 2, sort_order: 0, images: [PHOTOS[1], PHOTOS[2]] },
  { id: 'u2', name_en: 'One Bed', bedrooms: 1, bathrooms: 1, sqm: 45, price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 1, total_units: 2, sort_order: 1, images: [PHOTOS[3], PHOTOS[4]] },
] });

const MOBILE = { width: 390, height: 844 };
test.use({ viewport: MOBILE, hasTouch: true, isMobile: true });

const HINT = '.mg-swipe-hint';
const KEY = 'pt_gallery_swipe_hint_v1';
const slideTx = (page, i) => page.evaluate((n) => { const m = new DOMMatrix(getComputedStyle(document.querySelectorAll('#mg-track-el .mg-slide')[n]).transform); return m.m41; }, i);
const fingerOpacity = (page) => page.evaluate(() => { const f = document.querySelector('.mg-swipe-finger'); return f ? Number(getComputedStyle(f).opacity) : null; });
const seen = (page) => page.evaluate((k) => sessionStorage.getItem(k), KEY);
const geometry = (page) => page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y + scrollY), Math.round(b.width), Math.round(b.height)]; };
  return { gallery: r(document.querySelector('.mobile-gallery')), track: r(document.getElementById('mg-track-el')), dots: r(document.getElementById('mg-dots-box')),
           slides: [...document.querySelectorAll('#mg-track-el .mg-slide')].map(r), scrollHeight: document.documentElement.scrollHeight, scrollLeft: document.getElementById('mg-track-el').scrollLeft };
});
const slideSources = (page) => page.evaluate(() => [...document.querySelectorAll('#mg-track-el .mg-slide')].map((s) => {
  const i = s.querySelector('img'); return [s.dataset.idx, i.getAttribute('src'), i.getAttribute('data-src'), i.getAttribute('loading'), i.getAttribute('data-pt-original')]; }));

async function swipe(page, dx) {
  const box = await page.locator('#mg-track-el').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2, x0 = box.x + box.width * 0.85;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= 14; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 - (dx * i) / 14, y }] }); await page.waitForTimeout(24); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
// The hint lasts ~3 s and starts ~1 s after the photos load, so a single check after a fixed wait can miss it. Watch continuously.
async function expectNoHint(page, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await page.locator(HINT).count()) throw new Error('the swipe hint appeared when it must not'); await page.waitForTimeout(80); }
}
const activeDot = (page) => page.evaluate(() => [...document.querySelectorAll('.mg-dot')].findIndex((d) => d.classList.contains('active')));

test.describe('when it shows', () => {
  test('multi-photo listing: the hint appears on the initial view and demonstrates the REAL swipe (slides move left, the next photo is revealed)', async ({ page }) => {
    const errors = await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await expect(page.locator(HINT)).toHaveAttribute('aria-hidden', 'true');
    // sample the animation: the real slides translate left by ~15% of the photo width and the finger is visible
    let minTx = 0, maxOpacity = 0, nextVisible = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 2600) {
      minTx = Math.min(minTx, await slideTx(page, 0));
      maxOpacity = Math.max(maxOpacity, (await fingerOpacity(page)) || 0);
      nextVisible = Math.max(nextVisible, await page.evaluate(() => { const t = document.getElementById('mg-track-el').getBoundingClientRect();
        const n = document.querySelectorAll('#mg-track-el .mg-slide')[1].getBoundingClientRect(); return Math.max(0, t.right - n.left); }));
      await page.waitForTimeout(40);
    }
    expect(minTx).toBeLessThan(-40);                 // 15% of 390 = 58 px at the peak
    expect(minTx).toBeGreaterThan(-90);              // a hint, not a full swipe
    expect(maxOpacity).toBeGreaterThan(0.9);
    expect(nextVisible).toBeGreaterThan(40);         // a real part of the NEXT photo is on screen
    expect(errors.map((e) => e.message)).toEqual([]);
  });
  test('the real slides sit at rest (no transform, scrollLeft 0, first dot active) when the hint is over, and it ends by itself', async ({ page }) => {
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });          // its own timeout: ~3 s of animation
    for (let i = 0; i < 3; i++) expect(await slideTx(page, i)).toBe(0);
    expect((await geometry(page)).scrollLeft).toBe(0);
    expect(await activeDot(page)).toBe(0);
    expect(await seen(page)).toBe('1');
  });
  test('one photo: never shown', async ({ page }) => {
    const errors = await openListing(page, SINGLE);
    await expectNoHint(page, 5000);
    expect(await seen(page)).toBeNull();
    expect(errors.map((e) => e.message)).toEqual([]);
  });
  test('no photos (placeholder): never shown', async ({ page }) => {
    await openListing(page, NONE);
    await expectNoHint(page, 5000);
  });
  test('prefers-reduced-motion: never shown, nothing stored', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openListing(page, MULTI);
    await expectNoHint(page, 5000);
    expect(await seen(page)).toBeNull();
    for (let i = 0; i < 3; i++) expect(await slideTx(page, i)).toBe(0);
  });
  test('already seen in this session: not shown again after a reload', async ({ page }) => {
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });
    await page.reload();
    await page.waitForSelector('#mg-track-el');
    await expectNoHint(page, 5000);
  });
  test('NOT once per device: it may appear again in a NEW session (new tab / new browser context), but not again in the same one', async ({ page, browser }) => {
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });
    expect(await seen(page)).toBe('1');
    // same session (same tab): navigating to another listing and back, or reloading, does not repeat it
    await page.reload(); await page.waitForSelector('#mg-track-el');
    await expectNoHint(page, 4500);
    // a new tab = a new sessionStorage = a new session: it can be shown again
    const tab2 = await page.context().newPage();
    await openListing(tab2, MULTI);
    await expect(tab2.locator(HINT)).toBeAttached({ timeout: 8000 });
    // a brand-new browser context (e.g. a returning visit after the browser was closed) behaves the same
    const ctx = await browser.newContext({ viewport: MOBILE, hasTouch: true, isMobile: true });
    const p3 = await ctx.newPage();
    await openListing(p3, MULTI);
    await expect(p3.locator(HINT)).toBeAttached({ timeout: 8000 });
    await ctx.close();
  });
  test('a persistent (localStorage) flag from an earlier build no longer suppresses it', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, '1'), KEY);
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('1');          // untouched: the hint no longer writes localStorage
    expect(await seen(page)).toBe('1');
  });
  test('it never writes its flag to localStorage', async ({ page }) => {
    await page.addInitScript(() => { const o = Storage.prototype.setItem; window.__lsWrites = 0; Storage.prototype.setItem = function (k) { if (this === window.localStorage && k === 'pt_gallery_swipe_hint_v1') window.__lsWrites++; return o.apply(this, arguments); }; });
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });
    expect(await page.evaluate(() => window.__lsWrites)).toBe(0);
  });
  test('storage blocked: still works once per page load and does not throw', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } }); });
    const errors = await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

test.describe('dismissal', () => {
  test('touching the gallery cancels it immediately: hint gone, slides at rest, marked seen', async ({ page }) => {
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await page.waitForTimeout(500);
    await page.locator('#mg-track-el').tap();
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 500 });
    for (let i = 0; i < 3; i++) expect(await slideTx(page, i)).toBe(0);
    expect(await seen(page)).toBe('1');
    await expectNoHint(page, 5000);
  });
  test('a REAL swipe during the hint: the hint stops, the gallery moves to photo 2, nothing is left offset', async ({ page }) => {
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await page.waitForTimeout(400);
    await swipe(page, 260);
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 500 });
    // a fling can carry past one photo, so assert "moved on and settled on a whole photo", not an exact index
    await expect.poll(() => activeDot(page), { timeout: 4000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => { const l = (await geometry(page)).scrollLeft; return l > 300 && Math.abs(l / 390 - Math.round(l / 390)) < 0.01; }, { timeout: 4000 }).toBe(true);
    for (let i = 0; i < 3; i++) expect(await slideTx(page, i)).toBe(0);
    await expectNoHint(page, 5000);
  });
  test('swiping BEFORE the hint starts works natively and the hint never appears afterwards', async ({ page }) => {
    await openListing(page, MULTI);
    await swipe(page, 260);                                                        // immediately, before the ~1 s start delay
    await expect.poll(() => activeDot(page), { timeout: 4000 }).toBeGreaterThanOrEqual(1);
    await expectNoHint(page, 5000);
  });
  test('tapping a dot dismisses it and navigates as before', async ({ page }) => {
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await page.locator('.mg-dot').nth(3).tap();
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 500 });
    await expect.poll(() => activeDot(page), { timeout: 4000 }).toBe(3);
  });
  test('once per PAGE LOAD even when storage is blocked: a unit re-render of the gallery does not start it again', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } }); });
    const errors = await openListing(page, TWO_UNITS);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });
    await page.evaluate(() => selectUnitType('u1'));
    await page.waitForSelector('#mg-track-el');
    await expectNoHint(page, 5000);
    expect(errors.map((e) => e.message)).toEqual([]);
  });
  test('it never comes back: more swipes, a unit re-render of the gallery, or waiting', async ({ page }) => {
    await openListing(page, TWO_UNITS);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });
    await page.evaluate(() => selectUnitType('u1'));                              // re-renders the hero + gallery for that unit
    await page.waitForSelector('#mg-track-el');
    await swipe(page, 260); await page.waitForTimeout(600); await swipe(page, 260);
    await expectNoHint(page, 5000);
  });
});

test.describe('does not interfere', () => {
  test('gallery order, sources, loading attributes and CDN/fallback attributes are identical with and without the hint', async ({ page, browser }) => {
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    const during = await slideSources(page);
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });
    const after = await slideSources(page);
    expect(after).toEqual(during);
    // a second page where the hint is suppressed from the start (session flag pre-set): same markup
    const ctx = await browser.newContext({ viewport: MOBILE, hasTouch: true, isMobile: true });
    const p2 = await ctx.newPage();
    await p2.addInitScript((k) => sessionStorage.setItem(k, '1'), KEY);
    await openListing(p2, MULTI);
    await p2.waitForTimeout(1500);
    expect(await slideSources(p2)).toEqual(after);
    expect(after.map((s) => s[0])).toEqual(['0', '1', '2', '3', '4']);                         // order preserved
    expect(after.map((s) => s[1] || s[2])).toEqual(PHOTOS);                                    // exactly the listing's photos, no duplicates
    await ctx.close();
  });
  test('no extra image requests: the hint makes no requests of its own (same set as a page where it is suppressed)', async ({ page, browser }) => {
    const collect = (p) => { const urls = []; p.on('request', (r) => { if (r.resourceType() === 'image') urls.push(r.url()); }); return urls; };
    const a = collect(page);
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });
    const ctx = await browser.newContext({ viewport: MOBILE, hasTouch: true, isMobile: true });
    const p2 = await ctx.newPage();
    await p2.addInitScript((k) => sessionStorage.setItem(k, '1'), KEY);
    const b = collect(p2);
    await openListing(p2, MULTI);
    await p2.waitForTimeout(6000);
    const norm = (u) => u.filter((x) => x.includes('localhost:8949/pintag-')).sort();
    expect(norm(a)).toEqual(norm(b));
    expect(new Set(norm(a)).size).toBe(norm(a).length);                                        // no image fetched twice
    expect(norm(a).length).toBeLessThanOrEqual(3);                                              // the windowed loading (PT_SLIDE_WINDOW) is intact
    await ctx.close();
  });
  test('no layout shift: the gallery, dots, slides and page height are identical before, during and after', async ({ page }) => {
    await openListing(page, MULTI);
    await page.waitForFunction(() => document.querySelector('#mg-track-el img').complete);
    const before = await geometry(page);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    const samples = [];
    for (let i = 0; i < 12; i++) { samples.push(await geometry(page)); await page.waitForTimeout(220); }
    await expect(page.locator(HINT)).toHaveCount(0, { timeout: 6000 });
    const after = await geometry(page);
    samples.concat([after]).forEach((g) => { expect(g.gallery).toEqual(before.gallery); expect(g.track).toEqual(before.track); expect(g.dots).toEqual(before.dots); expect(g.scrollHeight).toBe(before.scrollHeight); expect(g.scrollLeft).toBe(0); });
  });
  test('the overlay cannot intercept a touch (pointer-events:none) and the track keeps touch-action pan-x', async ({ page }) => {
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.mg-swipe-hint')).pointerEvents)).toBe('none');
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('mg-track-el')).touchAction)).toContain('pan-x');
    expect(await page.evaluate(() => { const b = document.getElementById('mg-track-el').getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2).closest('.mg-slide') !== null; })).toBe(true);
  });
  test('existing dots/navigation: tapping each dot still jumps to that photo', async ({ page }) => {
    await openListing(page, MULTI);
    await page.locator('#mg-track-el').tap();                                                   // dismiss the hint first, then exercise the gallery
    for (const i of [2, 4, 1]) { await page.locator('.mg-dot').nth(i).tap(); await expect.poll(() => activeDot(page), { timeout: 4000 }).toBe(i); }
  });
});

test.describe('desktop and narrow windows', () => {
  test.describe('wide desktop (>960px): the desktop hero is used, no swipe track', () => {
    test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
    test('no hint; thumbnails and the lightbox still work', async ({ page }) => {
      await openListing(page, MULTI);
      await expectNoHint(page, 5000);
      await expect(page.locator('.dg-thumb').first()).toBeVisible();
      await page.locator('#dg-hero-frame').click();
      await expect(page.locator('#lb-overlay')).toHaveClass(/lb-open/);
    });
  });
  test.describe('narrow desktop window with a mouse (<=960px)', () => {
    test.use({ viewport: { width: 800, height: 900 }, hasTouch: false, isMobile: false });
    test('the carousel is shown, so the hint is too; a mouse press dismisses it', async ({ page }) => {
      await openListing(page, MULTI);
      await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
      await page.locator('#mg-track-el').click({ position: { x: 100, y: 100 } });
      await expect(page.locator(HINT)).toHaveCount(0, { timeout: 500 });
    });
  });
});

test.describe('390px mobile layout', () => {
  test('the finger stays inside the photo area and the page does not scroll sideways', async ({ page }) => {
    await openListing(page, MULTI);
    await expect(page.locator(HINT)).toBeAttached({ timeout: 8000 });
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => { const f = document.querySelector('.mg-swipe-finger').getBoundingClientRect(); const t = document.getElementById('mg-track-el').getBoundingClientRect();
      return { l: f.left - t.left, r: t.right - f.right, t: f.top - t.top, b: t.bottom - f.bottom, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
    expect(r.l).toBeGreaterThanOrEqual(0); expect(r.r).toBeGreaterThanOrEqual(0); expect(r.t).toBeGreaterThanOrEqual(0); expect(r.b).toBeGreaterThanOrEqual(0);
    expect(r.over).toBeLessThanOrEqual(1);
  });
});
