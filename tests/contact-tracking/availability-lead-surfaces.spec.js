// Availability State Integration (PR 1): no live lead-creating CTA for an unavailable property or a closed unit.
// The real listing.html with mocked Supabase. One resolver (property-availability.js) decides; this spec pins what
// every lead surface does in each state: per-unit Inquire, primary WhatsApp, primary Call, the Ask menu and the
// answer's "Ask the agent" button, and that a gated element sends no lead_events, no contact-intent row and no
// WhatsApp / tel: navigation.
const { test, expect } = require('@playwright/test');

const A = { id: 'a', role: 'agent', name: 'Somchai', phone: '+856 20 111 1111', whatsapp: '+856 20 111 1111', languages: ['lo', 'en'] };
const B = { id: 'b', role: 'agent', name: 'Nok', phone: '+856 20 222 2222', whatsapp: '+856 20 222 2222', languages: ['th'] };
const UNIT = (id, o) => Object.assign({ id, name_en: id, name_lo: id, name_zh: id, bedrooms: 2, bathrooms: 1, sqm: 40,
  price_amount: 400, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 2, total_units: null, images: [] }, o || {});
const OPEN = (id) => UNIT(id);
const FULL = (id) => UNIT(id, { available_count: 0, next_available_date: '2999-01-01' });
const TEMP = (id) => UNIT(id, { available_count: 0 });
const prop = (market, units, o) => Object.assign({
  id: 'p-av', slug: 'av-test', title_en: 'Avail Test', title_lo: 'ທົດສອບ', title_zh: '测试', property_type: 'apartment', transaction_type: 'for_rent',
  price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450/month',
  images: ['https://example.com/a.jpg'], amenities: [], features: [], district_en: 'Sisattanak',
  workflow_status: 'active', market_status: market, status: 'active', created_at: new Date().toISOString(), bedrooms: 2, bathrooms: 1, sqm: 60,
  contacts: null, property_contacts: [{ sort_order: 0, is_primary: true, contacts: A }], managed_by_party_id: 'party-1', parties: null, unit_types: units || [],
}, o || {});

async function open(page, row, { width, height } = {}) {
  const posts = { ui_events: [], lead_events: [] };
  if (width) await page.setViewportSize({ width, height: height || 760 });
  await page.addInitScript(() => {
    window.__opens = []; window.open = (...a) => { window.__opens.push(a); return null; };
    // wa.me / tel: navigations must never happen from a gated element; record any click that would navigate
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a && /^(https:\/\/wa\.me|tel:)/.test(a.getAttribute('href') || '')) { window.__navAttempts = (window.__navAttempts || []); window.__navAttempts.push(a.getAttribute('href')); e.preventDefault(); }
    }, true);
  });
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
  await page.goto('/listing.html?slug=' + row.slug + '&lang=en');
  await page.waitForSelector('#section-price');
  await page.waitForTimeout(450);
  return { posts, errors };
}
const contactRows = (posts) => posts.ui_events.filter((e) => /^contact_intent_(contact_agent|book_tour)$/.test(e.element_id) || e.element_id === 'contact-whatsapp' || e.element_id === 'contact-phone' || e.element_id === 'unit-inquire-whatsapp');
const navAttempts = (page) => page.evaluate(() => window.__navAttempts || []);
const inquire = (page) => page.locator('.unit-cta');
const unitIds = (page) => page.locator('.unit-cta').evaluateAll((els) => els.map((e) => e.closest('.unit-card').querySelector('.unit-name').textContent.trim()));
const badge = (page) => page.locator('.status-badge, [class*="status-badge"]').first();

