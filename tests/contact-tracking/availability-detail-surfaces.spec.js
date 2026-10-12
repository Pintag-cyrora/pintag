// Availability State Integration (PR 2) on listing.html: the browser title / OG metadata and Similar Properties follow
// the canonical resolver (property-availability.js), not market_status alone. Real page, mocked Supabase.
const { test, expect } = require('@playwright/test');

const A = { id: 'a', role: 'agent', name: 'Somchai', phone: '+856 20 111 1111', whatsapp: '+856 20 111 1111', languages: ['lo', 'en'] };
const UT = (id, o) => Object.assign({ id, name_en: id, is_available: true, available_count: 2, total_units: null, next_available_date: null,
  bedrooms: 2, bathrooms: 1, sqm: 40, price_amount: 400, price_currency: 'USD', price_frequency: 'monthly', images: [] }, o || {});
const OPEN = (id) => UT(id), FULL = (id) => UT(id, { available_count: 0, next_available_date: '2999-01-01' });
const prop = (market, units, o) => Object.assign({
  id: 'p-main', slug: 'main-test', title_en: 'Main Place', title_lo: 'ບ່ອນຫຼັກ', title_zh: '主房源', property_type: 'apartment', transaction_type: 'for_rent',
  price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450/month', images: ['https://example.com/a.jpg'],
  amenities: [], features: [], district_en: 'Sisattanak', workflow_status: 'active', market_status: market, status: 'active',
  created_at: new Date().toISOString(), bedrooms: 2, bathrooms: 1, sqm: 60, contacts: null,
  property_contacts: [{ sort_order: 0, is_primary: true, contacts: A }], managed_by_party_id: 'party-1', parties: null, unit_types: units || [],
}, o || {});

async function open(page, row, { similar = [], lang = 'en' } = {}) {
  const seen = { similarUrls: [] };
  await page.addInitScript(() => { window.open = () => null; });
  await page.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    const ok = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.indexOf('/properties?slug=eq.') !== -1) return ok([row]);
    if (url.indexOf('/properties?property_type=eq.') !== -1) {
      seen.similarUrls.push(url);
      const m = decodeURIComponent(url).match(/id=not\.in\.\(([^)]*)\)/);
      const excluded = m ? m[1].split(',') : [];
      return ok(similar.filter((r) => excluded.indexOf(r.id) === -1));       // honour the exclusion like the real query
    }
    if (url.indexOf('/rpc/') !== -1) return ok({});
    return ok([]);
  });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/listing.html?slug=' + row.slug + '&lang=' + lang);
  await page.waitForSelector('#section-price');
  await page.waitForTimeout(500);
  return { seen, errors };
}
const meta = (page) => page.evaluate(() => ({
  title: document.title,
  ogTitle: document.querySelector('meta[property="og:title"]').getAttribute('content'),
  desc: document.querySelector('meta[property="og:description"]').getAttribute('content'),
  twDesc: document.querySelector('meta[name="twitter:description"]').getAttribute('content'),
}));

