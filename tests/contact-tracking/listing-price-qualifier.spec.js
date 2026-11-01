// Starting price vs exact price on the PUBLIC listing detail page (real listing.html, mocked Supabase).
//
// A multi-unit listing advertised from $350/month must say "From $350 / month" -- never a bare "$350 / month" that reads
// as the confirmed rent of whatever unit is on screen. Exact prices stay exact, a selected unit shows ITS OWN exact price,
// and the share text / link-preview metadata and the Similar Properties tile carry the same qualifier. Lao, English and
// Chinese (Chinese puts 起 after the price).
const { test, expect } = require('@playwright/test');

const A = { id: 'a', role: 'agent', name: 'Somchai', phone: '+856 20 111 1111', whatsapp: '+856 20 111 1111', languages: ['lo', 'en'] };
const UT = (id, name, amount, o) => Object.assign({ id, name_en: name, name_lo: name, name_zh: name, is_available: true, available_count: 2, total_units: null,
  next_available_date: null, bedrooms: 1, bathrooms: 1, sqm: 30, price_amount: amount, price_currency: 'USD', price_frequency: 'monthly', images: [] }, o || {});
const STUDIO = UT('u-studio', 'Studio', 350), TWO = UT('u-two', 'Two Bedroom', 500);
const prop = (o) => Object.assign({
  id: 'p-main', slug: 'main-test', title_en: 'Main Place', title_lo: 'ບ່ອນຫຼັກ', title_zh: '主房源', property_type: 'apartment', transaction_type: 'for_rent',
  price_amount: 350, price_currency: 'USD', price_frequency: 'monthly', price_display: '$350 / month', images: ['https://example.com/a.jpg'],
  amenities: [], features: [], district_en: 'Sisattanak', workflow_status: 'active', market_status: 'available', status: 'active',
  created_at: new Date().toISOString(), bedrooms: 1, bathrooms: 1, sqm: 30, contacts: null,
  property_contacts: [{ sort_order: 0, is_primary: true, contacts: A }], managed_by_party_id: 'party-1', parties: null, unit_types: [],
}, o || {});
const MULTI = (o) => prop(Object.assign({ unit_types: [STUDIO, TWO] }, o || {}));

async function open(page, row, { lang = 'en', similar = [], query = '' } = {}) {
  await page.addInitScript(() => { window.open = () => null; });
  await page.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    const ok = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.indexOf('/properties?slug=eq.') !== -1) return ok([row]);
    if (url.indexOf('/properties?property_type=eq.') !== -1) return ok(similar);
    if (url.indexOf('/rpc/') !== -1) return ok({});
    return ok([]);
  });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/listing.html?slug=' + row.slug + '&lang=' + lang + query);
  await page.waitForSelector('#section-price .price-value, #section-price .price-inquire');
  await page.waitForTimeout(400);
  return errors;
}
const headline = (page) => page.locator('#section-price .price-value').first();
const norm = (t) => String(t).replace(/\s+/g, ' ').trim();

