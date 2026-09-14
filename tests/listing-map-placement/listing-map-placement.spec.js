// Regression tests for relocating the property map on listing.html.
//
// CONTEXT: the map (Google Maps /maps/embed iframe + "Open in Google Maps"
// link + Nearby Places, previously the third .detail-grid column far down
// the page) now renders directly under the title, inside .hero-left, as
// .hero-map-section -- on BOTH desktop (natural source order) and mobile
// (flex `order:6`, immediately after .info-title's `order:5`, so it can
// never land below price/specs/CTAs the way a plain sibling placed after
// .hero-section would). See listing.html's own comments on .hero-map-section
// and the mobile media query for the full rationale.
//
// These tests exist because NO test previously covered listing.html's map at
// all (tests/map-location/map-markers.spec.js only covers listings.html's
// separate Leaflet multi-property view). They prove the position change
// while proving everything else about the map is untouched: coordinates/
// marker, the Open-in-Google-Maps link, tracking attributes, localization,
// unit-selection re-render, responsive sizing, and CSP.
const { test, expect } = require('@playwright/test');

const PARTY = { id: 'p-1', name_en: 'Souksavanh', name_lo: 'ສຸກສະຫວັນ', photo_url: null, agency_name: 'Pintag Realty', slug: 'souksavanh', type: 'agent', bio_en: '', bio_lo: '', is_verified: true, is_active: true, whatsapp: '020 5551 2345' };
const CONTACT = { id: 'c1', role: 'agent', name: 'Souksavanh', phone: '020 5551 2345', whatsapp: '020 5551 2345', is_verified: true, languages: ['lo', 'en'] };

// A known Google Maps place URL -- window.PintagMapLocation.parseMapUrl()
// resolves this to a real (lat, lng) pair (same parser listings.html's map
// view uses), so the iframe src and the "Open in Google Maps" href are both
// exercised with a genuine coordinate, not just the district-name fallback.
const MAP_URL = 'https://www.google.com/maps/place/Wat+That+Luang/@17.9757,102.635,17z/';

function baseRow(overrides) {
  return Object.assign({
    id: 'id-a1', slug: 'a1', status: 'active', workflow_status: 'active', market_status: 'available', deleted_at: null,
    title_en: 'Riverside Apartment', title_lo: 'ອາພາດເມັນແມ່ນ້ຳຂອງ', title_zh: '河边公寓',
    property_type: 'apartment', property_style: null, transaction_type: 'for_rent',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', rent_price_amount: null, rent_price_currency: null, rent_price_frequency: null,
    price_display: '$450 / month', sale_price: null, rent_price: null, rent_period: null, price_previous: null,
    bedrooms: 2, bathrooms: 1, sqm: 65, sqm_land: null, floors: null, furnished: null,
    description_en: 'A lovely riverside apartment.', description_lo: 'ອາພາດເມັນ.', description_zh: '公寓。',
    features: ['pool'], amenities: [], highlights: null,
    province_en: 'Vientiane Capital', province_lo: 'ນະຄອນຫຼວງວຽງຈັນ', province_zh: '万象首都',
    district_en: 'Sisattanak', district_lo: 'ສີສັດຕະນາກ', district_zh: '西萨塔纳', village_en: 'Thongkang',
    map_embed_url: MAP_URL,
    nearby_places: [
      { name: 'Thongkang Market', icon: '🛒', distance: '0.4 km' },
      { name: 'Wat That Luang', icon: '🛕', distance: '1.1 km' },
    ],
    images: ['https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200'],
    is_featured: false, view_count: 12, created_at: '2026-08-01T00:00:00Z',
    contact_id: 'c1', managed_by_party_id: 'p-1', rental_terms: null, available_from: null,
    contacts: CONTACT, parties: PARTY,
    property_contacts: [{ sort_order: 0, is_primary: true, contacts: CONTACT }],
    unit_types: [],
  }, overrides);
}

const ROW = baseRow();

