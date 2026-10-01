// listings.html map: named Google Maps PLACES vs exact pins vs broken links.
//
// A place (Google "Share place" link: ftid + label, no coordinates) is a real,
// identified location with nothing to draw. It must therefore be:
//   - kept OFF the coordinate marker layer (no marker, no district/centroid guess),
//   - counted separately from listings that have no usable location at all,
//   - and explained in its own notice, so a visitor can tell "no exact pin" apart
//     from "no location".
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

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
    await route.fulfill({
      status: 200,
      contentType: key.endsWith('.css') ? 'text/css' : 'application/javascript',
      body: fs.readFileSync(path.join(__dirname, 'node_modules', CDN_FILES[key]), 'utf8'),
    });
  });
}

const PLACE_ID = '0x3123456789abcdef:0x7f9e8d7c6b5a4f3e';
const SHARE = (name, id) => 'https://www.google.com/maps?q=' + encodeURIComponent(name) + '&ftid=' + id + '&entry=gps&g_ep=EgoyMDI2';

const FIXTURES = [
  { slug: 'exact-a', map_embed_url: 'https://www.google.com/maps?q=17.9585,102.5978' },
  { slug: 'exact-b', map_embed_url: 'https://www.google.com/maps?q=17.9757, 102.6331' },          // newer exact format
  { slug: 'place-a', map_embed_url: SHARE('Lao Plaza Hotel, Vientiane', PLACE_ID) },
  { slug: 'place-b', map_embed_url: SHARE('Sunrise Residence', '0x3123456789abcdef:0x1111111111111111') },
  { slug: 'no-link', map_embed_url: null },
  { slug: 'short-link', map_embed_url: 'https://maps.app.goo.gl/duPW1hq3Bb23EwPi7?g_st=ic' },
  { slug: 'generic-search', map_embed_url: 'https://www.google.com/maps?q=apartments+in+Vientiane' },
];

const row = (f) => ({
  id: f.slug, slug: f.slug, status: 'active', title_en: f.slug, title_lo: f.slug, title_zh: f.slug,
  district_en: 'Sisattanak', province_en: 'Vientiane Capital', listing_type: 'rent', property_type: 'apartment',
  price_amount: 500, price_currency: 'USD', price_frequency: 'month', price_display: '$500/mo',
  is_featured: false, images: [], map_embed_url: f.map_embed_url, contacts: null, parties: null, unit_types: [],
});

