// listing.html location block: exact pin vs named Google Maps PLACE.
//
// Exact locations keep today's behaviour byte-for-byte (embedded map + link).
// A place has an identified location but NO coordinates, so the page must:
//   - say plainly that it is place-level (never imply an exact pin),
//   - draw no map and no marker (a name search embed cannot be guaranteed to land
//     on the right place, and there is no verified position to draw),
//   - keep the ORIGINAL Google Maps link as the destination.
const { test, expect } = require('@playwright/test');

const PARTY = { id: 'p-1', name_en: 'Souksavanh', name_lo: 'ສຸກສະຫວັນ', photo_url: null, agency_name: 'Pintag Realty', slug: 'souksavanh', type: 'agent', bio_en: '', bio_lo: '', is_verified: true, is_active: true, whatsapp: '020 5551 2345' };
const CONTACT = { id: 'c1', role: 'agent', name: 'Souksavanh', phone: '020 5551 2345', whatsapp: '020 5551 2345', is_verified: true, languages: ['lo', 'en'] };
const PLACE_ID = '0x3123456789abcdef:0x7f9e8d7c6b5a4f3e';
const PLACE_URL = 'https://www.google.com/maps?q=Lao+Plaza+Hotel,+23+Singha+Road,+Vientiane&ftid=' + PLACE_ID + '&entry=gps&g_ep=EgoyMDI2';
const EXACT_URL = 'https://www.google.com/maps/place/Wat+That+Luang/@17.9757,102.635,17z/';

function row(overrides) {
  return Object.assign({
    id: 'id-a1', slug: 'a1', status: 'active', workflow_status: 'active', market_status: 'available', deleted_at: null,
    title_en: 'Riverside Apartment', title_lo: 'ອາພາດເມັນແມ່ນ້ຳຂອງ', title_zh: '河边公寓',
    property_type: 'apartment', transaction_type: 'for_rent',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450 / month',
    bedrooms: 2, bathrooms: 1, sqm: 65,
    description_en: 'A lovely riverside apartment.', description_lo: 'ອາພາດເມັນ.', description_zh: '公寓。',
    features: ['pool'], amenities: [],
    province_en: 'Vientiane Capital', district_en: 'Sisattanak', district_lo: 'ສີສັດຕະນາກ', district_zh: '西萨塔纳', village_en: 'Thongkang',
    map_embed_url: EXACT_URL,
    nearby_places: [], images: ['https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200'],
    is_featured: false, view_count: 12, created_at: '2026-08-01T00:00:00Z',
    contact_id: 'c1', managed_by_party_id: 'p-1', rental_terms: null,
    contacts: CONTACT, parties: PARTY,
    property_contacts: [{ sort_order: 0, is_primary: true, contacts: CONTACT }],
    unit_types: [],
  }, overrides);
}

async function open(page, r, lang) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/cdn.jsdelivr.net/**', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript',
    body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}}};}};',
  }));
  await page.route('**/unpkg.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('**/rest/v1/**', (route) => {
    const t = new URL(route.request().url()).pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    if (t.startsWith('rpc/')) return json({});
    if (t === 'properties') return json([r]);
    if (t === 'parties') return json([PARTY]);
    return json([]);
  });
  await page.route('**/functions/v1/**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await page.goto('/listing.html?slug=' + r.slug + '&lang=' + (lang || 'en'));
  await page.waitForSelector('.hero-map-section');
  return errors;
}

test.use({ viewport: { width: 1400, height: 900 } });

