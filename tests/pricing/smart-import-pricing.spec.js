// Regression coverage for a production incident: Smart Import threw
// "Can't find variable: parseLegacyPriceAmount" for real users. Root
// cause, confirmed by a controlled reproduction (serving the current
// admin.html alongside a currency.js from before parseLegacyPriceAmount
// existed): admin.html and currency.js are two independently-cached
// static assets on a Cloudflare-fronted deploy with no cache-busting, so a
// browser/CDN could serve them from two different deploys at once. Fixed
// two ways, both covered here:
//   1. Asset versioning (deploy-prod.yml/deploy-dev.yml stamp a
//      __ASSET_VERSION__ token with the deploy's git SHA into every
//      first-party <script>/<link> tag) so mismatched pairs can no longer
//      be served together -- not testable from a single-process Playwright
//      suite, verified separately by simulating the sed substitution.
//   2. _parseImportPriceText() (admin.html) and _numericPrice()
//      (listings.html) feature-detect window.parseLegacyPriceAmount
//      instead of calling the bare identifier, so even if the two assets
//      somehow do end up mismatched, Smart Import degrades to a flagged,
//      blank price field instead of throwing and aborting the whole
//      import -- this IS directly testable here (see "degrades gracefully"
//      below) and is the real regression guard, since it holds regardless
//      of caching/deployment timing.
const { test, expect } = require('@playwright/test');

const STUB_SUPABASE = `
window.supabase = {
  createClient: function() {
    return {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'fake', user: { id: 'u1', email: 'admin@pintag.io' } } }, error: null }),
        getUser: async () => ({ data: { user: { id: 'u1', email: 'admin@pintag.io' } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
      },
    };
  }
};
`;

async function loadAdminAsStaff(page) {
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err));
  await page.route('**cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'application/javascript', body: STUB_SUPABASE }));
  await page.route('**fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/admin.html');
  await page.waitForSelector('#admin-screen', { state: 'visible', timeout: 15000 }).catch(() => {});
  return pageErrors;
}

test('parseLegacyPriceAmount and its call chain are real, loaded globals', async ({ page }) => {
  await loadAdminAsStaff(page);
  const globals = await page.evaluate(() => ({
    parseLegacyPriceAmount: typeof window.parseLegacyPriceAmount,
    formatMoneyRange: typeof window.formatMoneyRange,
    _parseImportPriceText: typeof window._parseImportPriceText,
    populateFormFromImport: typeof window.populateFormFromImport,
  }));
  expect(globals.parseLegacyPriceAmount).toBe('function');
  expect(globals.formatMoneyRange).toBe('function');
  expect(globals._parseImportPriceText).toBe('function');
  expect(globals.populateFormFromImport).toBe('function');
});

const SCENARIOS = [
  {
    name: 'rent listing (single price)',
    data: { property_type: 'house', transaction_type: 'for_rent', price_display: '$450 / month', title: 'Rent House' },
    expectAmount: '450', expectCurrency: 'USD',
  },
  {
    name: 'sale listing (single high-value price)',
    data: { property_type: 'condo', transaction_type: 'for_sale', price_display: '$550,000', title: 'Sale Condo' },
    expectAmount: '550000', expectCurrency: 'USD',
  },
  {
    name: 'price range listing',
    data: { property_type: 'apartment', transaction_type: 'for_rent', price_display: '$280-300 / month', title: 'Range Apartment' },
    // Must be the range's lower bound (280), never the digit-concatenated
    // "280300" -- the exact corruption this whole pass was about.
    expectAmount: '280', expectCurrency: 'USD',
  },
  {
    name: 'deposit-only listing (no rent price extracted)',
    data: { property_type: 'house', transaction_type: 'for_rent', price_display: null, title: 'Deposit Only House' },
    expectAmount: '', expectCurrency: 'USD',
  },
  {
    name: 'no-price listing',
    data: { property_type: 'land', transaction_type: 'for_sale', title: 'No Price Land' },
    expectAmount: '', expectCurrency: 'USD',
  },
];

for (const scenario of SCENARIOS) {
  test(`Smart Import price population: ${scenario.name}`, async ({ page }) => {
    const pageErrors = await loadAdminAsStaff(page);

    const result = await page.evaluate((data) => {
      populateFormFromImport(data);
      return {
        amount: document.getElementById('f-price-amount').value,
        currency: document.getElementById('f-price-currency').value,
      };
    }, scenario.data);

    expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
    expect(result.amount).toBe(scenario.expectAmount);
    expect(result.currency).toBe(scenario.expectCurrency);
  });
}

// Requirement: "verify Smart Import works after a hard refresh and from a
// completely clean browser session." Every test in this file already runs
// in its own fresh Playwright BrowserContext (no cookies/localStorage/cache
// carried over from any other test) -- that IS a clean session by
// construction. This test additionally covers a hard refresh specifically:
// load once, drive Smart Import, reload the page (a real HTTP round-trip
// for every asset, not a SPA-style state reset), then drive it again.
test('Smart Import survives a hard refresh mid-session', async ({ page }) => {
  const pageErrors = await loadAdminAsStaff(page);

  const before = await page.evaluate((data) => {
    populateFormFromImport(data);
    return document.getElementById('f-price-amount').value;
  }, SCENARIOS[2].data); // the price-range scenario -- the one that was corrupted pre-fix
  expect(before).toBe('280');

  await page.reload();
  await page.waitForSelector('#admin-screen', { state: 'visible', timeout: 15000 }).catch(() => {});

  const after = await page.evaluate((data) => {
    populateFormFromImport(data);
    return document.getElementById('f-price-amount').value;
  }, SCENARIOS[2].data);

  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
  expect(after).toBe('280');
});

// Requirement 3's actual regression guard: if currency.js and admin.html
// ever ARE served mismatched again (the exact production incident this
// suite exists for), Smart Import must degrade gracefully, never throw.
// Simulates the mismatch directly by stubbing window.parseLegacyPriceAmount
// away after the real page has loaded -- equivalent, for this function's
// purposes, to currency.js not having defined it in the first place.
test('Smart Import degrades gracefully when parseLegacyPriceAmount is unavailable (simulated stale currency.js)', async ({ page }) => {
  const pageErrors = await loadAdminAsStaff(page);
  // `delete window.parseLegacyPriceAmount` silently fails here (returns
  // false, does not throw in non-strict mode): a top-level `function`
  // declaration creates a non-configurable global property, same as a
  // top-level `var`. Reassigning to undefined is what actually simulates
  // "not defined by the loaded currency.js" for this test.
  await page.evaluate(() => { window.parseLegacyPriceAmount = undefined; });

  const result = await page.evaluate((data) => {
    populateFormFromImport(data); // must not throw
    return {
      amount: document.getElementById('f-price-amount').value,
      currency: document.getElementById('f-price-currency').value,
      flagged: document.getElementById('f-price-amount').classList.contains('field-low-confidence'),
    };
  }, { property_type: 'apartment', transaction_type: 'for_rent', price_display: '$280-300 / month', title: 'Range Apartment' });

  expect(pageErrors, pageErrors.map(e => e.message).join('; ')).toHaveLength(0);
  expect(result.amount).toBe(''); // left blank, never a guessed/corrupted value
  expect(result.currency).toBe('USD'); // currency itself doesn't depend on the missing helper
  expect(result.flagged).toBe(true); // visually flagged for manual entry
});