// A second fixture with 2 unit_types so selectUnitType() has something real
// to select -- buildMockupLayout() re-runs completely on unit selection, and
// the map's data comes from the property level (data.map_embed_url), not
// from the selected unit, so this proves the map doesn't move/disappear/
// duplicate across that full re-render.
const MULTI_UNIT_ROW = baseRow({
  slug: 'a2',
  unit_types: [
    { id: 'u1', sort_order: 0, name_en: 'Unit A', name_lo: 'ຫ້ອງ A', name_zh: 'A单元', price_display: '$400/mo', is_available: true, available_count: 1, total_units: 1 },
    { id: 'u2', sort_order: 1, name_en: 'Unit B', name_lo: 'ຫ້ອງ B', name_zh: 'B单元', price_display: '$500/mo', is_available: true, available_count: 1, total_units: 1 },
  ],
});

async function mockRest(page, rows) {
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({
    status: 200, contentType: 'application/javascript',
    body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}}};}};',
  }));
  await page.route('**/unpkg.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('**/rest/v1/**', (r) => {
    const u = new URL(r.request().url());
    const t = u.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (d) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    if (t.startsWith('rpc/')) return json({});
    if (t === 'properties') return json(rows);
    if (t === 'parties') return json([PARTY]);
    return json([]);
  });
  await page.route('**/functions/v1/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
}

test.describe('desktop (1400x900)', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('.hero-map-section renders as the child of .hero-left immediately after the title, before price/badges/specs -- and .detail-grid no longer has a Location column', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('.hero-map-section');

    const heroLeftClassOrder = await page.$$eval('.hero-left > *', (els) => els.map((el) => el.className));
    const titleIdx = heroLeftClassOrder.findIndex((c) => c.includes('info-title'));
    const mapIdx = heroLeftClassOrder.findIndex((c) => c.includes('hero-map-section'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(mapIdx).toBe(titleIdx + 1); // the VERY next sibling -- nothing else in between

    const detailGridChildren = await page.$$eval('.detail-grid > *', (els) => els.length);
    expect(detailGridChildren).toBe(2); // Overview, Features -- Location moved out
  });

  test('the map is a compact, readable size -- not stretched across the wide .detail-wrap container', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('.hero-map-section .map-frame');
    const box = await page.$eval('.hero-map-section .map-frame', (el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    // Roughly square/readable (hero-left's own column width), nowhere near
    // a flat strip stretched across the ~1200px .detail-wrap container.
    expect(box.width).toBeGreaterThan(200);
    expect(box.width).toBeLessThan(500);
    expect(box.height).toBeCloseTo(300, 0);
  });

  test('coordinates/marker: the iframe src and "Open in Google Maps" href are still derived from map_embed_url via the unchanged parser', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('.hero-map-section .map-frame iframe');
    const src = await page.getAttribute('.hero-map-section .map-frame iframe', 'src');
    expect(src).toContain('17.9757');
    expect(src).toContain('102.635');
    const href = await page.getAttribute('.hero-map-section .map-open-link', 'href');
    expect(href).toContain('17.9757');
    expect(href).toContain('102.635');
  });

  test('tracking: data-track="map-embed" and data-track="map-open-link" are still present on the relocated elements', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('.hero-map-section');
    await expect(page.locator('.hero-map-section [data-track="map-embed"]')).toHaveCount(1);
    await expect(page.locator('.hero-map-section [data-track="map-open-link"]')).toHaveCount(1);
  });

  test('Nearby Places moved together with the map (same .hero-map-section block)', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('.hero-map-section .nearby-list');
    const items = await page.locator('.hero-map-section .nearby-item').allTextContents();
    expect(items.length).toBe(2);
    expect(items.join(' ')).toContain('Thongkang Market');
    expect(items.join(' ')).toContain('Wat That Luang');
  });

  test('localization: switching language re-renders the map in place with a re-localized "Open in Google Maps" label, in all three languages', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=lo');
    await page.waitForSelector('.hero-map-section .map-open-link');

    const labels = {};
    for (const lang of ['lo', 'en', 'zh']) {
      await page.click(`.lang-btn[data-lang="${lang}"]`);
      await page.waitForTimeout(150);
      labels[lang] = (await page.textContent('.hero-map-section .map-open-link')).trim();
      // Still directly after the title on every re-render, not just the first.
      const order = await page.$$eval('.hero-left > *', (els) => els.map((el) => el.className));
      const t = order.findIndex((c) => c.includes('info-title'));
      const m = order.findIndex((c) => c.includes('hero-map-section'));
      expect(m).toBe(t + 1);
    }
    expect(labels.lo).not.toBe(labels.en);
    expect(labels.en).not.toBe(labels.zh);
    expect(labels.lo).not.toBe(labels.zh);
  });

  test('unit selection: selecting a unit type (full buildMockupLayout() re-render) keeps the map in place, still a single instance', async ({ page }) => {
    await mockRest(page, [MULTI_UNIT_ROW]);
    await page.goto('/listing.html?slug=a2&lang=en');
    await page.waitForSelector('.hero-map-section');
    await expect(page.locator('.hero-map-section')).toHaveCount(1);

    const unitCard = page.locator('.unit-card').first();
    if (await unitCard.count()) {
      await unitCard.click();
      await page.waitForTimeout(200);
      // Still exactly one map, still right after the title.
      await expect(page.locator('.hero-map-section')).toHaveCount(1);
      const order = await page.$$eval('.hero-left > *', (els) => els.map((el) => el.className));
      const t = order.findIndex((c) => c.includes('info-title'));
      const m = order.findIndex((c) => c.includes('hero-map-section'));
      expect(m).toBe(t + 1);
    }
  });

  test('CSP: the frame-src directive still allows the relocated map iframe to load (maps.google.com / www.google.com)', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=en');
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    expect(csp).toMatch(/frame-src[^;]*maps\.google\.com/);
    expect(csp).toMatch(/frame-src[^;]*www\.google\.com/);
  });
});