// ═══ Browser title / OG metadata ═══════════════════════════════════════════════════════════════════════════════════
test.describe('title and OG metadata', () => {
  test('available: no status suffix, normal description with the price', async ({ page }) => {
    await open(page, prop('available', []));
    const m = await meta(page);
    expect(m.title).toBe('Main Place · Pintag'); expect(m.desc).toMatch(/\$450/);
  });

  test('coming_soon: Coming Soon suffix, but the normal description (no sold/rented wording) and price', async ({ page }) => {
    for (const units of [[], [OPEN('a'), OPEN('b')]]) {
      const p2 = await page.context().newPage();
      await open(p2, prop('coming_soon', units));
      const m = await meta(p2);
      expect(m.title).toBe('Main Place — Coming Soon · Pintag'); expect(m.ogTitle).toBe(m.title);
      expect(m.desc).toMatch(/\$450/); expect(m.desc).not.toMatch(/browse similar|has been|fully occupied/i); expect(m.twDesc).toBe(m.desc);
      await p2.close();
    }
  });

  test('sold / off_market / single-unit rented (even with a lone open unit row): status suffix + the "browse similar" description', async ({ page }) => {
    for (const [market, units, label, lead] of [['sold', [OPEN('a'), OPEN('b')], 'Sold', /has been sold/], ['off_market', [], 'Off Market', /off market/],
      ['rented', [OPEN('a')], 'Rented', /has been rented/]]) {
      const p2 = await page.context().newPage();
      await open(p2, prop(market, units));
      const m = await meta(p2);
      expect(m.title).toBe('Main Place — ' + label + ' · Pintag'); expect(m.desc).toMatch(lead); expect(m.desc).toMatch(/similar available properties/i);
      await p2.close();
    }
  });

  test('a property with no open unit reads Fully Occupied even though market_status says available', async ({ page }) => {
    await open(page, prop('available', [FULL('a'), FULL('b')]));
    const m = await meta(page);
    expect(m.title).toBe('Main Place — Fully Occupied · Pintag'); expect(m.desc).toMatch(/fully occupied/i);
  });

  test('a stale "rented" on a multi-unit property with an open unit is NOT labelled rented; a date does not change the state', async ({ page }) => {
    await open(page, prop('rented', [OPEN('a'), FULL('b')]));
    const m = await meta(page);
    expect(m.title).toBe('Main Place · Pintag'); expect(m.desc).toMatch(/\$450/);
  });

  test('Lao and Chinese suffixes', async ({ page }) => {
    for (const [lang, titleBase, word] of [['lo', 'ບ່ອນຫຼັກ', 'ກຳລັງຈະມາ'], ['zh', '主房源', '即将推出']]) {
      const p2 = await page.context().newPage();
      await open(p2, prop('coming_soon', []), { lang });
      expect((await meta(p2)).title).toBe(titleBase + ' — ' + word + ' · Pintag');
      await p2.close();
    }
  });
});

// ═══ Similar Properties ════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Similar Properties', () => {
  const sim = (n, market, units) => prop(market, units, { id: 'p-s' + n, slug: 'sim-' + n, title_en: 'Similar ' + n, created_at: '2026-07-0' + n + 'T00:00:00Z' });
  const SIMILAR = [
    sim(1, 'available', []),                                       // in
    sim(2, 'coming_soon', []),                                     // out: coming soon
    sim(3, 'available', [FULL('x')]),                              // out: every unit closed
    sim(4, 'sold', [OPEN('y')]),                                   // out: sold
    sim(5, 'rented', [OPEN('p'), FULL('q')]),                      // in: multi-unit with an open unit
    sim(6, 'rented', [OPEN('z')]),                                 // out: single-unit rented beats a lone open unit
    sim(7, 'available', [OPEN('w')]),                              // in
    sim(8, 'off_market', []),                                      // out
  ];

  test('only genuinely available properties are recommended, whatever market_status says', async ({ page }) => {
    const { seen } = await open(page, prop('available', []), { similar: SIMILAR });
    await expect(page.locator('#similar-grid > *')).toHaveCount(3);
    const shown = await page.locator('#similar-grid > *').evaluateAll((els) => els.map((e) => (e.textContent.match(/Similar \d/) || [])[0]).sort());
    expect(shown).toEqual(['Similar 1', 'Similar 5', 'Similar 7']);
    expect(seen.similarUrls.length).toBeGreaterThan(0);
    for (const u of seen.similarUrls) expect(decodeURIComponent(u)).toContain('unit_types(');           // the unit availability columns are fetched
    for (const u of seen.similarUrls) expect(u).toContain('status=eq.active');                          // draft/archived stay excluded server-side
  });

  test('the section is hidden when nothing similar is actually available', async ({ page }) => {
    await open(page, prop('available', []), { similar: SIMILAR.filter((s) => ['Similar 2', 'Similar 3', 'Similar 4', 'Similar 6', 'Similar 8'].indexOf(s.title_en) !== -1) });
    await expect(page.locator('#similar-section')).toBeHidden();
  });

  test('over-fetch: unavailable rows ahead of available ones do not shrink the section', async ({ page }) => {
    const many = [];
    for (let i = 0; i < 6; i++) many.push(sim(i + 1, 'sold', []));          // six unavailable rows first
    many.push(sim(7, 'available', []), sim(8, 'available', []));
    const { seen } = await open(page, prop('available', []), { similar: many });
    await expect(page.locator('#similar-grid > *')).toHaveCount(2);
    expect(seen.similarUrls.some((u) => /limit=(\d+)/.test(u) && Number(u.match(/limit=(\d+)/)[1]) > 8)).toBe(true);
  });
});
