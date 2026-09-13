// Listing-card GALLERY ARROWS (left/right, cycling the card's own photo
// without opening the listing) -- drives the REAL listings.html with the
// REAL components.js renderPropertyCard() renderer, same pattern as
// listing-card-price.spec.js in this directory (real REST-query intercept,
// real DOM, real click()). Project default is a mobile (iPhone 13) viewport
// -- see playwright.config.js -- and the arrows have no responsive/media-
// query branching at all (always visible, no hover-reveal), so this single
// viewport already exercises the whole feature; one test near the bottom
// re-checks at a desktop width purely as a cross-check, matching the same
// "desktop viewport" describe-block precedent listing-card-price.spec.js
// already uses for its own FOMO-overlay tests.
const { test, expect } = require('@playwright/test');

let lastQuery = '';

function property(o) {
  return Object.assign({
    id: 'p-' + Math.abs(String(o.slug || 'x').split('').reduce((a, c) => a + c.charCodeAt(0), 0)),
    slug: o.slug || 'x', status: 'active', workflow_status: 'active', market_status: 'available',
    transaction_type: 'for_rent', property_type: 'apartment',
    title_en: 'T', title_lo: 'T', title_zh: 'T',
    district_en: 'Sisattanak', district_lo: 'Sisattanak', district_zh: 'Sisattanak',
    village_en: 'Thongkang', images: [], features: [], amenities: [],
    bedrooms: 1, bathrooms: 1, sqm: 40, created_at: '2026-08-01T00:00:00Z',
    contacts: null, parties: null, unit_types: []
  }, o);
}

const FIXTURES = [
  property({ slug: 'no-images', images: [] }),
  property({ slug: 'one-image', images: ['https://example.com/gallery/one-a.jpg'] }),
  property({ slug: 'three-images', images: [
    'https://example.com/gallery/three-a.jpg',
    'https://example.com/gallery/three-b.jpg',
    'https://example.com/gallery/three-c.jpg',
  ] }),
  // Same multi-image shape, but with real FOMO/heart context, to prove the
  // arrows coexist with both rather than covering or disabling them.
  property({ slug: 'multi-with-fomo', market_status: 'sold', images: [
    'https://example.com/gallery/fomo-a.jpg',
    'https://example.com/gallery/fomo-b.jpg',
  ] }),
];

async function openListings(page, query) {
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  await page.route('**cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**unpkg.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(u => /\/rest\/v1\/properties\?/.test(u.toString()), (r, req) => {
    lastQuery = req.url();
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES) });
  });
  await page.goto('/listings.html' + (query || ''));
  await page.waitForSelector('.pt-card', { timeout: 15000 });
  await revealAllCards(page);
  return errors;
}

async function revealAllCards(page) {
  let previous = -1;
  for (let i = 0; i < 20; i++) {
    const n = await page.locator('.pt-card').count();
    if (n === previous) break;
    previous = n;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(120);
  }
}

// renderPropertyCard() makes the CARD ITSELF the <a> (href="listing.html?slug=…"),
// so the card is not a container holding a link — it IS one.
const cardFor = (page, slug) => page.locator(`.pt-card[href*="slug=${slug}"]`).first();
const cardImgSrc = (page, slug) => cardFor(page, slug).locator('.pt-card-img > img').getAttribute('src');

test('arrows are absent when a listing has zero images', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'no-images');
  await expect(card.locator('.pt-card-arrow')).toHaveCount(0);
});

test('arrows are absent when a listing has exactly one image', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'one-image');
  await expect(card.locator('.pt-card-arrow')).toHaveCount(0);
  // The single photo itself is still rendered normally.
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /one-a\.jpg/);
});

test('arrows appear when a listing has 2+ images, one prev + one next, both real buttons', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'three-images');
  await expect(card.locator('.pt-card-arrow')).toHaveCount(2);
  await expect(card.locator('.pt-card-arrow-prev')).toHaveCount(1);
  await expect(card.locator('.pt-card-arrow-next')).toHaveCount(1);
  expect(await card.locator('.pt-card-arrow-prev').evaluate(el => el.tagName)).toBe('BUTTON');
  expect(await card.locator('.pt-card-arrow-next').evaluate(el => el.tagName)).toBe('BUTTON');
});

