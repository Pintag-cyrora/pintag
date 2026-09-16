// Regression tests for relocating the display-only 3/6/12-month lease-term
// pricing breakdown on listing.html.
//
// CONTEXT: a rental priced only via its lease terms (lease-pricing.js) shows
// its cheapest comparable tier as the headline price (PR #91, see
// lease-tier-headline-price.test.js -- that fix is NOT touched here). The
// full breakdown explaining what that headline price is quoted against used
// to render as a separate block deep in the Overview column, far from the
// price it explains. It now renders as .hero-lease-pricing, immediately
// under .price-block inside .hero-left -- on BOTH desktop (natural source
// order) and mobile (flex `order:2`, right after .price-block's `order:1`) --
// and the old Overview placement is gone (no duplication). It stays
// completely display-only: no selector, dropdown, or click action, and the
// existing "Lease-term pricing" label is unchanged (it is deliberately
// distinct from the separate, pre-existing "Rental Terms" deposit/utilities
// section built by rental-terms.js, which this does not touch or replace).
//
// This suite proves the position change while proving the pricing content
// itself (all three tiers, per-language labels, and the untouched cheapest-
// tier headline price from PR #91) is correct and unaffected by moving it.
const { test, expect } = require('@playwright/test');

const PARTY = { id: 'p-1', name_en: 'Souksavanh', name_lo: 'ສຸກສະຫວັນ', photo_url: null, agency_name: 'Pintag Realty', slug: 'souksavanh', type: 'agent', bio_en: '', bio_lo: '', is_verified: true, is_active: true, whatsapp: '020 5551 2345' };
const CONTACT = { id: 'c1', role: 'agent', name: 'Souksavanh', phone: '020 5551 2345', whatsapp: '020 5551 2345', is_verified: true, languages: ['lo', 'en'] };

function baseRow(overrides) {
  return Object.assign({
    id: 'id-a1', slug: 'a1', status: 'active', workflow_status: 'active', market_status: 'available', deleted_at: null,
    title_en: 'Riverside Studio', title_lo: 'ອາພາດເມັນແມ່ນ້ຳຂອງ', title_zh: '河边公寓',
    property_type: 'apartment', property_style: null, transaction_type: 'for_rent',
    price_amount: null, price_currency: null, price_frequency: null, price_display: null,
    rent_price_amount: null, rent_price_currency: null, rent_price_frequency: null,
    rent_price_daily: null, rent_price_3mo: null, rent_price_6mo: null, rent_price_12mo: null, lease_price_basis: null,
    sale_price: null, rent_price: null, rent_period: null, price_previous: null,
    bedrooms: 1, bathrooms: 1, sqm: 40, sqm_land: null, floors: null, furnished: null,
    description_en: 'A cozy studio near the river.', description_lo: 'ຫ້ອງນ້ອຍໃກ້ແມ່ນ້ຳ.', description_zh: '靠近河边的舒适公寓。',
    features: [], amenities: [], highlights: null,
    province_en: 'Vientiane Capital', province_lo: 'ນະຄອນຫຼວງວຽງຈັນ', province_zh: '万象首都',
    district_en: 'Sisattanak', district_lo: 'ສີສັດຕະນາກ', district_zh: '西萨塔纳', village_en: 'Thongkang',
    map_embed_url: null, nearby_places: [], images: ['https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1200'],
    is_featured: false, view_count: 3, created_at: '2026-08-01T00:00:00Z',
    contact_id: 'c1', managed_by_party_id: 'p-1', rental_terms: null, available_from: null,
    contacts: CONTACT, parties: PARTY,
    property_contacts: [{ sort_order: 0, is_primary: true, contacts: CONTACT }],
    unit_types: [],
  }, overrides);
}

// The exact bug-report fixture: 3mo=$700, 6mo=$600, 1yr=$500, no base price_amount.
const LEASE_ROW = baseRow({
  slug: 'lease1',
  rent_price_3mo: 700, rent_price_6mo: 600, rent_price_12mo: 500, lease_price_basis: 'monthly',
});

