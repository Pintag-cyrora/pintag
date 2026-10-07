// Contact Intent, PR B: the user-facing menu. A collapsible "Ask about this property" panel in the
// desktop contact band, the same intents in a bottom sheet opened from the mobile sticky bar, the
// Book a viewing / Contact agent WhatsApp actions, multi-unit gating, contact-picker re-pointing,
// the availability ON/OFF behaviour, and the tracking of all of it. Real listing.html, mocked Supabase.
//
// UX contract pinned here: the primary WhatsApp / Call buttons stay one tap away and unchanged in
// behaviour; the menu is a shortcut. contact_intent_open is recorded only when the visitor opens the
// panel or the sheet, never from a render, a language switch or a unit selection.
const { test, expect } = require('@playwright/test');

const A = { id: 'a', role: 'agent', name: 'Somchai', phone: '+856 20 111 1111', whatsapp: '+856 20 111 1111', languages: ['lo', 'en'] };
const B = { id: 'b', role: 'agent', name: 'Nok', phone: '+856 20 222 2222', whatsapp: '+856 20 222 2222', languages: ['th'] };
const NUM = { a: '856201111111', b: '856202222222' };
const UNIT = (id, name, o) => Object.assign({ id, name_en: name, name_lo: name + ' ລາວ', name_zh: name + '型', bedrooms: 2, bathrooms: 1, sqm: 40,
  price_amount: 400, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 2, total_units: null, images: [] }, o || {});
const UA = UNIT('room-a', 'Room Type A'), UB = UNIT('room-b', 'Room Type B', { bedrooms: 1, price_amount: 300 });
const FULL = (id, name) => UNIT(id, name, { available_count: 0, next_available_date: '2999-01-01' });

function prop(o) {
  return Object.assign({
    id: 'p-menu', slug: 'menu-test', title_en: 'Nice Apartment', title_lo: 'ອາພາດເມັນ', title_zh: '公寓',
    property_type: 'apartment', transaction_type: 'for_rent',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450/month',
    images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'], amenities: [], features: [],
    district_en: 'Sisattanak', workflow_status: 'active', market_status: 'available', status: 'active',
    created_at: new Date().toISOString(), bedrooms: 2, bathrooms: 1, sqm: 60,
    contacts: null, property_contacts: [{ sort_order: 0, is_primary: true, contacts: A }],
    managed_by_party_id: 'party-1', parties: null, unit_types: [],
  }, o || {});
}
const TWO = (o) => prop(Object.assign({ property_contacts: [{ sort_order: 0, is_primary: true, contacts: A }, { sort_order: 1, contacts: B }] }, o || {}));
const MULTI = (o) => prop(Object.assign({ unit_types: [UA, UB] }, o || {}));

async function open(page, row, { lang = 'en', width, height } = {}) {
  const posts = { ui_events: [], lead_events: [] };
  if (width) await page.setViewportSize({ width, height: height || 760 });
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
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/listing.html?slug=' + row.slug + '&lang=' + lang);
  await page.waitForSelector('#section-price');
  await page.waitForTimeout(450);
  return { posts, errors };
}
const phone = (page, o) => open(page, o.row, Object.assign({ width: 375, height: 760 }, o));
const opens = (posts) => posts.ui_events.filter((e) => e.element_id === 'contact_intent_open');
const intentRows = (posts) => posts.ui_events.filter((e) => /^contact_intent_/.test(e.element_id));
const ids = async (loc) => loc.evaluateAll((els) => els.map((e) => e.getAttribute('data-contact-intent') || e.getAttribute('data-ci-wa')));
const waText = async (loc) => decodeURIComponent(((await loc.getAttribute('href')) || '').split('?text=')[1] || '');
const inView = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }, sel);
const toBottom = (page) => page.evaluate(() => {
  const pad = document.createElement('div'); pad.style.height = '3000px'; document.body.appendChild(pad);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
});
const PANEL = '#ci-panel-body', SHEET = '#ci-sheet', ASK = '#ci-open-sheet';
const toggle = (page) => page.click('#ci-toggle');
const GATED = async (loc) => {
  await expect(loc).toHaveAttribute('data-wa-needs-unit', '1');
  await expect(loc).toHaveAttribute('aria-disabled', 'true');
  await expect(loc).toHaveAttribute('href', '#units-section');
};
const MENU = ['contact_agent', 'book_tour', 'location', 'price', 'availability', 'gallery'];
const ANSWERS = ['location', 'price', 'availability', 'gallery'];

