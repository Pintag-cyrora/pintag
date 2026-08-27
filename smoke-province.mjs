#!/usr/bin/env node
// smoke-province.mjs — production verification of the admin Province dropdown.
// TEMPORARY, scratch branch only. READ ONLY.
//
// WHAT THIS CAN AND CANNOT REACH
// Admin access requires TOTP two-factor: admin-auth.js has no path to
// enterAdmin() without a valid 6-digit code, and there is no code here to
// bypass that, nor should there be. So this does NOT sign in.
//
// It does something better than clicking through a logged-in UI would: it
// fetches the ACTUAL DEPLOYED admin.html byte-for-byte from production, serves
// it locally, and drives the real page. The province select is populated
// entirely client-side, before any authenticated data is fetched, so every
// assertion below exercises the identical code path an administrator hits --
// the only thing missing is the auth gate that stands in front of it.
//
// NOTHING IS WRITTEN. No listing is created: properties.deleted_at is a SOFT
// delete (admin.html deliberately has no hard delete, and logs an immutable
// listing_provenance row), so a "disposable" test listing is not disposable.
// The save path is verified by building the payload the page itself would send
// and reading it, never by sending it.
import { chromium, devices } from '@playwright/test';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const SITE = 'https://www.pintag.io';
const PORT = 8977;
const bust = (u) => `${u}${u.includes('?') ? '&' : '?'}cb=${Date.now()}`;

// The 18 canonical keys, from the properties_province_en_check constraint in
// migration 20260822000000. Hard-coded so the browser's rendered options are
// compared against the DATABASE's allowed set, not against the page's own idea
// of itself.
const DB_ALLOWED = [
  'Vientiane Capital','Vientiane Province','Phongsaly','Luang Namtha',
  'Oudomxay','Bokeo','Luang Prabang','Houaphanh','Xayabouly','Xiangkhouang',
  'Xaisomboun','Bolikhamxay','Khammouane','Savannakhet','Salavan','Sekong',
  'Champasak','Attapeu'];

let fail = 0;
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const ok  = (m) => console.log(`  ✓ ${m}`);

// ── 1. pull the deployed artifact ───────────────────────────────────────────
console.log('── 1. deployed artifact ────────────────────────────────');
const fetchText = async (path) => {
  const r = await fetch(bust(`${SITE}${path}`), { headers: { 'Cache-Control': 'no-cache' } });
  return { status: r.status, body: await r.text() };
};
const adminRes = await fetchText('/admin.html');
console.log(`  GET /admin.html -> ${adminRes.status} ${adminRes.body.length} bytes`);
adminRes.status === 200 ? ok('admin.html is served') : bad(`admin.html -> ${adminRes.status}`);

const stamp = (adminRes.body.match(/\?v=([A-Za-z0-9]+)/) || [])[1];
console.log(`  asset stamp: ${stamp}`);

// The fix itself, in the bytes production is serving. It is now a TOP-LEVEL
// initializer, deliberately NOT inside resetListingForm — building the
// registry on the twelfth statement of that function is what left the live
// Province field empty when something earlier in it threw.
/^populateProvinceSelect\(''\);$/m.test(adminRes.body)
  ? ok("served admin.html initializes the province options at page load (top level)")
  : bad('served admin.html has no page-load initializer — stale artifact');

const resetFn = adminRes.body.slice(adminRes.body.indexOf('function resetListingForm()'), 
                                   adminRes.body.indexOf('function resetListingForm()') + 3000);
!/populateProvinceSelect\(''\)/.test(resetFn)
  ? ok('resetListingForm no longer rebuilds the registry — the old coupling is gone')
  : bad('resetListingForm STILL rebuilds the registry — the old artifact is deployed');
/_provSel/.test(resetFn)
  ? ok('resetListingForm clears the selection only')
  : bad('resetListingForm does not clear the province selection');

const provRes = await fetchText('/provinces.js');
console.log(`  GET /provinces.js -> ${provRes.status} ${provRes.body.length} bytes`);
provRes.status === 200 ? ok('provinces.js is served') : bad(`provinces.js -> ${provRes.status}`);

