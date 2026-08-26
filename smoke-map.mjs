#!/usr/bin/env node
// smoke-map.mjs — production verification of the map pin pipeline.
// TEMPORARY, scratch branch only. READ ONLY: loads the live site in a real
// browser and issues GETs. Writes nothing, anywhere.
//
// Proves the whole chain end to end on pintag.io:
//     Google Maps URL -> map-location.js -> exact Leaflet marker
//
// It reads marker positions back out of Leaflet rather than counting DOM
// elements, because the bug being verified produced the RIGHT NUMBER of
// markers in the WRONG PLACES. A count-based check passes on the broken build.
import { chromium, devices } from '@playwright/test';

const SITE = 'https://www.pintag.io';

// The 23 normalized coordinates, from the step-2 acceptance test against the
// deployed resolver (run 32830286455) and re-verified in the database at step 4
// (run 32839602478). Hard-coded so the browser's rendered position is compared
// against an external reference, not against whatever the page happens to say.
const EXPECTED = {
  'fully-furnished-2-bedroom-apartment-with-lake-view-702': '17.9498242,102.6207476',
  'fully-furnished-room-for-rent-in-dongpalane-chanthabou': '17.963348,102.622093',
  'modern-commercial-building-with-4-beds-5-baths-for-ren': '18.020651,102.630333',
  'fully-furnished-apartment-with-security-and-cleaning-s': '18.0210869,102.6144531',
  'newly-stylish-furnished-apartment-for-rent-near-xang-j': '17.982599,102.552406',
  'city-apartment-on-khouvieng-road-near-parkson-vis-pis-': '17.944559,102.621292',
  'modern-apartment-with-balcony-view-491048':              '17.969587,102.586769',
  'modern-2-bedroom-house-near-lycee-francais-internation': '17.9109834,102.6393497',
  'modern-studio-apartment-with-kitchenette-in-thongsangn': '17.982363,102.616463',
  'modern-3-bedroom-apartment-with-river-view':             '17.9609143,102.6177841',
  '1-bed-1-bath-apartment-for-rent-in-nongtha-239015':      '18.009935,102.607132',
  'lao-style-house-for-rent-in-thongkang-sisattanak-vient': '17.9400262,102.6277036',
  'prime-land-for-sale-in-phonkheng-saysettha-district-vi': '17.9844698,102.6342928',
  '3-bedroom-townhouse-with-balcony-and-commercial-space-': '17.970139,102.608978',
  'house-for-rent-in-thongpong-village-sikhottabong-distr': '17.987701,102.534904',
  '2-bedroom-apartment-with-traditional-furnishings-in-ph': '17.961309,102.637787',
  'spacious-multi-level-home-with-rooftop-terrace-near-me': '17.9516911,102.61817',
  'modern-5-bedroom-house-in-thongphanthong-with-spacious': '17.9515893,102.6339266',
  'tuscan-style-townhouse-with-3-4-bedrooms-384903':        '17.9943291,102.6459936',
  'newly-opened-fully-furnished-apartment-in-phakhaw-vill': '18.016321,102.639854',
  '1-bedroom-1-bathroom-apartment-in-phonthan-555453':      '17.95352,102.641167',
  'modern-1-bedroom-apartment-with-parking-in-hadxaifong-': '17.9112282,102.6324329',
  'modern-1-bedroom-apartment-with-weekly-housekeeping-82': '17.9114059,102.6310341',
};
// Already held a coordinate before this work; never a short link, never touched.
const PRE_EXISTING = { 'fully-furnished-apartment-with-balcony-166805': '17.9739606,102.5827581' };

const NAME_ONLY = [
  'modern-1-bedroom-apartment-with-kitchen-in-nongdouang',
  'fully-furnished-studio-apartment-with-pool-gym-293416',
  'modern-1-bedroom-apartment-with-balcony-in-nonwaiy',
  'fully-furnished-apartment-in-donkoy-village-904034',
  'modern-studio-apartment-for-rent-near-itecc',
  'service-townhouse-for-rent-in-phoensinuan-vientiane-ca',
];