test('Next cycles forward through all three images and wraps back to the first', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'three-images');
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /three-a\.jpg/);
  await card.locator('.pt-card-arrow-next').click();
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /three-b\.jpg/);
  await card.locator('.pt-card-arrow-next').click();
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /three-c\.jpg/);
  await card.locator('.pt-card-arrow-next').click();
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /three-a\.jpg/);   // wrapped
});

test('Prev cycles backward and wraps to the LAST image from the first', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'three-images');
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /three-a\.jpg/);
  await card.locator('.pt-card-arrow-prev').click();
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /three-c\.jpg/);   // wrapped backward
  await card.locator('.pt-card-arrow-prev').click();
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /three-b\.jpg/);
});

test('src, alt, data-pt-original and the once-only fallback flag are all correctly updated on each step', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'three-images');
  const img = card.locator('.pt-card-img > img');

  // Simulate the FIRST photo already having fallen back once (as would
  // happen if it 404'd), then advance -- the guard must re-arm for the
  // newly shown photo rather than staying permanently tripped.
  await img.evaluate(el => { el.dataset.ptFellBack = '1'; });
  await card.locator('.pt-card-arrow-next').click();

  const state = await img.evaluate(el => ({
    src: el.getAttribute('src'),
    alt: el.getAttribute('alt'),
    original: el.getAttribute('data-pt-original'),
    fellBack: el.dataset.ptFellBack,
  }));
  expect(state.src).toMatch(/three-b\.jpg/);
  expect(state.alt).toBe('T');
  expect(state.original).toMatch(/three-b\.jpg/);
  expect(state.fellBack).toBeUndefined();
});