// ═══ Desktop panel ═══════════════════════════════════════════════════════════
test.describe('desktop panel', () => {
  test('is collapsed on load, records nothing, and the primary buttons are untouched', async ({ page }) => {
    const { posts, errors } = await open(page, prop());
    await expect(page.locator('#ci-toggle')).toBeVisible();
    await expect(page.locator('#ci-toggle')).toHaveText(/Ask about this property/);
    await expect(page.locator('#ci-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(PANEL)).toBeHidden();
    expect(intentRows(posts)).toEqual([]);                       // no open event (or anything) from the initial render
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /^https:\/\/wa\.me\/856201111111\?text=/);
    await expect(page.locator('#pt-call-primary')).toBeVisible();
    await expect(page.locator(ASK)).toBeHidden();                // phones only
    expect(errors).toEqual([]);
  });

  test('opening it shows the six intents, high-intent first, and records ONE contact_intent_open', async ({ page }) => {
    const { posts } = await open(page, prop());
    await toggle(page);
    await expect(page.locator('#ci-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(PANEL)).toBeVisible();
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(MENU);
    await page.waitForTimeout(300);
    const rows = opens(posts);
    expect(rows.length).toBe(1);
    expect(rows[0].element_type).toBe('contact_intent');
    expect(rows[0].property_id).toBe('p-menu'); expect(rows[0].session_id).toBeTruthy();
    expect(rows[0].metadata.surface).toBe('panel'); expect(rows[0].metadata.lang).toBe('en'); expect(rows[0].metadata.intent).toBe('open');
    expect(posts.lead_events).toEqual([]);
  });

  test('closing it records nothing; reopening later records again; a fast re-open is the 300ms dedupe', async ({ page }) => {
    const { posts } = await open(page, prop());
    await toggle(page); await toggle(page); await toggle(page);          // open, close, open within 300ms
    await page.waitForTimeout(500);
    expect(opens(posts).length).toBe(1);
    await toggle(page);                                                   // close
    await page.waitForTimeout(400);
    await toggle(page);                                                   // open again, well after the guard
    await page.waitForTimeout(300);
    expect(opens(posts).length).toBe(2);
  });

  test('a language switch keeps the panel open and re-labels it WITHOUT another open event', async ({ page }) => {
    const { posts } = await open(page, prop());
    await toggle(page);
    await page.waitForTimeout(450);
    for (const [lang, label] of [['zh', '咨询此房源'], ['lo', 'ສອບຖາມກ່ຽວກັບຊັບສິນນີ້'], ['en', 'Ask about this property']]) {
      await page.click('.lang-btn[data-lang="' + lang + '"]');
      await page.waitForTimeout(450);
      await expect(page.locator('#ci-toggle')).toContainText(label);
      await expect(page.locator('#ci-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator(PANEL)).toBeVisible();
    }
    expect(opens(posts).length).toBe(1);
  });

  test('a panel that was never opened stays closed through language switches (no open event either)', async ({ page }) => {
    const { posts } = await open(page, prop());
    await page.click('.lang-btn[data-lang="zh"]'); await page.waitForTimeout(450);
    await expect(page.locator(PANEL)).toBeHidden();
    expect(intentRows(posts)).toEqual([]);
  });

  test('the answer chips in the panel stay on the page and record their own row with surface "panel"', async ({ page }) => {
    const { posts } = await open(page, prop());
    await toggle(page);
    await toBottom(page);
    let popups = 0; page.on('popup', () => { popups++; });
    for (const intent of ANSWERS) {
      await page.locator(`${PANEL} [data-contact-intent="${intent}"]`).click();
      await page.waitForTimeout(450);
    }
    const rows = intentRows(posts).filter((e) => e.element_id !== 'contact_intent_open');
    expect(rows.map((r) => r.element_id)).toEqual(ANSWERS.map((a) => 'contact_intent_' + a));
    expect(rows.every((r) => r.metadata.surface === 'panel')).toBe(true);
    expect(posts.lead_events).toEqual([]);
    expect(popups).toBe(0);
    expect(await page.evaluate(() => window.__opens.length)).toBe(0);
  });

  test('chips fit the band (no horizontal overflow) in every language', async ({ page }) => {
    for (const lang of ['en', 'lo', 'zh']) {
      await open(page, prop(), { lang });
      await toggle(page);
      const ov = await page.evaluate(() => ({ b: document.documentElement.scrollWidth - document.documentElement.clientWidth, p: document.getElementById('ci-panel').scrollWidth - document.getElementById('ci-panel').clientWidth }));
      expect(ov.b, lang + ' page').toBeLessThanOrEqual(0); expect(ov.p, lang + ' panel').toBeLessThanOrEqual(0);
    }
  });
});

// ═══ Mobile bottom sheet ═════════════════════════════════════════════════════
test.describe('mobile sheet', () => {
  test('the sticky bar has WhatsApp + Ask; the sheet is closed on load and nothing is recorded', async ({ page }) => {
    const { posts, errors } = await phone(page, { row: prop() });
    await expect(page.locator('#pt-wa-mobile')).toBeVisible();
    await expect(page.locator(ASK)).toBeVisible();
    await expect(page.locator(ASK)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(page.locator(ASK)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
    await expect(page.locator('#ci-panel')).toBeHidden();                  // the inline panel is a desktop thing
    expect(intentRows(posts)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('tapping WhatsApp in the bar is still ONE tap to the chat (no sheet in the way)', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    await page.click('#pt-wa-mobile');
    await page.waitForTimeout(400);
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
    expect(opens(posts)).toEqual([]);
    expect(posts.lead_events.length).toBe(1);
  });

  test('Ask opens a modal sheet with the six intents and records ONE contact_intent_open (surface sheet)', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    await page.click(ASK);
    await expect(page.locator('#ci-sheet-root')).toBeVisible();
    await expect(page.locator(SHEET)).toHaveAttribute('role', 'dialog');
    await expect(page.locator(SHEET)).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#ci-sheet-title')).toHaveText('Ask about this property');
    expect(await ids(page.locator('#ci-sheet-body .ci-item'))).toEqual(MENU);
    await expect(page.locator(ASK)).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => document.body.classList.contains('ci-sheet-open'))).toBe(true);   // page scroll locked
    await expect(page.locator('#ci-sheet-close')).toBeFocused();
    await page.waitForTimeout(300);
    expect(opens(posts).length).toBe(1);
    expect(opens(posts)[0].metadata.surface).toBe('sheet');
  });

  for (const how of ['close button', 'backdrop', 'Escape']) {
    test(`closes with the ${how}; focus returns to Ask; nothing extra is recorded`, async ({ page }) => {
      const { posts } = await phone(page, { row: prop() });
      await page.click(ASK);
      await expect(page.locator('#ci-sheet-root')).toBeVisible();
      if (how === 'close button') await page.click('#ci-sheet-close');
      else if (how === 'backdrop') await page.mouse.click(20, 120);              // empty area above the sheet (below the dev banner)
      else await page.keyboard.press('Escape');
      await expect(page.locator('#ci-sheet-root')).toBeHidden();
      await expect(page.locator(ASK)).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator(ASK)).toBeFocused();
      expect(await page.evaluate(() => document.body.classList.contains('ci-sheet-open'))).toBe(false);
      await page.waitForTimeout(300);
      expect(intentRows(posts).length).toBe(1);                                 // only the open
      await page.waitForTimeout(400);
      await page.click(ASK);                                                    // reopen records again
      await page.waitForTimeout(300);
      expect(opens(posts).length).toBe(2);
    });
  }

  test('tapping the page does not open the sheet (no accidental opens)', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    await page.locator('.hero-location').first().tap().catch(() => {});
    await page.mouse.click(180, 300);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
    expect(opens(posts)).toEqual([]);
  });

  test('Tab stays inside the open sheet', async ({ page }) => {
    await phone(page, { row: prop() });
    await page.click(ASK);
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.getElementById('ci-sheet').contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.getElementById('ci-sheet').contains(document.activeElement))).toBe(true);
  });

  test('tap targets are at least 44px and the sheet never takes more than 80% of the screen', async ({ page }) => {
    await phone(page, { row: MULTI(), });
    await page.click(ASK);
    const boxes = await page.evaluate(() => ({
      items: [...document.querySelectorAll('#ci-sheet-body .ci-item')].map((e) => e.getBoundingClientRect().height),
      close: (() => { const r = document.getElementById('ci-sheet-close').getBoundingClientRect(); return [r.width, r.height]; })(),
      ask: (() => { const r = document.getElementById('ci-open-sheet').getBoundingClientRect(); return [r.width, r.height]; })(),
      sheet: document.getElementById('ci-sheet').getBoundingClientRect().height, vh: innerHeight,
    }));
    for (const h of boxes.items) expect(h).toBeGreaterThanOrEqual(44);
    expect(Math.min(...boxes.close)).toBeGreaterThanOrEqual(44);
    expect(boxes.sheet).toBeLessThanOrEqual(boxes.vh * 0.8 + 1);
    await page.click('#ci-sheet-close');
    const ask = await page.evaluate(() => { const r = document.getElementById('ci-open-sheet').getBoundingClientRect(); return [r.width, r.height]; });
    expect(Math.min(...ask)).toBeGreaterThanOrEqual(44);
  });

  test('on a very short screen the sheet scrolls and its last row is reachable', async ({ page }) => {
    await phone(page, { row: prop(), height: 480 });
    await page.click(ASK);
    const info = await page.evaluate(() => { const s = document.getElementById('ci-sheet'); return { scroll: s.scrollHeight, client: s.clientHeight, vh: innerHeight }; });
    expect(info.client).toBeLessThanOrEqual(info.vh * 0.8 + 1);
    await page.locator('#ci-sheet-body .ci-item').last().scrollIntoViewIfNeeded();
    await expect(page.locator('#ci-sheet-body .ci-item').last()).toBeInViewport();
  });

  for (const [w, lang] of [[320, 'lo'], [360, 'lo'], [375, 'lo'], [320, 'zh'], [360, 'en']]) {
    test(`${lang} at ${w}px: the bar and the sheet fit without horizontal overflow, text is not clipped`, async ({ page }) => {
      await open(page, MULTI(), { lang, width: w, height: 700 });
      const bar = await page.evaluate(() => { const b = document.getElementById('mobile-cta-bar'); return { s: b.scrollWidth, c: b.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
      expect(bar.s).toBeLessThanOrEqual(bar.c); expect(bar.page).toBeLessThanOrEqual(0);
      await page.click(ASK);
      const sheet = await page.evaluate(() => { const s = document.getElementById('ci-sheet'); return { s: s.scrollWidth, c: s.clientWidth, items: [...s.querySelectorAll('.ci-item')].map((e) => e.scrollWidth - e.clientWidth) }; });
      expect(sheet.s).toBeLessThanOrEqual(sheet.c);
      for (const d of sheet.items) expect(d).toBeLessThanOrEqual(0);
    });
  }

  test('an answer row closes the sheet, then answers on the page (scroll + one row, surface "sheet")', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    await toBottom(page);
    await page.click(ASK);
    await page.locator('#ci-sheet-body [data-contact-intent="price"]').click();
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
    await expect.poll(() => inView(page, '#section-price'), { timeout: 5000 }).toBe(true);
    const rows = intentRows(posts);
    expect(rows.map((r) => r.element_id)).toEqual(['contact_intent_open', 'contact_intent_price']);
    expect(rows[1].metadata.surface).toBe('sheet');
    expect(posts.lead_events).toEqual([]);
  });

  test('every answer row works from the sheet (location, availability, gallery)', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    for (const intent of ['location', 'availability', 'gallery']) {
      await toBottom(page);
      await page.click(ASK);
      await page.locator(`#ci-sheet-body [data-contact-intent="${intent}"]`).click();
      await page.waitForTimeout(700);
    }
    const answered = intentRows(posts).filter((r) => r.element_id !== 'contact_intent_open').map((r) => r.element_id);
    expect(answered).toEqual(['contact_intent_location', 'contact_intent_availability', 'contact_intent_gallery']);
    await expect(page.locator('#contact-intent-answer')).toBeVisible();
  });

  test('a language switch while the sheet exists re-labels it and records NO new open event', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    await page.click(ASK);
    await page.waitForTimeout(400);
    await page.evaluate(() => setLang('lo'));          // the nav is behind the modal backdrop, so switch programmatically
    await page.waitForTimeout(500);
    await expect(page.locator('#ci-sheet-root')).toBeVisible();
    await expect(page.locator('#ci-sheet-title')).toHaveText('ສອບຖາມກ່ຽວກັບຊັບສິນນີ້');
    await expect(page.locator('#ci-sheet-body .ci-item').first()).toContainText('ຕິດຕໍ່ຕົວແທນ');
    await page.evaluate(() => setLang('zh'));
    await page.waitForTimeout(500);
    await expect(page.locator('#ci-sheet-title')).toHaveText('咨询此房源');
    expect(opens(posts).length).toBe(1);
  });

  test('the sheet is not shown on desktop widths', async ({ page }) => {
    await open(page, prop());
    await expect(page.locator(ASK)).toBeHidden();
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
  });
});

// ═══ WhatsApp intents ════════════════════════════════════════════════════════
test.describe('Contact agent', () => {
  test('the menu\'s Contact agent is the main CTA\'s link, byte for byte (same message), in panel and sheet', async ({ page }) => {
    await open(page, prop());
    await toggle(page);
    const main = await page.locator('#pt-wa-primary').getAttribute('href');
    expect(await page.locator(`${PANEL} [data-ci-wa="contact_agent"]`).getAttribute('href')).toBe(main);
    expect(await page.locator('#pt-wa-mobile').getAttribute('href')).toBe(main);
    expect(await page.locator('#ci-sheet-body [data-ci-wa="contact_agent"]').getAttribute('href')).toBe(main);
    expect(await waText(page.locator('#pt-wa-primary'))).toContain("I'm interested in this property");
  });

  test('desktop panel click: ONE lead_events row and ONE ui_events row under contact_intent_contact_agent', async ({ page }) => {
    const { posts } = await open(page, prop());
    await toggle(page);
    await page.click(`${PANEL} [data-ci-wa="contact_agent"]`);
    await page.waitForTimeout(400);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0]).toMatchObject({ listing_id: 'p-menu', contact_id: 'a', event_type: 'whatsapp_click', unit_type_id: null });
    const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
    expect(cta.length).toBe(1);
    expect(cta[0].element_id).toBe('contact_intent_contact_agent');
    expect(cta[0].label).toBe('WhatsApp');                                            // the label the old rows used
    expect(cta[0].property_id).toBe('p-menu');
    expect(cta[0].metadata).toMatchObject({ intent: 'contact_agent', surface: 'panel', lang: 'en', unit_type_id: null });
    expect(cta[0].metadata.availability).toEqual({ available: true, reason: null, scope: 'property' });
  });

  test('the existing desktop button now records the same intent id with surface "band", one lead', async ({ page }) => {
    const { posts } = await open(page, prop());
    await page.click('#pt-wa-primary');
    await page.waitForTimeout(350);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta').map((e) => [e.element_id, e.metadata.surface])).toEqual([['contact_intent_contact_agent', 'band']]);
  });

  test('mobile bar button records surface "mobile_bar"; sheet row records surface "sheet"; one lead each', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    await page.click('#pt-wa-mobile');
    await page.waitForTimeout(350);
    await page.click(ASK);
    await page.click('#ci-sheet-body [data-ci-wa="contact_agent"]');
    await page.waitForTimeout(400);
    const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
    expect(cta.map((e) => [e.element_id, e.metadata.surface])).toEqual([['contact_intent_contact_agent', 'mobile_bar'], ['contact_intent_contact_agent', 'sheet']]);
    expect(posts.lead_events.length).toBe(2);
    await expect(page.locator('#ci-sheet-root')).toBeHidden();                         // choosing WhatsApp closes the sheet
  });

  test('the per-unit Inquire button is a contact_agent intent carrying that unit', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    await page.locator('.unit-card', { hasText: 'Room Type B' }).locator('.unit-cta').click();
    await page.waitForTimeout(400);
    const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
    expect(cta.length).toBe(1);
    expect(cta[0].element_id).toBe('contact_intent_contact_agent');
    expect(cta[0].label).toBe('Inquire unit');
    expect(cta[0].metadata).toMatchObject({ intent: 'contact_agent', surface: 'unit_card', unit_type_id: 'room-b', unit: 'Room Type B' });
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].unit_type_id).toBe('room-b');
  });

  test('waiting-list / status CTAs are not contact intents and keep their own ids', async ({ page }) => {
    const { posts } = await open(page, prop({ market_status: 'coming_soon' }));
    await page.locator('#agent-band-anchor a.btn-wa').click();
    await page.waitForTimeout(400);
    expect(posts.lead_events).toEqual([]);                                              // recordLead:false, as before
    expect(posts.ui_events.some((e) => e.element_id === 'contact-whatsapp-status-cta')).toBe(true);
    expect(intentRows(posts)).toEqual([]);
  });
});

