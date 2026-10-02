// Listing-card links keep the visitor's current language — in the real pages.
//
// A card link without ?lang= is what a visitor copies or shares, and the
// Cloudflare Worker builds the WhatsApp/Facebook link preview from ?lang= alone
// (absent == Lao), so an English browser's shared card link used to unfurl in
// Lao. components.js's _ptListingHref(p, lang) now appends &lang= after the
// slug; the pure function is covered by /listing-card-href.test.js, this drives
// the real pages that call it:
//   - listings.html  : the grid cards (renderPropertyCard)
//   - listing.html   : the Similar Properties cards (renderPropertyPreview)
// and the language switch, which must re-point the links rather than leave the
// previous language's URLs behind.
const { test, expect } = require('@playwright/test');

// Desktop viewport: the language buttons live in the nav.
test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

function property(o) {
  return Object.assign({
    id: 'p-' + String(o.slug).length + '-' + o.slug.charCodeAt(0), slug: o.slug, status: 'active', workflow_status: 'active', market_status: 'available',
    transaction_type: 'for_rent', property_type: 'apartment',
    title_en: 'English ' + o.slug, title_lo: 'Lao ' + o.slug, title_zh: 'Zh ' + o.slug,
    district_en: 'Sisattanak', district_lo: 'Sisattanak', district_zh: 'Sisattanak',
    village_en: 'Thongkang', images: [], features: [], amenities: [],
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450 / month',
    bedrooms: 1, bathrooms: 1, sqm: 40, created_at: '2026-08-01T00:00:00Z', contacts: null, parties: null, unit_types: [],
  }, o);
}
const SLUGS = ['river-view-apartment-111', 'café-garden-house-222', 'plain-slug-333'];
const FIXTURES = SLUGS.map((s) => property({ slug: s }));

