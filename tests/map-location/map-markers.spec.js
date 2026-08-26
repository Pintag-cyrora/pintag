// End-to-end: does the MAP actually put each marker where that listing's
// Google Maps link points?
//
// The unit tests prove the parser. They cannot prove the page uses it, reads
// the right column, or refrains from inventing a position — and every one of
// those was the actual defect. So this drives the real listings.html in a real
// browser with a stubbed listings response, and reads the coordinates back out
// of Leaflet rather than trusting the code path.
//
// Six listings at six real, widely-separated Vientiane locations, each
// expressed in a DIFFERENT Google Maps URL shape, plus three that must not be
// mapped at all.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Leaflet and its cluster plugin ship from unpkg in production. Fetching them
// over the network here would make the suite depend on a third party being up,
// so the exact pinned versions are installed as devDependencies and served in
// their place. Same files, same versions — only the transport changes.
const CDN_FILES = {
  'leaflet@1.9.4/dist/leaflet.js': 'leaflet/dist/leaflet.js',
  'leaflet@1.9.4/dist/leaflet.css': 'leaflet/dist/leaflet.css',
  'leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js': 'leaflet.markercluster/dist/leaflet.markercluster.js',
  'leaflet.markercluster@1.5.3/dist/MarkerCluster.css': 'leaflet.markercluster/dist/MarkerCluster.css',
};

async function serveCdnLocally(page) {
  await page.route('https://unpkg.com/**', async (route) => {
    const key = Object.keys(CDN_FILES).find((k) => route.request().url().includes(k));
    if (!key) return route.abort();
    const file = path.join(__dirname, 'node_modules', CDN_FILES[key]);
    await route.fulfill({
      status: 200,
      contentType: key.endsWith('.css') ? 'text/css' : 'application/javascript',
      body: fs.readFileSync(file, 'utf8'),
    });
  });
}

const FIXTURES = [
  // Patuxai — place URL. The @camera is deliberately 500m off the !3d/!4d pin,
  // so taking the camera instead of the pin is a visible, measurable failure.
  { slug: 'patuxai', lat: 17.9757, lng: 102.6180, district_en: 'Chanthabouly',
    map_embed_url: 'https://www.google.com/maps/place/Patuxai/@17.9800000,102.6250000,17z/' +
                   'data=!3m1!4b1!4m6!3m5!1s0x1!8m2!3d17.9757!4d102.6180!16s%2Fg%2F1' },
  // That Luang — embed URL: !2d is longitude FIRST. Transposing gives 102N.
  { slug: 'that-luang', lat: 17.9757, lng: 102.6488, district_en: 'Saysettha',
    map_embed_url: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3785!2d102.6488!3d17.9757!2m3!1f0' },
  // COPE Centre — plain ?q=
  { slug: 'cope-centre', lat: 17.9585, lng: 102.5978, district_en: 'Sisattanak',
    map_embed_url: 'https://www.google.com/maps?q=17.9585,102.5978' },
  // Wattay Airport — search API with a percent-encoded comma.
  { slug: 'wattay-airport', lat: 17.9883, lng: 102.5633, district_en: 'Sikhottabong',
    map_embed_url: 'https://www.google.com/maps/search/?api=1&query=17.9883%2C102.5633' },
  // Dongdok — camera-only URL, the one case where @ is the best available.
  { slug: 'dongdok', lat: 18.0433, lng: 102.7167, district_en: 'Xaythany',
    map_embed_url: 'https://www.google.com/maps/@18.0433,102.7167,16z' },
  // Thadeua Road, far south-east — proves the viewport follows the data
  // instead of framing a hardcoded city centre.
  { slug: 'thadeua', lat: 17.8869, lng: 102.7539, district_en: 'Hadxaifong',
    map_embed_url: 'https://www.google.com/maps/place/X/@17.8869,102.7539,17z/data=!4m2!3m1!8m2!3d17.8869!4d102.7539' },

  // ── Must NOT be mapped. Each of these produced a jittered MAP_CENTER pin. ──
  { slug: 'short-link-unresolved', district_en: 'Sisattanak',
    map_embed_url: 'https://maps.app.goo.gl/duPW1hq3Bb23EwPi7?g_st=ic' },
  { slug: 'no-link-at-all', district_en: 'Chanthabouly', map_embed_url: null },
  { slug: 'transposed', district_en: 'Saysettha',
    map_embed_url: 'https://www.google.com/maps?q=102.6113961,17.9615743' },
];

function row(f) {
  return {
    id: f.slug, slug: f.slug, status: 'active', title_en: f.slug, title_lo: f.slug, title_zh: f.slug,
    district_en: f.district_en, province_en: 'Vientiane Capital',
    listing_type: 'rent', property_type: 'apartment',
    price_amount: 500, price_currency: 'USD', price_frequency: 'month',
    price_display: '$500/mo', is_featured: false, images: [], map_embed_url: f.map_embed_url,
    contacts: null, parties: null, unit_types: []
  };
}

async function openMap(page) {
  await serveCdnLocally(page);
  await page.route('**/rest/v1/properties**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(FIXTURES.map(row))
    });
  });
  // Tiles are irrelevant to marker position and would be dozens of slow
  // third-party requests; a 1x1 PNG keeps Leaflet happy.
  await page.route('**/tile.openstreetmap.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }));

  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

  await page.goto('/listings.html');
  // allProperties is declared with `let`, which does not create a window
  // property — wait on rendered cards, which is what "data arrived" means to a
  // visitor anyway.
  await page.waitForSelector('#listings-container .pt-card, #listings-container [data-slug]', { timeout: 15000 });
  await page.click('#btn-map');
  await page.waitForFunction(() => window._markers && window._markers.length > 0, null, { timeout: 15000 });
  return warnings;
}

