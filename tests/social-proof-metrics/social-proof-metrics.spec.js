// Regression tests for the public "Views · Inquiries" social-proof row on
// listing.html.
//
// CONTEXT: Views and Inquiries existed in the data (properties.view_count,
// and the per-listing lead/inquiry count public_listing_stats() already
// aggregates -- see supabase/migrations/20260926000000_public_listing_
// stats_leads_source.sql) but were invisible to most real visitors: the
// old sp-views/sp-inquiries pills (formatViewCount()/formatInquiryCount())
// hid themselves entirely below a threshold (views < 10, inquiries < 5)
// and rounded/fuzzed everything else ("5+ inquiries", "1.2k views") -- a
// deliberate FOMO/marketing design for a DIFFERENT purpose, but it meant
// the actual exact counts staff already see in admin.html's and
// dashboard.html's own per-listing "views · leads" columns were never
// shown to the public at all for a typical (low-traffic) listing.
//
// This suite proves the row now shown at the same DOM position
// (.sp-metrics-row, immediately after .price-block and before the agent
// band) always renders, with the EXACT count public_listing_stats()
// returned -- including 0 -- in all three languages, and reads ONLY
// view_count/lead_count from that response (nothing else, even if present).
//
// No new tracking/counter is exercised or asserted here: every test mocks
// rpc/public_listing_stats directly, the one existing RPC loadPublicStats()
// already calls.
const { test, expect } = require('@playwright/test');

const PARTY = { id: 'p-1', name_en: 'Souksavanh', name_lo: 'ສຸກສະຫວັນ', photo_url: null, agency_name: 'Pintag Realty', slug: 'souksavanh', type: 'agent', bio_en: '', bio_lo: '', is_verified: true, is_active: true, whatsapp: '020 5551 2345' };
const CONTACT = { id: 'c1', role: 'agent', name: 'Souksavanh', phone: '020 5551 2345', whatsapp: '020 5551 2345', is_verified: true, languages: ['lo', 'en'] };

function baseRow(overrides) {
  return Object.assign({
    id: 'id-a1', slug: 'a1', status: 'active', workflow_status: 'active', market_status: 'available', deleted_at: null,
    title_en: 'Riverside Apartment', title_lo: 'ອາພາດເມັນແມ່ນ້ຳຂອງ', title_zh: '河边公寓',
    property_type: 'apartment', property_style: null, transaction_type: 'for_rent',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', rent_price_amount: null, rent_price_currency: null, rent_price_frequency: null,
    price_display: '$450 / month', sale_price: null, rent_price: null, rent_period: null, price_previous: null,
    bedrooms: 2, bathrooms: 1, sqm: 65, sqm_land: null, floors: null, furnished: null,
    description_en: 'A lovely riverside apartment.', description_lo: 'ອາພາດເມັນ.', description_zh: '公寓。',
    features: [], amenities: [], highlights: null,
    province_en: 'Vientiane Capital', province_lo: 'ນະຄອນຫຼວງວຽງຈັນ', province_zh: '万象首都',
    district_en: 'Sisattanak', district_lo: 'ສີສັດຕະນາກ', district_zh: '西萨塔纳', village_en: 'Thongkang',
    map_embed_url: null, nearby_places: [],
    images: ['https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200'],
    is_featured: false, view_count: 128, created_at: '2026-08-01T00:00:00Z',
    contact_id: 'c1', managed_by_party_id: 'p-1', rental_terms: null, available_from: null,
    contacts: CONTACT, parties: PARTY,
    property_contacts: [{ sort_order: 0, is_primary: true, contacts: CONTACT }],
    unit_types: [],
  }, overrides);
}

const ROW = baseRow();

// mockRest lets each test supply its own rpc/public_listing_stats response
// (the SAME RPC listing.html's loadPublicStats() already calls) -- default
// {} so tests that don't care about the row still work like every other
// suite's mockRest().
async function mockRest(page, rows, statsResponse) {
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({
    status: 200, contentType: 'application/javascript',
    body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}}};}};',
  }));
  await page.route('**/unpkg.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('**/rest/v1/**', (r) => {
    const u = new URL(r.request().url());
    const t = u.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (d) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    if (t === 'rpc/public_listing_stats') return json(statsResponse !== undefined ? statsResponse : {});
    if (t.startsWith('rpc/')) return json({});
    if (t === 'properties') return json(rows);
    if (t === 'parties') return json([PARTY]);
    return json([]);
  });
  await page.route('**/functions/v1/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
}

