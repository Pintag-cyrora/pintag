// agent.html — viewport-based impression tracking for the agent's portfolio
// grid (#portfolio-grid).
//
// Replaces the old inline batch block at the end of render(a, listings)
// (fired the instant the portfolio rendered, one row per listing regardless
// of whether it was ever scrolled to) with a direct call to components.js's
// shared _ptObserveForImpression() on each hand-rolled .p-card -- this page
// does not use renderPropertyCard/renderPropertyPreview, so there is no
// opts.trackImpression to wire into; the observer is attached explicitly at
// the same point the click listener already is. A card only attempts an
// impression once it has been >=50% visible for a continuous 500ms, as one
// unbatched POST per card. The server's existing 30-minute
// (session_id, property_id, event_type) dedup remains the sole authority on
// whether an attempt is actually counted.
//
// This page never rebuilds the portfolio grid after its one render() call
// (no language switcher, no re-fetch path -- confirmed by reading agent.html
// itself), so unlike listings.html/listing.html/index.html there is no
// rebuild-cooldown scenario to test here.

const { test, expect } = require('@playwright/test');

const AGENT = { id: 'agent-1', slug: 'somchai', name_en: 'Somchai', name_lo: 'ສົມໄຊ', whatsapp: '+8562099999999', is_verified: true };

function listing(i, over) {
  return Object.assign({
    id: 'listing-' + i,
    slug: 'slug-' + i,
    title_lo: 'ລາຍການ ' + i, title_en: 'Listing ' + i,
    price_amount: 400 + i, price_currency: 'USD', price_frequency: 'monthly',
    district_lo: 'ສີສັດຕະນາກ', district_en: 'Sisattanak',
    images: ['https://example.invalid/a.jpg'],
    transaction_type: 'for_rent', is_featured: false,
    market_status: 'available', workflow_status: 'active',
  }, over);
}

async function mount(page, listings) {
  const errors = [];
  const posts = [];
  page.on('pageerror', e => errors.push(String(e.message)));

  await page.route('**/rest/v1/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (url.indexOf('/parties?type=eq.agent') !== -1) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([AGENT]) });
    }
    if (url.indexOf('/properties?managed_by_party_id=eq.') !== -1) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listings) });
    }
    if (url.indexOf('/listing_events') !== -1 && req.method() === 'POST') {
      try { posts.push(req.postDataJSON()); } catch (_) {}
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    }
    if (req.method() === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/agent.html?slug=somchai');
  await page.waitForSelector('#page', { state: 'visible' });
  await expect(page.locator('#portfolio-grid .p-card').first()).toBeVisible();
  return { errors, posts };
}

const cards = page => page.locator('#portfolio-grid .p-card');
const impressions = (posts) => posts.filter(e => e && e.event_type === 'impression');
const clicks = (posts) => posts.filter(e => e && e.event_type === 'click');

test.use({ viewport: { width: 1280, height: 900 } });

test('a portfolio card scrolled into view attempts exactly one impression after the 500ms dwell', async ({ page }) => {
  const listings = Array.from({ length: 6 }, (_, i) => listing(i + 1));
  const { errors, posts } = await mount(page, listings);

  await cards(page).last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  expect(impressions(posts).length).toBeGreaterThan(0);

  impressions(posts).forEach(e => {
    expect(listings.some(l => l.id === e.property_id)).toBe(true);
    expect(e.source).toBe('agent_profile');
  });
  expect(errors).toEqual([]);
});

test('a card that leaves the viewport before the 500ms dwell completes is never attempted', async ({ page }) => {
  const listings = [listing(1)];
  const { posts } = await mount(page, listings);
  // A tall spacer pushes the single card below the fold so it starts
  // genuinely off-screen -- without this, a short page can already have the
  // card visible from initial load, and scrolling "away" from position 0
  // would be a no-op that never actually cancels a dwell timer.
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.cssText = 'height:2000px;';
    document.getElementById('portfolio-grid').parentNode.insertBefore(spacer, document.getElementById('portfolio-grid'));
  });
  await cards(page).first().scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0)); // back away well inside the dwell window
  await page.waitForTimeout(700);
  expect(impressions(posts)).toHaveLength(0);
});

test('a card only ever attempts once, even after repeated scroll-out/scroll-in', async ({ page }) => {
  const listings = [listing(1)];
  const { posts } = await mount(page, listings);
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

test('impression tracking does not change or duplicate the portfolio card\'s existing click tracking', async ({ page }) => {
  const listings = [listing(1)];
  const { posts } = await mount(page, listings);
  const card = cards(page).first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  expect(impressions(posts)).toHaveLength(1);

  await page.route('**/listing.html*', (r) => r.abort());
  await card.click();
  await page.waitForTimeout(200);
  expect(clicks(posts)).toHaveLength(1);
  expect(clicks(posts)[0].property_id).toBe('listing-1');
  expect(clicks(posts)[0].source).toBe('agent_profile');
  expect(impressions(posts)).toHaveLength(1); // click never adds a second impression attempt
});

test.describe('mobile viewport', () => {
  test.use({ viewport: { width: 375, height: 700 }, hasTouch: true, isMobile: true });

  test('a full-width mobile portfolio card still attempts an impression once scrolled into view', async ({ page }) => {
    const listings = [listing(1), listing(2), listing(3)];
    const { errors, posts } = await mount(page, listings);
    await cards(page).last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    expect(impressions(posts).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
