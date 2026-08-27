#!/usr/bin/env node
// probe-province.mjs — why does an iPhone see an empty Province dropdown when
// a Chromium test saw 19 options?
//
// STRICTLY READ ONLY. GETs and page loads. Writes nothing, anywhere.
//
// The two candidate explanations, and the flaw in the earlier verification:
//
//   A. DELIVERY. Every previous check fetched admin.html with a ?cb=<time>
//      cache-buster. A real visitor requests the BARE url. If an edge cache
//      holds a pre-deploy copy of /admin.html, the phone runs old code while
//      every cache-busted probe reads the new file and passes.
//
//   B. RUNTIME. populateProvinceSelect('') sits ~15 statements into
//      resetListingForm(). If anything before it throws on a real page, the
//      call never runs — and the District list stays full either way, because
//      its 7 options are static HTML. That is exactly the reported symptom.
//
// This distinguishes them instead of guessing.
import { chromium, devices } from '@playwright/test';

const ORIGINS = ['https://www.pintag.io', 'https://pintag.io', 'https://pintag-cyrora.github.io/pintag'];
const say = (m) => console.log(m);

// ── 1. what does each origin serve for the BARE url? ────────────────────────
say('── 1. BARE url (what a real visitor requests) ───────────────');
const bare = {};
for (const o of ORIGINS) {
  try {
    const r = await fetch(`${o}/admin.html`, { redirect: 'follow' });
    const body = await r.text();
    const h = (k) => r.headers.get(k) || '-';
    // The fix, checked INSIDE resetListingForm rather than anywhere in the file.
    const fnIdx = body.indexOf('function resetListingForm()');
    const fnBody = fnIdx === -1 ? '' : body.slice(fnIdx, fnIdx + 3500);
    bare[o] = {
      status: r.status, bytes: body.length,
      stamp: (body.match(/\?v=([A-Za-z0-9]+)/) || [])[1] || '(none)',
      hasFixInReset: /populateProvinceSelect\(''\)/.test(fnBody),
      loadsProvinces: body.includes('provinces.js'),
      loadsTitleModule: body.includes('listing-title.js'),
      cache: h('cf-cache-status'), age: h('age'), lastMod: h('last-modified'),
      etag: h('etag'), server: h('server'),
    };
  } catch (e) { bare[o] = { error: e.message }; }
  say(`  ${o}/admin.html`);
  for (const [k, v] of Object.entries(bare[o])) say(`      ${k}: ${v}`);
}

// ── 2. bare vs cache-busted, same origin, same moment ───────────────────────
say('\n── 2. BARE vs CACHE-BUSTED (the flaw in the old checks) ─────');
for (const o of ORIGINS.slice(0, 2)) {
  const get = async (u) => {
    const r = await fetch(u); const b = await r.text();
    const i = b.indexOf('function resetListingForm()');
    return { bytes: b.length, fix: i !== -1 && /populateProvinceSelect\(''\)/.test(b.slice(i, i + 3500)),
             stamp: (b.match(/\?v=([A-Za-z0-9]+)/) || [])[1] || '(none)',
             cf: r.headers.get('cf-cache-status') || '-', age: r.headers.get('age') || '-' };
  };
  const a = await get(`${o}/admin.html`);
  const b = await get(`${o}/admin.html?cb=${Date.now()}`);
  say(`  ${o}`);
  say(`      bare        : ${a.bytes}B  fix=${a.fix}  stamp=${a.stamp}  cf=${a.cf} age=${a.age}`);
  say(`      cache-busted: ${b.bytes}B  fix=${b.fix}  stamp=${b.stamp}  cf=${b.cf} age=${b.age}`);
  say(`      SAME CONTENT: ${a.bytes === b.bytes && a.fix === b.fix ? 'yes' : 'NO — the bare url serves something different'}`);
}

// ── 3. provinces.js, bare and stamped ───────────────────────────────────────
say('\n── 3. provinces.js as delivered ─────────────────────────────');
const stamp = bare['https://www.pintag.io']?.stamp;
for (const u of [`https://www.pintag.io/provinces.js`, `https://www.pintag.io/provinces.js?v=${stamp}`]) {
  try {
    const r = await fetch(u); const b = await r.text();
    say(`  ${u}`);
    say(`      ${r.status}  ${b.length}B  cf=${r.headers.get('cf-cache-status') || '-'}  age=${r.headers.get('age') || '-'}`);
    say(`      getAllProvinces defined: ${/function getAllProvinces/.test(b)}   LAO_PROVINCES entries: ${(b.match(/key: '/g) || []).length}`);
  } catch (e) { say(`  ${u} -> ${e.message}`); }
}

// ── 4. drive the REAL public page, no stubs, bare url ───────────────────────
// No supabase stub this time: the point is to see what the page actually does
// for a visitor, including whatever its own init does or fails to do.
say('\n── 4. the real page in a real browser (bare url, no stubs) ──');
const browser = await chromium.launch();

async function run(label, deviceName, freshContext) {
  const ctx = await browser.newContext(
    deviceName ? { ...devices[deviceName] } : { ...devices['Desktop Chrome'] });
  const page = await ctx.newPage();
  const errors = [], failed = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => failed.push(`${r.url().slice(0, 90)} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 90)}`); });

  await page.goto('https://www.pintag.io/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => {
    const opts = () => document.querySelectorAll('#f-province option').length;
    const out = {
      servedFixInReset: typeof resetListingForm === 'function'
        && /populateProvinceSelect\(''\)/.test(resetListingForm.toString()),
      getAllProvinces: typeof getAllProvinces,
      registry: typeof getAllProvinces === 'function' ? getAllProvinces().length : null,
      populateFn: typeof populateProvinceSelect,
      optionsOnLoad: opts(),
      districtOptions: document.querySelectorAll('#f-district option').length,
      loginVisible: !!document.querySelector('#paa-email, #paa-pw'),
    };
    // Now do exactly what the visitor does.
    try { showImportPanel(); out.showImportPanelThrew = null; }
    catch (e) { out.showImportPanelThrew = String(e); }
    out.optionsAfterNewListing = opts();

    // If the options are still missing, find out how far resetListingForm got.
    if (out.optionsAfterNewListing <= 1) {
      try { resetListingForm(); out.resetThrew = null; }
      catch (e) { out.resetThrew = String(e); }
      out.optionsAfterReset = opts();
      try { populateProvinceSelect(''); out.directCallThrew = null; }
      catch (e) { out.directCallThrew = String(e); }
      out.optionsAfterDirectCall = opts();
    }
    return out;
  });

  say(`  [${label}]`);
  for (const [k, v] of Object.entries(state)) say(`      ${k}: ${v}`);
  if (errors.length) { say(`      errors (${errors.length}):`); errors.slice(0, 6).forEach((e) => say(`        ${e.slice(0, 160)}`)); }
  if (failed.length) { say(`      failed requests (${failed.length}):`); failed.slice(0, 6).forEach((f) => say(`        ${f}`)); }
  await ctx.close();
  return state;
}

const desktop = await run('Desktop Chrome, fresh context', null, true);
const iphone  = await run('iPhone 13 Safari UA, fresh context', 'iPhone 13', true);

await browser.close();
say('\n── summary ──────────────────────────────────────────────────');
say(`  bare-url admin.html carries the fix : ${bare['https://www.pintag.io']?.hasFixInReset}`);
say(`  desktop options after New Listing   : ${desktop.optionsAfterNewListing}`);
say(`  iphone  options after New Listing   : ${iphone.optionsAfterNewListing}`);
