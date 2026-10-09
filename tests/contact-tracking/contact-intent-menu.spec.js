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
// What each row of the mobile Ask sheet is, in order: answers, Book a viewing, then the contact group
// (Call / WhatsApp are the same contact_agent intent: told apart by channel), or the status CTA when OFF.
const sheetKeys = (page) => page.locator('#ci-sheet-body .ci-item').evaluateAll((els) => els.map((e) =>
  e.getAttribute('data-contact-intent') || (e.hasAttribute('data-ci-call') ? 'call' : (e.getAttribute('data-ci-wa') === 'contact_agent' ? 'whatsapp' : (e.getAttribute('data-ci-wa') || 'status')))));
const SHEET_ON = ['location', 'price', 'terms', 'availability', 'gallery', 'book_tour', 'call', 'whatsapp'];
const SHEET_ANSWERS = ['location', 'price', 'availability', 'gallery'];
// tel: links would navigate the test browser; the click handlers (tracking) still run
const noTelNav = (page) => page.addInitScript(() => document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a[href^="tel:"]')) e.preventDefault(); }, true));
const toggle = (page) => page.click('#ci-toggle');
const GATED = async (loc) => {
  await expect(loc).toHaveAttribute('data-wa-needs-unit', '1');
  await expect(loc).toHaveAttribute('aria-disabled', 'true');
  await expect(loc).toHaveAttribute('href', '#units-section');
};
const MENU = ['contact_agent', 'book_tour', 'location', 'price', 'terms', 'availability', 'gallery'];   // a rental: Terms & utilities follows Price       // the mobile sheet: the complete menu
const PANEL_MENU = MENU.filter((i) => i !== 'contact_agent');                                       // the desktop panel: the primary WhatsApp button is Contact agent
const ANSWERS = ['location', 'price', 'availability', 'gallery'];                                  // an OFF listing / no number: no Terms row (nothing to answer with or hand to)
const ANSWERS_ON = ['location', 'price', 'terms', 'availability', 'gallery'];                          // a rental that is ON

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

  test('opening it shows the five intents (Book a viewing first; no Contact agent chip) and records ONE contact_intent_open', async ({ page }) => {
    const { posts } = await open(page, prop());
    await toggle(page);
    await expect(page.locator('#ci-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(PANEL)).toBeVisible();
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(PANEL_MENU);
    await expect(page.locator(PANEL + ' [data-ci-wa="contact_agent"]')).toHaveCount(0);
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
  test('the sticky bar is exactly [Ask about this property] [Share]: no standalone WhatsApp, status CTA or price', async ({ page }) => {
    const { posts, errors } = await phone(page, { row: prop() });
    const bar = page.locator('#mobile-cta-bar');
    await expect(bar).toBeVisible();
    await expect(page.locator(ASK)).toBeVisible();
    await expect(page.locator(ASK)).toHaveText(/Ask about this property/);
    await expect(page.locator(ASK)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(page.locator(ASK)).toHaveAttribute('aria-expanded', 'false');
    await expect(bar.locator('.pt-share-btn')).toBeVisible();                                   // Share
    await expect(bar.locator('.pt-share-btn')).toHaveAttribute('aria-label', 'Share');
    expect(await bar.locator('.mcta-inner > *').evaluateAll((els) => els.map((e) => e.id || e.className.split(' ')[0]))).toEqual(['ci-open-sheet', 'pt-share-btn']);
    // ...and NOTHING that starts a WhatsApp action:
    await expect(page.locator('#pt-wa-mobile')).toHaveCount(0);
    await expect(bar.locator('.mcta-btn')).toHaveCount(0);
    await expect(bar.locator('a')).toHaveCount(0);
    await expect(bar.locator('[href*="wa.me"], [data-ci-wa], [data-ci-call]')).toHaveCount(0);
    await expect(bar.locator('.mcta-price-wrap')).toHaveCount(0);
    expect((await bar.innerText()).replace(/\s+/g, ' ')).not.toMatch(/Chat on WhatsApp|WhatsApp/i);
    // the sheet is closed and nothing was recorded by rendering
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
    await expect(page.locator('#ci-panel')).toBeHidden();                                       // the inline panel is a desktop thing
    expect(intentRows(posts)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('tapping the sticky bar can only open the menu: no WhatsApp, no call, no lead', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    let popups = 0; page.on('popup', () => { popups++; });
    await page.click(ASK);
    await page.waitForTimeout(500);
    await expect(page.locator('#ci-sheet-root')).toBeVisible();
    expect(popups).toBe(0);
    expect(await page.evaluate(() => window.__opens.length)).toBe(0);
    expect(posts.lead_events).toEqual([]);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta')).toEqual([]);
    expect(intentRows(posts).map((r) => r.element_id)).toEqual(['contact_intent_open']);
  });

  test('Ask opens a modal sheet: questions, Book a viewing, a divider, then Call / WhatsApp; ONE contact_intent_open (surface sheet)', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    await page.click(ASK);
    await expect(page.locator('#ci-sheet-root')).toBeVisible();
    await expect(page.locator(SHEET)).toHaveAttribute('role', 'dialog');
    await expect(page.locator(SHEET)).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#ci-sheet-title')).toHaveText('Ask about this property');
    expect(await sheetKeys(page)).toEqual(SHEET_ON);
    expect(await page.locator('#ci-sheet-body .ci-item .ci-label').allInnerTexts()).toEqual(
      ['Where is it?', "What's the price?", 'Terms & utilities', 'Is it available?', 'View photos', 'Book a viewing', 'Call agent', 'Chat with agent on WhatsApp']);
    // the divider and the "Contact an agent" label sit between Book a viewing and the contact rows
    expect(await page.locator('#ci-sheet-body').evaluate((b) => [...b.children].map((e) => e.getAttribute('role') === 'separator' ? 'divider' : (e.classList.contains('ci-group-label') ? 'label:' + e.textContent : 'row')))).toEqual(
      ['row', 'row', 'row', 'row', 'row', 'row', 'divider', 'label:Contact an agent', 'row', 'row']);
    await expect(page.locator('#ci-call-sheet')).toBeVisible();
    await expect(page.locator('#ci-wa-sheet')).toBeVisible();
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
    await expect(page.locator('#ci-sheet-body .ci-item').first()).toContainText('ຢູ່ບ່ອນໃດ?');
    await expect(page.locator('#ci-wa-sheet')).toContainText('ແຊັດກັບນາຍໜ້າຜ່ານ WhatsApp');
    await expect(page.locator('#ci-call-sheet')).toContainText('ໂທຫານາຍໜ້າ');
    await page.evaluate(() => setLang('zh'));
    await page.waitForTimeout(500);
    await expect(page.locator('#ci-sheet-title')).toHaveText('咨询此房源');
    await expect(page.locator('#ci-wa-sheet')).toContainText('通过 WhatsApp 联系经纪人');
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
  test('desktop: NO Contact agent chip in the panel; the primary Chat on WhatsApp + Call are there; the mobile sheet keeps the row', async ({ page }) => {
    await open(page, prop());
    await toggle(page);
    await expect(page.locator(PANEL + ' [data-ci-wa="contact_agent"]')).toHaveCount(0);
    await expect(page.locator(PANEL + ' .ci-item-contact_agent')).toHaveCount(0);
    await expect(page.locator('#ci-panel')).not.toContainText('Contact agent');
    await expect(page.locator('#pt-wa-primary')).toBeVisible();
    await expect(page.locator('#pt-wa-primary')).toContainText('Chat on WhatsApp');
    await expect(page.locator('#pt-call-primary')).toBeVisible();
    await expect(page.locator('#ci-sheet-body [data-ci-wa="contact_agent"]')).toHaveCount(1);   // in the DOM for phones (hidden at this width)
  });

  test('the sheet\'s WhatsApp row is the main CTA\'s link, byte for byte (same message)', async ({ page }) => {
    await open(page, prop());
    const main = await page.locator('#pt-wa-primary').getAttribute('href');
    expect(await page.locator('#ci-wa-sheet').getAttribute('href')).toBe(main);
    expect(await waText(page.locator('#pt-wa-primary'))).toContain("I'm interested in this property");
    await expect(page.locator('#ci-call-sheet')).toHaveAttribute('href', 'tel:+856201111111');
  });

  test('the existing desktop button now records the same intent id with surface "band", one lead', async ({ page }) => {
    const { posts } = await open(page, prop());
    await page.click('#pt-wa-primary');
    await page.waitForTimeout(350);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta').map((e) => [e.element_id, e.metadata.surface])).toEqual([['contact_intent_contact_agent', 'band']]);
  });

  test('mobile sheet: WhatsApp and Call are the same contact_agent intent, told apart by channel; ONE lead each; no duplicates', async ({ page }) => {
    await noTelNav(page);
    const { posts } = await phone(page, { row: prop() });
    await page.click(ASK);
    await page.click('#ci-wa-sheet');
    await page.waitForTimeout(400);
    await expect(page.locator('#ci-sheet-root')).toBeHidden();                              // choosing a contact closes the sheet
    await page.waitForTimeout(400);
    await page.click(ASK);
    await page.click('#ci-call-sheet');
    await page.waitForTimeout(400);
    const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
    expect(cta.map((e) => [e.element_id, e.label, e.metadata.surface, e.metadata.channel, e.metadata.intent])).toEqual([
      ['contact_intent_contact_agent', 'WhatsApp', 'sheet', 'whatsapp', 'contact_agent'],
      ['contact_intent_contact_agent', 'Call', 'sheet', 'call', 'contact_agent'],
    ]);
    expect(cta.every((e) => e.property_id === 'p-menu' && e.metadata.lang === 'en' && e.metadata.availability.available === true)).toBe(true);
    expect(posts.lead_events.map((l) => l.event_type)).toEqual(['whatsapp_click', 'call_click']);      // exactly one lead per click
    expect(posts.lead_events.every((l) => l.listing_id === 'p-menu' && l.contact_id === 'a')).toBe(true);
    expect(opens(posts).length).toBe(2);
  });

  test('there is no way to a WhatsApp lead from the sticky bar itself', async ({ page }) => {
    const { posts } = await phone(page, { row: prop() });
    await page.locator('#mobile-cta-bar .mcta-inner').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);
    expect(posts.lead_events).toEqual([]);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta')).toEqual([]);
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
    const { posts } = await open(page, prop({ market_status: 'fully_occupied' }));
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
  test('no unit selected: Book a viewing (panel) and the main CTA are gated; answers are not', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    await toggle(page);
    const row = page.locator(`${PANEL} [data-ci-wa="book_tour"]`);
    await GATED(row);
    await expect(row).toContainText('Select a unit');
    expect(await row.getAttribute('href')).not.toMatch(/wa\.me/);
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
    await GATED(page.locator('#ci-sheet-body [data-ci-wa="contact_agent"]'));
    await expect(page.locator('#ci-sheet-body [data-ci-wa="contact_agent"]')).toContainText('Select a unit');
    const row = page.locator('#ci-sheet-body [data-ci-wa="book_tour"]');
    await GATED(row);
    await expect(row).toContainText('Select a unit');
    await row.click({ force: true });
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
    await expect.poll(() => inView(page, '#units-section'), { timeout: 5000 }).toBe(true);
    expect(posts.lead_events).toEqual([]);
  });

  test('selecting a unit makes them live; the viewing and the contact message name THAT unit; leads carry unit_type_id', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    await page.locator('.unit-card', { hasText: 'Room Type A' }).first().click();
    await page.waitForTimeout(500);
    await toggle(page);
    const tourLink = page.locator(`${PANEL} [data-ci-wa="book_tour"]`), agentLink = page.locator('#ci-sheet-body [data-ci-wa="contact_agent"]');
    await expect(tourLink).not.toHaveAttribute('data-wa-needs-unit', '1');
    await expect(agentLink).not.toHaveAttribute('data-wa-needs-unit', '1');
    await expect(agentLink).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.a));
    const tour = await waText(tourLink);
    expect(tour).toContain("I'd like to book a viewing of the Room Type A (2 Beds) unit at Nice Apartment ($400 / month)");
    expect(tour).toContain('Nice Apartment \u2014 Room Type A');
    expect(tour).toContain('https://pintag.io/listing.html?slug=menu-test&lang=en');
    expect(await waText(agentLink)).toBe(await waText(page.locator('#pt-wa-primary')));          // Contact agent = the existing unit message
    expect(await waText(agentLink)).toContain('Room Type A');
    await tourLink.click();
    await page.waitForTimeout(350);
    await page.click('#pt-wa-primary');                                                           // desktop Contact agent = the primary button
    await page.waitForTimeout(400);
    expect(posts.lead_events.map((l) => l.unit_type_id)).toEqual(['room-a', 'room-a']);
    const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
    expect(cta.map((e) => [e.element_id, e.metadata.surface])).toEqual([['contact_intent_book_tour', 'panel'], ['contact_intent_contact_agent', 'band']]);
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
    const row = page.locator(`${PANEL} [data-ci-wa="book_tour"]`);
    await GATED(row);
    await expect(row).toContainText('Unit not available');
    const sheetRow = page.locator('#ci-sheet-body [data-ci-wa="contact_agent"]');
    await GATED(sheetRow);
    await expect(sheetRow).toContainText('Unit not available');
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
  test('picking another number re-points Book a viewing and Contact agent (panel / sheet), message unchanged', async ({ page }) => {
    const { posts } = await open(page, TWO());
    await toggle(page);
    const before = await waText(page.locator(`${PANEL} [data-ci-wa="book_tour"]`));
    await page.locator('.contact-picker .cpick-row').nth(1).click();
    for (const [scope, intent] of [[PANEL, 'book_tour'], ['#ci-sheet-body', 'book_tour'], ['#ci-sheet-body', 'contact_agent']]) {
      const a = page.locator(`${scope} [data-ci-wa="${intent}"]`);
      await expect(a).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.b + '\\?text='));
      await expect(a).toHaveAttribute('data-contact-id', 'b');
    }
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.b));   // the primary button follows too
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
    await expect(page.locator(`${PANEL} [data-ci-wa="book_tour"]`)).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.b));
    await page.click('#pt-wa-primary');
    await page.waitForTimeout(400);
    expect(posts.lead_events[0]).toMatchObject({ contact_id: 'b', unit_type_id: 'room-a' });
    // ...and the sheet's actions follow the same contact
    await page.setViewportSize({ width: 375, height: 760 });
    await page.waitForTimeout(300);
    for (const intent of ['book_tour', 'contact_agent']) {
      await expect(page.locator(`#ci-sheet-body [data-ci-wa="${intent}"]`)).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.b));
    }
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
  test('ON: Book a viewing is in the desktop panel (Contact agent is the primary button); the sheet has Call and WhatsApp', async ({ page }) => {
    await open(page, prop());
    await toggle(page);
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(PANEL_MENU);
    await expect(page.locator('#pt-wa-primary')).toBeVisible();
    await page.setViewportSize({ width: 375, height: 760 });
    await page.waitForTimeout(300);
    await page.click(ASK);
    expect(await sheetKeys(page)).toEqual(SHEET_ON);
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

  test('OFF on a phone: the sheet lists answers, then the status CTA; the bar stays Ask + Share', async ({ page }) => {
    await phone(page, { row: prop({ market_status: 'rented' }) });
    await expect(page.locator('#pt-wa-mobile')).toHaveCount(0);
    await expect(page.locator('#mobile-cta-bar .mcta-btn')).toHaveCount(0);                  // the bar is Ask + Share only
    await page.click(ASK);
    expect(await sheetKeys(page)).toEqual([...SHEET_ANSWERS, 'status']);                     // the status CTA is the last row
  });

  test('coming soon: OFF everywhere in the contact area; no WhatsApp, Call or Notify Me at all', async ({ page }) => {
    const { posts } = await open(page, prop({ market_status: 'coming_soon' }));
    await expect(page.locator('#pt-wa-primary')).toHaveCount(0);
    await expect(page.locator('#pt-call-primary')).toHaveCount(0);
    await expect(page.locator('#agent-band-anchor a.btn-wa, #agent-band-anchor .agent-ctas')).toHaveCount(0);
    await toggle(page);
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(ANSWER_ONLY);
    await page.locator(`${PANEL} [data-contact-intent="availability"]`).click();
    await expect(page.locator('#contact-intent-answer .ci-answer-head')).toHaveText('Coming Soon');
    await expect(page.locator('#contact-intent-answer')).not.toContainText('Available Now');
    expect(posts.lead_events).toEqual([]);
  });

  test('coming soon on a phone: the sheet shows the page answers only (no status row)', async ({ page }) => {
    await phone(page, { row: prop({ market_status: 'coming_soon', unit_types: [UA, UB] }) });
    await expect(page.locator('#pt-wa-mobile')).toHaveCount(0);
    await expect(page.locator('#mobile-cta-bar .mcta-btn')).toHaveCount(0);
    await page.click(ASK);
    expect(await sheetKeys(page)).toEqual(SHEET_ANSWERS);
    await expect(page.locator('#ci-sheet-body .ci-item-status')).toHaveCount(0);
  });

  test('multi-unit rented with an open unit: ON for that unit only (gated actions, unit-specific answer)', async ({ page }) => {
    await open(page, MULTI({ market_status: 'rented', unit_types: [UA, FULL('f', 'Full Type')] }));
    await toggle(page);
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(PANEL_MENU);
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
    expect(await page.locator(PANEL + ' .ci-item .ci-label').allInnerTexts()).toEqual(['ນັດເບິ່ງຊັບສິນ', 'ຢູ່ບ່ອນໃດ?', 'ລາຄາເທົ່າໃດ?', 'ເງື່ອນໄຂ, ຄ່າໄຟ ແລະ ຄ່ານ້ຳ', 'ຍັງວ່າງຢູ່ບໍ?', 'ເບິ່ງຮູບພາບ']);
    await page.setViewportSize({ width: 375, height: 760 });
    await page.waitForTimeout(300);
    await page.click(ASK);
    expect(await page.locator('#ci-sheet-body .ci-item .ci-label').allInnerTexts()).toEqual(['ຢູ່ບ່ອນໃດ?', 'ລາຄາເທົ່າໃດ?', 'ເງື່ອນໄຂ, ຄ່າໄຟ ແລະ ຄ່ານ້ຳ', 'ຍັງວ່າງຢູ່ບໍ?', 'ເບິ່ງຮູບພາບ', 'ນັດເບິ່ງຊັບສິນ', 'ໂທຫານາຍໜ້າ', 'ແຊັດກັບນາຍໜ້າຜ່ານ WhatsApp']);
  });
});

// ═══ Labels per language / no photos / no phone ══════════════════════════════
test.describe('labels and edge cases', () => {
  for (const [lang, labels, callLabel, waLabel] of [
    ['en', ['Book a viewing', 'Where is it?', "What's the price?", 'Terms & utilities', 'Is it available?', 'View photos'], 'Call agent', 'Chat with agent on WhatsApp'],
    ['zh', ['预约看房', '在哪里？', '价格多少？', '条款与水电杂费', '还有吗？', '查看照片'], '致电经纪人', '通过 WhatsApp 联系经纪人'],
  ]) {
    test(`${lang}: the menu labels`, async ({ page }) => {
      await open(page, prop(), { lang });
      await toggle(page);
      expect(await page.locator(PANEL + ' .ci-item .ci-label').allInnerTexts()).toEqual(labels);
      await page.setViewportSize({ width: 375, height: 760 });
      await page.waitForTimeout(300);
      await page.click(ASK);
      const [book, ...answers] = labels;
      expect(await page.locator('#ci-sheet-body .ci-item .ci-label').allInnerTexts()).toEqual([...answers, book, callLabel, waLabel]);   // the sheet is the complete menu
    });
  }

  test('no photos: View photos is not offered', async ({ page }) => {
    await open(page, prop({ images: [] }));
    await toggle(page);
    expect(await ids(page.locator(PANEL + ' .ci-item'))).toEqual(['book_tour', 'location', 'price', 'terms', 'availability']);
    await page.setViewportSize({ width: 375, height: 760 });
    await page.waitForTimeout(300);
    await page.click(ASK);
    expect(await sheetKeys(page)).toEqual(['location', 'price', 'terms', 'availability', 'book_tour', 'call', 'whatsapp']);
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

// ═══ Unavailable listings: the status CTA works from the contact band AND from the Ask sheet ═══════════════
// (Find Similar for sold / rented / reserved / off market; Notify Me for coming soon; waiting list for fully
// occupied.) Neither is a contact intent: own tracking ids, never a lead. The mobile bar no longer holds it.
test.describe('unavailable listings: status CTA from the band and the Ask sheet', () => {
  // Make Similar Properties tall and visible so "scrolled to it" is observable.
  const showSimilar = (page) => page.evaluate(() => {
    const s = document.getElementById('similar-section');
    s.style.display = 'block'; s.style.minHeight = '900px';
    const pad = document.createElement('div'); pad.style.height = '3000px'; s.before(pad);
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  const nearTop = (page) => page.evaluate(() => Math.abs(document.getElementById('similar-section').getBoundingClientRect().top) < 120);
  const statusEvents = (posts, id) => posts.ui_events.filter((e) => e.element_id === id);

  for (const status of ['sold', 'rented', 'reserved', 'off_market']) {
    test(`${status}: Find Similar works from the band and from the sheet; no lead, no contact intent`, async ({ page }) => {
      const { posts, errors } = await phone(page, { row: prop({ market_status: status }) });
      await expect(page.locator('#mobile-cta-bar .mcta-inner > *')).toHaveCount(2);                // Ask + Share only
      // contact band
      await showSimilar(page);
      await page.locator('#agent-band-anchor a[href="#similar-section"]').click();
      await expect.poll(() => nearTop(page)).toBe(true);
      expect(statusEvents(posts, 'status-cta-find-similar').length).toBe(1);
      // Ask sheet
      await showSimilar(page);
      await page.click(ASK);
      await page.locator('#ci-sheet-body .ci-item-status').click();
      await expect(page.locator('#ci-sheet-root')).toBeHidden();                                   // the sheet closes
      await expect.poll(() => nearTop(page)).toBe(true);
      const sheet = statusEvents(posts, 'mcta-find-similar');
      expect(sheet.length).toBe(1);
      expect(sheet[0]).toMatchObject({ element_type: 'cta', label: 'Find Similar' });
      // never a lead, never a WhatsApp/call contact intent
      expect(posts.lead_events).toEqual([]);
      expect(posts.ui_events.some((e) => e.element_id === 'contact_intent_contact_agent' || e.element_type === 'cta' && /^contact_intent_/.test(e.element_id))).toBe(false);
      expect(errors).toEqual([]);
    });
  }

  for (const [status, label] of [['fully_occupied', 'Waiting List']]) {
    test(`${status}: the ${label} CTA opens WhatsApp from the band and from the sheet; recordLead:false, no lead`, async ({ page }) => {
      const { posts, errors } = await phone(page, { row: prop({ market_status: status }) });
      const band = page.locator('#agent-band-anchor a.btn-wa');
      const bandHref = await band.getAttribute('href');
      expect(bandHref).toMatch(new RegExp('^https://wa\\.me/' + NUM.a + '\\?text='));
      await band.click();
      await page.waitForTimeout(300);
      expect(statusEvents(posts, 'contact-whatsapp-status-cta').length).toBe(1);
      await page.click(ASK);
      const row = page.locator('#ci-sheet-body .ci-item-status');
      await expect(row).toHaveAttribute('href', bandHref);                                        // same destination and message
      await expect(row).toHaveAttribute('target', '_blank');
      await row.click();
      await expect(page.locator('#ci-sheet-root')).toBeHidden();
      await page.waitForTimeout(300);
      const sheet = statusEvents(posts, 'mcta-whatsapp-status');
      expect(sheet.length).toBe(1);
      expect(sheet[0]).toMatchObject({ element_type: 'cta', property_id: 'p-menu' });
      expect(posts.lead_events).toEqual([]);                                                      // a waitlist ping is not a lead
      expect(intentRows(posts).filter((e) => e.element_id !== 'contact_intent_open' && e.element_id !== 'contact_intent_availability')).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});

// ═══ A WhatsApp / Call action is exactly one lead, however it is reached ═══════════════════════════════════
test.describe('lead_events: exactly once per actual WhatsApp / call action', () => {
  test('mobile: sheet WhatsApp x1 and Call x1 → 2 leads (whatsapp_click, call_click); the row is unreachable the instant it is tapped', async ({ page }) => {
    await noTelNav(page);
    const { posts } = await phone(page, { row: prop() });
    await page.click(ASK);
    // the tap closes the sheet synchronously, so a second real tap cannot land on the row again
    // (a script's .click() ignores visibility, so assert the reachability instead of faking a double tap)
    const reachable = await page.evaluate(() => { const a = document.getElementById('ci-wa-sheet'); a.click(); return !!(a.offsetParent || a.getClientRects().length); });
    expect(reachable).toBe(false);
    await page.waitForTimeout(500);
    expect(posts.lead_events.map((l) => l.event_type)).toEqual(['whatsapp_click']);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta').length).toBe(1);
    await page.click(ASK);
    await page.click('#ci-call-sheet');
    await page.waitForTimeout(500);
    expect(posts.lead_events.map((l) => l.event_type)).toEqual(['whatsapp_click', 'call_click']);
    const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
    expect(cta.map((e) => e.element_id)).toEqual(['contact_intent_contact_agent', 'contact_intent_contact_agent']);
    expect(cta.map((e) => e.metadata.channel)).toEqual(['whatsapp', 'call']);
  });

  test('desktop: the primary Chat on WhatsApp and Call buttons are unchanged: one lead per click', async ({ page }) => {
    await noTelNav(page);
    const { posts } = await open(page, prop());
    await page.click('#pt-wa-primary');
    await page.waitForTimeout(400);
    expect(posts.lead_events.map((l) => l.event_type)).toEqual(['whatsapp_click']);
    await page.locator('#agent-band-anchor a[href^="tel:"]').first().click();
    await page.waitForTimeout(400);
    expect(posts.lead_events.map((l) => l.event_type)).toEqual(['whatsapp_click', 'call_click']);
    const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
    // desktop WhatsApp is the contact_agent intent (channel whatsapp, surface band); the desktop Call button is
    // untouched by this change and keeps its legacy id
    expect(cta.map((e) => [e.element_id, e.label])).toEqual([['contact_intent_contact_agent', 'WhatsApp'], ['contact-phone', 'Call']]);
    expect(cta[0].metadata).toMatchObject({ intent: 'contact_agent', surface: 'band', channel: 'whatsapp' });
  });
});

// ═══ The sticky bar is exactly two controls at every phone width, in every language ═════════════════════
test.describe('sticky bar: exactly Ask + Share', () => {
  for (const lang of ['en', 'lo', 'zh']) {
    test(`${lang}: two visible controls (Ask, Share), no third button, no WhatsApp, no overflow, 320–960px`, async ({ page }) => {
      await phone(page, { row: prop(), lang });
      for (const width of [320, 360, 375, 414, 600, 960]) {
        await page.setViewportSize({ width, height: 760 });
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => {
          const bar = document.getElementById('mobile-cta-bar'); const inner = bar.querySelector('.mcta-inner');
          const kids = [...inner.children].map((e) => ({ id: e.id, cls: e.className, w: e.getBoundingClientRect().width, vis: !!(e.offsetParent || e.getClientRects().length) }));
          const ask = document.getElementById('ci-open-sheet').getBoundingClientRect(); const share = inner.querySelector('.pt-share-btn').getBoundingClientRect();
          return { kids, buttons: bar.querySelectorAll('button, a').length, overflow: bar.scrollWidth > bar.clientWidth + 1 || inner.scrollWidth > inner.clientWidth + 1,   // the BAR only: the page's own Lao Call button overflows at 320px on main too
            askInBar: ask.left >= 0 && ask.right <= innerWidth && share.left >= 0 && share.right <= innerWidth && ask.right <= share.left, text: bar.innerText.replace(/\s+/g, ' ') };
        });
        const tag = lang + '@' + width;
        expect(m.kids.map((k) => k.id || k.cls.split(' ')[0]), tag).toEqual(['ci-open-sheet', 'pt-share-btn']);
        expect(m.kids.every((k) => k.vis && k.w > 0), tag).toBe(true);
        expect(m.buttons, tag).toBe(2);                                    // Ask + Share: no third button, no link
        expect(m.overflow, tag).toBe(false);
        expect(m.askInBar, tag).toBe(true);
        expect(m.text, tag).not.toMatch(/WhatsApp|ວອດ|微信/i);
        await expect(page.locator('#mobile-cta-bar [data-ci-wa], #mobile-cta-bar [href*="wa.me"], #mobile-cta-bar .mcta-btn, #pt-wa-mobile')).toHaveCount(0);
      }
    });
  }
});

// ═══ contact_intent_unit_select: the actual "Select a unit" interaction on a multi-unit listing ═══════════
test.describe('contact_intent_unit_select', () => {
  const unitEvents = (posts) => posts.ui_events.filter((e) => e.element_id === 'contact_intent_unit_select');

  test('not fired by a render, a language switch or a deep link; fired once per real selection', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    await page.click('.lang-btn[data-lang="zh"]'); await page.waitForTimeout(400);
    expect(unitEvents(posts)).toEqual([]);                                                  // render + language switch: nothing
    await page.goto('/listing.html?slug=menu-test&lang=en&unit=room-a');                    // deep link preselects a unit
    await page.waitForSelector('#section-price'); await page.waitForTimeout(500);
    expect(unitEvents(posts)).toEqual([]);                                                  // ...and that is not an interaction

    await page.locator('.unit-card', { hasText: 'Room Type B' }).first().click();
    await page.waitForTimeout(400);
    const ev = unitEvents(posts);
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ element_type: 'contact_intent', label: 'Selected a unit', property_id: 'p-menu', page: 'listing.html' });
    expect(ev[0].metadata).toMatchObject({ intent: 'unit_select', surface: 'unit_card', unit_type_id: 'room-b', lang: 'en' });
    expect(ev[0].metadata.availability).toMatchObject({ available: true });
    expect(posts.lead_events).toEqual([]);                                                  // never a lead
  });

  test('un-selecting back to the overview records nothing; selecting another unit records it', async ({ page }) => {
    const { posts } = await open(page, MULTI());
    const card = (n) => page.locator('.unit-card', { hasText: n }).first();
    await card('Room Type A').click(); await page.waitForTimeout(450);
    expect(unitEvents(posts).length).toBe(1);
    await card('Room Type A').click(); await page.waitForTimeout(450);                      // toggle off
    expect(unitEvents(posts).length).toBe(1);
    await card('Room Type B').click(); await page.waitForTimeout(450);
    expect(unitEvents(posts).map((e) => e.metadata.unit_type_id)).toEqual(['room-a', 'room-b']);
  });

  test('a single-unit listing has no unit picker and never records it', async ({ page }) => {
    const { posts } = await open(page, prop());
    await page.waitForTimeout(300);
    expect(unitEvents(posts)).toEqual([]);
  });
});

// ═══ Terms & utilities and Price & deposit: answered on the page, or handed to the agent ════════════════
// resolution 'answer_on_site' | 'escalate_to_agent' and topic 'price' | 'deposit' | 'terms' travel in ui_events.metadata
// (no schema change). Nothing opens WhatsApp until the explicit "Ask the agent" button is tapped; that click is one
// contact_intent_contact_agent row (surface "answer", channel "whatsapp", resolution escalate_to_agent) + ONE lead.
test.describe('Terms & utilities / Price & deposit', () => {
  const TERMS = { version: 1, deposit: { type: 'months_of_rent', value: 2 }, electricity: { type: 'included' } };
  const NO_DEPOSIT = { version: 1, electricity: { type: 'included' } };
  const BOX = '#contact-intent-answer';
  const ASKBTN = `${BOX} .ci-answer-ask`;
  const evs = (posts, id) => posts.ui_events.filter((e) => e.element_id === id);
  const panelTerms = (page) => page.locator(`${PANEL} [data-contact-intent="terms"]`);
  const panelPrice = (page) => page.locator(`${PANEL} [data-contact-intent="price"]`);

  test.describe('the Terms row: where and when it appears', () => {
    const NO_NUMBER = [{ sort_order: 0, is_primary: true, contacts: Object.assign({}, A, { phone: '', whatsapp: '' }) }];
    for (const [label, row, expected] of [
      ['rental with terms', prop({ rental_terms: TERMS }), true],
      ['rental with no terms but a number (the agent can be asked)', prop(), true],
      ['rental with terms but no number', prop({ rental_terms: TERMS, property_contacts: NO_NUMBER }), true],
      ['rental with no terms and no number: nothing to answer with or hand to', prop({ property_contacts: NO_NUMBER }), false],
      ['sale listing (rental terms do not apply)', prop({ transaction_type: 'for_sale', rental_terms: TERMS }), false],
      ['sold rental WITH terms: still answerable', prop({ market_status: 'sold', rental_terms: TERMS }), true],
      ['sold rental with NO terms: an OFF listing has no WhatsApp path to hand it to', prop({ market_status: 'sold' }), false],
    ]) {
      test(`${label}: ${expected ? 'shown' : 'hidden'}`, async ({ page }) => {
        await open(page, row);
        await toggle(page);
        const keys = await ids(page.locator(PANEL + ' .ci-item'));
        expect(keys.includes('terms')).toBe(expected);
        if (expected) expect(keys.indexOf('terms')).toBe(keys.indexOf('price') + 1);              // directly after Price
      });
    }
  });

  test('Terms with data: answers on the page (answer_on_site), lists the terms, no lead, no WhatsApp; then an explicit ask = ONE lead', async ({ page }) => {
    const { posts } = await open(page, prop({ rental_terms: TERMS }));
    await toggle(page);
    await panelTerms(page).click();
    await expect(page.locator(BOX)).toBeVisible();
    await expect(page.locator(BOX)).toHaveAttribute('data-resolution', 'answer_on_site');
    await expect(page.locator(`${BOX} .ci-answer-terms li`)).toHaveCount(2);
    await expect(page.locator(BOX)).toContainText('Security Deposit');
    const t = evs(posts, 'contact_intent_terms');
    expect(t.length).toBe(1);
    expect(t[0]).toMatchObject({ element_type: 'contact_intent', label: 'Terms & utilities', property_id: 'p-menu' });
    expect(t[0].metadata).toMatchObject({ intent: 'terms', resolution: 'answer_on_site', topic: 'terms', surface: 'panel', lang: 'en' });
    expect(posts.lead_events).toEqual([]);
    expect(await page.evaluate(() => window.__opens.length)).toBe(0);
    // the soft "ask about anything not listed" control: one tap, one lead, an escalation
    const ask = page.locator(ASKBTN);
    await expect(ask).toHaveText(/Ask the agent about anything not listed/);
    const href = await ask.getAttribute('href');
    expect(href).toMatch(new RegExp('^https://wa\\.me/' + NUM.a + '\\?text='));
    const msg = decodeURIComponent(href.split('?text=')[1]);
    expect(msg).toContain('rental terms and utilities'); expect(msg).toContain('Nice Apartment'); expect(msg).toContain('https://pintag.io/listing.html?slug=menu-test&lang=en');
    await ask.click(); await page.waitForTimeout(400);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0]).toMatchObject({ listing_id: 'p-menu', contact_id: 'a', event_type: 'whatsapp_click' });
    const cta = posts.ui_events.filter((e) => e.element_type === 'cta');
    expect(cta.length).toBe(1);
    expect(cta[0]).toMatchObject({ element_id: 'contact_intent_contact_agent', label: 'WhatsApp' });
    expect(cta[0].metadata).toMatchObject({ intent: 'contact_agent', surface: 'answer', channel: 'whatsapp', resolution: 'escalate_to_agent', topic: 'terms' });
  });

  test('Terms with NO data: escalate_to_agent, says what is missing, offers the agent; WhatsApp only on the tap', async ({ page }) => {
    const { posts } = await open(page, prop());
    await toggle(page);
    await panelTerms(page).click();
    await expect(page.locator(BOX)).toHaveAttribute('data-resolution', 'escalate_to_agent');
    await expect(page.locator(BOX)).toContainText("aren't listed yet");
    await expect(page.locator(`${BOX} .ci-answer-terms`)).toHaveCount(0);
    await expect(page.locator(ASKBTN)).toHaveText(/Ask the agent about terms on WhatsApp/);
    expect(evs(posts, 'contact_intent_terms')[0].metadata).toMatchObject({ resolution: 'escalate_to_agent', topic: 'terms' });
    expect(posts.lead_events).toEqual([]);                                                   // choosing the question is not contacting anyone
    await page.locator(ASKBTN).click(); await page.waitForTimeout(400);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta')[0].metadata).toMatchObject({ resolution: 'escalate_to_agent', topic: 'terms', surface: 'answer', channel: 'whatsapp' });
  });

  test('Price on a rental WITH a deposit: answer_on_site, topic deposit; the price section is shown, nothing to ask', async ({ page }) => {
    const { posts } = await open(page, prop({ rental_terms: TERMS }));
    await toggle(page);
    await panelPrice(page).click();
    await page.waitForTimeout(300);
    const p = evs(posts, 'contact_intent_price');
    expect(p.length).toBe(1);
    expect(p[0].metadata).toMatchObject({ intent: 'price', resolution: 'answer_on_site', topic: 'deposit', surface: 'panel' });
    await expect(page.locator(BOX)).toBeHidden();
    await expect(page.locator('.price-deposit')).toContainText('Security Deposit');         // the price section already shows it
    expect(posts.lead_events).toEqual([]);
  });

  test('Price on a rental with NO deposit listed: escalate_to_agent, topic deposit, an explicit ask button', async ({ page }) => {
    const { posts } = await open(page, prop({ rental_terms: NO_DEPOSIT }));
    await toggle(page);
    await panelPrice(page).click();
    await expect(page.locator(BOX)).toBeVisible();
    await expect(page.locator(BOX)).toContainText("deposit for this property isn't listed");
    expect(evs(posts, 'contact_intent_price')[0].metadata).toMatchObject({ resolution: 'escalate_to_agent', topic: 'deposit' });
    const msg = decodeURIComponent((await page.locator(ASKBTN).getAttribute('href')).split('?text=')[1]);
    expect(msg).toContain('the deposit');
    expect(posts.lead_events).toEqual([]);
    await page.locator(ASKBTN).click(); await page.waitForTimeout(400);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta')[0].metadata).toMatchObject({ resolution: 'escalate_to_agent', topic: 'deposit' });
  });

  test('Price on a sale listing: answer_on_site, topic price; no deposit question is invented', async ({ page }) => {
    const { posts } = await open(page, prop({ transaction_type: 'for_sale' }));
    await toggle(page);
    await panelPrice(page).click();
    await page.waitForTimeout(300);
    expect(evs(posts, 'contact_intent_price')[0].metadata).toMatchObject({ resolution: 'answer_on_site', topic: 'price' });
    await expect(page.locator(BOX)).toBeHidden();
  });

  test('an OFF rental offers no agent: Price stays answer_on_site, Terms (with data) has no ask button', async ({ page }) => {
    const { posts } = await open(page, prop({ market_status: 'sold', rental_terms: NO_DEPOSIT }));
    await toggle(page);
    await panelPrice(page).click(); await page.waitForTimeout(250);
    expect(evs(posts, 'contact_intent_price')[0].metadata).toMatchObject({ resolution: 'answer_on_site', topic: 'price' });   // nothing was offered, so nothing is "escalated"
    await panelTerms(page).click();
    await expect(page.locator(BOX)).toHaveAttribute('data-resolution', 'answer_on_site');
    await expect(page.locator(ASKBTN)).toHaveCount(0);
    expect(posts.lead_events).toEqual([]);
  });

  test('multi-unit with no unit chosen: the ask control is gated on the unit picker (no lead, no WhatsApp); choosing a unit unlocks it', async ({ page }) => {
    const { posts } = await open(page, MULTI({ unit_types: [UA, UB] }));
    await toggle(page);
    await panelTerms(page).click();
    const gated = page.locator(`${BOX} .ci-answer-ask`);
    await expect(gated).toHaveAttribute('data-wa-needs-unit', '1');
    await expect(gated).toHaveAttribute('aria-disabled', 'true');
    await expect(gated).toContainText('Select a unit above');
    await gated.click({ force: true }); await page.waitForTimeout(350);
    expect(posts.lead_events).toEqual([]);
    expect(posts.ui_events.filter((e) => e.element_type === 'cta')).toEqual([]);
    await page.locator('.unit-card', { hasText: 'Room Type B' }).first().click();
    await page.waitForTimeout(500);                                                          // the panel stays open across the re-render
    await panelTerms(page).click();
    const live = page.locator(ASKBTN);
    await expect(live).not.toHaveAttribute('data-wa-needs-unit', '1');
    const msg = decodeURIComponent((await live.getAttribute('href')).split('?text=')[1]);
    expect(msg).toContain('Room Type B');                                                  // the lead says WHICH unit
    await live.click(); await page.waitForTimeout(400);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0]).toMatchObject({ unit_type_id: 'room-b' });
  });

  test('a per-unit override changes the answer for that unit', async ({ page }) => {
    const UO = Object.assign({}, UA, { rental_terms_overrides: { version: 1, deposit: { type: 'months_of_rent', value: 1 } } });
    await open(page, MULTI({ rental_terms: TERMS, unit_types: [UO, UB] }));
    await toggle(page);
    await panelTerms(page).click();
    const building = (await page.locator(`${BOX} .ci-answer-terms`).innerText()).replace(/\s+/g, ' ');
    await page.locator('.unit-card', { hasText: 'Room Type A' }).first().click();
    await page.waitForTimeout(500);
    await panelTerms(page).click();
    const unit = (await page.locator(`${BOX} .ci-answer-terms`).innerText()).replace(/\s+/g, ' ');
    expect(unit).not.toBe(building);
  });

  test('mobile sheet: Terms is in the sheet after Price, records surface "sheet", closes the sheet and answers on the page', async ({ page }) => {
    const { posts } = await phone(page, { row: prop({ rental_terms: TERMS }) });
    await page.click(ASK);
    expect(await sheetKeys(page)).toEqual(SHEET_ON);
    await page.locator('#ci-sheet-body [data-contact-intent="terms"]').click();
    await expect(page.locator('#ci-sheet-root')).toBeHidden();
    await expect(page.locator(BOX)).toBeVisible();
    expect(evs(posts, 'contact_intent_terms')[0].metadata).toMatchObject({ surface: 'sheet', resolution: 'answer_on_site' });
  });

  test('the question is asked in the visitor\'s language (zh) and follows the contact picker', async ({ page }) => {
    const { posts } = await open(page, TWO(), { lang: 'zh' });
    await toggle(page);
    await page.locator('.contact-picker .cpick-row').nth(1).click();
    await page.waitForTimeout(300);
    await panelTerms(page).click();
    const href = await page.locator(ASKBTN).getAttribute('href');
    expect(href).toMatch(new RegExp('^https://wa\\.me/' + NUM.b));
    expect(decodeURIComponent(href.split('?text=')[1])).toContain('租赁条款和水电杂费');
    await page.locator(ASKBTN).click(); await page.waitForTimeout(400);
    expect(posts.lead_events[0]).toMatchObject({ contact_id: 'b' });
    expect(posts.ui_events.filter((e) => e.element_type === 'cta')[0].metadata).toMatchObject({ contact_id: 'b', lang: 'zh', resolution: 'escalate_to_agent' });
  });

  test('repeat taps on Terms/Price never create a lead, and an answer rendered earlier is replaced, not stacked', async ({ page }) => {
    const { posts } = await open(page, prop({ rental_terms: NO_DEPOSIT }));
    await toggle(page);
    await panelTerms(page).click(); await page.waitForTimeout(350);
    await panelPrice(page).click(); await page.waitForTimeout(350);
    await panelTerms(page).click(); await page.waitForTimeout(350);
    expect(await page.locator(`${BOX} .ci-answer-ask`).count()).toBe(1);
    expect(posts.lead_events).toEqual([]);
    expect(evs(posts, 'contact_intent_terms').length).toBe(2);
    expect(evs(posts, 'contact_intent_price').length).toBe(1);
  });

  test('no JS errors and no duplicate ids with the new row and answer controls', async ({ page }) => {
    const { errors } = await open(page, MULTI({ rental_terms: NO_DEPOSIT }));
    await toggle(page);
    await panelTerms(page).click();
    await panelPrice(page).click();
    const dup = await page.evaluate(() => { const c = {}; document.querySelectorAll('[id]').forEach((e) => { c[e.id] = (c[e.id] || 0) + 1; }); return Object.keys(c).filter((k) => c[k] > 1); });
    expect(dup).toEqual([]);
    expect(errors).toEqual([]);
  });
});