test.describe('Book a viewing', () => {
  for (const [lang, snippet, nameField] of [['en', "I'd like to book a viewing of this property", 'Nice Apartment'], ['lo', 'ຂ້ອຍຢາກນັດເບິ່ງຊັບສິນນີ້', 'ອາພາດເມັນ'], ['zh', '我想预约看房', '公寓']]) {
    test(`${lang}: wa.me link to the selected contact with the viewing message, the property and its link`, async ({ page }) => {
      const { posts } = await open(page, prop(), { lang });
      await toggle(page);
      const a = page.locator(`${PANEL} [data-ci-wa="book_tour"]`);
      await expect(a).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.a + '\\?text='));
      await expect(a).toHaveAttribute('target', '_blank');
      const msg = await waText(a);
      expect(msg).toContain(snippet);
      expect(msg).toContain(nameField);
      expect(msg).toContain('https://pintag.io/listing.html?slug=menu-test&lang=' + lang);
      expect(msg).not.toContain("interested in this property");                           // not the Contact agent message
      await a.click();
      await page.waitForTimeout(400);
      expect(posts.lead_events.length).toBe(1);
      expect(posts.lead_events[0]).toMatchObject({ listing_id: 'p-menu', contact_id: 'a', event_type: 'whatsapp_click' });
      const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
      expect(cta.length).toBe(1);
      expect(cta[0]).toMatchObject({ element_id: 'contact_intent_book_tour', label: 'Book a viewing', property_id: 'p-menu' });
      expect(cta[0].metadata).toMatchObject({ intent: 'book_tour', surface: 'panel', lang });
    });
  }

  test('from the mobile sheet: same message, surface "sheet", and the sheet closes', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    await page.click(ASK);
    const a = page.locator('#ci-sheet-body [data-ci-wa="book_tour"]');
    expect(await waText(a)).toContain("I'd like to book a viewing");
    await a.click();
    await page.waitForTimeout(400);
    expect(posts.ui_events.filter((e) => e.element_id === 'contact_intent_book_tour')[0].metadata.surface).toBe('sheet');
    expect(posts.lead_events.length).toBe(1);
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
  });

  test('the main CTA\'s message is unchanged (Book a viewing did not touch WA_MESSAGE_TEMPLATES)', async ({ page }) => {
    await open(page, prop(), { lang: 'zh' });
    expect(await waText(page.locator('#pt-wa-primary'))).toContain('我对这处房产很感兴趣');
  });
});