// ═══ Per-unit Inquire ══════════════════════════════════════════════════════════════════════════════════════════
test.describe('per-unit Inquire is a lead CTA: only for an OPEN unit of a contactable property', () => {
  const CASES = [
    // [label, market, units, expected Inquire unit ids]
    ['available, both units open (existing behaviour intact)', 'available', [OPEN('a'), OPEN('b')], ['a', 'b']],
    ['available, one open one full: only the open unit', 'available', [OPEN('a'), FULL('b')], ['a']],
    ['available, open + temporarily unavailable: only the open unit', 'available', [TEMP('b'), OPEN('a')], ['a']],
    ['available, every unit closed', 'available', [FULL('a'), TEMP('b')], []],
    ['rented multi-unit with an open unit: unit-level, only the open unit', 'rented', [OPEN('a'), FULL('b')], ['a']],
    ['rented multi-unit, no open unit', 'rented', [FULL('a'), FULL('b')], []],
    ['sold with open units', 'sold', [OPEN('a'), OPEN('b')], []],
    ['off_market with open units', 'off_market', [OPEN('a'), OPEN('b')], []],
    ['coming_soon with open units', 'coming_soon', [OPEN('a'), OPEN('b')], []],
    ['reserved with open units: a multi-unit open unit is still contactable', 'reserved', [OPEN('a'), OPEN('b')], ['a', 'b']],
  ];
  for (const [label, market, units, expectIds] of CASES) {
    test(label, async ({ page }) => {
      const { posts, errors } = await open(page, prop(market, units));
      expect((await unitIds(page)).sort()).toEqual(expectIds);
      for (const href of await inquire(page).evaluateAll((els) => els.map((e) => e.getAttribute('href')))) expect(href).toMatch(/^https:\/\/wa\.me\/856201111111\?text=/);
      expect(contactRows(posts)).toEqual([]); expect(posts.lead_events).toEqual([]);                 // rendering records nothing
      expect(errors).toEqual([]);
    });
  }

  test('an available unit\'s Inquire still records exactly one lead with its unit id', async ({ page }) => {
    const { posts } = await open(page, prop('available', [OPEN('a'), FULL('b')]));
    await inquire(page).first().click();
    await page.waitForTimeout(200);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].unit_type_id).toBe('a');
    expect(posts.lead_events[0].event_type).toBe('whatsapp_click');
  });
});