test.describe('desktop (1400x900)', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('exact counts render, matching the example format ("128 views · 7 inquiries")', async ({ page }) => {
    await mockRest(page, [ROW], { view_count: 128, lead_count: 7 });
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('#sp-views:visible');

    await expect(page.locator('#sp-views')).toHaveText('👁 128 views');
    await expect(page.locator('#sp-inquiries')).toHaveText('💬 7 inquiries');
    await expect(page.locator('#sp-inquiries')).toBeVisible();

    // A visible "·" separator between the two metrics (CSS ::before content
    // on the second .sp-metric) -- matches the requested compact format
    // "👁 128 views · 💬 7 inquiries".
    const separator = await page.$eval('#sp-inquiries', (el) => getComputedStyle(el, '::before').content);
    expect(separator.replace(/"/g, '')).toContain('·');
  });

  test('zero case: view_count=0 and lead_count=0 both DISPLAY "0", never hidden', async ({ page }) => {
    await mockRest(page, [ROW], { view_count: 0, lead_count: 0 });
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('#sp-views');
    // Give loadPublicStats() a moment to resolve and applyPublicStats() to run.
    await page.waitForFunction(() => {
      const el = document.getElementById('sp-views');
      return el && el.textContent.trim().length > 0;
    });

    await expect(page.locator('#sp-views')).toBeVisible();
    await expect(page.locator('#sp-inquiries')).toBeVisible();
    await expect(page.locator('#sp-views')).toHaveText('👁 0 views');
    await expect(page.locator('#sp-inquiries')).toHaveText('💬 0 inquiries');
  });

  test('no rounding/fuzzing: a large view count and a small inquiry count both render exactly', async ({ page }) => {
    await mockRest(page, [ROW], { view_count: 12345, lead_count: 3 });
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('#sp-views:visible');

    // Old behavior would have shown "12.3k views" and hidden "3 inquiries"
    // entirely (below its old threshold of 5) -- neither may happen now.
    await expect(page.locator('#sp-views')).toHaveText('👁 12345 views');
    await expect(page.locator('#sp-inquiries')).toHaveText('💬 3 inquiries');
  });

  test('placement: .sp-metrics-row is the child immediately after .price-block\'s group and before the agent band, in DOM order', async ({ page }) => {
    await mockRest(page, [ROW], { view_count: 128, lead_count: 7 });
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('#sp-views:visible');

    const heroLeftOrder = await page.$$eval('.hero-left > *', (els) => els.map((el) => el.className));
    const priceIdx   = heroLeftOrder.findIndex((c) => c.includes('price-block'));
    const metricsIdx = heroLeftOrder.findIndex((c) => c.includes('sp-metrics-row'));
    expect(priceIdx).toBeGreaterThanOrEqual(0);
    expect(metricsIdx).toBeGreaterThan(priceIdx); // underneath the price section

    // .sp-metrics-row lives inside .hero-left; the agent band is a
    // separate section further down the page. Direct, unambiguous check:
    // agent-band-anchor must come AFTER sp-metrics-row in the rendered
    // document, i.e. the row is never pushed below agent info.
    const beforeAgent = await page.evaluate(() => {
      const metrics = document.querySelector('.sp-metrics-row');
      const agent = document.getElementById('agent-band-anchor');
      if (!metrics || !agent) return null;
      // Node.compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING (4) means
      // `agent` comes after `metrics` in the document.
      return !!(metrics.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(beforeAgent).toBe(true);
  });

  test('localization: switching language re-localizes the SAME cached counts without a new RPC round-trip, in all three languages', async ({ page }) => {
    let statsCalls = 0;
    await mockRest(page, [ROW], { view_count: 128, lead_count: 7 });
    await page.route('**/rest/v1/rpc/public_listing_stats', (r) => {
      statsCalls++;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ view_count: 128, lead_count: 7 }) });
    });
    await page.goto('/listing.html?slug=a1&lang=lo');
    await page.waitForSelector('#sp-views:visible');

    const seen = {};
    for (const lang of ['lo', 'en', 'zh']) {
      await page.click(`.lang-btn[data-lang="${lang}"]`);
      await page.waitForTimeout(150);
      seen[lang] = {
        views: (await page.textContent('#sp-views')).trim(),
        inquiries: (await page.textContent('#sp-inquiries')).trim(),
      };
      expect(seen[lang].views).toContain('128');
      expect(seen[lang].inquiries).toContain('7');
    }
    expect(seen.lo.views).not.toBe(seen.en.views);
    expect(seen.en.views).not.toBe(seen.zh.views);
    expect(seen.lo.inquiries).not.toBe(seen.en.inquiries);
    expect(seen.en.inquiries).not.toBe(seen.zh.inquiries);

    // Exactly one RPC call for the whole test -- three language switches did
    // not trigger three more fetches (cached _publicStats is re-localized).
    expect(statsCalls).toBe(1);
  });

  test('no PII: the row only ever reflects view_count/lead_count, even if the RPC response carries other fields', async ({ page }) => {
    // A real public_listing_stats() response can never actually contain
    // these fields (it's an aggregate-only, anonymised RPC by design -- see
    // its own SQL comment), but this guards against a future regression
    // where someone widens the response or the rendering code and
    // accidentally surfaces something identifying a specific inquirer.
    await mockRest(page, [ROW], {
      view_count: 128, lead_count: 7,
      customer_name: 'Somchai Vongsa', customer_phone: '020 9999 1234', notes: 'Wants to view Saturday',
    });
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('#sp-views:visible');

    const rowText = await page.textContent('.sp-metrics-row');
    expect(rowText).not.toContain('Somchai');
    expect(rowText).not.toContain('020 9999 1234');
    expect(rowText).not.toContain('Saturday');
    // The "·" separator between the two spans is CSS ::before content, not
    // a real text node, so it is intentionally absent from textContent here.
    expect(rowText.replace(/\s+/g, ' ').trim()).toBe('👁 128 views💬 7 inquiries');
  });
});