// ═══ Multi-unit gating ═══════════════════════════════════════════════════════
test.describe('multi-unit listings', () => {
  test('no unit selected: Book a viewing and Contact agent are gated like the main CTA; answers are not', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    await toggle(page);
    for (const intent of ['contact_agent', 'book_tour']) {
      const row = page.locator(`${PANEL} [data-ci-wa="${intent}"]`);
      await GATED(row);
      await expect(row).toContainText('Select a unit');
      expect(await row.getAttribute('href')).not.toMatch(/wa\.me/);
    }
    for (const intent of ANSWERS) {
      await expect(page.locator(`${PANEL} [data-contact-intent="${intent}"]`)).toBeEnabled();
    }
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-wa-needs-unit', '1');   // the main CTA agrees
    let popups = 0; page.on('popup', () => { popups++; });
    await page.locator(`${PANEL} [data-ci-wa="book_tour"]`).click({ force: true });
    await page.waitForTimeout(500);
    expect(popups).toBe(0);
    expect(await page.evaluate(() => window.__opens.length)).toBe(0);
    expect(posts.lead_events).toEqual([]);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta')).toEqual([]);
    await expect(page.locator('#units-section')).toHaveClass(/units-section-prompt/);
    await expect(page.locator('#units-section')).toBeInViewport();
  });

  test('sheet: gated rows say "Select a unit", close the sheet and take the visitor to the unit picker', async ({ page }) => {
    const { posts } = await phone(page, { row: MULTI() });
    await page.click(ASK);
    const row = page.locator('#ci-sheet-body [data-ci-wa="book_tour"]');
    await GATED(row);
    await expect(row).toContainText('Select a unit');
    await row.click({ force: true });
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
    await expect.poll(() => inView(page, '#units-section'), { timeout: 5000 }).toBe(true);
    expect(posts.lead_events).toEqual([]);
  });

  test('selecting a unit makes both live; the viewing and the contact message name THAT unit; leads carry unit_type_id', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    await page.locator('.unit-card', { hasText: 'Room Type A' }).first().click();
    await page.waitForTimeout(500);
    await toggle(page);
    const tourLink = page.locator(`${PANEL} [data-ci-wa="book_tour"]`), agentLink = page.locator(`${PANEL} [data-ci-wa="contact_agent"]`);
    await expect(tourLink).not.toHaveAttribute('data-wa-needs-unit', '1');
    await expect(agentLink).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.a));
    const tour = await waText(tourLink);
    expect(tour).toContain("I'd like to book a viewing of the Room Type A (2 Beds) unit at Nice Apartment ($400 / month)");
    expect(tour).toContain('Nice Apartment — Room Type A');
    expect(tour).toContain('https://pintag.io/listing.html?slug=menu-test&lang=en');
    expect(await waText(agentLink)).toBe(await waText(page.locator('#pt-wa-primary')));          // Contact agent = the existing unit message
    expect(await waText(agentLink)).toContain('Room Type A');
    await tourLink.click();
    await page.waitForTimeout(350);
    await agentLink.click();
    await page.waitForTimeout(400);
    expect(posts.lead_events.map((l) => l.unit_type_id)).toEqual(['room-a', 'room-a']);
    const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
    expect(cta.map((e) => e.element_id)).toEqual(['contact_intent_book_tour', 'contact_intent_contact_agent']);
    expect(cta.every((e) => e.metadata.unit_type_id === 'room-a')).toBe(true);
    expect(cta[0].metadata.availability.scope).toBe('unit_specific');
  });

  test('the unit message follows the language (lo/zh) and the selected unit', async ({ page }) => {
    await open(page, MULTI(), { lang: 'zh' });
    await page.locator('.unit-card', { hasText: 'Room Type B' }).first().click();
    await page.waitForTimeout(500);
    await toggle(page);
    const tour = await waText(page.locator(`${PANEL} [data-ci-wa="book_tour"]`));
    expect(tour).toMatch(/我想预约参观公寓的Room Type B型 \(1 卧室\)户型（\$300 \/ 月）。请问什么时间方便？/);   // same "<unit>户型" shape as the existing unit message
    expect(tour).toContain('1 卧室 \u2014 $300 / 月');
  });

  test('a selected unit that is closed disables Book a viewing / Contact agent ("Unit not available")', async ({ page }) => {
    await open(page, MULTI({ unit_types: [UA, FULL('room-full', 'Full Type')] }));
    await page.locator('.unit-card', { hasText: 'Full Type' }).first().click();
    await page.waitForTimeout(500);
    await toggle(page);
    for (const intent of ['contact_agent', 'book_tour']) {
      const row = page.locator(`${PANEL} [data-ci-wa="${intent}"]`);
      await GATED(row);
      await expect(row).toContainText('Unit not available');
    }
  });

  test('Price and Availability answer for the selected unit', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    await page.locator('.unit-card', { hasText: 'Room Type B' }).first().click();
    await page.waitForTimeout(500);
    await toggle(page);
    await page.locator(`${PANEL} [data-contact-intent="price"]`).click();
    await expect(page.locator('#section-price')).toContainText('$300');                      // the price block shows the selected unit
    await page.waitForTimeout(400);
    await page.locator(`${PANEL} [data-contact-intent="availability"]`).click();
    await expect(page.locator('#contact-intent-answer .ci-answer-head')).toHaveText(/Room Type B — Available Now/);
    await expect(page.locator('#contact-intent-answer li.ci-unit-selected')).toHaveCount(1);
    const rows = intentRows(posts).filter((r) => r.element_id === 'contact_intent_price' || r.element_id === 'contact_intent_availability');
    expect(rows.every((r) => r.metadata.unit_type_id === 'room-b')).toBe(true);
  });

  test('with no unit selected Price/Availability use the established property / unit-list answers', async ({ page }) => {
    await open(page, MULTI());
    await toggle(page);
    await page.locator(`${PANEL} [data-contact-intent="availability"]`).click();
    await expect(page.locator('#contact-intent-answer')).toContainText('2 of 2 unit types are available. Check each unit below.');
    await expect(page.locator('#contact-intent-answer li')).toHaveCount(2);
  });

  test('un-selecting the unit re-gates the actions', async ({ page }) => {
    await open(page, MULTI());
    await page.locator('.unit-card', { hasText: 'Room Type A' }).first().click();
    await page.waitForTimeout(500);
    await page.locator('.unit-card', { hasText: 'Room Type A' }).first().click();            // toggles back to the overview
    await page.waitForTimeout(500);
    await toggle(page);
    await GATED(page.locator(`${PANEL} [data-ci-wa="book_tour"]`));
  });

  test('the open panel survives selecting a unit (re-render) without a new open event', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    await toggle(page);
    await page.waitForTimeout(450);
    await page.locator('.unit-card', { hasText: 'Room Type A' }).first().click();
    await page.waitForTimeout(600);
    await expect(page.locator('#ci-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(PANEL)).toBeVisible();
    expect(opens(posts).length).toBe(1);
  });
});

