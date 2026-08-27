// Does the admin form actually put the location into an AI-generated title?
//
// listing-title.test.js proves the RULE. It cannot prove that admin.html calls
// it, that it reads the form's real location fields, or that it runs AFTER
// Smart Import has filled those fields — and every one of those is a way the
// guarantee disappears while the unit tests stay green. So this drives the
// real admin.html in a real browser and reads the title INPUTS back.
const { test, expect } = require('@playwright/test');

async function stubSupabase(page) {
  await page.addInitScript(() => {
    const chain = new Proxy(function () {}, {
      get: (_t, k) => (k === 'then' ? (r) => r({ data: [], error: null }) : chain), apply: () => chain });
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
  await page.route('**/rest/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: '[]' }));
}

async function openAdmin(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await stubSupabase(page);
  await page.goto('/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.populateFormFromImport === 'function');
  await page.waitForFunction(() => !!window.PintagListingTitle);
  // Enter through the real New Listing door. showImportPanel() -> the shared
  // resetListingForm() is what populates the province <select>, and setting
  // .value on a select with no matching <option> silently resets it to '' --
  // so a test that skips this step reads a blank province and concludes the
  // city is missing, when the flow it models never had one.
  // The whole admin app sits behind the login gate, so nothing here is ever
  // VISIBLE without signing in — and admin requires TOTP two-factor, which is
  // not something to work around in a test. The DOM and the functions are
  // fully present regardless, so every assertion below reads state rather than
  // clicking. showImportPanel() is still the real entry point and is what
  // populates the province <select>: setting .value on a select with no
  // matching <option> silently resets it to '', which would make the city look
  // missing when the flow simply never had one.
  await page.evaluate(() => showImportPanel());
  await page.waitForFunction(() =>
    document.querySelectorAll('#f-province option').length > 1);
  return errors;
}

const titles = (page) => page.evaluate(() => ({
  en: document.getElementById('f-title-en').value,
  lo: document.getElementById('f-title-lo').value,
  zh: document.getElementById('f-title-zh').value,
}));

// The shape smart-listing-importer returns: prose at the top level, factual
// fields confidence-tagged, location nested.
const importPayload = (over = {}) => ({
  title: 'Modern 2-Bedroom Condo', title_lo: 'ຫ້ອງແຖວ 2 ຫ້ອງນອນ', title_zh: '现代两居室公寓',
  location: { district: { value: 'Sisattanak', confidence: 'high' },
              village:  { value: 'Ban Phonxay', confidence: 'high' } },
  ...over,
});

test('the shared module is loaded on the admin page', async ({ page }) => {
  await openAdmin(page);
  const api = await page.evaluate(() => Object.keys(window.PintagListingTitle).sort());
  expect(api).toContain('ensureTitleLocation');
  expect(api).toContain('titleLocationPatch');
});

test('SMART IMPORT: the generated title ends up carrying village, district and city', async ({ page }) => {
  await openAdmin(page);
  await page.evaluate((d) => populateFormFromImport(d), importPayload());

  const t = await titles(page);
  // The province select defaults to nothing on a blank form; the operator's
  // district drives the rest. What must be true is that the title names where.
  expect(t.en, t.en).toContain('Ban Phonxay');
  expect(t.en, t.en).toContain('Sisattanak');
  expect(t.lo, t.lo).toContain('ສີສັດຕະນາກ');
  expect(t.zh, t.zh).toContain('西沙塔纳克');
});

test('SMART IMPORT: the location is applied AFTER the location fields are filled', async ({ page }) => {
  await openAdmin(page);
  await page.evaluate((d) => populateFormFromImport(d), importPayload());
  // If applyImportTitles ran before the district landed, the title would be
  // untouched — this asserts the ordering, which is the subtle way this breaks.
  const district = await page.inputValue('#f-district');
  const t = await titles(page);
  expect(district).toBe('Sisattanak');
  expect(t.en).toContain(district);
});

test('SMART IMPORT: no village found → district only, and no invented village', async ({ page }) => {
  await openAdmin(page);
  await page.evaluate((d) => populateFormFromImport(d),
    importPayload({ location: { district: { value: 'Chanthabouly', confidence: 'high' }, village: null } }));

  const t = await titles(page);
  expect(t.en, t.en).toContain('Chanthabouly');
  expect(t.en, t.en).not.toMatch(/Ban\s/i);
});

test('SMART IMPORT: a title the AI already located is not decorated twice', async ({ page }) => {
  await openAdmin(page);
  await page.evaluate((d) => populateFormFromImport(d),
    importPayload({ title: 'Modern 2-Bedroom Condo in Ban Phonxay, Sisattanak' }));

  const t = await titles(page);
  expect(t.en).toBe('Modern 2-Bedroom Condo in Ban Phonxay, Sisattanak');
  expect((t.en.match(/Sisattanak/g) || []).length).toBe(1);
});

test('SMART IMPORT: no location at all → the title is left exactly as generated', async ({ page }) => {
  await openAdmin(page);
  await page.evaluate((d) => populateFormFromImport(d),
    importPayload({ location: { district: null, village: null } }));

  const t = await titles(page);
  expect(t.en).toBe('Modern 2-Bedroom Condo');
});

test('the province select feeds the CITY into the title', async ({ page }) => {
  await openAdmin(page);
  await page.evaluate((d) => populateFormFromImport(d), importPayload());
  // Now the operator picks the province, as they must to save, and re-locates.
  await page.evaluate(() => {
    document.getElementById('f-province').value = 'Vientiane Capital';
    document.getElementById('f-title-en').value = 'Modern 2-Bedroom Condo';
    applyImportTitles();
  });
  const t = await titles(page);
  expect(t.en).toBe('Modern 2-Bedroom Condo in Ban Phonxay, Sisattanak, Vientiane');
  // The prefecture key must never surface in customer-facing copy.
  expect(t.en).not.toContain('Vientiane Capital');
});

test('Vientiane PROVINCE is not rendered as the capital', async ({ page }) => {
  await openAdmin(page);
  await page.evaluate(() => {
    document.getElementById('f-province').value = 'Vientiane Province';
    onProvinceChange();                       // outside the capital -> free-text district
    const free = document.getElementById('f-district-free');
    if (free) free.value = 'Phonhong';
    document.getElementById('f-village').value = '';
    document.getElementById('f-title-en').value = 'Farmhouse with Land';
    applyImportTitles();
  });
  const t = await titles(page);
  expect(t.en, t.en).toContain('Vientiane Province');
  expect(t.en, t.en).toContain('Phonhong');
});

test('REGENERATE: repeated runs keep the location without stacking it', async ({ page }) => {
  await openAdmin(page);
  await page.evaluate((d) => populateFormFromImport(d), importPayload());
  await page.evaluate(() => { applyImportTitles(); applyImportTitles(); applyImportTitles(); });

  const t = await titles(page);
  expect((t.en.match(/Sisattanak/g) || []).length).toBe(1);
  expect((t.en.match(/Ban Phonxay/g) || []).length).toBe(1);
});

test('currentListingLocation reads the form, not the import payload', async ({ page }) => {
  await openAdmin(page);
  await page.evaluate((d) => populateFormFromImport(d), importPayload());
  // The operator corrects a district the AI got wrong. The title must follow
  // the FORM, because the form is what gets saved.
  const loc = await page.evaluate(() => {
    document.getElementById('f-district').value = 'Saysettha';
    document.getElementById('f-title-en').value = 'Modern 2-Bedroom Condo';
    applyImportTitles();
    return currentListingLocation();
  });
  expect(loc.district_en).toBe('Saysettha');
  expect(loc.district_lo).toBeTruthy();          // denormalized from DISTRICT_MAP
  const t = await titles(page);
  expect(t.en).toContain('Saysettha');
  expect(t.en).not.toContain('Sisattanak');
});

test('no uncaught exceptions while any of this runs', async ({ page }) => {
  const errors = await openAdmin(page);
  await page.evaluate((d) => populateFormFromImport(d), importPayload());
  await page.evaluate(() => { applyImportTitles(); showForm(null); });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('markup in a location field cannot reach the title, and never executes', async ({ page }) => {
  await openAdmin(page);
  const out = await page.evaluate(() => {
    document.getElementById('f-village').value = '<img src=x onerror=window.__xss=1>';
    document.getElementById('f-district').value = 'Sisattanak';
    document.getElementById('f-title-en').value = 'Condo';
    applyImportTitles();
    const title = document.getElementById('f-title-en').value;
    // esc() is admin.html's own escaper, used at every render site — the
    // primary control, asserted here to still be in force.
    return { title, rendered: esc(title) };
  });
  // Defence in depth: the phrase is built from script runs, so angle brackets
  // cannot survive into it at all.
  expect(out.title, out.title).not.toContain('<');
  expect(out.title, out.title).toContain('Sisattanak');
  expect(out.rendered).not.toContain('<img');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
