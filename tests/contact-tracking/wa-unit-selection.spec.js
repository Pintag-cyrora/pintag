// Multi-unit listings: the visitor must say WHICH UNIT they are asking about before the main or
// mobile WhatsApp button starts a conversation. Driven against the real listing.html with mocked
// Supabase, like contact-tracking-live.spec.js.
//
// What is gated: the main CTA (#pt-wa-primary) and the Ask sheet's WhatsApp row (#ci-wa-sheet; the sticky
// bar itself no longer carries a WhatsApp button), and only
// on a listing with TWO OR MORE unit types that has no unit selected.
// What is NOT gated, and must stay exactly as it was:
//   - single-unit listings (no unit types, or one);
//   - the per-unit "Inquire" buttons (.unit-cta) -- they already name their unit;
//   - the waiting-list / status CTAs of an unavailable listing, and "Notify me about similar
//     properties" -- those are not inquiries about a unit.
const { test, expect } = require('@playwright/test');

const UNIT_A = { id: 'room-type-a', name_en: 'Room Type A', name_lo: 'ຫ້ອງ ແບບ A', name_zh: 'A型房', bedrooms: 2, bathrooms: 1, sqm: 45, price_amount: 400, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 2, total_units: null, images: [] };
const UNIT_B = { id: 'room-type-b', name_en: 'Room Type B', name_lo: 'ຫ້ອງ ແບບ B', name_zh: 'B型房', bedrooms: 1, bathrooms: 1, sqm: 32, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 3, total_units: null, images: [] };
const PHONE_DIGITS = '8562099999999';

function prop(overrides) {
  return Object.assign({
    id: 'p-wa', slug: 'wa-unit-test', title_en: 'Nice Apartment', title_lo: 'ອາພາດເມັນ', title_zh: '公寓',
    property_type: 'apartment', transaction_type: 'for_rent',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450/month',
    images: ['https://example.com/a.jpg'], amenities: [], features: [],
    district_en: 'Sisattanak', workflow_status: 'active', market_status: 'available', status: 'active',
    created_at: new Date().toISOString(), bedrooms: 2, bathrooms: 1, sqm: 60,
    contacts: { id: 'c-1', role: 'agent', name: 'Somchai', phone: '+8562099999999', whatsapp: '+8562099999999' },
    managed_by_party_id: 'party-1', parties: null, unit_types: [],
  }, overrides || {});
}
const MULTI = (o) => prop(Object.assign({ unit_types: [UNIT_A, UNIT_B] }, o || {}));

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
  await page.waitForSelector('#pt-wa-primary');
  await page.waitForTimeout(400);
  return { posts, errors };
}
const contactUi = (posts) => posts.ui_events.filter((e) => e.element_type === 'cta');
const href = (loc) => loc.getAttribute('href');
const text = async (loc) => decodeURIComponent(((await href(loc)) || '').split('?text=')[1] || '');
const selectUnit = (page, name) => page.locator('.unit-card', { hasText: name }).first().click();
const GATED = async (loc) => {
  await expect(loc).toHaveAttribute('data-wa-needs-unit', '1');
  await expect(loc).toHaveAttribute('aria-disabled', 'true');
  await expect(loc).toHaveAttribute('href', '#units-section');
  expect(await href(loc)).not.toMatch(/wa\.me/);
};
const LIVE = async (loc) => {
  await expect(loc).not.toHaveAttribute('data-wa-needs-unit', '1');
  await expect(loc).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + PHONE_DIGITS + '\\?text='));
};

// ═══ Single-unit listings: the existing flow, unchanged ═══════════════════════════
test.describe('single-unit listings are unchanged', () => {
  for (const [label, units] of [
    ['no unit types', []],
    ['exactly one unit type', [UNIT_A]],
    ['one unit type that tracks a total_units inventory', [Object.assign({}, UNIT_A, { total_units: 24, available_count: 7 })]],
  ]) {
    test(label + ': the WhatsApp CTA is a live link with the generic property message, and the lead carries no unit', async ({ page }) => {
      const { posts, errors } = await open(page, prop({ unit_types: units }));
      await LIVE(page.locator('#pt-wa-primary'));
      await LIVE(page.locator('#ci-wa-sheet'));
      await expect(page.locator('.wa-unit-hint')).toHaveCount(0);
      await expect(page.locator('.agent-ctas-needs-unit')).toHaveCount(0);
      const msg = await text(page.locator('#pt-wa-primary'));
      expect(msg).toContain("I'm interested in this property");
      expect(msg).toContain('Property: Nice Apartment');
      await page.click('#pt-wa-primary');
      await page.waitForTimeout(300);
      expect(contactUi(posts).length).toBe(1);
      expect(posts.lead_events.length).toBe(1);
      expect(posts.lead_events[0].unit_type_id).toBe(null);
      expect(posts.lead_events[0].listing_id).toBe('p-wa');
      expect(errors).toEqual([]);
    });
  }
});