// ═══ Contact picker ══════════════════════════════════════════════════════════
test.describe('contact picker', () => {
  test('picking another number re-points Book a viewing and Contact agent (panel and sheet), message unchanged', async ({ page }) => {
    const { posts } = await open(page, TWO());
    await toggle(page);
    const before = await waText(page.locator(`${PANEL} [data-ci-wa="book_tour"]`));
    await page.locator('.contact-picker .cpick-row').nth(1).click();
    for (const scope of [PANEL, '#ci-sheet-body']) {
      for (const intent of ['book_tour', 'contact_agent']) {
        const a = page.locator(`${scope} [data-ci-wa="${intent}"]`);
        await expect(a).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.b + '\\?text='));
        await expect(a).toHaveAttribute('data-contact-id', 'b');
      }
    }
    expect(await waText(page.locator(`${PANEL} [data-ci-wa="book_tour"]`))).toBe(before);
    await page.click(`${PANEL} [data-ci-wa="book_tour"]`);
    await page.waitForTimeout(400);
    expect(posts.lead_events[0].contact_id).toBe('b');
  });

  test('the pick persists through a language switch and a unit selection, in the menu too', async ({ page }) => {
    const { posts } = await open(page, TWO({ unit_types: [UA, UB] }));
    await page.locator('.contact-picker .cpick-row').nth(1).click();
    await page.click('.lang-btn[data-lang="zh"]'); await page.waitForTimeout(500);
    await page.locator('.unit-card', { hasText: 'Room Type A' }).first().click(); await page.waitForTimeout(500);
    await toggle(page);
    for (const intent of ['book_tour', 'contact_agent']) {
      await expect(page.locator(`${PANEL} [data-ci-wa="${intent}"]`)).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.b));
    }
    await page.click(`${PANEL} [data-ci-wa="contact_agent"]`);
    await page.waitForTimeout(400);
    expect(posts.lead_events[0]).toMatchObject({ contact_id: 'b', unit_type_id: 'room-a' });
    // ...and the sheet's actions follow the same contact
    await page.setViewportSize({ width: 375, height: 760 });
    await page.waitForTimeout(300);
    await expect(page.locator('#ci-sheet-body [data-ci-wa="book_tour"]')).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.b));
  });

  test('a gated multi-unit action gets the picked contact once a unit is chosen', async ({ page }) => {
    await open(page, TWO({ unit_types: [UA, UB] }));
    await toggle(page);
    await page.locator('.contact-picker .cpick-row').nth(1).click();
    await expect(page.locator(`${PANEL} [data-ci-wa="book_tour"]`)).toHaveAttribute('data-contact-id', 'b');
    await GATED(page.locator(`${PANEL} [data-ci-wa="book_tour"]`));                         // still gated: the pick did not turn it into a link
    await page.locator('.unit-card', { hasText: 'Room Type B' }).first().click();
    await page.waitForTimeout(500);
    await expect(page.locator(`${PANEL} [data-ci-wa="book_tour"]`)).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.b));
  });
});