async function stubCommon(page) {
  await page.route('**cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**unpkg.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
}

async function openListings(page, query) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await stubCommon(page);
  await page.route('**/rest/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route((u) => /\/rest\/v1\/properties\?/.test(u.toString()), (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES) }));
  await page.goto('/listings.html' + query);
  await page.waitForSelector('.pt-card', { timeout: 15000 });
  return errors;
}

const cardHrefs = (page) => page.$$eval('#listings-container a.pt-card', (as) => as.map((a) => a.getAttribute('href')));
const langOf = (href) => new URL(href, 'https://pintag.io/').searchParams.get('lang');
const slugOf = (href) => new URL(href, 'https://pintag.io/').searchParams.get('slug');

test.describe('listings.html grid cards', () => {
  test('English page -> every card URL carries lang=en', async ({ page }) => {
    const errors = await openListings(page, '?lang=en');
    const hrefs = await cardHrefs(page);
    expect(hrefs.length).toBe(SLUGS.length);
    for (const h of hrefs) expect(langOf(h)).toBe('en');
    expect(errors).toEqual([]);
  });

  test('Lao page -> every card URL carries lang=lo', async ({ page }) => {
    const errors = await openListings(page, '?lang=lo');
    const hrefs = await cardHrefs(page);
    expect(hrefs.length).toBe(SLUGS.length);
    for (const h of hrefs) expect(langOf(h)).toBe('lo');
    expect(errors).toEqual([]);
  });

  test('existing slug behaviour is intact: same page, slug is the FIRST param, encoded as before, language appended after', async ({ page }) => {
    await openListings(page, '?lang=en');
    const hrefs = await cardHrefs(page);
    expect(hrefs.slice().sort()).toEqual(SLUGS.map((s) => 'listing.html?slug=' + encodeURIComponent(s) + '&lang=en').sort());
    expect(hrefs.map(slugOf).sort()).toEqual(SLUGS.slice().sort());
    // The scroll-restore reader (listings.html _ptRestoreScrollPosition) finds the card by /[?&]slug=([^&]+)/.
    for (const [i, s] of SLUGS.entries()) {
      const h = hrefs.find((x) => decodeURIComponent(/[?&]slug=([^&]+)/.exec(x)[1]) === s);
      expect(h, 'card for ' + s + ' is still found by the slug reader (index ' + i + ')').toBeTruthy();
    }
  });

  test('switching language re-points the card URLs (en -> lo -> en), nothing stays stale', async ({ page }) => {
    const errors = await openListings(page, '?lang=en');
    expect((await cardHrefs(page)).every((h) => langOf(h) === 'en')).toBe(true);

    await page.click('.lang-btn[data-lang="lo"]');
    await expect.poll(async () => (await cardHrefs(page)).map(langOf)).toEqual(SLUGS.map(() => 'lo'));
    // the page itself really switched, i.e. this is the real language switch and not a stale render
    await expect(page.locator('.lang-btn[data-lang="lo"]')).toHaveClass(/active/);

    await page.click('.lang-btn[data-lang="en"]');
    await expect.poll(async () => (await cardHrefs(page)).map(langOf)).toEqual(SLUGS.map(() => 'en'));
    await expect(page.locator('.lang-btn[data-lang="en"]')).toHaveClass(/active/);
    expect(errors).toEqual([]);
  });

  test('clicking a card opens the listing page in the SAME language', async ({ page }) => {
    await openListings(page, '?lang=en');
    await page.route('**/rest/v1/properties?slug=eq.*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FIXTURES[2]]) }));
    await Promise.all([page.waitForURL(/listing\.html\?slug=plain-slug-333&lang=en/), page.locator('a.pt-card[href*="plain-slug-333"]').first().click()]);
    await expect(page.locator('.lang-btn[data-lang="en"]')).toHaveClass(/active/);
  });
});

test.describe('listing.html Similar Properties cards', () => {
  const MAIN = property({ slug: 'main-listing-000', id: 'main-id', property_type: 'apartment' });
  const SIMILAR = [property({ slug: 'similar-one-001' }), property({ slug: 'similar-two-002' })];

  async function openListing(page, lang) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await stubCommon(page);
    await page.route('**/rest/v1/**', (r) => {
      const u = r.request().url();
      const json = (d) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
      if (u.includes('/rpc/')) return json({});
      if (u.includes('property_type=eq.')) return json(SIMILAR);      // fetchSimilarProperties()
      if (u.includes('slug=eq.')) return json([MAIN]);                // the listing itself
      return json([]);
    });
    await page.route('**/functions/v1/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.goto('/listing.html?slug=' + MAIN.slug + '&lang=' + lang);
    await page.waitForSelector('#similar-grid a.pt-preview', { timeout: 20000 });
    return errors;
  }
  // The stub answers every similarity tier with the same rows, so the grid can hold repeats; compare the distinct links.
  const simHrefs = (page) => page.$$eval('#similar-grid a.pt-preview', (as) => Array.from(new Set(as.map((a) => a.getAttribute('href')))).sort());

  test('English listing page -> similar cards carry lang=en', async ({ page }) => {
    await openListing(page, 'en');
    expect(await simHrefs(page)).toEqual(SIMILAR.map((p) => 'listing.html?slug=' + p.slug + '&lang=en').sort());
  });

  test('Lao listing page -> similar cards carry lang=lo', async ({ page }) => {
    await openListing(page, 'lo');
    expect(await simHrefs(page)).toEqual(SIMILAR.map((p) => 'listing.html?slug=' + p.slug + '&lang=lo').sort());
  });

  test('switching the listing page language re-points the similar cards', async ({ page }) => {
    const errors = await openListing(page, 'en');
    await page.click('.lang-btn[data-lang="lo"]');
    await expect.poll(async () => (await simHrefs(page)).map(langOf)).toEqual(['lo', 'lo']);
    expect((await simHrefs(page)).map(slugOf)).toEqual(SIMILAR.map((p) => p.slug).sort());
    await page.click('.lang-btn[data-lang="en"]');
    await expect.poll(async () => (await simHrefs(page)).map(langOf)).toEqual(['en', 'en']);
    expect(errors).toEqual([]);
  });
});