const OLD_CENTER = [17.960, 102.630];   // the coordinate every marker used to sit on
// Only a real, data-backed card — never one of the page's loading skeletons.
const REAL_CARD = '#listings-container a.pt-card[href*="listing.html"]';

let fail = 0;
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const ok  = (m) => console.log(`  ✓ ${m}`);
const bust = (u) => `${u}${u.includes('?') ? '&' : '?'}cb=${Date.now()}${Math.floor(Math.random() * 1e6)}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Desktop Chrome'] });
const page = await ctx.newPage();

const errors = [], warnings = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (m.type() === 'warning') warnings.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
// A CDN script that never arrives produces no console error and no exception
// at the point of failure -- only a later "is not a function". Recording the
// failed request names the real cause instead of its symptom.
const failedRequests = [];
page.on('requestfailed', (r) => failedRequests.push(`${r.url().slice(0, 120)} — ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.url().slice(0, 120)} — HTTP ${r.status()}`); });

// ── 1. is the browser actually being served the NEW map-location.js? ────────
console.log('── 1. deployed artifact ────────────────────────────────');
const mlRes = await page.request.get(bust(`${SITE}/map-location.js`));
const mlBody = await mlRes.text();
console.log(`  GET /map-location.js -> ${mlRes.status()} ${mlBody.length} bytes`);
mlRes.status() === 200 ? ok('map-location.js is served') : bad(`map-location.js -> ${mlRes.status()}`);
// Fingerprints unique to the new file. A cached old artifact has none of them,
// because the file did not exist before this deploy.
for (const [what, needle] of [
  ['parseMapUrl export',      'parseMapUrl'],
  ['authority-ordered patterns', 'place-pin(!3d/!4d)'],
  ['refuses transposed pairs', 'reversed-coordinates'],
  ['short-link detection',     'unresolved-short-link'],
]) mlBody.includes(needle) ? ok(`served file has ${what}`) : bad(`served map-location.js is MISSING ${what} — stale artifact?`);

const lhBody = await (await page.request.get(bust(`${SITE}/listings.html`))).text();
const stamp = (lhBody.match(/\?v=([A-Za-z0-9]+)/) || [])[1];
console.log(`  listings.html asset stamp: ${stamp}`);
lhBody.includes('map-location.js') ? ok('listings.html loads map-location.js') : bad('listings.html does NOT reference map-location.js — stale artifact');
// The old broken source must be gone from what visitors receive. Comments are
// stripped first: listings.html explains the old defect in prose, and matching
// that prose would report a stale artifact where none exists.
const lhCode = lhBody.replace(/^\s*\/\/.*$/gm, '');
!/DISTRICT_COORDS/.test(lhCode) ? ok('DISTRICT_COORDS is gone from the served page') : bad('served listings.html STILL contains DISTRICT_COORDS — old artifact');
!/p\.map_url/.test(lhCode)      ? ok('p.map_url is gone from the served page')      : bad('served listings.html STILL reads p.map_url — old artifact');
/parseMapUrl\(\s*p\.map_embed_url\s*\)/.test(lhCode)
  ? ok('served page reads the coordinate through parseMapUrl(p.map_embed_url)')
  : bad('served page does NOT call parseMapUrl(p.map_embed_url) — old artifact');

// ── 2. open the real map ────────────────────────────────────────────────────
console.log('\n── 2. live map ─────────────────────────────────────────');
await page.goto(bust(`${SITE}/listings.html`), { waitUntil: 'domcontentloaded' });
// listings.html ships SIX static skeleton .pt-card placeholders so the grid
// does not jump when data arrives. Waiting on `.pt-card` therefore matches
// instantly, before a single listing has loaded — run 32977370252 clicked
// through to the map with allProperties still empty and read 0 markers, 0
// unmapped, which looks exactly like a broken map. A real card is an <a> with
// a listing href; a skeleton is an aria-hidden <div> with neither.
await page.waitForSelector(REAL_CARD, { timeout: 60000 });
// The first card can render before the rest of the page's listings do, so
// settle on a stable count rather than the first arrival.
let prevCount = -1;
for (let i = 0; i < 20; i++) {
  const n = await page.locator(REAL_CARD).count();
  if (n === prevCount && n > 0) break;
  prevCount = n;
  await page.waitForTimeout(500);
}
await page.click('#btn-map');
try {
  await page.waitForFunction(() => window._markers && window._markers.length > 0, null, { timeout: 40000 });
} catch {
  // "Timeout exceeded" names the symptom, not the cause. Every plausible cause
  // is observable from here, so report all of them rather than guessing.
  const d = await page.evaluate(() => ({
    leaflet:      typeof window.L,
    markerCluster: typeof (window.L && window.L.markerClusterGroup),
    parser:       typeof (window.PintagMapLocation && window.PintagMapLocation.parseMapUrl),
    mapCreated:   !!window._map,
    markers:      window._markers ? window._markers.length : 'undefined',
    realCards:    document.querySelectorAll('#listings-container a.pt-card[href*="listing.html"]').length,
    skeletons:    document.querySelectorAll('#listings-container .pt-card[aria-hidden]').length,
    loaded:       typeof window.allProperties === 'undefined' ? '(not a window property)' : window.allProperties.length,
    mapWrap:      (document.getElementById('map-wrap') || {}).style?.display,
    notice:       (document.getElementById('map-unmapped') || {}).textContent?.trim().slice(0, 200),
  }));
  console.log('  DIAGNOSTIC — no marker appeared:');
  for (const [k, v] of Object.entries(d)) console.log(`      ${k}: ${v}`);
  console.log(`      console errors (${errors.length}):`);
  errors.slice(0, 10).forEach((e) => console.log(`        ${e.slice(0, 200)}`));
  console.log(`      console warnings (${warnings.length}):`);
  warnings.slice(0, 10).forEach((w) => console.log(`        ${w.slice(0, 200)}`));
  console.log(`      failed requests (${failedRequests.length}):`);
  failedRequests.slice(0, 12).forEach((f) => console.log(`        ${f}`));
  bad('no markers rendered on the live map');
  await browser.close();
  console.log('\nMAP SMOKE TEST FAILED (no markers)');
  process.exit(1);
}

const read = () => page.evaluate(() => window._markers.map((m) => ({
  slug: m._pintag.slug, lat: m.getLatLng().lat, lng: m.getLatLng().lng })));

const markers = await read();
// allProperties is declared with `let`, which creates no window property, so it
// cannot be read from here. The rendered card count is the same number and is
// what a visitor actually sees.
const total = await page.locator(REAL_CARD).count();
console.log(`  markers rendered: ${markers.length}`);

const want = { ...EXPECTED, ...PRE_EXISTING };
markers.length === 24
  ? ok('24 pins — the 23 normalized plus the 1 pre-existing')
  : bad(`expected 24 pins, got ${markers.length}`);

// ── 3. every marker on its verified coordinate ──────────────────────────────
console.log('\n── 3. each marker vs its verified coordinate ───────────');
let matched = 0;
for (const [pre, coord] of Object.entries(want)) {
  const m = markers.find((x) => (x.slug || '').startsWith(pre));
  if (!m) { bad(`no marker for ${pre}…`); continue; }
  const got = `${m.lat},${m.lng}`;
  if (got !== coord) bad(`${m.slug}\n        rendered ${got}\n        verified ${coord}`);
  else matched++;
}
matched === Object.keys(want).length
  ? ok(`all ${matched} markers render at exactly their verified coordinate`)
  : bad(`${Object.keys(want).length - matched} marker(s) are not at their verified coordinate`);

// ── 4. the old fallback is genuinely gone ───────────────────────────────────
console.log('\n── 4. no MAP_CENTER fallback, no jitter ───────────────');
const nearOld = markers.filter((m) => Math.abs(m.lat - OLD_CENTER[0]) < 0.007 && Math.abs(m.lng - OLD_CENTER[1]) < 0.007);
// The old build put EVERY marker inside this box. One or two listings may
// legitimately sit near the city centre, so the test is that they are not all
// there -- and that any that are match a verified coordinate.
const nearOldUnverified = nearOld.filter((m) => !Object.entries(want).some(([pre, c]) => (m.slug || '').startsWith(pre) && `${m.lat},${m.lng}` === c));
nearOldUnverified.length === 0
  ? ok(`${nearOld.length} marker(s) fall near the old centre, all matching a verified coordinate — none is a fallback`)
  : bad(`${nearOldUnverified.length} marker(s) near the old MAP_CENTER with no verified coordinate`);
const uniq = new Set(markers.map((m) => `${m.lat},${m.lng}`));
uniq.size === markers.length ? ok(`all ${uniq.size} positions distinct — no shared default`) : bad(`${markers.length - uniq.size} duplicate position(s)`);

// ── 5. unmapped listings stay unmapped ──────────────────────────────────────
console.log('\n── 5. unmapped listings ────────────────────────────────');
const slugs = markers.map((m) => m.slug || '');
let leaked = 0;
for (const pre of NAME_ONLY) if (slugs.some((s) => s.startsWith(pre))) { bad(`name-only listing ${pre}… IS on the map`); leaked++; }
if (!leaked) ok(`all ${NAME_ONLY.length} name-only listings remain unmapped`);
console.log(`  listing cards on the first page: ${total}`);
// The map's own notice is the authority on how many listings it considered:
// the card grid is paginated, so its length is a page size, not a total.
const notice = ((await page.locator('#map-unmapped').textContent().catch(() => '')) || '').trim();
console.log(`  on-map notice: ${notice || '(none)'}`);
const m = notice.match(/(\d+)\s+of\s+(\d+)/);
if (m) {
  const [unmappedN, consideredN] = [Number(m[1]), Number(m[2])];
  console.log(`  considered: ${consideredN}   mapped: ${markers.length}   unmapped: ${unmappedN}`);
  unmappedN + markers.length === consideredN
    ? ok(`every listing is accounted for — ${markers.length} mapped + ${unmappedN} unmapped = ${consideredN}`)
    : bad(`${consideredN} considered but ${markers.length} mapped + ${unmappedN} unmapped — ${consideredN - markers.length - unmappedN} listing(s) silently dropped`);
} else {
  bad('the map reported no unmapped-listing notice — cannot confirm listings are accounted for');
}

// ── 6. clustering does not move anything ───────────────────────────────────
console.log('\n── 6. clustering ───────────────────────────────────────');
await page.evaluate(() => window._map.setZoom(11));
await page.waitForTimeout(900);
const clusters = await page.locator('.pt-cluster').count();
const afterZoomOut = await read();
clusters > 0 ? ok(`${clusters} cluster bubble(s) at zoom 11`) : bad('no clusters formed at zoom 11');
JSON.stringify(afterZoomOut) === JSON.stringify(markers)
  ? ok('clustering did not alter a single underlying coordinate')
  : bad('coordinates CHANGED when clustering engaged');

// ── 7. re-render / filter must not move a marker ───────────────────────────
console.log('\n── 7. stability across re-render and filtering ────────');
await page.evaluate(() => window.renderMap());
await page.waitForTimeout(500);
const afterRerender = await read();
const sortKey = (a) => a.map((m) => `${m.slug}:${m.lat},${m.lng}`).sort().join('|');
sortKey(afterRerender) === sortKey(markers)
  ? ok('re-render left every marker exactly where it was')
  : bad('a marker MOVED on re-render — jitter is still present');

// A real filter interaction, which is what re-randomised positions before.
// A real click on a real button, not a synthetic call: the onclick attribute
// is the code path a visitor takes, and it is the one that used to re-roll
// every marker's position.
const rentBtn = page.locator('.tx-btn[data-filter="for_rent"]');
await rentBtn.click();
await page.waitForTimeout(900);
const duringFilter = await read();
console.log(`  filtered to For Rent: ${duringFilter.length} marker(s) of ${markers.length}`);
duringFilter.every((m) => {
  const before = markers.find((x) => x.slug === m.slug);
  return !before || (before.lat === m.lat && before.lng === m.lng);
}) ? ok('markers kept their coordinates while the filter was applied')
   : bad('a marker MOVED when the filter was applied');

await page.locator('.tx-btn[data-filter="all"]').click();
await page.waitForTimeout(900);
const afterFilter = await read();
afterFilter.length === markers.length
  ? ok(`clearing the filter restored all ${afterFilter.length} markers`)
  : bad(`after clearing the filter ${afterFilter.length} markers, expected ${markers.length}`);
const stable = afterFilter.every((m) => {
  const before = markers.find((x) => x.slug === m.slug);
  return !before || (before.lat === m.lat && before.lng === m.lng);
});
stable ? ok('every marker still on its original coordinate after filtering') : bad('a marker moved after filtering');

// ── 8. runtime errors ──────────────────────────────────────────────────────
console.log('\n── 8. console ──────────────────────────────────────────');
// The map deliberately warns about each unmapped listing, so warnings are
// expected output, not noise. Errors are not.
const mapWarnings = warnings.filter((w) => w.includes('[pintag/map]'));
console.log(`  map diagnostic warnings: ${mapWarnings.length}`);
mapWarnings.slice(0, 3).forEach((w) => console.log(`      ${w.slice(0, 110)}`));
const assetFailures = failedRequests.filter((f) => !/favicon|tile\.openstreetmap/i.test(f));
console.log(`  failed asset requests: ${assetFailures.length}`);
assetFailures.slice(0, 8).forEach((f) => console.log(`      ${f}`));
const PRE_EXISTING_ERRORS = [
  // Cloudflare injects its Web Analytics beacon at the edge; the CSP declines
  // it. Nothing in this repository references cloudflareinsights, and the map
  // merge changed no CSP directive -- this is the policy working, on every
  // Cloudflare-fronted page, and it predates this work.
  { name: 'Cloudflare Web Analytics beacon refused by CSP', re: /cloudflareinsights\.com/i },
  // agent-setup.html stores avatar URLs absolutely, as https://www.pintag.io/...
  // The document is served from the apex, so 'self' does not cover the www
  // host and img-src declines it. A pre-existing broken agent avatar, in files
  // the map merge never touched -- reported here, not fixed here.
  { name: 'agent avatar on the www host refused by img-src (pre-existing)', re: /pintag\.io\/agent-[^']*\.(jpe?g|png|webp)/i },
];
const preExisting = [], realErrors = [];
for (const e of errors) {
  if (/favicon|net::ERR_|tile\.openstreetmap/i.test(e)) continue;
  const known = PRE_EXISTING_ERRORS.find((k) => k.re.test(e));
  (known ? preExisting : realErrors).push(known ? `${known.name}: ${e.slice(0, 140)}` : e);
}
console.log(`  known pre-existing errors (not caused by the map): ${preExisting.length}`);
preExisting.forEach((e) => console.log(`      ${e}`));
realErrors.length === 0 ? ok('no console errors attributable to the map') : bad(`${realErrors.length} console error(s):\n      ${realErrors.slice(0, 5).join('\n      ')}`);

await browser.close();
console.log(`\n${fail === 0 ? 'MAP SMOKE TEST PASSED' : `MAP SMOKE TEST FAILED (${fail} check(s))`}`);
process.exit(fail === 0 ? 0 : 1);