// ═══ Availability ON / OFF ═══════════════════════════════════════════════════
const ANSWER_ONLY = ANSWERS;
test.describe('availability', () => {
  test('ON: both WhatsApp actions are in the menu', async ({ page }) => {
    await open(page, prop());
    await toggle(page);
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(MENU);
  });

  for (const [label, row] of [
    ['rented, single-unit', prop({ market_status: 'rented' })],
    ['reserved, single-unit', prop({ market_status: 'reserved' })],
    ['sold', prop({ market_status: 'sold' })],
    ['off market', prop({ market_status: 'off_market' })],
    ['fully occupied (market_status)', prop({ market_status: 'fully_occupied' })],
    ['fully occupied (all units closed)', MULTI({ unit_types: [FULL('f1', 'Full A'), FULL('f2', 'Full B')] })],
    ['rented, single-unit with a lone open unit row', prop({ market_status: 'rented', unit_types: [UA] })],
  ]) {
    test(`OFF (${label}): menu = answers only; no main WhatsApp CTA; the status CTA / waiting-list path remains`, async ({ page }) => {
      const { posts } = await open(page, row);
      await toggle(page);
      expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(ANSWER_ONLY);
      await expect(page.locator('[data-ci-wa]')).toHaveCount(0);
      await expect(page.locator('#pt-wa-primary')).toHaveCount(0);
      await expect(page.locator('#agent-band-anchor .agent-ctas a')).toHaveCount(1);          // the existing status CTA
      await page.locator(`${PANEL} [data-contact-intent="availability"]`).click();
      await expect(page.locator('#contact-intent-answer')).toHaveAttribute('data-availability', 'off');
      expect(posts.lead_events).toEqual([]);
    });
  }

  test('OFF on a phone: the sheet lists answers only and the bar keeps the status CTA', async ({ page }) => {
    await phone(page, { row: prop({ market_status: 'rented' }) });
    await expect(page.locator('#pt-wa-mobile')).toHaveCount(0);
    await expect(page.locator('#mobile-cta-bar .mcta-btn')).toBeVisible();                   // Find Similar
    await page.click(ASK);
    expect(await ids(page.locator('#ci-sheet-body .ci-item'))).toEqual(ANSWER_ONLY);
  });

  test('coming soon: OFF everywhere in the contact area; the existing Notify Me CTA replaces WhatsApp', async ({ page }) => {
    const { posts } = await open(page, prop({ market_status: 'coming_soon' }));
    await expect(page.locator('#pt-wa-primary')).toHaveCount(0);
    await expect(page.locator('#agent-band-anchor a.btn-wa')).toContainText('Notify Me When Available');
    await toggle(page);
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(ANSWER_ONLY);
    await page.locator(`${PANEL} [data-contact-intent="availability"]`).click();
    await expect(page.locator('#contact-intent-answer .ci-answer-head')).toHaveText('Coming Soon');
    await expect(page.locator('#contact-intent-answer')).not.toContainText('Available Now');
    expect(posts.lead_events).toEqual([]);
  });

  test('coming soon on a phone: bar shows Notify Me, sheet shows answers only', async ({ page }) => {
    await phone(page, { row: prop({ market_status: 'coming_soon', unit_types: [UA, UB] }) });
    await expect(page.locator('#pt-wa-mobile')).toHaveCount(0);
    await expect(page.locator('#mobile-cta-bar .mcta-btn')).toContainText('Notify Me');
    await page.click(ASK);
    expect(await ids(page.locator('#ci-sheet-body .ci-item'))).toEqual(ANSWER_ONLY);
  });

  test('multi-unit rented with an open unit: ON for that unit only (gated actions, unit-specific answer)', async ({ page }) => {
    await open(page, MULTI({ market_status: 'rented', unit_types: [UA, FULL('f', 'Full Type')] }));
    await toggle(page);
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(MENU);
    await GATED(page.locator(`${PANEL} [data-ci-wa="book_tour"]`));
    await page.locator(`${PANEL} [data-contact-intent="availability"]`).click();
    await expect(page.locator('#contact-intent-answer')).toHaveAttribute('data-scope', 'unit_specific');
    await expect(page.locator('#contact-intent-answer')).toContainText('The listing is marked Rented, but some units are still open.');
    await expect(page.locator('#contact-intent-answer li')).toHaveCount(2);
  });

  test('Lao and Chinese: the OFF answer and the ON labels', async ({ page }) => {
    await open(page, prop({ market_status: 'sold' }), { lang: 'zh' });
    await toggle(page);
    await page.locator(`${PANEL} [data-contact-intent="availability"]`).click();
    await expect(page.locator('#contact-intent-answer')).toContainText('已售出');
    await open(page, prop(), { lang: 'lo' });
    await toggle(page);
    expect(await page.locator(PANEL + ' .ci-item .ci-label').allInnerTexts()).toEqual(['ຕິດຕໍ່ຕົວແທນ', 'ນັດເບິ່ງຊັບສິນ', 'ຢູ່ບ່ອນໃດ?', 'ລາຄາເທົ່າໃດ?', 'ຍັງວ່າງຢູ່ບໍ?', 'ເບິ່ງຮູບພາບ']);
  });
});

