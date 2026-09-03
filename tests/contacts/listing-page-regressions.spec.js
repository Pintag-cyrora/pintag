// Regression suite for the listing.html fixes of 2026-09-03, driven against
// the REAL page with the same harness as multi-contact.spec.js.
const { test, expect } = require('@playwright/test');
const { contact, BASE, openListing } = require('./fixtures');

const IMG = (n) => 'http://localhost:8973/' + n;
const ROUTED = Object.assign({}, BASE, {
  slug: 'routed', images: [IMG('pintag-hero.png'), IMG('pintag-villa.png'), IMG('pintag-interior.png')],
  contacts: contact({ id: 'legacy', phone: '+856 20 999 9999' }),
  property_contacts: [
    { sort_order: 0, is_primary: true, contacts: contact({ id: 'a', name: 'Somchai', phone: '+856 20 111 1111', languages: ['lo', 'en'] }) },
    { sort_order: 1, contacts: contact({ id: 'cc', name: 'Ms. Li', phone: '+856 20 333 3333', languages: ['zh'] }) },
  ],
  unit_types: [
    { id: 'u1', name_en: 'Studio', bedrooms: 0, bathrooms: 1, sqm: 30, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 1, total_units: 2, sort_order: 0, images: [IMG('pintag-balcony.png')] },
    { id: 'u2', name_en: 'One Bedroom', bedrooms: 1, bathrooms: 1, sqm: 45, price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 1, total_units: 2, sort_order: 1, images: [] },
  ],
});

test('the mobile sticky WhatsApp button follows the contact picker, with the picked contact id for lead attribution', async ({ page }) => {
  const errors = await openListing(page, ROUTED);
  await expect(page.locator('#pt-wa-mobile')).toHaveAttribute('href', /wa\.me\/856201111111/);
  await expect(page.locator('#pt-wa-mobile')).toHaveAttribute('data-contact-id', 'a');
  await page.evaluate(() => ptSelectContact(2));   // [legacy embed, a, cc]: the picker lists the legacy row first
  await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /wa\.me\/856203333333/);
  await expect(page.locator('#pt-wa-mobile')).toHaveAttribute('href', /wa\.me\/856203333333/);
  await expect(page.locator('#pt-wa-mobile')).toHaveAttribute('data-contact-id', 'cc');
  expect(await page.evaluate(() => document.getElementById('pt-wa-mobile').getAttribute('onclick'))).toContain("contactId:this.getAttribute('data-contact-id')");
  expect(errors.map((e) => e.message)).toEqual([]);
});

test('unit-card inquiries are attributed to the RESOLVED contact, not the legacy contacts embed', async ({ page }) => {
  await openListing(page, ROUTED);
  const onclicks = await page.evaluate(() => [...document.querySelectorAll('.unit-cta')].map((a) => a.getAttribute('onclick')));
  expect(onclicks.length).toBeGreaterThan(0);
  onclicks.forEach((oc) => { expect(oc).toContain("contactId:'a'"); expect(oc).not.toContain("contactId:'legacy'"); });
});

test('unit-card covers and building-strip photos carry the rendition fallback like every other image', async ({ page }) => {
  await openListing(page, ROUTED);
  const cover = page.locator('.unit-card-cover img').first();
  await expect(cover).toHaveAttribute('data-pt-original', IMG('pintag-balcony.png'));
  await expect(cover).toHaveAttribute('onerror', /ptImageFallback/);
  await page.evaluate(() => selectUnitType('u1'));
  const strip = page.locator('.building-strip-photo img').first();
  await expect(strip).toHaveAttribute('data-pt-original', IMG('pintag-hero.png'));
});

test.describe('desktop gallery', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('clicking the hero opens the lightbox at the photo being shown, and the hero fallback follows that photo', async ({ page }) => {
    await openListing(page, ROUTED);
    await expect(page.locator('#dg-hero-img')).toHaveAttribute('data-pt-original', IMG('pintag-hero.png'));
    await page.evaluate(() => syncDesktopHero(2, document.querySelectorAll('.dg-thumb')[2] || null));
    await page.waitForTimeout(250);
    await expect(page.locator('#dg-hero-img')).toHaveAttribute('data-pt-original', IMG('pintag-interior.png'));
    await page.evaluate(() => document.getElementById('dg-hero-frame').click());
    expect(await page.evaluate(() => [LB.idx, document.getElementById('lb-overlay').classList.contains('lb-open')])).toEqual([2, true]);
    // A fallback that already fired for one photo must not disable it for the next
    await page.evaluate(() => { LB.close(); document.getElementById('dg-hero-img').dataset.ptFellBack = '1'; syncDesktopHero(1, null); });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.getElementById('dg-hero-img').dataset.ptFellBack)).toBeUndefined();
  });
});