test.describe('detail page headline', () => {
  for (const [lang, want] of [['en', 'From $350 / month'], ['lo', 'ເລີ່ມຕົ້ນ $350 / ເດືອນ'], ['zh', '$350 / 月起']]) {
    test(`a multi-unit listing with differing unit prices says it is a starting price (${lang})`, async ({ page }) => {
      const errors = await open(page, MULTI(), { lang });
      expect(norm(await headline(page).innerText())).toBe(want);
      await expect(headline(page)).toHaveAttribute('data-price-kind', 'from');
      expect(errors).toEqual([]);
    });
  }

  test('the span of unit prices is shown on its own line; the headline stays the minimum', async ({ page }) => {
    await open(page, MULTI());
    expect(norm(await page.locator('#section-price .price-range').innerText())).toBe('$350–500 / month');
    expect(norm(await headline(page).innerText())).toBe('From $350 / month');
  });

  test('English/Lao put the word BEFORE the price, Chinese puts 起 AFTER it', async ({ page }) => {
    await open(page, MULTI(), { lang: 'en' });
    expect(await page.locator('#section-price .price-value').first().evaluate((el) => el.firstElementChild.className)).toContain('price-from');
    const p2 = await page.context().newPage();
    await open(p2, MULTI(), { lang: 'zh' });
    expect(await p2.locator('#section-price .price-value').first().evaluate((el) => el.lastElementChild.className)).toContain('price-from-suffix');
    await p2.close();
  });

  for (const [lang, want] of [['en', '$350 / month'], ['lo', '$350 / ເດືອນ'], ['zh', '$350 / 月']]) {
    test(`an EXACT price (a plain listing) is unchanged: no qualifier, no range line (${lang})`, async ({ page }) => {
      await open(page, prop(), { lang });
      expect(norm(await headline(page).innerText())).toBe(want);
      await expect(headline(page)).toHaveAttribute('data-price-kind', 'exact');
      await expect(page.locator('#section-price .price-from')).toHaveCount(0);
      await expect(page.locator('#section-price .price-range')).toHaveCount(0);
    });
  }

  test('units that all cost the same are NOT turned into a starting price', async ({ page }) => {
    await open(page, MULTI({ unit_types: [UT('a', 'Studio', 350), UT('b', 'Studio 2', 350)] }));
    expect(norm(await headline(page).innerText())).toBe('$350 / month');
    await expect(page.locator('#section-price .price-from')).toHaveCount(0);
  });

  test('LAK and THB keep their own symbols in the qualified price', async ({ page }) => {
    await open(page, MULTI({ price_amount: 3000000, price_currency: 'LAK', unit_types: [UT('a', 'Fan', 3000000, { price_currency: 'LAK' }), UT('b', 'AC', 4000000, { price_currency: 'LAK' })] }));
    expect(norm(await headline(page).innerText())).toBe('From ₭3,000,000 / month');
    const p2 = await page.context().newPage();
    await open(p2, MULTI({ slug: 'thb', price_amount: 9000, price_currency: 'THB', unit_types: [UT('a', 'A', 9000, { price_currency: 'THB' }), UT('b', 'B', 12000, { price_currency: 'THB' })] }), { lang: 'lo' });
    expect(norm(await p2.locator('#section-price .price-value').first().innerText())).toBe('ເລີ່ມຕົ້ນ ฿9,000 / ເດືອນ');
    await p2.close();
  });

  test('selecting a unit shows THAT unit\'s own exact price (no "From")', async ({ page }) => {
    await open(page, MULTI(), { query: '&unit=two-bedroom' });
    expect(norm(await headline(page).innerText())).toBe('$500 / month');
    await expect(page.locator('#section-price .price-from')).toHaveCount(0);
  });

  test('missing or invalid pricing -> "Price on request", never "null" / "NaN" / "$0"', async ({ page }) => {
    for (const bad of [null, 0, 'abc']) {
      const p2 = await page.context().newPage();
      await open(p2, prop({ slug: 'bad-' + String(bad), price_amount: bad, price_display: null }));
      const text = norm(await p2.locator('#section-price').innerText());
      expect(text).toMatch(/Price on request|Inquire|ສອບຖາມ/i);
      expect(text).not.toMatch(/null|NaN|\$0\b/);
      await p2.close();
    }
  });
});

test.describe('share text and link-preview metadata', () => {
  const meta = (page) => page.evaluate(() => ({
    desc: document.querySelector('meta[property="og:description"]').getAttribute('content'),
    tw: document.querySelector('meta[name="twitter:description"]').getAttribute('content'),
    meta: document.querySelector('meta[name="description"]').getAttribute('content'),
    share: (typeof getListingSharePayload === 'function' && getListingSharePayload()) ? getListingSharePayload().text : null,
  }));
  for (const [lang, re] of [['en', /^From \$350 \/ month/], ['lo', /^ເລີ່ມຕົ້ນ \$350 \/ ເດືອນ/], ['zh', /^\$350 \/ 月起/]]) {
    test(`a starting price is qualified in og:description, twitter:description, the meta description and the share text (${lang})`, async ({ page }) => {
      await open(page, MULTI(), { lang });
      const m = await meta(page);
      expect(m.desc).toMatch(re); expect(m.tw).toMatch(re); expect(m.meta).toMatch(re);
      if (m.share) expect(m.share).toMatch(re);
    });
  }
  test('an exact price is not qualified in the metadata', async ({ page }) => {
    await open(page, prop());
    const m = await meta(page);
    expect(m.desc).toMatch(/^\$350 \/ month/); expect(m.desc).not.toMatch(/^From/);
  });
});

test.describe('Similar Properties tile', () => {
  const sim = (slug, units) => prop({ id: 'p-' + slug, slug, title_en: 'Sim ' + slug, title_lo: 'Sim', title_zh: 'Sim', price_amount: 350, unit_types: units });
  test('a similar multi-unit listing says "From" with its unit; an exact one does not', async ({ page }) => {
    await open(page, prop({ slug: 'host' }), { similar: [sim('multi', [STUDIO, TWO]), sim('exact', [])] });
    const tiles = page.locator('.pt-preview');
    await expect(tiles.first()).toBeVisible();
    const texts = (await page.locator('.pt-preview-price').allInnerTexts()).map(norm);
    expect(texts).toContain('From $350 / month');
    expect(texts).toContain('$350 / month');
  });
});
