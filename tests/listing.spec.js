import { test, expect } from '@playwright/test';

const SUPABASE_ORIGIN = 'https://eoladhcljbpbhnrmmpev.supabase.co';

const BASE_PROP = {
  id: 1,
  slug: 'test-villa',
  title_en: 'Test Villa',
  title_lo: 'Test Villa',
  title_zh: 'Test Villa',
  district_en: 'Sisattanak',
  district_lo: 'ສີສັດຕະນາກ',
  district_zh: '西萨塔纳克',
  transaction_type: 'for_sale',
  status: 'active',
  price_display: '$250,000',
  bedrooms: 3,
  bathrooms: 2,
  sqm: 150,
  images: [
    'https://example.com/photo1.jpg',
    'https://example.com/photo2.jpg',
    'https://example.com/photo3.jpg',
  ],
  agent_name: 'Jane Smith',
  agent_whatsapp: '8562012345678',
  agent_photo: null,
  amenities: ['pool', 'security', 'parking'],
  features: [
    { label_en: 'Modern kitchen', label_lo: 'ຄົວ', name: 'modern_kitchen' },
    { label_en: 'Air conditioning', label_lo: 'ແອ', name: 'air_conditioning' },
    { label_en: 'Garden', label_lo: 'ສວນ', name: 'garden' },
    { label_en: 'Balcony', label_lo: 'ລານ', name: 'balcony' },
  ],
  highlights: ['Embassy District', 'Near Schools'],
  nearby_places: [
    { name: 'Lycée Hoffet', icon: '🏫', distance: '0.3 km', category: 'school' },
    { name: 'Vientiane Center', icon: '🛍️', distance: '1.2 km', category: 'shopping' },
  ],
};

// Intercept all Supabase REST calls.
// `property` — object to return in the properties array, or null to simulate 404.
async function setupMocks(page, property) {
  await page.route(`${SUPABASE_ORIGIN}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/rest/v1/properties?slug=eq.')) {
      await route.fulfill({ json: property !== null ? [property] : [] });
    } else {
      // Similar-properties queries — always return empty to keep tests focused
      await route.fulfill({ json: [] });
    }
  });
}

// Navigate and wait until the layout has been injected into #view-target.
async function loadPage(page) {
  await page.goto('/listing.html?slug=test-villa');
  await page.waitForSelector('.info-title', { timeout: 10000 });
}

// Switch to English and wait for the layout to re-render.
async function switchToEnglish(page) {
  await page.locator('button.lang-btn', { hasText: 'EN' }).click();
  // buildMockupLayout is synchronous; a frame flush is enough.
  await page.waitForTimeout(50);
}

// ── title ────────────────────────────────────────────────────────────────

test('title renders from title_en', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  await expect(page.locator('.info-title')).toContainText('Test Villa');
});

// ── transaction badge ─────────────────────────────────────────────────────

test('For Sale badge renders for a for_sale property', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  await switchToEnglish(page);
  await expect(page.locator('.tx-badge')).toContainText('For Sale');
});

test('For Rent badge renders for a for_rent property', async ({ page }) => {
  await setupMocks(page, { ...BASE_PROP, transaction_type: 'for_rent' });
  await loadPage(page);
  await switchToEnglish(page);
  await expect(page.locator('.tx-badge')).toContainText('For Rent');
});

// ── price ─────────────────────────────────────────────────────────────────

test('price_display value renders in .price-value', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  await expect(page.locator('.price-value')).toContainText('$250,000');
});

test('"Price on request" element renders when price_display is null', async ({ page }) => {
  await setupMocks(page, { ...BASE_PROP, price_display: null });
  await loadPage(page);
  await expect(page.locator('.price-inquire')).toBeVisible();
});

// ── spec grid ─────────────────────────────────────────────────────────────

test('spec grid shows bedroom count', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  const specVals = page.locator('.spec-val');
  await expect(specVals.first()).toContainText('3');
});

test('spec grid shows bathroom count', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  const specVals = page.locator('.spec-val');
  await expect(specVals.nth(1)).toContainText('2');
});

// ── gallery ───────────────────────────────────────────────────────────────

test('hero gallery image has correct src', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  await expect(page.locator('#dg-hero-img')).toHaveAttribute('src', /example\.com\/photo1/);
});

test('desktop gallery renders one thumbnail per image with data-thumb-idx', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  // 3 images → 3 dg-thumb elements with data-thumb-idx (0, 1, 2)
  await expect(page.locator('.dg-thumb[data-thumb-idx]')).toHaveCount(3);
});

// ── agent ─────────────────────────────────────────────────────────────────

test('agent name renders in .agent-name-en', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  await expect(page.locator('.agent-name-en')).toContainText('Jane Smith');
});

test('WhatsApp button is visible and has correct href', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  const waBtn = page.locator('.btn-wa').first();
  await expect(waBtn).toBeVisible();
  await expect(waBtn).toHaveAttribute('href', /wa\.me\/8562012345678/);
});

// ── amenities ─────────────────────────────────────────────────────────────

test('amenity row renders exactly 3 amenity items', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  await expect(page.locator('.amenity-item')).toHaveCount(3);
});

// ── features ─────────────────────────────────────────────────────────────

test('features list renders exactly 4 feature items', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  await expect(page.locator('.feature-item')).toHaveCount(4);
});

// ── highlight pills ───────────────────────────────────────────────────────

test('highlight pills render exactly 2 pills', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  await expect(page.locator('.highlight-pill')).toHaveCount(2);
});

// ── nearby places ─────────────────────────────────────────────────────────

test('nearby places section renders exactly 2 items', async ({ page }) => {
  await setupMocks(page, BASE_PROP);
  await loadPage(page);
  await expect(page.locator('.nearby-item')).toHaveCount(2);
});

// ── error state ───────────────────────────────────────────────────────────

test('error state renders "Property not found" for a missing slug', async ({ page }) => {
  await setupMocks(page, null);
  await page.goto('/listing.html?slug=nonexistent');
  // showErrorState injects a <div> directly into #view-target
  await page.waitForSelector('#view-target > div', { timeout: 10000 });
  await expect(page.locator('#view-target')).toContainText('Property not found');
});
