// Contact Intent, PR A: the four ANSWER intents (location / price / availability / gallery),
// their anchors, their tracking, and the availability state they surface. Driven against the real
// listing.html with mocked Supabase, like wa-unit-selection.spec.js.
//
// PR A has no intent menu yet, so the tests raise intents the way the menu will: an element
// carrying data-contact-intent (added to the page here). What is pinned:
//   * each answer intent writes exactly ONE ui_events row (contact_intent_<x>, element_type
//     'contact_intent') carrying property_id, session_id, language and the availability state,
//     and NEVER a lead_events row or a WhatsApp/tel navigation;
//   * location / price / gallery scroll their section into view (gallery picks the visible
//     desktop/mobile variant); availability fills an in-page answer;
//   * the availability answer follows the agreed state table, per language;
//   * the existing WhatsApp / call flow is unchanged, and the WhatsApp intents are not handled here.
const { test, expect } = require('@playwright/test');

const UNIT = (id, name, o) => Object.assign({ id, name_en: name, name_lo: name + ' (lo)', name_zh: name + ' (zh)', bedrooms: 1, bathrooms: 1, sqm: 30,
  price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 2, total_units: null, images: [] }, o || {});
const OPEN = (id, name) => UNIT(id, name);
const FULL = (id, name) => UNIT(id, name, { available_count: 0, next_available_date: '2999-01-01' });

function prop(o) {
  return Object.assign({
    id: 'p-ci', slug: 'ci-test', title_en: 'Nice Apartment', title_lo: 'ອາພາດເມັນ', title_zh: '公寓',
    property_type: 'apartment', transaction_type: 'for_rent',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450/month',
    images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'], amenities: [], features: [],
    district_en: 'Sisattanak', workflow_status: 'active', market_status: 'available', status: 'active',
    created_at: new Date().toISOString(), bedrooms: 2, bathrooms: 1, sqm: 60,
    contacts: { id: 'c-1', role: 'agent', name: 'Somchai', phone: '+8562099999999', whatsapp: '+8562099999999' },
    managed_by_party_id: 'party-1', parties: null, unit_types: [],
  }, o || {});
}

async function mock(page, row) {
  const posts = { ui_events: [], lead_events: [] };
  await page.addInitScript(() => { window.__opens = []; window.open = (...a) => { window.__opens.push(a); return null; }; });
  await page.route('**/rest/v1/**', (route) => {
    const req = route.request(); const url = req.url();
    const ok = (b, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.indexOf('/properties?slug=eq.') !== -1) return ok([row]);
    if (url.indexOf('/rpc/') !== -1) return ok({});
    if (req.method() === 'POST' && url.indexOf('/ui_events') !== -1) { posts.ui_events.push(req.postDataJSON()); return ok({}, 201); }
    if (req.method() === 'POST' && url.indexOf('/lead_events') !== -1) { posts.lead_events.push(req.postDataJSON()); return ok({}, 201); }
    return ok([]);
  });
  return posts;
}
async function open(page, row, query) {
  const posts = await mock(page, row);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/listing.html?slug=' + row.slug + (query || '&lang=en'));
  await page.waitForSelector('#section-price');
  await page.waitForTimeout(400);
  return { posts, errors };
}
// Adds an element that raises an intent exactly the way the future menu will, and clicks it.
async function raise(page, intent, surface) {
  await page.evaluate(([i, s]) => {
    const b = document.createElement('button');
    b.id = 'ci-test-btn'; b.type = 'button'; b.textContent = i;
    b.setAttribute('data-contact-intent', i);
    if (s) b.setAttribute('data-contact-intent-surface', s);
    b.style.cssText = 'position:fixed;top:60px;right:8px;z-index:99999';
    document.body.appendChild(b);
  }, [intent, surface || null]);
  await page.click('#ci-test-btn');
  await page.evaluate(() => document.getElementById('ci-test-btn').remove());
  await page.waitForTimeout(500);
}
const intentRows = (posts) => posts.ui_events.filter((e) => e.element_type === 'contact_intent');
// The mock listing is short, so pad the page first: otherwise "scrolled to the bottom" can still have the
// target in view and the scroll tests prove nothing.
const toBottom = (page) => page.evaluate(() => {
  const pad = document.createElement('div'); pad.style.height = '3000px'; document.body.appendChild(pad);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });   // the page CSS smooth-scrolls by default
});
const inView = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s); if (!el) return false;
  const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight;
}, sel);

