// Does the admin Province dropdown actually offer provinces on a NEW listing?
//
// The <select id="f-province"> ships in admin.html with exactly ONE option --
// the empty "Select province" placeholder. All 18 real provinces are injected
// at runtime by populateProvinceSelect() from the LAO_PROVINCES registry.
//
// That means an EMPTY dropdown and a WORKING one are indistinguishable in the
// HTML, and were indistinguishable to every existing test: provinces.test.js
// proves the registry holds 18 entries, and it passed the whole time the New
// Listing dropdown was empty, because the registry was never the broken part.
// The missing piece was the CALL -- populateProvinceSelect() had a single call
// site, on the edit path -- so a New Listing opened with nothing to select and
// the required Location section could not be completed.
//
// These assertions therefore count and name the options actually rendered into
// the live DOM, on each real entry point, rather than checking that the select
// exists or that the registry is non-empty.
const { test, expect } = require('@playwright/test');

// admin.html loads the Supabase client from a CDN and immediately builds a
// client from it at module scope. None of that is needed to observe the
// province select, but if it throws, the page's script block aborts partway
// and everything declared after the throw is missing -- which would make a
// populated dropdown look empty for an entirely unrelated reason. This stub
// exists so the page evaluates to the end and the reading means what it says.
async function stubSupabase(page) {
  await page.addInitScript(() => {
    const chain = new Proxy(function () {}, {
      get: (_t, k) => (k === 'then' ? (r) => r({ data: [], error: null }) : chain),
      apply: () => chain,
    });
    window.supabase = {
      createClient: () => ({
        from: () => chain,
        rpc: () => chain,
        storage: { from: () => chain },
        functions: { invoke: async () => ({ data: null, error: null }) },
        channel: () => ({ on: () => ({ subscribe() {} }), subscribe() {} }),
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          getUser: async () => ({ data: { user: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signInWithPassword: async () => ({ data: {}, error: null }),
          signOut: async () => ({ error: null }),
        },
      }),
    };
  });
  await page.route('**/rest/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: '[]' }));
}

async function openAdmin(page) {
  const errors = [];
  const exceptions = [];
  const badRequests = [];
  page.on('pageerror', (e) => { exceptions.push(e.message); errors.push('PAGEERROR: ' + e.message); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // A console line for a failed subresource is just "Failed to load resource:
  // ... 404" with NO url in the text, so it cannot be filtered accurately from
  // the console alone. Recording the response gives the url, which is the
  // difference between "a first-party script is missing" (a real finding) and
  // "the minimal static server has no favicon" (noise).
  page.on('response', (r) => { if (r.status() >= 400) badRequests.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => badRequests.push(`FAILED ${r.url()}`));
  page.__diag = { errors, exceptions, badRequests };
  await stubSupabase(page);
  await page.goto('/admin.html', { waitUntil: 'domcontentloaded' });
  // The page's script block must have run to completion, or every reading
  // below is measuring a half-initialised page rather than the real one.
  await page.waitForFunction(() => typeof window.getAllProvinces === 'function');
  await expect
    .poll(() => page.evaluate(() => typeof window.populateOwnerSelect === 'function'))
    .toBe(true);
  return page.__diag;
}

const readProvince = (page) => page.evaluate(() => {
  const opts = [...document.querySelectorAll('#f-province option')];
  return {
    total: opts.length,
    placeholders: opts.filter((o) => o.value === '').length,
    provinces: opts.filter((o) => o.value !== '').map((o) => o.value),
    selected: document.getElementById('f-province').value,
  };
});

test.describe('the admin Province select on a NEW listing', () => {
  test('showForm(null) offers 1 placeholder + all 18 provinces', async ({ page }) => {
    await openAdmin(page);
    await page.evaluate(() => showForm(null));

    const got = await readProvince(page);
    expect(got.placeholders, 'the empty "Select province" placeholder').toBe(1);
    expect(got.provinces.length, 'selectable provinces').toBe(18);
    expect(got.total, 'total <option> elements').toBe(19);
    // A fresh listing must not arrive with a province already chosen.
    expect(got.selected).toBe('');
  });

  test('showImportPanel() — the + New Listing button — offers the same 19', async ({ page }) => {
    await openAdmin(page);
    await page.evaluate(() => showImportPanel());

    const got = await readProvince(page);
    expect(got.placeholders).toBe(1);
    expect(got.provinces.length, 'selectable provinces').toBe(18);
    expect(got.total).toBe(19);
    expect(got.selected).toBe('');
  });

  test('the options ARE the registry — same values, same order, no duplicates', async ({ page }) => {
    await openAdmin(page);
    await page.evaluate(() => showForm(null));

    const { rendered, registry } = await page.evaluate(() => ({
      rendered: [...document.querySelectorAll('#f-province option')]
        .filter((o) => o.value !== '').map((o) => o.value),
      registry: getAllProvinces().map((p) => p.key),
    }));
    // Order matters: the registry's order is canonical (Vientiane Capital
    // first, then north to south) and no consumer may re-sort it.
    expect(rendered).toEqual(registry);
    expect(new Set(rendered).size, 'no duplicated province').toBe(rendered.length);
    // Vientiane Capital and Vientiane Province are DISTINCT and must both be
    // offered -- conflating them is the specific mistake provinces.js warns of.
    expect(rendered).toContain('Vientiane Capital');
    expect(rendered).toContain('Vientiane Province');
  });

  test('opening New Listing twice does not duplicate the options', async ({ page }) => {
    await openAdmin(page);
    await page.evaluate(() => { showForm(null); showImportPanel(); showForm(null); });

    const got = await readProvince(page);
    expect(got.total, 'still 19 after three resets').toBe(19);
  });

  test('opening the form throws nothing and loads every first-party asset', async ({ page }) => {
    const diag = await openAdmin(page);
    await page.evaluate(() => { showForm(null); showImportPanel(); });
    await page.waitForTimeout(500);

    // The real signal, and the one this bug's investigation asked for: does
    // anything throw before the province options are populated? An uncaught
    // exception mid-script aborts the rest of the block, which is exactly how
    // a populated dropdown could still come out empty.
    expect(diag.exceptions, diag.exceptions.join('\n')).toEqual([]);

    // Every first-party script/page must actually be served -- provinces.js
    // failing to load would leave getAllProvinces undefined and populate would
    // silently return. Third-party CDNs and favicons are the static server's
    // business, not this suite's, so they are reported rather than asserted.
    const firstParty = diag.badRequests.filter((r) => /localhost:\d+\/[^?]*\.(js|html|css)/.test(r));
    expect(firstParty, firstParty.join('\n')).toEqual([]);
    if (diag.badRequests.length) console.log('  (non-first-party request failures: ' + diag.badRequests.join(', ') + ')');
  });
});

// ── The edit path must keep working exactly as it did ──────────────────────
test.describe('the Edit Listing path is unchanged', () => {
  test('an existing listing’s province is populated AND selected', async ({ page }) => {
    await openAdmin(page);

    // Drive the same two calls the edit path makes, in the same order.
    const got = await page.evaluate(() => {
      populateProvinceSelect('Luang Prabang');
      onProvinceChange();
      const opts = [...document.querySelectorAll('#f-province option')];
      return {
        total: opts.length,
        selected: document.getElementById('f-province').value,
        // Outside the capital the district select is replaced by free text.
        districtSelectHidden: document.getElementById('f-district').style.display === 'none',
        freeTextShown: (document.getElementById('f-district-free') || {}).style?.display === '',
      };
    });
    expect(got.total).toBe(19);
    expect(got.selected, 'the stored province stays selected').toBe('Luang Prabang');
    expect(got.districtSelectHidden, 'capital-only district list is hidden').toBe(true);
    expect(got.freeTextShown, 'free-text district is shown').toBe(true);
  });

  test('a Vientiane Capital listing keeps the district dropdown', async ({ page }) => {
    await openAdmin(page);
    const got = await page.evaluate(() => {
      populateProvinceSelect('Vientiane Capital');
      onProvinceChange();
      return {
        selected: document.getElementById('f-province').value,
        districtSelectShown: document.getElementById('f-district').style.display !== 'none',
        districtOptions: document.querySelectorAll('#f-district option').length,
      };
    });
    expect(got.selected).toBe('Vientiane Capital');
    expect(got.districtSelectShown).toBe(true);
    expect(got.districtOptions, 'placeholder + the 7 capital districts').toBe(8);
  });
});