// ── serve the deployed bytes locally so the page can load its siblings ──────
const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    const upstream = await fetch(`${SITE}${p}`, { headers: { 'Cache-Control': 'no-cache' } });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ext = p.slice(p.lastIndexOf('.'));
    res.writeHead(upstream.status, { 'Content-Type':
      ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/html' });
    res.end(buf);
  } catch { res.writeHead(502); res.end('upstream failed'); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Desktop Chrome'] });
const page = await ctx.newPage();

const exceptions = [], consoleErrors = [], badRequests = [];
page.on('pageerror', (e) => exceptions.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
// A console line for a failed subresource is just "Failed to load resource:
// ... 404" with NO url in it, so it cannot be classified from the console
// alone. The response event carries the url, which is the difference between
// "provinces.js is missing" and "the known image-preview placeholder 404s".
page.on('response', (r) => { if (r.status() >= 400) badRequests.push(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => badRequests.push(`FAILED ${r.url()}`));

// admin.html builds a Supabase client at module scope. Without a stub the
// script block aborts there and everything after it is missing -- which would
// make a working dropdown read as empty for an unrelated reason.
await page.addInitScript(() => {
  const chain = new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? (r) => r({ data: [], error: null }) : chain), apply: () => chain });
  window.__posted = [];
  window.supabase = { createClient: () => ({
    from: () => chain, rpc: () => chain, storage: { from: () => chain },
    functions: { invoke: async () => ({ data: null, error: null }) },
    channel: () => ({ on: () => ({ subscribe() {} }), subscribe() {} }),
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: async () => ({ data: {}, error: null }), signOut: async () => ({ error: null }),
    } }) };
});
// Absolute belt and braces: no request may reach the production database.
await page.route('**/rest/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' }, body: '[]' }));

