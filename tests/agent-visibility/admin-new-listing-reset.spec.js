// Regression: New Listing must start from a genuinely blank form.
//
// Bug: editing a listing that had Unit Types, Building Rental Terms, an Owner,
// and lease-duration tiers, then saving and clicking New Listing (which routes
// through Smart Import), left that previous listing's state in the form —
// populateFormFromImport() didn't clear those areas, and leaked Unit Types even
// flipped pricing into calculated/range mode. Fix: showImportPanel() (and
// showForm(null)) now call the one shared resetListingForm().
//
// This drives the REAL admin.html in the browser (auth + supabase-js stubbed),
// seeds the exact leaked state via the real functions, then calls the real
// showImportPanel() and asserts everything is cleared BEFORE a subsequent
// Smart Import populate — and that pricing is not in range mode.

const { test, expect } = require('@playwright/test');

// Boot admin.html without real auth or the supabase-js CDN (same approach as
// admin-visibility.spec.js).
async function stub(page) {
  await page.route('**/cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript',
      body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),refreshSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}},storage:{from:function(){return {upload:async()=>({}),getPublicUrl:function(){return {data:{publicUrl:""}};}};}}};}};' }));
  await page.route('**/admin-auth.js*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript',
      body: 'window.PintagAdminAuth={protect:function(c,cb){cb();},token:async()=>"test-token",requireAdminSession:async()=>true,ADMIN_EMAIL:"x"};' }));
  // Everything the page fetches returns an empty set — a clean, listing-free boot.
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}

// Populate the form with a previous listing's worth of leaked state, using the
// real functions/state exactly as loadProperty() would have on Edit.
const SEED_LEAK = () => {
  // Unit Types — one active, priced unit (this is what would flip pricing to
  // calculated/range mode if it leaked).
  loadUnitTypes([{
    id: 'u-prev', name_en: '1 Bedroom', name_lo: '', name_zh: '',
    price_amount: 450, price_currency: 'USD', price_frequency: 'month',
    is_available: true, available_count: 2, total_units: null,
    bedrooms: 1, bathrooms: 1, sort_order: 0
  }]);
  // Building Rental Terms — set via the real onChange so the module-scoped
  // _buildingRentalTermsValues (not a window global) is actually populated,
  // then render it into #rental-terms-building.
  _onBuildingRentalTermChange('deposit', { type: 'months_of_rent', value: 2 });
  renderBuildingRentalTerms();
  // Owner picker — inject a selected owner option (as populateOwnerSelect would).
  const os = document.getElementById('f-owner-select');
  const opt = document.createElement('option');
  opt.value = 'owner-prev'; opt.textContent = 'Mr Previous Owner';
  os.appendChild(opt); os.value = 'owner-prev';
  // Lease-duration tiers + a leftover standard field.
  document.getElementById('f-rent-3mo').value = '380';
  document.getElementById('f-rent-6mo').value = '350';
  document.getElementById('f-rent-12mo').value = '320';
  document.getElementById('f-title-en').value = 'PREVIOUS LISTING TITLE';
  // Make pricing actually reflect the leaked units (for_rent, recompute).
  document.getElementById('f-transaction').value = 'for_rent';
  onTransactionChange();
};

const SNAPSHOT = () => ({
  unitCards: document.querySelectorAll('#unit-types-list .ut-card').length,
  // Observe rental-terms state via its rendered DOM (the module var isn't global).
  rentalDepositFilled: [...document.querySelectorAll('#rental-terms-building input[type=number]')].some(i => i.value !== ''),
  owner: document.getElementById('f-owner-select').value,
  lease3: document.getElementById('f-rent-3mo').value,
  lease6: document.getElementById('f-rent-6mo').value,
  lease12: document.getElementById('f-rent-12mo').value,
  titleEn: document.getElementById('f-title-en').value,
  priceAmountDisabled: document.getElementById('f-price-amount').disabled,
  rangeHintShown: document.getElementById('price-range-hint').style.display !== 'none',
});

test.describe('admin.html New Listing reset (real page)', () => {
  test('showImportPanel() clears all previous-listing state and disables range pricing', async ({ page }) => {
    await stub(page);
    await page.goto('/admin.html');
    await page.waitForFunction(() => typeof window.showImportPanel === 'function'
      && typeof window.resetListingForm === 'function'
      && typeof window.loadUnitTypes === 'function');

    // 1. Seed the leaked previous-listing state.
    await page.evaluate(SEED_LEAK);

    // Pre-condition: the leaked, active, priced Unit Type put pricing into
    // calculated/range mode (single price field disabled), and all the
    // previous-listing state is present.
    const before = await page.evaluate(SNAPSHOT);
    expect(before.unitCards).toBe(1);
    expect(before.rentalDepositFilled, 'seeded rental terms should be present').toBe(true);
    expect(before.owner).toBe('owner-prev');
    expect(before.lease3).toBe('380');
    expect(before.titleEn).toBe('PREVIOUS LISTING TITLE');
    expect(before.priceAmountDisabled, 'leaked Unit Types should have forced range pricing').toBe(true);
    expect(before.rangeHintShown).toBe(true);

    // 2. New Listing entry point.
    await page.evaluate(() => showImportPanel());

    // 3. Everything from the previous listing is gone, and pricing is back to a
    // single editable field (leaked Unit Types can no longer trigger range mode).
    const after = await page.evaluate(SNAPSHOT);
    expect(after.unitCards, 'Unit Types must be cleared').toBe(0);
    expect(after.rentalDepositFilled, 'Rental Terms must be cleared').toBe(false);
    expect(after.owner, 'Owner must be cleared').toBe('');
    expect(after.lease3, 'lease tier 3mo must be cleared').toBe('');
    expect(after.lease6).toBe('');
    expect(after.lease12).toBe('');
    expect(after.titleEn, 'standard fields must be cleared').toBe('');
    expect(after.priceAmountDisabled, 'range pricing must be off after reset').toBe(false);
    expect(after.rangeHintShown).toBe(false);
  });

  test('Smart Import populates onto the clean form; imported data is not fought by leaked state', async ({ page }) => {
    await stub(page);
    await page.goto('/admin.html');
    await page.waitForFunction(() => typeof window.showImportPanel === 'function'
      && typeof window.populateFormFromImport === 'function');

    await page.evaluate(SEED_LEAK);
    await page.evaluate(() => showImportPanel());          // reset (New Listing)
    await page.evaluate(() => populateFormFromImport({     // then Smart Import
      title: 'Imported House', property_type: 'house', transaction_type: 'for_rent',
      price_display: '$300', location: {}
    }));

    const r = await page.evaluate(() => ({
      title: document.getElementById('f-title-en').value,
      unitCards: document.querySelectorAll('#unit-types-list .ut-card').length,
      priceAmount: document.getElementById('f-price-amount').value,
      priceAmountDisabled: document.getElementById('f-price-amount').disabled,
      owner: document.getElementById('f-owner-select').value,
    }));
    expect(r.title).toBe('Imported House');       // imported value landed
    expect(r.unitCards).toBe(0);                   // no leaked Unit Types
    expect(r.priceAmountDisabled).toBe(false);     // single price, editable
    expect(r.priceAmount).toBe('300');             // imported price, not a range from old units
    expect(r.owner).toBe('');                       // no leaked owner
  });
});