test.describe('mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('responsive: the row wraps/stays compact and legible on a narrow viewport, positioned after price via computed flex order', async ({ page }) => {
    await mockRest(page, [ROW], { view_count: 128, lead_count: 7 });
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForSelector('#sp-views:visible');

    const box = await page.$eval('.sp-metrics-row', (el) => el.getBoundingClientRect());
    expect(box.width).toBeLessThan(390); // never overflows the viewport
    expect(box.height).toBeLessThan(40); // stays a single compact line, not a stacked block

    const items = await page.$$eval('.hero-left > *', (els) => els.map((el) => ({
      cls: el.className,
      order: parseInt(getComputedStyle(el).order, 10) || 0,
    })));
    const byOrder = items.slice().sort((a, b) => a.order - b.order);
    const clsList = byOrder.map((p) => p.cls);
    const priceIdx   = clsList.findIndex((c) => c.includes('price-block'));
    const metricsIdx = clsList.findIndex((c) => c.includes('sp-metrics-row'));
    expect(priceIdx).toBeGreaterThanOrEqual(0);
    expect(metricsIdx).toBeGreaterThan(priceIdx);
  });

  test('zero case is visible on mobile too', async ({ page }) => {
    await mockRest(page, [ROW], { view_count: 0, lead_count: 0 });
    await page.goto('/listing.html?slug=a1&lang=en');
    await page.waitForFunction(() => {
      const el = document.getElementById('sp-views');
      return el && el.textContent.trim().length > 0;
    });
    await expect(page.locator('#sp-views')).toBeVisible();
    await expect(page.locator('#sp-inquiries')).toBeVisible();
    await expect(page.locator('#sp-views')).toHaveText('👁 0 views');
    await expect(page.locator('#sp-inquiries')).toHaveText('💬 0 inquiries');
  });
});