// A plain listing with a normal price_amount and NO lease tiers at all --
// proves .hero-lease-pricing doesn't appear where it never used to, and that
// the ordinary headline price path is completely unaffected by this change.
const PLAIN_ROW = baseRow({
  slug: 'plain1', price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450 / month',
});

// A listing with unit_types AND lease tiers, so selectUnitType() (a full
// buildMockupLayout() re-render) has something real to select. Per
// lease-pricing.js rule 8 ("tiers do NOT inherit per unit type -- a tier is
// a discount quoted against a specific base rent"), the property-level
// tiers below apply only while viewing the property as a whole: Unit A
// carries its own tiers (shown once selected), Unit B carries none of its
// own (so the breakdown correctly disappears once selected -- it would be
// misleading to show the building's tiers as if quoted against Unit B).
const MULTI_UNIT_LEASE_ROW = baseRow({
  slug: 'lease2',
  rent_price_3mo: 700, rent_price_6mo: 600, rent_price_12mo: 500, lease_price_basis: 'monthly',
  unit_types: [
    { id: 'u1', sort_order: 0, name_en: 'Unit A', name_lo: 'ຫ້ອງ A', name_zh: 'A单元', price_display: '$300/mo', is_available: true, available_count: 1, total_units: 1, rent_price_3mo: 350, rent_price_6mo: 320, rent_price_12mo: 300, lease_price_basis: 'monthly' },
    { id: 'u2', sort_order: 1, name_en: 'Unit B', name_lo: 'ຫ້ອງ B', name_zh: 'B单元', price_display: '$500/mo', is_available: true, available_count: 1, total_units: 1 },
  ],
});

async function mockRest(page, rows) {
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({
    status: 200, contentType: 'application/javascript',
    body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}}};}};',
  }));
  await page.route('**/unpkg.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('**/rest/v1/**', (r) => {
    const u = new URL(r.request().url());
    const t = u.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (d) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    if (t.startsWith('rpc/')) return json({});
    if (t === 'properties') return json(rows);
    if (t === 'parties') return json([PARTY]);
    return json([]);
  });
  await page.route('**/functions/v1/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
}