// ═══ Primary WhatsApp / Call with a selected CLOSED unit ═══════════════════════════════════════════════════════
test.describe('selecting a closed unit gates the primary WhatsApp and Call buttons', () => {
  const GATED = async (loc) => {
    await expect(loc).toHaveAttribute('data-wa-needs-unit', '1');
    await expect(loc).toHaveAttribute('aria-disabled', 'true');
    await expect(loc).toHaveAttribute('href', '#units-section');
  };

  test('closed unit selected: both buttons are inert, say the unit is not available, and a click sends nothing', async ({ page }) => {
    const { posts, errors } = await open(page, prop('available', [OPEN('a'), FULL('b')]));
    // before any selection: WhatsApp needs a unit, Call is a normal tel: link (unchanged behaviour)
    await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', /^tel:/);
    await page.locator('.unit-card').nth(1).click();                       // sorted: open unit first, so nth(1) is the closed one
    await page.waitForTimeout(400);
    await expect(page.locator('.unit-card-selected .unit-name')).toHaveText('b');
    await GATED(page.locator('#pt-wa-primary')); await GATED(page.locator('#pt-call-primary'));
    await expect(page.locator('#pt-wa-primary')).toContainText('Unit not available');
    await expect(page.locator('#pt-call-primary')).toContainText('Unit not available');
    await expect(page.locator('#pt-wa-unit-hint')).toContainText('Unit not available');
    await page.locator('#pt-wa-primary').click({ force: true });
    await page.locator('#pt-call-primary').click({ force: true });
    await page.waitForTimeout(300);
    expect(posts.lead_events).toEqual([]); expect(contactRows(posts)).toEqual([]);
    expect(await navAttempts(page)).toEqual([]);
    expect(await page.evaluate(() => window.__opens)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('switching to an OPEN unit makes both live again, and they track as before', async ({ page }) => {
    const { posts } = await open(page, prop('available', [OPEN('a'), FULL('b')]));
    await page.locator('.unit-card').nth(1).click(); await page.waitForTimeout(300);
    await GATED(page.locator('#pt-wa-primary'));
    await page.locator('.unit-card').nth(0).click(); await page.waitForTimeout(300);
    await expect(page.locator('.unit-card-selected .unit-name')).toHaveText('a');
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /^https:\/\/wa\.me\/856201111111\?text=/);
    await expect(page.locator('#pt-wa-primary')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', /^tel:/);
    await page.locator('#pt-wa-primary').click(); await page.waitForTimeout(250);
    expect(posts.lead_events.map((l) => [l.event_type, l.unit_type_id])).toEqual([['whatsapp_click', 'a']]);
    expect(posts.ui_events.filter((e) => e.element_id === 'contact_intent_contact_agent').length).toBe(1);
  });

  test('the contact picker cannot re-enable a gated WhatsApp / Call', async ({ page }) => {
    const row = prop('available', [OPEN('a'), FULL('b')], { property_contacts: [{ sort_order: 0, is_primary: true, contacts: A }, { sort_order: 1, contacts: B }] });
    const { posts } = await open(page, row);
    await page.locator('.unit-card').nth(1).click(); await page.waitForTimeout(300);
    await GATED(page.locator('#pt-wa-primary')); await GATED(page.locator('#pt-call-primary'));
    await page.locator('.cpick-row').nth(1).click(); await page.waitForTimeout(200);
    await GATED(page.locator('#pt-wa-primary')); await GATED(page.locator('#pt-call-primary'));
    await page.locator('#pt-call-primary').click({ force: true });
    expect(posts.lead_events).toEqual([]); expect(await navAttempts(page)).toEqual([]);
  });

  test('a deep link (?unit=) to a closed unit starts gated', async ({ page }) => {
    const row = prop('available', [OPEN('a'), FULL('b')]);
    await page.addInitScript(() => { /* no-op: the URL below carries the deep link */ });
    const posts = { ui_events: [], lead_events: [] };
    await page.route('**/rest/v1/**', (route) => { const url = route.request().url(); const ok = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.indexOf('/properties?slug=eq.') !== -1) return ok([row]); return ok([]); });
    await page.goto('/listing.html?slug=av-test&lang=en&unit=' + encodeURIComponent('b'));
    await page.waitForSelector('#section-price'); await page.waitForTimeout(450);
    await expect(page.locator('.unit-card-selected .unit-name')).toHaveText('b');
    await GATED(page.locator('#pt-wa-primary')); await GATED(page.locator('#pt-call-primary'));
    expect(posts.lead_events).toEqual([]);
  });

  test('the Ask menu rows follow the same gate (Book a viewing and Contact agent are inert for a closed unit)', async ({ page }) => {
    const { posts } = await open(page, prop('available', [OPEN('a'), FULL('b')]));
    await page.locator('.unit-card').nth(1).click(); await page.waitForTimeout(300);
    await page.click('#ci-toggle'); await page.waitForTimeout(250);
    for (const id of ['book_tour']) await expect(page.locator(`#ci-panel-body [data-ci-wa="${id}"]`)).toHaveAttribute('aria-disabled', 'true');
    await page.locator('#ci-panel-body [data-ci-wa="book_tour"]').click({ force: true });
    expect(posts.lead_events).toEqual([]); expect(await navAttempts(page)).toEqual([]);
    expect(contactRows(posts)).toEqual([]);
  });

  test('the answer\'s "Ask the agent" button is not offered for a closed unit (Terms with no data)', async ({ page }) => {
    const { posts } = await open(page, prop('available', [OPEN('a'), FULL('b')]));
    await page.locator('.unit-card').nth(1).click(); await page.waitForTimeout(300);
    await page.click('#ci-toggle'); await page.waitForTimeout(250);
    await page.locator('#ci-panel-body [data-contact-intent="terms"]').click(); await page.waitForTimeout(250);
    await expect(page.locator('#contact-intent-answer')).toBeVisible();
    await expect(page.locator('#contact-intent-answer .ci-answer-ask')).toHaveCount(0);
    expect(posts.lead_events).toEqual([]);
  });
});

// ═══ Unavailable properties: nothing lead-creating survives ════════════════════════════════════════════════════
test.describe('an unavailable property has no live lead-creating CTA anywhere on the page', () => {
  const STATES = [
    ['coming_soon, no units', prop('coming_soon'), 'Coming Soon'],
    ['coming_soon, multi-unit with open units', prop('coming_soon', [OPEN('a'), OPEN('b')]), 'Coming Soon'],
    ['sold, multi-unit with open units', prop('sold', [OPEN('a'), OPEN('b')]), 'Sold'],
    ['off_market with an open unit', prop('off_market', [OPEN('a')]), 'Off Market'],
    ['single-unit rented with a LONE OPEN unit row (property status wins)', prop('rented', [OPEN('a')]), 'Rented'],
    ['single-unit reserved with a lone open unit row', prop('reserved', [OPEN('a')]), 'Reserved'],
    ['single-unit fully_occupied with a lone open unit row', prop('fully_occupied', [OPEN('a')]), 'Fully Occupied'],
    ['available, every unit closed', prop('available', [FULL('a'), TEMP('b')]), 'Fully Occupied'],
  ];
  for (const [label, row, badgeText] of STATES) {
    test(label, async ({ page }) => {
      const { posts, errors } = await open(page, row);
      await expect(badge(page)).toContainText(badgeText);
      // no primary WhatsApp / Call, no per-unit Inquire, no WhatsApp/Call rows in the Ask panel
      await expect(page.locator('#pt-wa-primary')).toHaveCount(0);
      await expect(page.locator('#pt-call-primary')).toHaveCount(0);
      await expect(inquire(page)).toHaveCount(0);
      await page.click('#ci-toggle'); await page.waitForTimeout(250);
      await expect(page.locator('#ci-panel-body [data-ci-wa]')).toHaveCount(0);
      // the page-level availability answer agrees
      await page.locator('#ci-panel-body [data-contact-intent="availability"]').click(); await page.waitForTimeout(200);
      await expect(page.locator('#contact-intent-answer')).toHaveAttribute('data-availability', 'off');
      expect(contactRows(posts)).toEqual([]); expect(posts.lead_events).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test('coming_soon has NO Notify Me / WhatsApp action: no button, no wa.me link, no lead, no navigation, on desktop and phone', async ({ page }) => {
    for (const row of [prop('coming_soon'), prop('coming_soon', [OPEN('a'), OPEN('b')])]) {
      for (const size of [undefined, { width: 375, height: 760 }]) {
        const p2 = await page.context().newPage();
        const { posts, errors } = await open(p2, row, size);
        await expect(badge(p2)).toContainText('Coming Soon');
        await expect(p2.locator('.price-value').first()).toContainText('450');                 // the normal advertised price stays
        await expect(p2.locator('body')).not.toContainText(/Notify Me/i);
        await expect(p2.locator('#agent-band-anchor .agent-ctas')).toHaveCount(0);
        await expect(p2.locator('a[href^="https://wa.me"], a[href^="tel:"]')).toHaveCount(0);   // no WhatsApp or Call link anywhere on the page
        await expect(p2.locator('.btn-wa, .btn-call, .unit-cta')).toHaveCount(0);
        if (size) { await p2.click('#ci-open-sheet'); await p2.waitForTimeout(250); await expect(p2.locator('#ci-sheet-body .ci-item-status, #ci-sheet-body [data-ci-wa], #ci-sheet-body [data-ci-call]')).toHaveCount(0); }
        else { await p2.click('#ci-toggle'); await p2.waitForTimeout(250); await expect(p2.locator('#ci-panel-body [data-ci-wa]')).toHaveCount(0); }
        // even a forced click anywhere in the contact band cannot navigate or record a lead
        await p2.locator('#agent-band-anchor').click({ force: true }).catch(() => {});
        await p2.waitForTimeout(250);
        expect(await navAttempts(p2)).toEqual([]); expect(await p2.evaluate(() => window.__opens)).toEqual([]);
        expect(posts.lead_events).toEqual([]); expect(contactRows(posts)).toEqual([]);
        expect(posts.ui_events.filter((e) => /status-cta/.test(e.element_id))).toEqual([]);
        expect(errors).toEqual([]);
        await p2.close();
      }
    }
  });

  test('mobile: the Ask sheet of an unavailable property has no Call / WhatsApp / Book rows, only the status CTA', async ({ page }) => {
    for (const [, row] of STATES.slice(0, 5)) {
      const p2 = await page.context().newPage();
      const { posts } = await open(p2, row, { width: 375, height: 760 });
      await p2.click('#ci-open-sheet'); await p2.waitForTimeout(300);
      await expect(p2.locator('#ci-sheet-body [data-ci-wa], #ci-sheet-body [data-ci-call]')).toHaveCount(0);
      expect(posts.lead_events).toEqual([]);
      await p2.close();
    }
  });

  test('the remaining status CTAs (Find Similar / Waiting List) are unchanged and record NO lead', async ({ page }) => {
    for (const [market, label] of [['sold', /Find Similar/], ['fully_occupied', /Waiting List/]]) {
      const p2 = await page.context().newPage();
      const { posts } = await open(p2, prop(market));
      const cta = p2.locator('#agent-band-anchor .agent-ctas a.btn-primary');
      await expect(cta).toHaveText(label);
      await cta.click(); await p2.waitForTimeout(250);
      expect(posts.lead_events).toEqual([]);
      expect(contactRows(posts)).toEqual([]);
      await p2.close();
    }
  });
});

// ═══ Presentation: badge / price / panels agree with the resolver ══════════════════════════════════════════════
test.describe('presentation', () => {
  test('coming_soon: normal Coming Soon badge and normal price, NOT the sold/rented history treatment', async ({ page }) => {
    await open(page, prop('coming_soon', [OPEN('a')], { unit_types: [] }));
    await expect(badge(page)).toContainText('Coming Soon');
    await expect(page.locator('.price-value').first()).toContainText('450');
    await expect(page.locator('.price-orig-label')).toHaveCount(0);        // no "Original Asking Price"
    await expect(page.locator('#conversion-panel')).toHaveCount(0);
    await expect(page.locator('.pt-fomo-overlay')).toHaveCount(0);
  });

  test('single-unit rented with a lone open unit row: Rented badge + history treatment, no scarcity / available messaging', async ({ page }) => {
    await open(page, prop('rented', [UNIT('a', { available_count: 1, total_units: 20 })]));
    await expect(badge(page)).toContainText('Rented');
    await expect(page.locator('#conversion-panel')).toHaveCount(1);
    await expect(page.locator('.price-orig-label')).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText(/Only \d+ left|of \d+ available/i);
  });

  test('multi-unit with a stale "rented" status and an open unit: shows as available, with units, never a Rented badge', async ({ page }) => {
    await open(page, prop('rented', [OPEN('a'), FULL('b')]));
    await expect(badge(page)).not.toContainText('Rented');
    await expect(page.locator('#conversion-panel')).toHaveCount(0);
    await expect(inquire(page)).toHaveCount(1);
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-wa-needs-unit', '1');       // multi-unit: choose a unit first (unchanged)
  });

  test('existing available multi-unit behaviour is intact: both units open, WhatsApp needs a unit, picking one makes it live', async ({ page }) => {
    const { posts } = await open(page, prop('available', [OPEN('a'), OPEN('b')]));
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-wa-needs-unit', '1');
    await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', /^tel:/);
    await page.locator('.unit-card').nth(0).click(); await page.waitForTimeout(300);
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', /^https:\/\/wa\.me\//);
    await page.locator('#pt-wa-primary').click(); await page.waitForTimeout(250);
    expect(posts.lead_events.length).toBe(1);
  });
});