// ═══ Multi-unit, nothing selected: the CTA does not start a conversation ══════════
test.describe('multi-unit listing, no unit selected', () => {
  test('desktop: the main CTA is not a WhatsApp link and explains what to do', async ({ page }) => {
    const { errors } = await open(page, MULTI());
    await GATED(page.locator('#pt-wa-primary'));
    await expect(page.locator('#pt-wa-primary')).toContainText('Select a unit');
    const hint = page.locator('#pt-wa-unit-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Select the unit you are asking about');
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('aria-describedby', 'pt-wa-unit-hint');
    expect(errors).toEqual([]);
  });

  test('desktop: activating it opens no WhatsApp, records nothing, and takes the visitor to the unit picker', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    let popups = 0; page.on('popup', () => { popups++; });
    // force: the CTA is aria-disabled (it is announced as unavailable) but a visitor CAN activate it -- that is how it
    // takes them to the unit picker -- and Playwright's actionability check otherwise refuses to click aria-disabled.
    await page.click('#pt-wa-primary', { force: true });
    await page.waitForTimeout(500);
    expect(popups).toBe(0);
    expect(await page.evaluate(() => window.__opens.length)).toBe(0);
    expect(posts.lead_events).toEqual([]);
    expect(posts.ui_events.filter((e) => /whatsapp/i.test(String(e.element_id) + String(e.label)))).toEqual([]);
    expect(page.url()).not.toContain('#units-section');           // the default anchor jump was prevented
    await expect(page.locator('#units-section')).toHaveClass(/units-section-prompt/);
    await expect(page.locator('#units-section')).toBeInViewport();
  });

  test('mobile: the Ask sheet\'s WhatsApp row is gated the same way', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const { posts } = await open(page, MULTI());
    await page.click('#ci-open-sheet');
    const m = page.locator('#ci-wa-sheet');
    await GATED(m);
    await expect(m).toContainText('Select a unit');
    let popups = 0; page.on('popup', () => { popups++; });
    await m.click({ force: true });   // aria-disabled but activatable -- see the desktop test
    await page.waitForTimeout(400);
    expect(popups).toBe(0);
    expect(posts.lead_events).toEqual([]);
    expect(contactUi(posts)).toEqual([]);
    await expect(page.locator('#units-section')).toBeInViewport();
  });

  test('an unknown ?unit= deep link selects nothing, so the CTA stays gated', async ({ page }) => {
    await open(page, MULTI(), '&lang=en&unit=does-not-exist');
    await GATED(page.locator('#pt-wa-primary'));
  });
});