test.describe('desktop (1400x900)', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('.hero-lease-pricing renders as the child of .hero-left immediately after .price-block, and is no longer present in the Overview column', async ({ page }) => {
    await mockRest(page, [LEASE_ROW]);
    await page.goto('/listing.html?slug=lease1&lang=en');
    await page.waitForSelector('.hero-lease-pricing');

    const heroLeftClassOrder = await page.$$eval('.hero-left > *', (els) => els.map((el) => el.className));
    const priceIdx = heroLeftClassOrder.findIndex((c) => c.includes('price-block'));
    const leaseIdx = heroLeftClassOrder.findIndex((c) => c.includes('hero-lease-pricing'));
    expect(priceIdx).toBeGreaterThanOrEqual(0);
    expect(leaseIdx).toBe(priceIdx + 1); // the VERY next sibling

    const overviewText = await page.$eval('.detail-grid', (el) => el.innerText);
    expect(overviewText).not.toContain('Lease-term pricing');
    await expect(page.locator('.hero-lease-pricing')).toHaveCount(1); // never duplicated
  });

  test('keeps the existing "Lease-term pricing" label unchanged, and shows all three tiers in duration order', async ({ page }) => {
    await mockRest(page, [LEASE_ROW]);
    await page.goto('/listing.html?slug=lease1&lang=en');
    await page.waitForSelector('.hero-lease-pricing-line');

    const label = await page.$eval('.hero-lease-pricing .section-label', (el) => el.textContent.trim());
    expect(label).toBe('Lease-term pricing');

    const lines = await page.$$eval('.hero-lease-pricing-line', (els) => els.map((el) => el.textContent.trim()));
    expect(lines).toEqual([
      '3 months — $700 / month',
      '6 months — $600 / month',
      '1 year — $500 / month',
    ]);
  });

  test('is completely display-only: no button, select, or clickable control inside it', async ({ page }) => {
    await mockRest(page, [LEASE_ROW]);
    await page.goto('/listing.html?slug=lease1&lang=en');
    await page.waitForSelector('.hero-lease-pricing');
    const interactive = await page.$$eval('.hero-lease-pricing button, .hero-lease-pricing select, .hero-lease-pricing input, .hero-lease-pricing a', (els) => els.length);
    expect(interactive).toBe(0);
  });

  test('the headline .price-block is unchanged from PR #91: it still shows the cheapest comparable tier, with no "From" prefix on the detail page', async ({ page }) => {
    await mockRest(page, [LEASE_ROW]);
    await page.goto('/listing.html?slug=lease1&lang=en');
    await page.waitForSelector('.hero-lease-pricing');
    const headline = await page.$eval('.price-block', (el) => el.textContent.trim());
    expect(headline).toBe('$500 / month');
  });

  test('localization: the label and all three lines are correctly translated in lo/en/zh', async ({ page }) => {
    await mockRest(page, [LEASE_ROW]);
    await page.goto('/listing.html?slug=lease1&lang=en');
    await page.waitForSelector('.hero-lease-pricing-line');

    const expected = {
      en: { label: 'Lease-term pricing', lines: ['3 months — $700 / month', '6 months — $600 / month', '1 year — $500 / month'] },
      lo: { label: 'ລາຄາຕາມໄລຍະເຊົ່າ', lines: ['3 ເດືອນ — $700 / ເດືອນ', '6 ເດືອນ — $600 / ເດືອນ', '1 ປີ — $500 / ເດືອນ'] },
      zh: { label: '租期价格', lines: ['3个月 — $700 / 月', '6个月 — $600 / 月', '1年 — $500 / 月'] },
    };
    for (const lang of ['lo', 'en', 'zh']) {
      await page.click(`.lang-btn[data-lang="${lang}"]`);
      await page.waitForTimeout(150);
      const label = await page.$eval('.hero-lease-pricing .section-label', (el) => el.textContent.trim());
      const lines = await page.$$eval('.hero-lease-pricing-line', (els) => els.map((el) => el.textContent.trim()));
      expect(label).toBe(expected[lang].label);
      expect(lines).toEqual(expected[lang].lines);
      // Still directly after price-block on every re-render, not just the first.
      const order = await page.$$eval('.hero-left > *', (els) => els.map((el) => el.className));
      const p = order.findIndex((c) => c.includes('price-block'));
      const l = order.findIndex((c) => c.includes('hero-lease-pricing'));
      expect(l).toBe(p + 1);
    }
  });

  test('a listing with no lease tiers configured at all does not render .hero-lease-pricing, and its ordinary priced headline is unaffected', async ({ page }) => {
    await mockRest(page, [PLAIN_ROW]);
    await page.goto('/listing.html?slug=plain1&lang=en');
    await page.waitForSelector('.price-block');
    await expect(page.locator('.hero-lease-pricing')).toHaveCount(0);
    const headline = await page.$eval('.price-block', (el) => el.textContent.trim());
    expect(headline).toBe('$450 / month');
  });

  test('unit selection (full buildMockupLayout() re-render): a unit with its own tiers shows them right after the price, still a single instance', async ({ page }) => {
    await mockRest(page, [MULTI_UNIT_LEASE_ROW]);
    await page.goto('/listing.html?slug=lease2&lang=en');
    await page.waitForSelector('.hero-lease-pricing');
    await expect(page.locator('.hero-lease-pricing')).toHaveCount(1);

    const unitCards = page.locator('.unit-card');
    if (await unitCards.count()) {
      await unitCards.nth(0).click(); // Unit A -- has its own 3/6/12mo tiers
      await page.waitForTimeout(200);
      await expect(page.locator('.hero-lease-pricing')).toHaveCount(1);
      const lines = await page.$$eval('.hero-lease-pricing-line', (els) => els.map((el) => el.textContent.trim()));
      expect(lines).toEqual([
        '3 months — $350 / month',
        '6 months — $320 / month',
        '1 year — $300 / month',
      ]);
      const order = await page.$$eval('.hero-left > *', (els) => els.map((el) => el.className));
      const p = order.findIndex((c) => c.includes('price-block'));
      const l = order.findIndex((c) => c.includes('hero-lease-pricing'));
      expect(l).toBe(p + 1);
    }
  });

  test('unit selection: a unit with no tiers of its own correctly hides the breakdown (rule 8 -- tiers never inherit from the property to a specific unit), with no stale copy left in Overview', async ({ page }) => {
    await mockRest(page, [MULTI_UNIT_LEASE_ROW]);
    await page.goto('/listing.html?slug=lease2&lang=en');
    await page.waitForSelector('.hero-lease-pricing');

    const unitCards = page.locator('.unit-card');
    if (await unitCards.count() > 1) {
      await unitCards.nth(1).click(); // Unit B -- no tiers of its own
      await page.waitForTimeout(200);
      await expect(page.locator('.hero-lease-pricing')).toHaveCount(0);
      const overviewText = await page.$eval('.detail-grid', (el) => el.innerText);
      expect(overviewText).not.toContain('Lease-term pricing');
    }
  });
});