test('clicking an arrow does NOT navigate away from listings.html and does NOT fire the card\'s own click tracking', async ({ page }) => {
  const errs = await openListings(page);
  let listingEventsBody = null;
  await page.route('**/rest/v1/listing_events', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (Array.isArray(body) ? body.some(x => x.event_type === 'click') : body.event_type === 'click') {
      listingEventsBody = body;
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const card = cardFor(page, 'three-images');
  await card.locator('.pt-card-arrow-next').click();
  await page.waitForTimeout(300);
  expect(page.url()).toContain('/listings.html');
  expect(listingEventsBody).toBeNull();
  expect(errs).toEqual([]);
});

// ── ui_events tracking (tracking.js's existing declarative data-track
// delegate -- no manual postEvent call was added; these attributes are
// enough for the existing global click delegate to pick them up) ─────────
test('arrow clicks post separate ui_events rows (listing-card-photo-prev / -next), carrying the property id', async ({ page }) => {
  await openListings(page);
  const rows = [];
  await page.route('**/rest/v1/ui_events', (r) => {
    rows.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const card = cardFor(page, 'three-images');
  // The ARROW BUTTON itself carries data-track-property-id (written as a
  // literal HTML attribute, per this feature's own implementation) -- the
  // top-level .pt-card element's pre-existing dataTrack.propertyId is a
  // SEPARATE, unrelated mechanism (_ptApplyDataTrack's camelCase key gets
  // lowercased by setAttribute to "data-track-propertyid", no hyphen, so
  // tracking.js's own getAttribute('data-track-property-id') reader never
  // actually matches it on the card -- a pre-existing gap, untouched here).
  const propertyId = await card.locator('.pt-card-arrow-next').evaluate(el => el.getAttribute('data-track-property-id') || null);

  await card.locator('.pt-card-arrow-next').click();
  await page.waitForTimeout(50);
  await card.locator('.pt-card-arrow-prev').click();
  await page.waitForTimeout(50);

  expect(rows.length).toBe(2);
  expect(rows[0].element_id).toBe('listing-card-photo-next');
  expect(rows[0].element_type).toBe('button');
  expect(rows[1].element_id).toBe('listing-card-photo-prev');
  // The arrow buttons carry data-track-property-id directly (written as a
  // literal HTML attribute at render time), which is exactly the attribute
  // name/shape tracking.js's delegate reads.
  const idFromFixture = FIXTURES.find(f => f.slug === 'three-images').id;
  expect(propertyId).toBe(idFromFixture);
  expect(rows[0].property_id).toBe(idFromFixture);
  expect(rows[1].property_id).toBe(idFromFixture);
});

test('arrow clicks never appear as listing-card element_id (they are their own distinct tracked elements)', async ({ page }) => {
  await openListings(page);
  const rows = [];
  await page.route('**/rest/v1/ui_events', (r) => {
    rows.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await cardFor(page, 'three-images').locator('.pt-card-arrow-next').click();
  await page.waitForTimeout(50);
  expect(rows.every(r => r.element_id !== 'listing-card')).toBe(true);
});

// ── Coexistence with FOMO overlay + heart/save button ───────────────────
test('arrows, the FOMO overlay, and the heart button all coexist -- none disables another', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'multi-with-fomo');
  await expect(card.locator('.pt-card-arrow')).toHaveCount(2);
  await expect(card.locator('.pt-fomo-overlay')).toHaveCount(1);
  await expect(card.locator('.pt-heart-btn')).toHaveCount(1);

  // Cycling the photo does not remove or alter the FOMO overlay.
  await card.locator('.pt-card-arrow-next').click();
  await expect(card.locator('.pt-fomo-overlay')).toHaveCount(1);
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /fomo-b\.jpg/);

  // The heart button still toggles independently of the arrows.
  await expect(card.locator('.pt-heart-btn')).not.toHaveClass(/pt-saved/);
  await card.locator('.pt-heart-btn').click();
  await expect(card.locator('.pt-heart-btn')).toHaveClass(/pt-saved/);
});

test('the existing photo-count badge is unchanged by the arrows (still a static total, not a live position indicator)', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'three-images');
  await expect(card.locator('.photo-count')).toContainText('3');
  await card.locator('.pt-card-arrow-next').click();
  await card.locator('.pt-card-arrow-next').click();
  // Still "3" after cycling -- the badge is the TOTAL count, not a "2 / 3" position.
  await expect(card.locator('.photo-count')).toContainText('3');
});

// ── Keyboard accessibility ───────────────────────────────────────────────
test('arrow buttons are keyboard-focusable and activate on Enter, without navigating', async ({ page }) => {
  await openListings(page);
  const card = cardFor(page, 'three-images');
  await card.locator('.pt-card-arrow-next').focus();
  await expect(card.locator('.pt-card-arrow-next')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /three-b\.jpg/);
  expect(page.url()).toContain('/listings.html');
});

test('aria-labels are real localized text in English, Lao and Chinese (not left hardcoded/English-only)', async ({ page }) => {
  await openListings(page, '?lang=en');
  const cardEn = cardFor(page, 'three-images');
  expect(await cardEn.locator('.pt-card-arrow-prev').getAttribute('aria-label')).toBe('Previous photo');
  expect(await cardEn.locator('.pt-card-arrow-next').getAttribute('aria-label')).toBe('Next photo');

  await openListings(page, '?lang=lo');
  const cardLo = cardFor(page, 'three-images');
  const loPrev = await cardLo.locator('.pt-card-arrow-prev').getAttribute('aria-label');
  const loNext = await cardLo.locator('.pt-card-arrow-next').getAttribute('aria-label');
  expect(loPrev).not.toBe('Previous photo');
  expect(loNext).not.toBe('Next photo');
  expect(loPrev.length).toBeGreaterThan(0);

  await openListings(page, '?lang=zh');
  const cardZh = cardFor(page, 'three-images');
  const zhPrev = await cardZh.locator('.pt-card-arrow-prev').getAttribute('aria-label');
  expect(zhPrev).toMatch(/[一-鿿]/);
});

// ── Desktop cross-check -- the arrows have no responsive/media-query
// branching, so this only confirms the same behaviour holds at a wider
// viewport too, matching listing-card-price.spec.js's own precedent. ────
test.describe('desktop viewport', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('arrows are visible and cycle correctly at desktop width too', async ({ page }) => {
    await openListings(page);
    const card = cardFor(page, 'three-images');
    await expect(card.locator('.pt-card-arrow')).toHaveCount(2);
    await card.locator('.pt-card-arrow-next').click();
    await expect(card.locator('.pt-card-img > img')).toHaveAttribute('src', /three-b\.jpg/);
  });
});