// ═══ Multi-unit, unit selected: the unit is in the message and the lead ═══════════
test.describe('multi-unit listing, unit selected', () => {
  test('desktop: the CTA becomes a live link whose message names the unit, and the lead carries unit_type_id', async ({ page }) => {
    const { posts, errors } = await open(page, MULTI());
    await selectUnit(page, 'Room Type B');
    const cta = page.locator('#pt-wa-primary');
    await LIVE(cta);
    await expect(page.locator('.wa-unit-hint')).toHaveCount(0);
    const msg = await text(cta);
    expect(msg).toContain('Room Type B');
    expect(msg).toContain('1 Beds');
    expect(msg).toContain('$300 / month');
    expect(msg).toContain('Nice Apartment');
    expect(msg).toContain('https://pintag.io/listing.html?slug=wa-unit-test&lang=en');
    expect(msg).not.toContain('Room Type A');
    await cta.click();
    await page.waitForTimeout(300);
    expect(contactUi(posts).length).toBe(1);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-b');
    expect(posts.lead_events[0].listing_id).toBe('p-wa');
    expect(posts.lead_events[0].event_type).toBe('whatsapp_click');
    expect(errors).toEqual([]);
  });

  test('mobile: the Ask sheet\'s WhatsApp row carries the selected unit in the message and the lead', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const { posts } = await open(page, MULTI());
    await selectUnit(page, 'Room Type A');
    await page.click('#ci-open-sheet');
    const m = page.locator('#ci-wa-sheet');
    await LIVE(m);
    const msg = await text(m);
    expect(msg).toContain('Room Type A'); expect(msg).toContain('2 Beds'); expect(msg).toContain('$400 / month');
    await m.click();
    await page.waitForTimeout(300);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
  });

  test('a ?unit= deep link starts with the CTA already live and the unit in the message', async ({ page }) => {
    await open(page, MULTI(), '&lang=en&unit=room-type-b');
    await LIVE(page.locator('#pt-wa-primary'));
    expect(await text(page.locator('#pt-wa-primary'))).toContain('Room Type B');
  });

  test('un-selecting the unit gates the CTA again', async ({ page }) => {
    await open(page, MULTI());
    await selectUnit(page, 'Room Type A');
    await LIVE(page.locator('#pt-wa-primary'));
    await page.locator('.viewing-unit-reset').first().click();
    await GATED(page.locator('#pt-wa-primary'));
    await selectUnit(page, 'Room Type B');
    await LIVE(page.locator('#pt-wa-primary'));
    expect(await text(page.locator('#pt-wa-primary'))).toContain('Room Type B');
  });
});

// ═══ Language: English / Lao / Chinese ════════════════════════════════════════════
test.describe('language', () => {
  const CASES = {
    en: { label: 'Select a unit', hint: 'Select the unit you are asking about', unit: 'Room Type A', greeting: "I'm interested in the Room Type A", title: 'Nice Apartment' },
    lo: { label: 'ເລືອກຫ້ອງ', hint: 'ມີຫຼາຍຫ້ອງ', unit: 'ຫ້ອງ ແບບ A', greeting: 'ສະບາຍດີ!', title: 'ອາພາດເມັນ' },
    zh: { label: '选择户型', hint: '多种户型', unit: 'A型房', greeting: '您好！', title: '公寓' },
  };
  for (const [lang, c] of Object.entries(CASES)) {
    test(lang + ': gated label + hint, then a unit message in the same language', async ({ page }) => {
      await open(page, MULTI(), '&lang=' + lang);
      await GATED(page.locator('#pt-wa-primary'));
      await expect(page.locator('#pt-wa-primary')).toContainText(c.label);
      await expect(page.locator('#pt-wa-unit-hint')).toContainText(c.hint);
      await selectUnit(page, c.unit);
      await LIVE(page.locator('#pt-wa-primary'));
      const msg = await text(page.locator('#pt-wa-primary'));
      expect(msg).toContain(c.greeting);
      expect(msg).toContain(c.unit);
      expect(msg).toContain(c.title);
      expect(msg).toContain('lang=' + lang);
    });
  }

  test('switching language keeps the gate, and keeps a selected unit live in the new language', async ({ page }) => {
    await open(page, MULTI(), '&lang=en');
    await page.click('.lang-btn[data-lang="lo"]');
    await GATED(page.locator('#pt-wa-primary'));
    await expect(page.locator('#pt-wa-primary')).toContainText('ເລືອກຫ້ອງ');
    await selectUnit(page, 'ຫ້ອງ ແບບ B');
    await page.click('.lang-btn[data-lang="zh"]');
    await LIVE(page.locator('#pt-wa-primary'));
    const msg = await text(page.locator('#pt-wa-primary'));
    expect(msg).toContain('B型房'); expect(msg).toContain('您好！');
  });
});

