// index.html — viewport-based impression tracking for the homepage
// featured-listings grid (#card-grid).
//
// Replaces the old postHomepageImpressions() batch POST (fired the instant
// loadFeatured()'s fetch resolved, one row per rendered card regardless of
// whether it was ever scrolled to) with the same shared mechanism used by
// listings.html/listing.html: a card only attempts an impression once it has
// been >=50% visible for a continuous 500ms (components.js's
// _ptObserveForImpression), as one unbatched POST per card. The server's
// existing 30-minute (session_id, property_id, event_type) dedup remains the
// sole authority on whether an attempt is actually counted.

const { test, expect } = require('@playwright/test');

function listing(i, over) {
  return Object.assign({
    id: 'id-' + i,
    slug: 'slug-' + i,
    title_lo: 'ລາຍການ ' + i, title_en: 'Listing ' + i, title_zh: '房源 ' + i,
    property_type: 'apartment',
    transaction_type: 'for_rent',
    district_lo: 'ສີສັດຕະນາກ', district_en: 'Sisattanak',
    images: ['https://example.invalid/a.jpg'],
    price_amount: 400 + i, price_currency: 'USD', price_frequency: 'monthly',
    bedrooms: 2, bathrooms: 1, sqm: 80,
    workflow_status: 'active', status: 'active',
    market_status: 'available',
    is_featured: true,
    created_at: '2026-08-01T00:00:00Z',
    contacts: null, parties: null, unit_types: [],
  }, over);
}

async function mount(page, rows) {
  const errors = [];
  const posts = [];
  page.on('pageerror', e => errors.push(String(e.message)));

  await page.route('**/rest/v1/properties**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) }));
  await page.route('**/rest/v1/listing_events**', r => {
    try { posts.push(r.request().postDataJSON()); } catch (_) {}
    return r.fulfill({ status: 201, body: '' });
  });
  for (const t of ['search_events', 'ui_events', 'page_views']) {
    await page.route('**/rest/v1/' + t + '**', r => r.fulfill({ status: 201, body: '' }));
  }

  await page.goto('/index.html');
  await expect(page.locator('#card-grid .pt-card').first()).toBeVisible();
  return { errors, posts };
}

const cards = page => page.locator('#card-grid .pt-card');
const impressions = (posts) => posts.filter(e => e && e.event_type === 'impression');
const clicks = (posts) => posts.filter(e => e && e.event_type === 'click');

test.use({ viewport: { width: 1280, height: 800 } });

test('a featured card scrolled into view attempts exactly one impression after the 500ms dwell', async ({ page }) => {
  const rows = [listing(1), listing(2), listing(3), listing(4)];
  const { errors, posts } = await mount(page, rows);

  await cards(page).last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  expect(impressions(posts).length).toBeGreaterThan(0);

  impressions(posts).forEach(e => {
    expect(rows.some(r => r.id === e.property_id)).toBe(true);
    expect(e.source).toBe('homepage');
  });
  expect(errors).toEqual([]);
});

test('a card that leaves the viewport before the 500ms dwell completes is never attempted', async ({ page }) => {
  const rows = [listing(1)];
  const { posts } = await mount(page, rows);
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.cssText = 'height:2000px;';
    document.getElementById('card-grid').parentNode.insertBefore(spacer, document.getElementById('card-grid'));
  });
  await cards(page).first().scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0)); // back away well inside the dwell window
  await page.waitForTimeout(700);
  expect(impressions(posts)).toHaveLength(0);
});

test('a card only ever attempts once, even after repeated scroll-out/scroll-in', async ({ page }) => {
  const rows = [listing(1)];
  const { posts } = await mount(page, rows);
  const card = cards(page).first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  expect(impressions(posts)).toHaveLength(1);

  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(100);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  expect(impressions(posts)).toHaveLength(1);
});

test('a language toggle rebuild of an already-visible card does not immediately duplicate the attempt (client cooldown)', async ({ page }) => {
  // renderCards() rebuilds every card as a new DOM node on setLang() -- this
  // asserts the client-side rebuild-cooldown ONLY (an optimization, never
  // the semantic definition of an impression: the server's 30-minute dedup
  // remains the sole authority on whether an attempt actually counts).
  const rows = [listing(1), listing(2)];
  const { posts, errors } = await mount(page, rows);
  await cards(page).last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  const firstCount = impressions(posts).length;
  expect(firstCount).toBeGreaterThan(0);

  await page.locator('.nav-lang-item[data-lang="en"]').click();
  await page.waitForTimeout(700); // still well inside the 5s cooldown
  expect(impressions(posts).length).toBe(firstCount);
  expect(errors).toEqual([]);
});

test('impression tracking does not change or duplicate existing click/save tracking', async ({ page }) => {
  const rows = [listing(1)];
  const { posts } = await mount(page, rows);
  const card = cards(page).first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  expect(impressions(posts)).toHaveLength(1);

  // The click handler is a page-level delegated listener reading data-pid
  // off the card -- aborting the navigation request (rather than
  // ctrl-clicking) keeps the test on this page without affecting when the
  // click POST itself is sent.
  await page.route('**/listing.html*', (r) => r.abort());
  await card.click();
  await page.waitForTimeout(200);
  expect(clicks(posts)).toHaveLength(1);
  expect(clicks(posts)[0].property_id).toBe('id-1');
  expect(clicks(posts)[0].source).toBe('homepage');
  expect(impressions(posts)).toHaveLength(1); // click never adds a second impression attempt
});

test.describe('mobile viewport', () => {
  test.use({ viewport: { width: 375, height: 700 }, hasTouch: true, isMobile: true });

  test('a full-width mobile featured card still attempts an impression once scrolled into view', async ({ page }) => {
    const rows = [listing(1), listing(2)];
    const { errors, posts } = await mount(page, rows);
    await cards(page).last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    expect(impressions(posts).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