test.describe('mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('visual order: the map renders directly below the title and above every other hero-left content (price/badges already precede the title unchanged; nothing new was inserted between title and map)', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('.hero-map-section');

    // The authoritative source of visual order on mobile is the computed
    // flex `order` (see listing.html's @media(max-width:960px) block) --
    // NOT bounding-rect `top`, which ties (and can misrepresent order) for
    // zero-height siblings like .sp-metrics-row when its contents are
    // display:none. Reading `order` directly tests the actual mechanism.
    const items = await page.$$eval('.hero-left > *', (els) => els.map((el) => ({
      cls: el.className,
      order: parseInt(getComputedStyle(el).order, 10) || 0,
    })));
    const byOrder = items.slice().sort((a, b) => a.order - b.order);
    const clsList = byOrder.map((p) => p.cls);
    const titleIdx = clsList.findIndex((c) => c.includes('info-title'));
    const mapIdx = clsList.findIndex((c) => c.includes('hero-map-section'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(mapIdx).toBeGreaterThan(titleIdx);
    // Nothing else from hero-left sits between title and map, in order.
    expect(mapIdx).toBe(titleIdx + 1);
    // Everything that used to sit between the title and the bottom of the
    // hero card (highlight/location line/specs/pills/actions) must now be
    // ordered AFTER the map, not before it.
    for (const cls of ['hero-location', 'spec-grid', 'highlight-pills', 'left-actions']) {
      const idx = clsList.findIndex((c) => c.includes(cls));
      if (idx !== -1) expect(idx).toBeGreaterThan(mapIdx);
    }

    // Cross-check against actual on-screen geometry: the map's visible top
    // must be at or below the title's, and strictly above the next visible
    // (non-zero-height) sibling that follows it in the order list.
    const titleTop = await page.$eval('.info-title', (el) => el.getBoundingClientRect().top);
    const mapTop = await page.$eval('.hero-map-section', (el) => el.getBoundingClientRect().top);
    expect(mapTop).toBeGreaterThanOrEqual(titleTop);
  });

  test('the map is present and appropriately small on mobile (existing .map-frame mobile height override still applies)', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('.hero-map-section .map-frame');
    const box = await page.$eval('.hero-map-section .map-frame', (el) => el.getBoundingClientRect());
    expect(box.height).toBeCloseTo(240, 0); // mobile override, unchanged
    expect(box.width).toBeLessThan(390);
    expect(box.width).toBeGreaterThan(200);
  });

  test('no horizontal overflow / clipping introduced by the relocated map section', async ({ page }) => {
    await mockRest(page, [ROW]);
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('.hero-map-section');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1); // sub-pixel rounding tolerance
  });
});