// ═══ Anchors ═════════════════════════════════════════════════════════════════
test.describe('section anchors', () => {
  test('price, map and the desktop gallery anchors exist; the answer box is hidden until asked', async ({ page }) => {
    const { errors } = await open(page, prop());
    await expect(page.locator('#section-price')).toBeVisible();
    await expect(page.locator('#section-price')).toContainText('$450');          // the price block still renders its price
    await expect(page.locator('#section-map')).toBeVisible();
    await expect(page.locator('#section-gallery-desktop')).toBeVisible();
    await expect(page.locator('#section-gallery-mobile')).toBeHidden();
    await expect(page.locator('#contact-intent-answer')).toBeHidden();
    expect(await page.locator('#contact-intent-answer').evaluate((e) => e.closest('#section-price') !== null)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('on a phone the mobile gallery is the visible gallery anchor', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page, prop());
    await expect(page.locator('#section-gallery-mobile')).toBeVisible();
    await expect(page.locator('#section-gallery-desktop')).toBeHidden();
  });

  test('every anchor id is unique on the page', async ({ page }) => {
    await open(page, prop({ unit_types: [OPEN('a', 'Studio'), OPEN('b', 'One Bed')] }));
    const dup = await page.evaluate(() => {
      const ids = {}; document.querySelectorAll('[id]').forEach((e) => { ids[e.id] = (ids[e.id] || 0) + 1; });
      return Object.entries(ids).filter(([, n]) => n > 1).map(([k]) => k);
    });
    expect(dup).toEqual([]);
  });
});

// ═══ Scroll answers ══════════════════════════════════════════════════════════
test.describe('scroll answers', () => {
  for (const [intent, sel] of [['location', '#section-map'], ['price', '#section-price']]) {
    test(`${intent}: scrolls to ${sel}, records one ui_events row, opens nothing and records no lead`, async ({ page }) => {
      const { posts, errors } = await open(page, prop());
      await toBottom(page);
      expect(await inView(page, sel)).toBe(false);
      let popups = 0; page.on('popup', () => { popups++; });
      await raise(page, intent);
      await expect.poll(() => inView(page, sel), { timeout: 5000 }).toBe(true);
      await expect(page.locator(sel)).toHaveClass(/ci-flash/);
      const rows = intentRows(posts);
      expect(rows.length).toBe(1);
      expect(rows[0].element_id).toBe('contact_intent_' + intent);
      expect(rows[0].property_id).toBe('p-ci');
      expect(rows[0].session_id).toBeTruthy();
      expect(rows[0].metadata.lang).toBe('en');
      expect(rows[0].metadata.intent).toBe(intent);
      expect(posts.lead_events).toEqual([]);
      expect(popups).toBe(0);
      expect(await page.evaluate(() => window.__opens.length)).toBe(0);
      expect(page.url()).not.toMatch(/#section-/);                     // the default anchor jump was prevented
      expect(errors).toEqual([]);
    });
  }

  test('gallery (desktop): scrolls to the desktop gallery', async ({ page }) => {
    const { posts } = await open(page, prop());
    await toBottom(page);
    await raise(page, 'gallery');
    await expect.poll(() => inView(page, '#section-gallery-desktop'), { timeout: 5000 }).toBe(true);
    expect(intentRows(posts).map((r) => r.element_id)).toEqual(['contact_intent_gallery']);
    expect(posts.lead_events).toEqual([]);
  });

  test('gallery (phone): scrolls to the MOBILE gallery, not the hidden desktop one', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const { posts } = await open(page, prop());
    await toBottom(page);
    await raise(page, 'gallery');
    await expect.poll(() => inView(page, '#section-gallery-mobile'), { timeout: 5000 }).toBe(true);
    await expect(page.locator('#section-gallery-mobile')).toHaveClass(/ci-flash/);
    expect(intentRows(posts).length).toBe(1);
  });

  test('the highlight is temporary', async ({ page }) => {
    await open(page, prop());
    await raise(page, 'price');
    await expect(page.locator('#section-price')).not.toHaveClass(/ci-flash/, { timeout: 4000 });
  });

  test('a listing with no photos still records the gallery intent and does not throw', async ({ page }) => {
    const { posts, errors } = await open(page, prop({ images: [] }));
    await raise(page, 'gallery');
    expect(intentRows(posts).map((r) => r.element_id)).toEqual(['contact_intent_gallery']);
    expect(errors).toEqual([]);
  });
});

// ═══ Tracking payload ════════════════════════════════════════════════════════
test.describe('tracking', () => {
  test('language is recorded per page language', async ({ page }) => {
    for (const lang of ['lo', 'zh']) {
      const { posts } = await open(page, prop(), '&lang=' + lang);
      await raise(page, 'price');
      expect(intentRows(posts)[0].metadata.lang).toBe(lang);
    }
  });

  test('the surface and the selected unit travel in metadata', async ({ page }) => {
    const { posts } = await open(page, prop({ unit_types: [OPEN('room-a', 'Room A'), OPEN('room-b', 'Room B')] }));
    await raise(page, 'price', 'band');
    await page.locator('.unit-card', { hasText: 'Room B' }).first().click();
    await page.waitForTimeout(500);
    await raise(page, 'location', 'mobile_bar');
    const rows = intentRows(posts);
    expect(rows[0].metadata.surface).toBe('band'); expect(rows[0].metadata.unit_type_id).toBe(null);
    expect(rows[1].metadata.surface).toBe('mobile_bar'); expect(rows[1].metadata.unit_type_id).toBe('room-b');
  });

  test('the row has no event_type override and stays within the existing ui_events columns', async ({ page }) => {
    const { posts } = await open(page, prop());
    await raise(page, 'availability');
    const row = intentRows(posts)[0];
    expect(Object.keys(row).sort()).toEqual(['element_id', 'element_type', 'label', 'metadata', 'page', 'property_id', 'session_id']);
    expect(row.page).toBe('listing.html');
    expect(row.label).toBe('Is it available?');
  });

  test('a double-tap records once', async ({ page }) => {
    const { posts } = await open(page, prop());
    await page.evaluate(() => {
      const b = document.createElement('button'); b.id = 'dbl'; b.setAttribute('data-contact-intent', 'price');
      b.style.cssText = 'position:fixed;top:60px;right:8px;z-index:99999'; b.textContent = 'x'; document.body.appendChild(b);
    });
    await page.dblclick('#dbl');
    await page.waitForTimeout(500);
    expect(intentRows(posts).length).toBe(1);
  });
});

// ═══ Availability answer: the agreed state table ═════════════════════════════
const ANSWER = '#contact-intent-answer';
async function ask(page, row, query) {
  const ctx = await open(page, row, query);
  await raise(page, 'availability');
  return ctx;
}

test.describe('availability answer', () => {
  test('Available (no unit rows): "Available Now", on, property-wide, and it scrolls into view', async ({ page }) => {
    const { posts, errors } = await open(page, prop());
    await toBottom(page);
    await raise(page, 'availability');
    await expect(page.locator(ANSWER)).toBeVisible();
    await expect(page.locator(ANSWER)).toHaveAttribute('data-availability', 'on');
    await expect(page.locator(ANSWER)).toHaveAttribute('data-scope', 'property');
    await expect(page.locator(ANSWER)).toContainText('Available Now');
    await expect.poll(() => inView(page, ANSWER), { timeout: 5000 }).toBe(true);
    expect(intentRows(posts)[0].metadata.availability).toEqual({ available: true, reason: null, scope: 'property' });
    expect(errors).toEqual([]);
  });

  test('Multi-unit: unit-specific wording and each unit\'s own state (never "the whole building")', async ({ page }) => {
    await ask(page, prop({ unit_types: [OPEN('a', 'Studio'), FULL('b', 'One Bed')] }));
    await expect(page.locator(ANSWER)).toHaveAttribute('data-scope', 'unit_specific');
    await expect(page.locator(ANSWER)).toContainText('1 of 2 unit types available. Availability depends on the unit.');
    const lines = await page.locator(ANSWER + ' li').allInnerTexts();
    expect(lines.length).toBe(2);
    expect(lines.join('|')).toMatch(/Studio\s+Available Now/);
    expect(lines.join('|')).toMatch(/One Bed\s+Fully Occupied/);
    await expect(page.locator(ANSWER)).not.toContainText(/^Available Now$/);
  });

  for (const [label, row, headline] of [
    ['Rented, single-unit', prop({ market_status: 'rented' }), 'Rented'],
    ['Rented, single-unit with a lone open unit row', prop({ market_status: 'rented', unit_types: [OPEN('a', 'Studio')] }), 'Rented'],
    ['Reserved, single-unit', prop({ market_status: 'reserved' }), 'Reserved'],
    ['Sold', prop({ market_status: 'sold' }), 'Sold'],
    ['Off market', prop({ market_status: 'off_market' }), 'Off Market'],
    ['Coming soon', prop({ market_status: 'coming_soon' }), 'Coming Soon'],
    ['Coming soon even with open units', prop({ market_status: 'coming_soon', unit_types: [OPEN('a', 'Studio'), OPEN('b', 'One Bed')] }), 'Coming Soon'],
    ['Temporarily unavailable (single unit row)', prop({ unit_types: [UNIT('a', 'Studio', { available_count: 0, next_available_date: null })] }), 'Currently Unavailable'],
  ]) {
    test(`${label}: OFF, says "${headline}", honest about not being available`, async ({ page }) => {
      const { posts } = await ask(page, row);
      await expect(page.locator(ANSWER)).toBeVisible();
      await expect(page.locator(ANSWER)).toHaveAttribute('data-availability', 'off');
      await expect(page.locator(ANSWER + ' .ci-answer-head')).toHaveText(headline);
      await expect(page.locator(ANSWER)).toContainText('This property is not currently available.');
      await expect(page.locator(ANSWER)).not.toContainText('Available Now');
      await expect(page.locator(ANSWER + ' li')).toHaveCount(0);        // an OFF listing never lists units as available
      expect(intentRows(posts)[0].metadata.availability.available).toBe(false);
      expect(posts.lead_events).toEqual([]);
    });
  }

  for (const market of ['rented', 'reserved']) {
    test(`${market}, multi-unit with an open unit: unit-specific, names the property status, lists the units`, async ({ page }) => {
      const { posts } = await ask(page, prop({ market_status: market, unit_types: [OPEN('a', 'Studio'), FULL('b', 'One Bed')] }));
      await expect(page.locator(ANSWER)).toHaveAttribute('data-availability', 'on');
      await expect(page.locator(ANSWER)).toHaveAttribute('data-scope', 'unit_specific');
      await expect(page.locator(ANSWER)).toContainText(`The listing is marked ${market === 'rented' ? 'Rented' : 'Reserved'}, but the units below are open.`);
      await expect(page.locator(ANSWER + ' li').first()).toBeVisible();
      expect(intentRows(posts)[0].metadata.availability).toEqual({ available: true, reason: null, scope: 'unit_specific' });
    });
  }

  test('Lao and Chinese answers', async ({ page }) => {
    await ask(page, prop(), '&lang=lo');
    await expect(page.locator(ANSWER)).toContainText('ວ່າງດຽວນີ້');
    await ask(page, prop({ market_status: 'sold' }), '&lang=zh');
    await expect(page.locator(ANSWER)).toContainText('已售出');
    await ask(page, prop({ unit_types: [OPEN('a', 'Studio'), FULL('b', 'One Bed')] }), '&lang=zh');
    await expect(page.locator(ANSWER)).toContainText('2种户型中有1种可租');
  });

  test('the existing status treatment of an unavailable listing is unchanged (badge + waiting-list CTA remain)', async ({ page }) => {
    await ask(page, prop({ market_status: 'rented' }));
    await expect(page.locator('#conversion-panel')).toBeVisible();
    await expect(page.locator('#pt-wa-primary')).toHaveCount(0);       // no main WhatsApp CTA on an unavailable listing, as before
  });
});

// ═══ Nothing else changed ════════════════════════════════════════════════════
test.describe('existing contact flow is unchanged', () => {
  test('the WhatsApp CTA is still a live tracked link and an ordinary click still records the lead', async ({ page }) => {
    const { posts } = await open(page, prop());
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /^https:\/\/wa\.me\/8562099999999\?text=/);
    await page.click('#pt-wa-primary');
    await page.waitForTimeout(400);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta').length).toBe(1);
    expect(intentRows(posts)).toEqual([]);                             // the existing flow records no contact_intent rows
  });

  test('the WhatsApp intents are NOT handled yet: no event, no navigation', async ({ page }) => {
    const { posts } = await open(page, prop());
    await raise(page, 'book_tour');
    await raise(page, 'contact_agent');
    await raise(page, 'open');
    expect(intentRows(posts)).toEqual([]);
    expect(posts.lead_events).toEqual([]);
    expect(await page.evaluate(() => window.__opens.length)).toBe(0);
  });

  test('unknown intents are ignored', async ({ page }) => {
    const { posts } = await open(page, prop());
    await raise(page, 'drop_table');
    expect(posts.ui_events.filter((e) => /drop_table/.test(JSON.stringify(e)))).toEqual([]);
  });

  test('unrelated clicks record nothing extra', async ({ page }) => {
    const { posts } = await open(page, prop());
    await page.locator('.hero-location').first().click();
    await page.waitForTimeout(300);
    expect(intentRows(posts)).toEqual([]);
  });

  test('the multi-unit WhatsApp gate still works', async ({ page }) => {
    await open(page, prop({ unit_types: [OPEN('a', 'Studio'), OPEN('b', 'One Bed')] }));
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-wa-needs-unit', '1');
  });
});
