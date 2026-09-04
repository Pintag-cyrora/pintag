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

// ── Portfolio availability badge + WhatsApp button (2026-09-03) ────────────
// agents.html keyed its badge on the legacy `status` column, which the DB
// collapses to active/draft/archived, so every sold or rented listing was
// badged "ວ່າງ" (Available); agent.html showed no badge at all. Both now
// resolve market_status through listing-status.js. And an agent with no
// WhatsApp number got a wa.me/?text=... button with no recipient.
for (const pageFile of ['agents.html', 'agent.html']) {
  test.describe(pageFile + ' portfolio', () => {
    const listing = (o) => Object.assign({
      id: 'p-' + o.slug, slug: o.slug, title_lo: 'ບ້ານ ' + o.slug, title_en: 'House ' + o.slug,
      price_amount: 500, price_currency: 'USD', price_frequency: 'monthly', district_lo: 'ສີສັດຕະນາກ', district_en: 'Sisattanak',
      images: [], transaction_type: 'for_rent', is_featured: false, status: 'active', workflow_status: 'active', market_status: 'available',
    }, o);
    async function openWith(page, rows, agent) {
      const seen = {}; const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await mockProfile(page, [agent || AGENT], seen);
      await page.route('**/rest/v1/properties**', (route) => {
        seen.props = route.request().url();
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      });
      await page.goto('/' + pageFile + '?slug=daeng');
      await expect(page.locator('#page')).toBeVisible();
      return { seen, errors };
    }

    test('sold / rented / reserved listings are badged by market_status, never "ວ່າງ"', async ({ page }) => {
      const { seen, errors } = await openWith(page, [
        listing({ slug: 'a', market_status: 'available' }), listing({ slug: 'r', market_status: 'rented' }),
        listing({ slug: 's', market_status: 'sold', status: 'active' }), listing({ slug: 'v', market_status: 'reserved' }),
      ]);
      expect(seen.props).toContain('market_status');
      const badges = await page.evaluate(() => [...document.querySelectorAll('.p-card .p-status')].map((b) => b.className.replace('p-status ', '') + ':' + b.textContent));
      expect(badges).toEqual(['p-status-available:ວ່າງ', 'p-status-rented:ເຊົ່າແລ້ວ', 'p-status-sold:ຂາຍແລ້ວ', 'p-status-offer:ຖືກຈອງແລ້ວ']);
      expect(errors).toEqual([]);
    });

    test('with renditions ON: portfolio and hero photos are the sized WebP renditions, originals kept as the fallback', async ({ page }) => {
      // Both production flags on: renditions AND the image CDN.
      await page.route('**/config.js*', async (r) => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()) + '\nwindow.PINTAG.renditionsEnabled = true; window.PINTAG.imageCdn = true;' }); });
      const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      await page.route('**/storage/v1/object/public/property-images/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
      const PATH = '/storage/v1/object/public/property-images/';
      const ORIG = 'https://ebtgoqrywdywuqrvudcp.supabase.co' + PATH + 'photo-1.jpg';
      const CDN = 'https://img.pintag.io' + PATH;
      const { errors } = await openWith(page, [listing({ slug: 'a', images: [ORIG] })]);
      const imgs = await page.evaluate(() => [...document.querySelectorAll('.p-card .p-img img, .hero-img, .hero-bg-slide')].map((i) => ({ cls: i.className, src: i.getAttribute('src'), orig: i.getAttribute('data-pt-original') })));
      expect(imgs).toHaveLength(2);   // one card thumbnail + the hero (agents.html) / one reel slide (agent.html)
      imgs.forEach((i) => {
        expect(i.orig).toBe(CDN + 'photo-1.jpg');
        expect(i.src).toBe(CDN + 'renditions/photo-1/' + (/hero/.test(i.cls) ? 'hero' : 'card') + '.webp');
      });
      expect(errors).toEqual([]);
    });

    test('an agent card for a party with no slug is inert: no href, no arrow, not a hover invitation', async ({ page }) => {
      await openWith(page, []);
      const card = await page.evaluate(() => {
        const el = renderAgentCard({ id: 'x', type: 'agent', name_en: 'No Slug', name_lo: '', slug: null, is_active: true, is_verified: false, photo_url: null, bio_en: '' }, { layout: 'row', lang: 'lo' });
        return { tag: el.tagName, href: el.getAttribute('href'), cls: el.className, arrow: !!el.querySelector('.pt-agent-row-arrow'), name: el.textContent.includes('No Slug') };
      });
      expect(card).toEqual({ tag: 'DIV', href: null, cls: 'pt-agent-row pt-agent-row-inert', arrow: false, name: true });
    });

    test('portfolio and hero photos are sized renditions with the once-only fallback, not bare originals', async ({ page }) => {
      // Same-origin photo (the page's CSP img-src allows 'self', not arbitrary
      // hosts), so what is asserted is the composition, not the fallback chain
      // firing on a blocked URL.
      const PHOTO = 'http://localhost:8956/pintag-hero.png';
      const { errors } = await openWith(page, [listing({ slug: 'a', images: [PHOTO] })]);
      const imgs = await page.evaluate(() => [...document.querySelectorAll('.p-card .p-img img, .hero-img, .hero-bg-slide')].map((i) => ({
        src: i.getAttribute('src'), orig: i.getAttribute('data-pt-original'), fallback: typeof i.onerror === 'function' || /ptImageFallback/.test(i.getAttribute('onerror') || '') })));
      expect(imgs.length).toBeGreaterThan(0);
      // renditionsEnabled is production-only, so here src === original; the
      // data-pt-original + fallback wiring is what proves the shared
      // composition (ptCardImageSrc) is in use rather than a bare .src.
      imgs.forEach((i) => { expect(i.orig).toBe(PHOTO); expect(i.src).toBe(PHOTO); expect(i.fallback).toBe(true); });
      expect(errors).toEqual([]);
    });

    test('an agent with no WhatsApp number gets no WhatsApp button (not a recipient-less wa.me link)', async ({ page }) => {
      const { errors } = await openWith(page, [], Object.assign({}, AGENT, { whatsapp: null }));
      await expect(page.locator('#wa-btn')).toBeHidden();
      expect(await page.locator('#wa-btn').getAttribute('href')).not.toMatch(/wa\.me\/\?/);
      expect(errors).toEqual([]);
    });

    test('an agent WITH a number keeps the normalised wa.me link', async ({ page }) => {
      await openWith(page, []);
      await expect(page.locator('#wa-btn')).toBeVisible();
      await expect(page.locator('#wa-btn')).toHaveAttribute('href', /wa\.me\/8562055500000\?text=/);
    });
  });
}
