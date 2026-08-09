// Agent soft-hide (parties.is_active) — PUBLIC surfaces.
//
// WHY THIS SUITE EXISTS
// Hiding an agent must (a) drop their standalone public profile page and
// (b) NOT drop them from listings they already manage. These two rules pull
// in opposite directions, so both are pinned here against real page loads
// with mocked Supabase (no network, no auth):
//   * agents.html / agent.html fetch the profile with is_active=eq.true, so a
//     hidden agent's profile returns not-found.
//   * listing.html joins the managing party by id and renders it regardless of
//     is_active, so a listing keeps showing a hidden agent's name/branding.

const { test, expect } = require('@playwright/test');

const AGENT = {
  id: 'agent-daeng', type: 'agent', slug: 'daeng',
  name_en: 'Daeng Somphone', name_lo: 'ແດງ', agency_name: 'Pintag',
  photo_url: null, whatsapp: '02055500000', bio_en: 'Advisor.', bio_lo: 'ທີ່ປຶກສາ',
  is_verified: true, is_active: true,
};

// Route the profile fetch and report back whether it carried is_active=eq.true.
// `rows` is what the (filtered) query returns: the agent when visible, [] when
// the is_active=eq.true filter hides them.
function mockProfile(page, rows, seen) {
  return page.route('**/rest/v1/parties**', (route) => {
    seen.url = route.request().url();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
}
function mockAgentListings(page) {
  return page.route('**/rest/v1/properties**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}

for (const pageFile of ['agents.html', 'agent.html']) {
  test.describe(pageFile + ' public agent profile', () => {
    test('fetches the profile filtered by is_active=eq.true', async ({ page }) => {
      const seen = {};
      await mockProfile(page, [AGENT], seen);
      await mockAgentListings(page);
      await page.goto('/' + pageFile + '?slug=daeng');
      await expect(page.locator('#page')).toBeVisible();
      expect(seen.url, 'the profile query must exclude hidden agents').toContain('is_active=eq.true');
    });

    test('a visible agent renders', async ({ page }) => {
      const seen = {};
      await mockProfile(page, [AGENT], seen);
      await mockAgentListings(page);
      await page.goto('/' + pageFile + '?slug=daeng');
      await expect(page.locator('#page')).toBeVisible();
      // The hero shows the agent's name (Lao-first: name_lo || name_en).
      await expect(page.locator('body')).toContainText('ແດງ');
    });

    test('a hidden agent (filtered out) shows not-found, not the profile', async ({ page }) => {
      const seen = {};
      // is_active=eq.true means a hidden agent comes back as [] from the query.
      await mockProfile(page, [], seen);
      await mockAgentListings(page);
      await page.goto('/' + pageFile + '?slug=daeng');
      await expect(page.locator('#page')).toBeHidden();
      await expect(page.locator('body')).not.toContainText('ແດງ');
    });
  });
}

test.describe('listing.html attribution for a hidden agent', () => {
  // The listing detail page joins parties by managed_by_party_id and renders
  // the agent when type==='agent' — with NO is_active filter. This guards
  // against a regression that would hide the agent from their own listings.
  function activeProp(over) {
    return Object.assign({
      id: 'p-1', slug: 'riverside-villa', title_en: 'Riverside Villa', title_lo: 'ວິນລາ', title_zh: '别墅',
      property_type: 'house', transaction_type: 'for_rent',
      price_amount: 800, price_currency: 'USD', price_frequency: 'monthly', price_display: '$800/month',
      images: ['https://example.com/a.jpg'], amenities: [], features: [],
      district_en: 'Sisattanak', workflow_status: 'active', market_status: 'available', status: 'active',
      created_at: new Date().toISOString(), bedrooms: 3, bathrooms: 2, sqm: 120,
      contacts: { id: 'c-1', role: 'agent', name: 'Daeng Somphone', phone: '02055500000', whatsapp: '02055500000' },
      managed_by_party_id: 'agent-daeng',
      // The managing agent is HIDDEN (is_active:false) — the listing must still
      // display them. listing.html renders `parties` when type==='agent'.
      parties: { id: 'agent-daeng', type: 'agent', name_en: 'Daeng Somphone', name_lo: 'ແດງ',
                 slug: 'daeng', photo_url: null, agency_name: 'Pintag', bio_en: 'Advisor.', bio_lo: 'ທີ່ປຶກສາ',
                 is_verified: true, is_active: false },
      unit_types: [],
    }, over || {});
  }

  test('a listing still shows the name of the hidden agent that manages it', async ({ page }) => {
    await page.route('**/rest/v1/**', (route) => {
      const url = route.request().url();
      if (url.indexOf('/properties?slug=eq.') !== -1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([activeProp()]) });
      }
      if (url.indexOf('/rpc/') !== -1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/listing.html?slug=riverside-villa&lang=en');
    await page.waitForTimeout(600);
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain('No property selected');
    // The agent-profile block renders the hidden agent's name.
    expect(bodyText).toContain('Daeng Somphone');
  });
});