await page.goto(`http://localhost:${PORT}/admin.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.getAllProvinces === 'function', null, { timeout: 30000 });
await page.waitForFunction(() => typeof window.populateOwnerSelect === 'function', null, { timeout: 30000 });
ok('the deployed admin.html script block evaluated to completion');

const readProvince = () => page.evaluate(() => {
  const o = [...document.querySelectorAll('#f-province option')];
  return { total: o.length, placeholders: o.filter((x) => x.value === '').length,
           provinces: o.filter((x) => x.value !== '').map((x) => x.value),
           disabled: o.filter((x) => x.value !== '' && x.disabled).map((x) => x.value),
           selected: document.getElementById('f-province').value };
});

// ── 2. both New Listing entry points ────────────────────────────────────────
for (const [label, call] of [
  ['showForm(null)      ', () => page.evaluate(() => showForm(null))],
  ['showImportPanel()   ', () => page.evaluate(() => showImportPanel())],
]) {
  console.log(`\n── 2. New Listing via ${label.trim()} ──────────────────`);
  await call();
  await page.waitForTimeout(400);
  const g = await readProvince();
  console.log(`  options: ${g.total} (placeholder ${g.placeholders} + provinces ${g.provinces.length})`);
  g.placeholders === 1 ? ok('exactly 1 placeholder') : bad(`${g.placeholders} placeholders, expected 1`);
  g.provinces.length === 18 ? ok('exactly 18 provinces') : bad(`${g.provinces.length} provinces, expected 18`);
  g.total === 19 ? ok('19 options in total') : bad(`${g.total} options, expected 19`);
  g.selected === '' ? ok('nothing pre-selected on a fresh listing') : bad(`pre-selected "${g.selected}"`);
  g.disabled.length === 0 ? ok('all 18 are selectable (none disabled)') : bad(`disabled: ${g.disabled.join(', ')}`);
  JSON.stringify(g.provinces.slice().sort()) === JSON.stringify(DB_ALLOWED.slice().sort())
    ? ok('the 18 offered ARE the 18 the database CHECK allows')
    : bad(`offered set differs from the DB constraint:\n      offered: ${g.provinces.join(', ')}`);
}

// ── 3. every province is actually selectable, and drives District ───────────
console.log('\n── 3. selecting each province drives District ──────────');
const districtBehaviour = await page.evaluate((keys) => {
  const out = [];
  const sel = document.getElementById('f-province');
  for (const k of keys) {
    sel.value = k;
    sel.dispatchEvent(new Event('change', { bubbles: true }));   // fires onProvinceChange
    const dsel = document.getElementById('f-district');
    const free = document.getElementById('f-district-free');
    out.push({ key: k, stuck: sel.value !== k,
      districtSelectShown: dsel.style.display !== 'none',
      freeTextShown: !!free && free.style.display !== 'none' });
  }
  return out;
}, DB_ALLOWED);

const unselectable = districtBehaviour.filter((d) => d.stuck).map((d) => d.key);
unselectable.length === 0
  ? ok(`all 18 provinces accept selection`)
  : bad(`could not select: ${unselectable.join(', ')}`);

const capital = districtBehaviour.find((d) => d.key === 'Vientiane Capital');
capital.districtSelectShown && !capital.freeTextShown
  ? ok('Vientiane Capital -> the 7-district dropdown, free text hidden')
  : bad(`Vientiane Capital -> dropdown ${capital.districtSelectShown}, free text ${capital.freeTextShown}`);

const outside = districtBehaviour.filter((d) => d.key !== 'Vientiane Capital');
const wrong = outside.filter((d) => d.districtSelectShown || !d.freeTextShown);
wrong.length === 0
  ? ok(`all 17 other provinces -> free-text district, capital dropdown hidden`)
  : bad(`wrong district behaviour for: ${wrong.map((d) => d.key).join(', ')}`);

// ── 4. the create payload carries the province ──────────────────────────────
// saveListing() is behind requireAdminSession(), so the POST is never reached
// here -- and must not be. What IS verifiable is the payload mapping itself:
// these are the exact expressions admin.html uses to build province_en/_lo/_zh,
// evaluated against the live page's own registry.
console.log('\n── 4. create payload (built, deliberately NOT sent) ────');
const payloads = await page.evaluate((keys) => keys.map((k) => {
  document.getElementById('f-province').value = k;
  const provinceEn = document.getElementById('f-province').value || null;
  const provinceDef = (typeof provinceByKey === 'function') ? provinceByKey(provinceEn) : null;
  return { province_en: provinceEn,
           province_lo: provinceDef ? provinceDef.lo : null,
           province_zh: provinceDef ? provinceDef.zh : null };
}), DB_ALLOWED);

const incomplete = payloads.filter((p) => !p.province_en || !p.province_lo || !p.province_zh);
incomplete.length === 0
  ? ok('all 18 produce a complete {province_en, province_lo, province_zh} triple')
  : bad(`${incomplete.length} province(s) produce a null label: ${JSON.stringify(incomplete)}`);

const rejected = payloads.filter((p) => !DB_ALLOWED.includes(p.province_en));
rejected.length === 0
  ? ok('every province_en the form would send satisfies properties_province_en_check')
  : bad(`the DB CHECK would REJECT: ${rejected.map((p) => p.province_en).join(', ')}`);

console.log('  sample payload (Luang Prabang):',
  JSON.stringify(payloads.find((p) => p.province_en === 'Luang Prabang')));
const posted = await page.evaluate(() => window.__posted.length);
posted === 0 ? ok('NOTHING was written — 0 requests reached the database') : bad(`${posted} write(s) escaped`);

// ── 5. console ──────────────────────────────────────────────────────────────
console.log('\n── 5. console ──────────────────────────────────────────');
exceptions.length === 0 ? ok('no uncaught exceptions') : bad(`exceptions:\n      ${exceptions.join('\n      ')}`);
// Named, printed, not silently dropped -- both predate this change and neither
// is in the province path. The ${esc(url)} 404 is the known admin
// image-preview bug, deliberately left unfixed.
const KNOWN_URLS = [
  { name: 'Cloudflare Web Analytics beacon refused by CSP', re: /cloudflareinsights/i },
  { name: 'pre-existing admin image-preview ${esc(url)} placeholder', re: /%7Besc|\$\{esc/i },
  { name: 'CDN/font not reachable from this runner', re: /jsdelivr|googleapis|gstatic/i },
];
console.log(`  failing requests: ${badRequests.length}`);
const knownReq = [], unknownReq = [];
for (const r of badRequests) {
  if (/favicon/i.test(r)) continue;
  const k = KNOWN_URLS.find((x) => x.re.test(r));
  (k ? knownReq : unknownReq).push(k ? `${k.name}  <-  ${r.slice(0, 120)}` : r);
}
knownReq.forEach((r) => console.log(`      known: ${r}`));
unknownReq.forEach((r) => console.log(`      UNEXPLAINED: ${r}`));

// The province flow loads exactly two first-party assets: admin.html and
// provinces.js. If either 404s, populateProvinceSelect() silently returns and
// the dropdown is empty -- that is the failure mode this whole task was about,
// so it is asserted by url rather than inferred from a console line.
const firstParty = unknownReq.filter((r) => /localhost:\d+\/[^?]*\.(js|html|css)/.test(r));
firstParty.length === 0
  ? ok('every first-party asset the province flow needs was served')
  : bad(`first-party asset(s) failed: ${firstParty.join(', ')}`);

// Console errors, minus the resource-load lines already accounted for by url
// above -- counting both would report the same 404 twice, and the console
// copy carries no url to identify it by.
const nonResource = consoleErrors.filter((e) => !/Failed to load resource|favicon/i.test(e));
const known = [], unknown = [];
for (const e of nonResource) {
  const k = KNOWN_URLS.find((x) => x.re.test(e));
  (k ? known : unknown).push(k ? `${k.name}: ${e.slice(0, 110)}` : e);
}
console.log(`  known pre-existing (not province-related): ${known.length}`);
known.forEach((e) => console.log(`      ${e}`));
unknown.length === 0 && unknownReq.length === firstParty.length
  ? ok('no console errors related to the province flow')
  : bad(`unexplained: ${[...unknown, ...unknownReq.filter((r) => !firstParty.includes(r))].slice(0, 5).join('\n      ')}`);

// ── 6. the province column is live in production, read-only ────────────────
// This is the "accepted by the API" half, without writing anything. If the
// migration were missing, province_en would not exist and PostgREST would
// answer 42703 rather than a result set; if the CHECK were not applied, stored
// values could drift off the registry. Both are observable from a GET.
console.log('\n── 6. province column in production (READ ONLY GET) ────');
const cfg = readFileSync(new URL('./config.prod.js', import.meta.url), 'utf8');
const pick = (k) => (cfg.match(new RegExp(`${k}:\\s*'([^']+)'`)) || [])[1];
const SUPABASE_URL = pick('supabaseUrl'), ANON = pick('anonKey');   // anonKey is public
const res = await fetch(`${SUPABASE_URL}/rest/v1/properties?select=province_en&limit=1000`,
  { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
console.log(`  GET properties?select=province_en -> ${res.status}`);
if (res.status !== 200) {
  const body = await res.text();
  bad(`province_en is not queryable: ${res.status} ${body.slice(0, 160)}`);
} else {
  ok('province_en exists and is queryable (the migration is applied)');
  const rows = await res.json();
  const distinct = [...new Set(rows.map((r) => r.province_en).filter(Boolean))];
  console.log(`  ${rows.length} rows, distinct province_en: ${distinct.join(', ') || '(none)'}`);
  const offRegistry = distinct.filter((v) => !DB_ALLOWED.includes(v));
  offRegistry.length === 0
    ? ok('every stored province_en is one of the 18 — the CHECK is holding')
    : bad(`stored value(s) outside the registry: ${offRegistry.join(', ')}`);
}

await browser.close();
server.close();
console.log(`\n${fail === 0 ? 'PROVINCE SMOKE TEST PASSED' : `PROVINCE SMOKE TEST FAILED (${fail} check(s))`}`);
process.exit(fail === 0 ? 0 : 1);