test.describe('slugless listing opened via ?id=', () => {
  async function openById(page, property, hash) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    const slugQueries = [];
    await page.route('**cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}};}};' }));
    await page.route('**fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('**unpkg.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('**/rest/v1/**', (r) => {
      const u = r.request().url();
      if (/properties\?slug=eq\./.test(u)) slugQueries.push(u);
      if (/properties\?id=eq\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([property]) });
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/listing.html?id=' + property.id + '&lang=en' + (hash || ''));
    await page.waitForTimeout(1500);
    return { errors, slugQueries };
  }
  const NOSLUG = Object.assign({}, BASE, { id: 'p-noslug', slug: null, market_status: 'rented', contacts: contact({ id: 'a' }) });

  test('#similar-section left by Find Similar is not read as a slug (refresh/share keeps working)', async ({ page }) => {
    const { errors, slugQueries } = await openById(page, NOSLUG, '#similar-section');
    expect(slugQueries).toEqual([]);
    await expect(page.locator('.section-label').first()).toBeVisible();
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('Property not found');
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test('the Find Similar CTAs scroll in place instead of rewriting the address bar', async ({ page }) => {
    await openById(page, NOSLUG);
    const ctas = await page.evaluate(() => [...document.querySelectorAll('a[href="#similar-section"]')].map((a) => a.getAttribute('onclick') || ''));
    expect(ctas.length).toBeGreaterThan(0);
    ctas.forEach((oc) => expect(oc).toContain('scrollToSimilar'));
  });
});

test.describe('similar listings', () => {
  async function openWithSimilar(page, similarRows) {
    const posts = [];
    let served = false;
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.route('**cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}};}};' }));
    await page.route('**fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('**unpkg.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('**/rest/v1/**', (r) => {
      const req = r.request(); const u = req.url();
      if (req.method() === 'POST' && /listing_events/.test(u)) { try { posts.push(req.postDataJSON()); } catch (_) {} return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
      if (/properties\?slug=eq\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([BASE]) });
      if (/properties\?property_type=eq\./.test(u) && !served) { served = true; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(similarRows) }); }
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/listing.html?slug=multi&lang=en');
    await page.waitForSelector('#similar-section .pt-preview, #similar-section a', { timeout: 15000 });
    await page.waitForTimeout(500);
    return { posts, errors };
  }
  const sim = (o) => Object.assign({ id: 'sim-' + o.slug, status: 'active', workflow_status: 'active', market_status: 'available', property_type: 'apartment', transaction_type: 'for_rent', title_en: 'Sim ' + o.slug, images: [], price_amount: 400, price_currency: 'USD', price_frequency: 'monthly', created_at: '2026-08-01T00:00:00Z' }, o);
  const impressions = (posts) => posts.flat().filter((e) => e && e.event_type === 'impression' && e.source === 'similar');

  test('impressions are posted once per result set, not again on every language switch', async ({ page }) => {
    const { posts, errors } = await openWithSimilar(page, [sim({ slug: 'one' }), sim({ slug: 'two' })]);
    expect(impressions(posts)).toHaveLength(2);
    await page.evaluate(() => setLang('lo'));
    await page.evaluate(() => setLang('zh'));
    await page.waitForTimeout(400);
    expect(impressions(posts)).toHaveLength(2);
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test('a slugless similar listing still gets a card (linked through ?id=), so the count matches the grid', async ({ page }) => {
    const { errors } = await openWithSimilar(page, [sim({ slug: 'one' }), sim({ id: 'sim-noslug', slug: null })]);
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('#similar-section .pt-preview')].map((c) => (c.matches('a') ? c : c.querySelector('a')).getAttribute('href')));
    expect(hrefs).toHaveLength(2);
    expect(hrefs.some((h) => /[?&]id=sim-noslug/.test(h))).toBe(true);
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

test.describe('status copy for sale_or_rent and localised WhatsApp titles', () => {
  test('the market-transition line treats sale_or_rent as a sale, like every other surface', async ({ page }) => {
    await openListing(page, Object.assign({}, BASE, { slug: 'sor', transaction_type: 'sale_or_rent', contacts: contact({ id: 'a' }) }));
    const line = (tx) => page.evaluate((tx) => { applyMarketTransitionStats({ sample_size: 5, median_days: 12 }, 'en', tx); return document.getElementById('market-insight-days').textContent; }, tx);
    expect(await line('sale_or_rent')).toContain('sell within 12 days');
    expect(await line('for_sale')).toContain('sell within 12 days');
    expect(await line('for_rent')).toContain('rent within 12 days');
  });

  test('the waiting-list WhatsApp message carries the title in the page language, not always English', async ({ page }) => {
    const occupied = Object.assign({}, BASE, { slug: 'occ', market_status: 'fully_occupied', title_lo: 'ອາພາດເມັນ ລິມແມ່ນ້ຳ', title_en: 'Riverside Apartment', contacts: contact({ id: 'a' }) });
    await openListing(page, occupied, 'lo');
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href*="wa.me"]')].map((a) => decodeURIComponent(a.getAttribute('href'))));
    const statusLinks = hrefs.filter((h) => /ລໍຖ້າ/.test(h));   // the "Join Waiting List" CTA (desktop + mobile)
    expect(statusLinks.length).toBeGreaterThan(0);
    statusLinks.forEach((h) => { expect(h).toContain('ອາພາດເມັນ ລິມແມ່ນ້ຳ'); expect(h).not.toContain('Riverside Apartment'); });
  });
});