async function openMap(page, fixtures) {
  await serveCdnLocally(page);
  await page.route('**/rest/v1/properties**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify((fixtures || FIXTURES).map(row)),
  }));
  await page.route('**/tile.openstreetmap.org/**', (route) => route.fulfill({
    status: 200, contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  }));
  const infos = [], warnings = [], errors = [];
  page.on('console', (m) => { if (m.type() === 'info') infos.push(m.text()); if (m.type() === 'warning') warnings.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/listings.html');
  await page.waitForSelector('#listings-container .pt-card, #listings-container [data-slug]', { timeout: 15000 });
  await page.click('#btn-map');
  await page.waitForFunction(() => window._markers && window._markers.length > 0, null, { timeout: 15000 });
  return { infos, warnings, errors };
}

test('place-only listings get NO marker; exact listings (old and newer formats) still do', async ({ page }) => {
  const { errors } = await openMap(page);
  const markers = await page.evaluate(() => window._markers.map((m) => ({ slug: m._pintag.slug, lat: m.getLatLng().lat, lng: m.getLatLng().lng })));
  expect(markers.map((m) => m.slug).sort()).toEqual(['exact-a', 'exact-b']);
  const a = markers.find((m) => m.slug === 'exact-a'), b = markers.find((m) => m.slug === 'exact-b');
  expect(a.lat).toBeCloseTo(17.9585, 6); expect(a.lng).toBeCloseTo(102.5978, 6);
  expect(b.lat).toBeCloseTo(17.9757, 6); expect(b.lng).toBeCloseTo(102.6331, 6);
  // Nothing sits on the old hardcoded centre either: no place was "approximated".
  for (const m of markers) expect(Math.abs(m.lat - 17.960) + Math.abs(m.lng - 102.630)).toBeGreaterThan(0.001);
  expect(errors).toEqual([]);
});

test('places are counted SEPARATELY from listings with no usable location, each with its own notice', async ({ page }) => {
  const { infos, warnings } = await openMap(page);

  const place = page.locator('#map-place-notice');
  await expect(place).toBeVisible();
  await expect(place).toHaveAttribute('data-count', '2');
  await expect(place).toContainText('2 of 7');
  await expect(place).toContainText('named Google Maps place');
  await expect(place).toContainText('no exact coordinates');

  const unmapped = page.locator('#map-unmapped');
  await expect(unmapped).toBeVisible();
  await expect(unmapped).toContainText('3 of 7');                 // no-link + short-link + generic-search
  await expect(unmapped).not.toContainText('place');

  // The operator log separates them too: places are info, broken links are warnings.
  expect(infos.join('\n')).toContain('place-a');
  expect(infos.join('\n')).toContain('place-b');
  const w = warnings.join('\n');
  expect(w).toContain('no-link');
  expect(w).toContain('short-link');
  expect(w).toContain('generic-search');
  expect(w).not.toContain('place-a');
});

test('the two notices are distinguishable and do not overlap', async ({ page }) => {
  await openMap(page);
  const p = await page.locator('#map-place-notice').boundingBox();
  const u = await page.locator('#map-unmapped').boundingBox();
  expect(p && u).toBeTruthy();
  expect(p.y + p.height).toBeLessThanOrEqual(u.y + 1);            // stacked, not on top of each other
  expect(await page.locator('#map-place-notice').evaluate((e) => getComputedStyle(e).borderLeftWidth)).toBe('3px');
});

test('with no place listings the place notice stays hidden and the unmapped notice is unchanged', async ({ page }) => {
  await openMap(page, FIXTURES.filter((f) => !f.slug.startsWith('place-')));
  await expect(page.locator('#map-place-notice')).toBeHidden();
  await expect(page.locator('#map-place-notice')).toHaveAttribute('data-count', '0');
  await expect(page.locator('#map-unmapped')).toContainText('3 of 5');
});

test('with only places (no exact pins at all) nothing is plotted and no marker is invented', async ({ page }) => {
  await serveCdnLocally(page);
  await page.route('**/rest/v1/properties**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(FIXTURES.filter((f) => f.slug.startsWith('place-')).map(row)),
  }));
  await page.route('**/tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
  await page.goto('/listings.html');
  await page.waitForSelector('#listings-container .pt-card, #listings-container [data-slug]', { timeout: 15000 });
  await page.click('#btn-map');
  await expect(page.locator('#map-place-notice')).toBeVisible();
  await expect(page.locator('#map-place-notice')).toContainText('2 of 2');
  expect(await page.evaluate(() => (window._markers || []).length)).toBe(0);
  await expect(page.locator('#map-unmapped')).toBeHidden();
});

test('place notice follows the language switch (lo / zh)', async ({ page }) => {
  await openMap(page);
  await page.evaluate(() => setLang('zh', document.querySelector('.lang-btn[data-lang="zh"]')));
  await expect(page.locator('#map-place-notice')).toContainText('命名地点');
  await page.evaluate(() => setLang('lo', document.querySelector('.lang-btn[data-lang="lo"]')));
  await expect(page.locator('#map-place-notice')).toContainText('ສະຖານທີ່ທີ່ມີຊື່');
  await page.evaluate(() => setLang('en', document.querySelector('.lang-btn[data-lang="en"]')));
  await expect(page.locator('#map-place-notice')).toContainText('named Google Maps place');
});

test('a place label in the data cannot inject markup into the notice', async ({ page }) => {
  const evil = SHARE('<img src=x onerror=window.__pwned=1>', PLACE_ID);
  await openMap(page, [{ slug: 'exact-a', map_embed_url: 'https://www.google.com/maps?q=17.9585,102.5978' }, { slug: 'evil', map_embed_url: evil }]);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator('#map-place-notice img').count()).toBe(0);
});