// ═══ Labels per language / no photos / no phone ══════════════════════════════
test.describe('labels and edge cases', () => {
  for (const [lang, labels] of [
    ['en', ['Contact agent', 'Book a viewing', 'Where is it?', "What's the price?", 'Is it available?', 'View photos']],
    ['zh', ['联系经纪人', '预约看房', '在哪里？', '价格多少？', '还有吗？', '查看照片']],
  ]) {
    test(`${lang}: the menu labels`, async ({ page }) => {
      await open(page, prop(), { lang });
      await toggle(page);
      expect(await page.locator(PANEL + ' .ci-item .ci-label').allInnerTexts()).toEqual(labels);
    });
  }

  test('no photos: View photos is not offered', async ({ page }) => {
    await open(page, prop({ images: [] }));
    await toggle(page);
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(['contact_agent', 'book_tour', 'location', 'price', 'availability']);
  });

  test('no contact number: only the answers are offered', async ({ page }) => {
    await open(page, prop({ property_contacts: [{ sort_order: 0, is_primary: true, contacts: Object.assign({}, A, { phone: '', whatsapp: '' }) }] }));
    await toggle(page);
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(ANSWERS);
  });

  test('no JS errors across open / answer / WhatsApp / language / unit flows', async ({ page }) => {
    const { errors } = await open(page, MULTI());
    await toggle(page);
    await page.locator(`${PANEL} [data-contact-intent="location"]`).click();
    await page.click('.lang-btn[data-lang="lo"]'); await page.waitForTimeout(400);
    await page.locator('.unit-card', { hasText: 'Room Type A' }).first().click(); await page.waitForTimeout(400);
    await page.click(`${PANEL} [data-ci-wa="book_tour"]`);
    expect(errors).toEqual([]);
  });

  test('every id on the page stays unique with the menu, sheet and answer box', async ({ page }) => {
    await open(page, MULTI());
    const dup = await page.evaluate(() => { const c = {}; document.querySelectorAll('[id]').forEach((e) => { c[e.id] = (c[e.id] || 0) + 1; }); return Object.keys(c).filter((k) => c[k] > 1); });
    expect(dup).toEqual([]);
  });
});
