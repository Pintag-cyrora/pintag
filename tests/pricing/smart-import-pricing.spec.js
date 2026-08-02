// Regression coverage for a reported "Can't find variable:
// parseLegacyPriceAmount" error during Smart Import. Investigation found
// no such reference anywhere in the repo -- parseLegacyPriceAmount() is
// defined exactly once (currency.js), was never removed (confirmed via
// `git log -S`), and currency.js loads before admin.html's inline script
// on every page that references it. This suite exists to keep that true:
// it drives the real populateFormFromImport() -> _parseImportPriceText()
// -> parseLegacyPriceAmount() call chain end to end and fails loudly if a
// future edit reintroduces a load-order or naming break.
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