test('every mapped marker sits exactly on its own link’s coordinate', async ({ page }) => {
  await openMap(page);

  const placed = await page.evaluate(() =>
    window._markers.map((m) => ({
      slug: m._pintag.slug,
      lat: m.getLatLng().lat,
      lng: m.getLatLng().lng
    })));

  const expected = FIXTURES.filter((f) => f.lat !== undefined);
  expect(placed.length).toBe(expected.length);

  for (const f of expected) {
    const got = placed.find((p) => p.slug === f.slug);
    expect(got, `${f.slug} should be on the map`).toBeTruthy();
    // Exact, not "close enough". The old code was within ~600m of a hardcoded
    // point, so a tolerance test would have passed on the broken build.
    expect(got.lat, `${f.slug} latitude`).toBeCloseTo(f.lat, 6);
    expect(got.lng, `${f.slug} longitude`).toBeCloseTo(f.lng, 6);
  }
});

test('the place PIN beats the camera position when a URL carries both', async ({ page }) => {
  await openMap(page);
  const patuxai = await page.evaluate(() => {
    const m = window._markers.find((x) => x._pintag.slug === 'patuxai');
    return { lat: m.getLatLng().lat, lng: m.getLatLng().lng };
  });
  expect(patuxai.lat).toBeCloseTo(17.9757, 6);   // the !3d pin
  expect(patuxai.lng).toBeCloseTo(102.6180, 6);  // the !4d pin
  expect(patuxai.lat).not.toBeCloseTo(17.9800, 4); // NOT the @camera
});

test('an embed URL is not transposed — !2d is longitude', async ({ page }) => {
  await openMap(page);
  const tl = await page.evaluate(() => {
    const m = window._markers.find((x) => x._pintag.slug === 'that-luang');
    return { lat: m.getLatLng().lat, lng: m.getLatLng().lng };
  });
  expect(tl.lat).toBeCloseTo(17.9757, 6);
  expect(tl.lng).toBeCloseTo(102.6488, 6);
});

test('listings without a usable link get NO marker, and are reported', async ({ page }) => {
  const warnings = await openMap(page);

  const slugs = await page.evaluate(() => window._markers.map((m) => m._pintag.slug));
  for (const missing of ['short-link-unresolved', 'no-link-at-all', 'transposed']) {
    expect(slugs, `${missing} must not be plotted`).not.toContain(missing);
  }

  // Visible to the visitor, so the map cannot silently under-report.
  const notice = page.locator('#map-unmapped');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('3 of 9');

  // And actionable for the operator.
  const joined = warnings.join('\n');
  expect(joined).toContain('unresolved-short-link');
  expect(joined).toContain('reversed-coordinates');
  expect(joined).toContain('short-link-unresolved');
});

test('THE REGRESSION: no two markers share a jittered default position', async ({ page }) => {
  await openMap(page);
  const pts = await page.evaluate(() =>
    window._markers.map((m) => [m.getLatLng().lat, m.getLatLng().lng]));

  // Old behaviour: every marker within +/-0.006 deg of [17.960, 102.630].
  const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
  const spreadLat = Math.max(...lats) - Math.min(...lats);
  const spreadLng = Math.max(...lngs) - Math.min(...lngs);
  expect(spreadLat).toBeGreaterThan(0.02);
  expect(spreadLng).toBeGreaterThan(0.02);

  // And none of them may sit on the hardcoded centre.
  for (const [lat, lng] of pts) {
    expect(Math.abs(lat - 17.960) + Math.abs(lng - 102.630)).toBeGreaterThan(0.001);
  }
});

test('marker positions are stable across re-renders', async ({ page }) => {
  await openMap(page);
  const read = () => page.evaluate(() =>
    window._markers.map((m) => m._pintag.slug + ':' + m.getLatLng().lat + ',' + m.getLatLng().lng).sort());

  const first = await read();
  await page.evaluate(() => window.renderMap());   // what a filter change does
  const second = await read();
  // Math.random() in the old fallback moved every marker on every draw.
  expect(second).toEqual(first);
});

test('clustering groups markers without moving them', async ({ page }) => {
  await openMap(page);
  const before = await page.evaluate(() =>
    window._markers.map((m) => [m.getLatLng().lat, m.getLatLng().lng]));

  // Zoom out until the cluster group must collapse them.
  await page.evaluate(() => window._map.setZoom(11));
  await page.waitForTimeout(400);
  const clusters = await page.locator('.pt-cluster').count();
  expect(clusters).toBeGreaterThan(0);

  // The underlying coordinates are untouched — clustering is presentation.
  const after = await page.evaluate(() =>
    window._markers.map((m) => [m.getLatLng().lat, m.getLatLng().lng]));
  expect(after).toEqual(before);

  // Zoomed in past the threshold, individual price bubbles come back.
  await page.evaluate(() => window._map.setView([17.9757, 102.6180], 17));
  await page.waitForTimeout(400);
  expect(await page.locator('.price-bubble').count()).toBeGreaterThan(0);
});