// ═══ Contact picker: it re-points live links, never un-gates a gated one ══════════
test.describe('multi-number contact picker', () => {
  const A = { id: 'a', role: 'agent', name: 'Somchai', phone: '+856 20 111 1111', whatsapp: '+856 20 111 1111', languages: ['lo', 'en'] };
  const B = { id: 'b', role: 'agent', name: 'Ms. Li', phone: '+856 20 222 2222', whatsapp: '+856 20 222 2222', languages: ['en'] };
  const TWO = () => MULTI({ contacts: null, property_contacts: [{ sort_order: 0, is_primary: true, contacts: A }, { sort_order: 1, contacts: B }] });

  test('picking another number while gated does not turn the CTA into a WhatsApp link', async ({ page }) => {
    await open(page, TWO());
    await expect(page.locator('.contact-picker .cpick-row')).toHaveCount(2);
    await page.locator('.contact-picker .cpick-row').nth(1).click();
    await GATED(page.locator('#pt-wa-primary'));
    await GATED(page.locator('#ci-wa-sheet'));
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-contact-id', 'b');
  });

  test('picking a number AFTER choosing a unit re-points the live link and keeps the unit in the message', async ({ page }) => {
    const { posts } = await open(page, TWO());
    await selectUnit(page, 'Room Type A');
    await page.locator('.contact-picker .cpick-row').nth(1).click();
    const cta = page.locator('#pt-wa-primary');
    await expect(cta).toHaveAttribute('href', /^https:\/\/wa\.me\/856202222222\?text=/);
    await expect(cta).toHaveAttribute('data-contact-id', 'b');
    expect(await text(cta)).toContain('Room Type A');
    await cta.click();
    await page.waitForTimeout(300);
    expect(posts.lead_events[0].contact_id).toBe('b');
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
  });
});

// ═══ Entry points that must NOT be gated ══════════════════════════════════════════
test.describe('not gated', () => {
  test('per-unit Inquire buttons work with no unit selected and carry their own unit', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    await GATED(page.locator('#pt-wa-primary'));                   // main CTA is gated...
    const inquire = page.locator('.unit-card', { hasText: 'Room Type A' }).locator('.unit-cta');
    await expect(inquire).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + PHONE_DIGITS + '\\?text='));
    const msg = await text(inquire);
    expect(msg).toContain('Room Type A'); expect(msg).toContain('$400 / month');
    await inquire.click();                                          // ...but the unit's own button is live
    await page.waitForTimeout(300);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
  });

  // An unavailable listing swaps the main CTA for a waiting-list / status CTA, so #pt-wa-primary does not
  // exist there; wait on the status button instead.
  async function openUnavailable(page, query) {
    // A multi-unit listing reads as unavailable (and swaps the main CTA for the waiting-list CTA) only when every
    // unit type is occupied -- see the note in contact-tracking-live.spec.js.
    const FULL = [UNIT_A, UNIT_B].map((u) => Object.assign({}, u, { is_available: false, available_count: 0 }));
    const posts = await mock(page, MULTI({ market_status: 'fully_occupied', unit_types: FULL }));
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/listing.html?slug=wa-unit-test' + (query || '&lang=en'));
    await page.waitForSelector('.agent-ctas .btn-wa');
    await page.waitForTimeout(400);
    return { posts, errors };
  }

  test('an unavailable multi-unit listing: the desktop waiting-list CTA needs no unit (and still records no lead)', async ({ page }) => {
    const { posts, errors } = await openUnavailable(page);
    await expect(page.locator('#pt-wa-primary')).toHaveCount(0);
    const status = page.locator('.agent-ctas .btn-wa').first();
    await expect(status).not.toHaveAttribute('data-wa-needs-unit', '1');
    await expect(status).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + PHONE_DIGITS + '\\?text='));
    await expect(page.locator('.wa-unit-hint')).toHaveCount(0);
    await status.click();
    await page.waitForTimeout(300);
    expect(contactUi(posts).length).toBe(1);        // the click is tracked as before...
    expect(posts.lead_events).toEqual([]);          // ...and, as before, is not a lead (recordLead:false)
    expect(errors).toEqual([]);
  });

  test('an unavailable multi-unit listing: the status CTA in the Ask sheet needs no unit', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const { posts } = await openUnavailable(page);
    await page.click('#ci-open-sheet');
    const m = page.locator('#ci-sheet-body .ci-item-status');
    await expect(m).not.toHaveAttribute('data-wa-needs-unit', '1');
    await expect(m).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + PHONE_DIGITS + '\\?text='));
    await m.click();
    await page.waitForTimeout(300);
    expect(contactUi(posts).length).toBe(1);
    expect(posts.lead_events).toEqual([]);
  });

  test('"Notify me about similar properties" needs no unit', async ({ page }) => {
    const { posts } = await openUnavailable(page);
    const notify = page.locator('.waitlist-cta-btn');
    await expect(notify).toHaveCount(1);
    await notify.click();
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => window.__opens.map((a) => String(a[0])));
    expect(opened.length).toBe(1);
    expect(opened[0]).toMatch(new RegExp('^https://wa\\.me/' + PHONE_DIGITS + '\\?text='));
    expect(posts.lead_events).toEqual([]);
  });
});