test('EXACT: unchanged -- embedded map from the coordinates, link built from them, no place block', async ({ page }) => {
  const errors = await open(page, row());
  await expect(page.locator('.hero-map-section .map-frame iframe')).toHaveCount(1);
  expect(await page.getAttribute('.hero-map-section .map-frame iframe', 'src')).toContain('17.9757,102.635');
  expect(await page.getAttribute('.hero-map-section .map-open-link', 'href')).toBe('https://www.google.com/maps?q=17.9757,102.635');
  await expect(page.locator('.hero-map-section .map-place')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('EXACT via a newer format (?q=lat, lng) gets the same embedded map', async ({ page }) => {
  await open(page, row({ map_embed_url: 'https://www.google.com/maps?q=17.9757, 102.6331' }));
  expect(await page.getAttribute('.hero-map-section .map-frame iframe', 'src')).toContain('17.9757,102.6331');
  await expect(page.locator('.hero-map-section .map-place')).toHaveCount(0);
});

test('PLACE: a clear place-level state with the label, the preserved original link, and NO map or pin', async ({ page }) => {
  const errors = await open(page, row({ map_embed_url: PLACE_URL }));
  const block = page.locator('.hero-map-section .map-place[data-map-type="place"]');
  await expect(block).toBeVisible();
  await expect(block).toContainText('Google Maps place');
  await expect(block.locator('.map-place-name')).toHaveText('Lao Plaza Hotel, 23 Singha Road, Vientiane');
  await expect(block).toContainText('no exact coordinates');

  // The original Google Maps URL, byte-for-byte, is the destination.
  const link = block.locator('a.map-open-link');
  expect(await link.getAttribute('href')).toBe(PLACE_URL);
  expect(await link.getAttribute('target')).toBe('_blank');
  expect(await link.getAttribute('rel')).toContain('noopener');
  await expect(link).toContainText('Open in Google Maps');

  // No embedded map, no frame, no coordinates anywhere in the location block.
  await expect(page.locator('.hero-map-section iframe')).toHaveCount(0);
  await expect(page.locator('.hero-map-section .map-frame')).toHaveCount(0);
  const html = await page.locator('.hero-map-section').innerHTML();
  expect(html).not.toMatch(/\b\d{1,3}\.\d{4,}\s*,\s*\d{1,3}\.\d{4,}/);
  expect(errors).toEqual([]);
});

test('PLACE: tracking attributes stay on the link; there is no embed to track', async ({ page }) => {
  await open(page, row({ map_embed_url: PLACE_URL }));
  await expect(page.locator('.hero-map-section [data-track="map-open-link"]')).toHaveCount(1);
  await expect(page.locator('.hero-map-section [data-track="map-embed"]')).toHaveCount(0);   // there is no embed to track
});

test('PLACE without a label still shows the place-level state and the link', async ({ page }) => {
  await open(page, row({ map_embed_url: 'https://www.google.com/maps?ftid=' + PLACE_ID }));
  const block = page.locator('.hero-map-section .map-place');
  await expect(block).toBeVisible();
  await expect(block.locator('.map-place-name')).toHaveCount(0);
  await expect(block.locator('a.map-open-link')).toHaveAttribute('href', 'https://www.google.com/maps?ftid=' + PLACE_ID);
});

test('PLACE: lo and zh copy, and the label is escaped', async ({ page }) => {
  await open(page, row({ map_embed_url: PLACE_URL }), 'lo');
  await expect(page.locator('.hero-map-section .map-place-note')).toContainText('ບໍ່ມີພິກັດແນ່ນອນ');
  const page2 = await page.context().newPage();
  await open(page2, row({ map_embed_url: PLACE_URL }), 'zh');
  await expect(page2.locator('.hero-map-section .map-place-note')).toContainText('暂无精确坐标');

  const page3 = await page.context().newPage();
  const evil = 'https://www.google.com/maps?q=' + encodeURIComponent('<img src=x onerror=window.__pwned=1>') + '&ftid=' + PLACE_ID;
  await open(page3, row({ map_embed_url: evil }));
  expect(await page3.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page3.locator('.hero-map-section .map-place-name')).toHaveText('<img src=x onerror=window.__pwned=1>');
  expect(await page3.locator('.hero-map-section .map-place-name img').count()).toBe(0);
});

test('a generic search link is NOT presented as a place: it keeps the previous link-only fallback', async ({ page }) => {
  const url = 'https://www.google.com/maps?q=apartments+in+Vientiane';
  await open(page, row({ map_embed_url: url }));
  await expect(page.locator('.hero-map-section .map-place')).toHaveCount(0);
  await expect(page.locator('.hero-map-section iframe')).toHaveCount(0);
  expect(await page.getAttribute('.hero-map-section .map-open-link', 'href')).toBe(url);
});

test('no map link at all: unchanged district-search fallback, no place block', async ({ page }) => {
  await open(page, row({ map_embed_url: null }));
  await expect(page.locator('.hero-map-section .map-place')).toHaveCount(0);
  expect(await page.getAttribute('.hero-map-section .map-open-link', 'href')).toContain('google.com/maps/search/');
});