test.describe('mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('visual order: the lease-pricing breakdown renders directly below the price and above everything else in .hero-left', async ({ page }) => {
    await mockRest(page, [LEASE_ROW]);
    await page.goto('/listing.html?slug=lease1&lang=en');
    await page.waitForSelector('.hero-lease-pricing');

    // The authoritative source of visual order on mobile is the computed
    // flex `order` (see listing.html's @media(max-width:960px) block) --
    // NOT bounding-rect `top`, which ties for zero-height siblings.
    const items = await page.$$eval('.hero-left > *', (els) => els.map((el) => ({
      cls: el.className,
      order: parseInt(getComputedStyle(el).order, 10) || 0,
    })));
    const byOrder = items.slice().sort((a, b) => a.order - b.order);
    const clsList = byOrder.map((p) => p.cls);
    const priceIdx = clsList.findIndex((c) => c.includes('price-block'));
    const leaseIdx = clsList.findIndex((c) => c.includes('hero-lease-pricing'));
    expect(priceIdx).toBeGreaterThanOrEqual(0);
    expect(leaseIdx).toBe(priceIdx + 1); // nothing else sits between price and its breakdown
    for (const cls of ['hero-badges-row', 'sp-metrics-row', 'info-title', 'hero-map-section', 'hero-location', 'spec-grid', 'highlight-pills', 'left-actions']) {
      const idx = clsList.findIndex((c) => c.includes(cls));
      if (idx !== -1) expect(idx).toBeGreaterThan(leaseIdx);
    }

    // Cross-check against actual on-screen geometry.
    const priceTop = await page.$eval('.price-block', (el) => el.getBoundingClientRect().bottom);
    const leaseTop = await page.$eval('.hero-lease-pricing', (el) => el.getBoundingClientRect().top);
    expect(leaseTop).toBeGreaterThanOrEqual(priceTop - 1); // sub-pixel tolerance
  });

  test('reads as part of the price block: tight vertical gap, no divider/border between price and breakdown', async ({ page }) => {
    await mockRest(page, [LEASE_ROW]);
    await page.goto('/listing.html?slug=lease1&lang=en');
    await page.waitForSelector('.hero-lease-pricing');
    const priceBottom = await page.$eval('.price-block', (el) => el.getBoundingClientRect().bottom);
    const leaseTop = await page.$eval('.hero-lease-pricing', (el) => el.getBoundingClientRect().top);
    expect(leaseTop - priceBottom).toBeLessThan(20); // tight spacing, not a distant standalone section
  });

  test('no horizontal overflow / clipping introduced by the relocated lease-pricing block', async ({ page }) => {
    await mockRest(page, [LEASE_ROW]);
    await page.goto('/listing.html?slug=lease1&lang=en');
    await page.waitForSelector('.hero-lease-pricing');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('all three tiers still render correctly on mobile', async ({ page }) => {
    await mockRest(page, [LEASE_ROW]);
    await page.goto('/listing.html?slug=lease1&lang=en');
    await page.waitForSelector('.hero-lease-pricing-line');
    const lines = await page.$$eval('.hero-lease-pricing-line', (els) => els.map((el) => el.textContent.trim()));
    expect(lines).toEqual([
      '3 months — $700 / month',
      '6 months — $600 / month',
      '1 year — $500 / month',
    ]);
  });
});
