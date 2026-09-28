// listings.html — viewport-based impression tracking.
//
// Replaces the old "every rendered card is an impression" batch POST (fired
// the instant a search settled, regardless of whether a card was ever
// actually seen) with a real per-card IntersectionObserver: a card only
// attempts an impression once it has been >=50% visible for a continuous
// 500ms. One unbatched POST per attempt; the server's existing 30-minute
// (session_id, property_id, event_type) dedup remains the sole authority on
// whether an attempt is actually counted -- nothing here decides that.
//
// Mirrors listings-visibility.spec.js's own mount() convention, but adds
// body-capturing on the listing_events route so impression attempts (and
// only impression attempts -- clicks are asserted separately, see the
// non-regression test at the bottom) can be counted.

const { test, expect } = require('@playwright/test');

function listing(i, over) {
  return Object.assign({
    id: 'id-' + i,
    slug: 'slug-' + i,
    title_en: 'Listing ' + i, title_lo: 'ລາຍການ ' + i, title_zh: '房源 ' + i,
    property_type: 'house',
    transaction_type: 'for_rent',
    district_en: 'Chanthabouly',
    images: ['https://example.invalid/a.jpg'],
    price_amount: 500 + i, price_currency: 'USD', price_frequency: 'monthly',
    bedrooms: 2, bathrooms: 1, sqm: 100,
    workflow_status: 'active', status: 'active',
    market_status: 'available',
    is_featured: false,
    created_at: '2026-07-01T00:00:00Z',
    views_week: 3, view_count: 30,
    contacts: null, parties: null,
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
  await page.route('**/rest/v1/rpc/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('/listings.html');
  await expect(page.locator('#listings-container > *').first()).toBeVisible();
  return { errors, posts };
}

const cards = page => page.locator('#listings-container > .pt-card');
const impressions = (posts) => posts.filter(e => e && e.event_type === 'impression');
const clicks = (posts) => posts.filter(e => e && e.event_type === 'click');

test.describe('main grid: viewport impression attempts', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a card scrolled into view attempts exactly one impression after the 500ms dwell', async ({ page }) => {
    // Enough rows that several are guaranteed to still be below the fold
    // after the initial batch settles, whatever the grid's column count.
    const rows = Array.from({ length: 16 }, (_, i) => listing(i + 1));
    const { errors, posts } = await mount(page, rows);

    // Nothing above the fold has dwelt 500ms yet -- give layout a moment,
    // then confirm the very first (already-visible) cards start attempting.
    await page.waitForTimeout(700);
    const firstBatch = impressions(posts).length;
    expect(firstBatch).toBeGreaterThan(0);
    expect(firstBatch).toBeLessThanOrEqual(rows.length);

    // Scroll a later card into view and let it dwell -- more attempts appear.
    await cards(page).last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    expect(impressions(posts).length).toBeGreaterThan(firstBatch);

    // Every attempt names a real property and the 'search' source (the
    // main-grid convention shared with its own click events).
    impressions(posts).forEach(e => {
      expect(rows.some(r => r.id === e.property_id)).toBe(true);
      expect(e.source).toBe('search');
    });
    expect(errors).toEqual([]);
  });

  test('a card that leaves the viewport before the 500ms dwell completes is never attempted', async ({ page }) => {
    const rows = [listing(1)];
    // A tall spacer pushes the single card below the fold so it can be
    // scrolled into and immediately back out of view within the dwell window.
    const { posts } = await mount(page, rows);
    await page.evaluate(() => {
      var spacer = document.createElement('div');
      spacer.style.cssText = 'height:2000px;';
      document.getElementById('listings-container').parentNode.insertBefore(spacer, document.getElementById('listings-container'));
    });
    await cards(page).first().scrollIntoViewIfNeeded();
    // Immediately scroll back away, well inside the 500ms dwell window.
    await page.evaluate(() => window.scrollTo(0, 0));
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
    expect(impressions(posts)).toHaveLength(1); // still just the one attempt
  });

  test('impression tracking does not change or duplicate existing click tracking', async ({ page }) => {
    const rows = [listing(1)];
    const { posts } = await mount(page, rows);
    const card = cards(page).first();
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    expect(impressions(posts)).toHaveLength(1);

    // The click handler's fetch(keepalive) fires synchronously before the
    // browser acts on the link's default navigation -- aborting the
    // navigation request itself (rather than ctrl-clicking) keeps the test
    // on this page without affecting when the tracking POST is sent.
    await page.route('**/listing.html*', (r) => r.abort());
    await card.click();
    await page.waitForTimeout(200);
    expect(clicks(posts)).toHaveLength(1);
    expect(clicks(posts)[0].property_id).toBe('id-1');
    expect(clicks(posts)[0].source).toBe('search');
    // Clicking never itself produces a second impression attempt.
    expect(impressions(posts)).toHaveLength(1);
  });
});

test.describe('main grid: mobile viewport', () => {
  test.use({ viewport: { width: 375, height: 700 }, hasTouch: true, isMobile: true });

  test('a full-width mobile card still attempts an impression once scrolled into view', async ({ page }) => {
    const rows = [listing(1), listing(2), listing(3)];
    const { errors, posts } = await mount(page, rows);
    await cards(page).last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    expect(impressions(posts).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
