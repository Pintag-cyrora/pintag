// The visitor's explicit contact choice survives every re-render of the listing page.
//
// THE BUG. The picked contact lived only in module globals and in DOM attributes that
// buildMockupLayout() rebuilds from scratch on every render, always re-deriving the contact from
// language routing. So "pick a contact, THEN select a unit" (and a language switch) swapped the
// choice back to the routed contact. (Picking a unit first and a contact second worked, only
// because ptSelectContact() patched attributes without re-rendering.)
//
// THE RULE NOW. An explicit pick outranks language routing -- through unit selection, un-selection
// and every EN/LO/ZH switch. Routing applies only when nothing was picked or the picked contact is
// no longer on the listing. Selecting a unit never changes which contact is chosen, and choosing a
// contact never changes which unit is selected; the final wa.me link and the lead carry both.
const { test, expect } = require('@playwright/test');

const A = { id: 'a', role: 'agent', name: 'Somchai', phone: '+856 20 111 1111', whatsapp: '+856 20 111 1111', languages: ['lo', 'en'] };
const B = { id: 'b', role: 'agent', name: 'Nok', phone: '+856 20 222 2222', whatsapp: '+856 20 222 2222', languages: ['th'] };
const C = { id: 'cc', role: 'agent', name: 'Ms. Li', phone: '+856 20 333 3333', whatsapp: '+856 20 333 3333', languages: ['zh'] };
const NUM = { a: '856201111111', b: '856202222222', cc: '856203333333' };
const TEL = { a: 'tel:+856201111111', b: 'tel:+856202222222', cc: 'tel:+856203333333' };
const ROW = { a: 0, b: 1, cc: 2 };          // picker row order: [a, b, cc]
// Language routing would choose: en -> a, lo -> a, zh -> cc. Nobody routes to b (Thai only).

const UNIT_A = { id: 'room-type-a', name_en: 'Room Type A', name_lo: 'ຫ້ອງ ແບບ A', name_zh: 'A型房', bedrooms: 2, bathrooms: 1, sqm: 45, price_amount: 400, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 2, total_units: null, images: [] };
const UNIT_B = { id: 'room-type-b', name_en: 'Room Type B', name_lo: 'ຫ້ອງ ແບບ B', name_zh: 'B型房', bedrooms: 1, bathrooms: 1, sqm: 32, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', is_available: true, available_count: 3, total_units: null, images: [] };

function prop(overrides) {
  return Object.assign({
    id: 'p-order', slug: 'wa-order-test', title_en: 'Nice Apartment', title_lo: 'ອາພາດເມັນ', title_zh: '公寓',
    property_type: 'apartment', transaction_type: 'for_rent',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450/month',
    images: ['https://example.com/a.jpg'], amenities: [], features: [],
    district_en: 'Sisattanak', workflow_status: 'active', market_status: 'available', status: 'active',
    created_at: new Date().toISOString(), bedrooms: 2, bathrooms: 1, sqm: 60,
    contacts: null,
    property_contacts: [{ sort_order: 0, is_primary: true, contacts: A }, { sort_order: 1, contacts: B }, { sort_order: 2, contacts: C }],
    managed_by_party_id: 'party-1', parties: null, unit_types: [],
  }, overrides || {});
}
const MULTI = (o) => prop(Object.assign({ unit_types: [UNIT_A, UNIT_B] }, o || {}));

async function open(page, row, lang) {
  const posts = { ui_events: [], lead_events: [] };
  await page.addInitScript(() => { window.open = () => null; });
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
  await page.goto('/listing.html?slug=' + row.slug + '&lang=' + (lang || 'en'));
  await page.waitForSelector('#pt-wa-primary');
  await page.waitForTimeout(400);
  return { posts, errors };
}
const pick = (page, id) => page.locator('.contact-picker .cpick-row').nth(ROW[id]).click();
const selectUnit = (page, name) => page.locator('.unit-card', { hasText: name }).first().click();
const setLang = (page, l) => page.click('.lang-btn[data-lang="' + l + '"]');
const waText = async (loc) => decodeURIComponent(((await loc.getAttribute('href')) || '').split('?text=')[1] || '');

// The whole contact surface agrees on one contact.
async function expectContact(page, id, { live = true } = {}) {
  const num = NUM[id];
  // picker: exactly this row is the active, checked one
  await expect(page.locator('.cpick-row.is-active')).toHaveCount(1);
  await expect(page.locator('.cpick-row').nth(ROW[id])).toHaveClass(/is-active/);
  await expect(page.locator('.cpick-row').nth(ROW[id])).toHaveAttribute('aria-checked', 'true');
  // every CTA is attributed to it, and (when live) dials it
  for (const sel of ['#pt-wa-primary', '#pt-wa-mobile', '#pt-call-primary']) {
    await expect(page.locator(sel)).toHaveAttribute('data-contact-id', id);
  }
  await expect(page.locator('#pt-call-primary')).toHaveAttribute('href', TEL[id]);
  if (live) {
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + num + '\\?text='));
    await expect(page.locator('#pt-wa-mobile')).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + num + '\\?text='));
  } else {
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', '#units-section');
    await expect(page.locator('#pt-wa-mobile')).toHaveAttribute('href', '#units-section');
  }
}

// ═══ Contact first, then unit ═════════════════════════════════════════════════════
test.describe('contact first, then unit', () => {
  test('selecting a unit keeps the picked contact; the final link and the lead carry BOTH', async ({ page }) => {
    const { posts, errors } = await open(page, MULTI(), 'en');
    await pick(page, 'b');
    await selectUnit(page, 'Room Type A');                 // re-renders the page
    await expectContact(page, 'b');
    const cta = page.locator('#pt-wa-primary');
    const msg = await waText(cta);
    expect(msg).toContain('Room Type A'); expect(msg).toContain('$400 / month');
    // the unit cards' own Inquire buttons follow the picked contact too
    await expect(page.locator('.unit-cta').first()).toHaveAttribute('data-contact-id', 'b');
    await expect(page.locator('.unit-cta').first()).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.b));
    await cta.click();
    await page.waitForTimeout(300);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].contact_id).toBe('b');
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
    expect(posts.lead_events[0].listing_id).toBe('p-order');
    expect(errors).toEqual([]);
  });

  test('the gated flow: pick a contact while the CTA is gated, then select a unit -> live on THAT contact', async ({ page }) => {
    await open(page, MULTI(), 'en');
    await pick(page, 'b');
    await expectContact(page, 'b', { live: false });       // still gated, but already attributed to the pick
    await selectUnit(page, 'Room Type B');
    await expectContact(page, 'b');                        // live now, on the picked contact
    const msg = await waText(page.locator('#pt-wa-primary'));
    expect(msg).toContain('Room Type B'); expect(msg).toContain('$300 / month');
  });

  test('un-selecting and re-selecting units never loses the contact; the CTA re-gates and goes live again', async ({ page }) => {
    await open(page, MULTI(), 'en');
    await pick(page, 'cc');
    await selectUnit(page, 'Room Type A');
    await expectContact(page, 'cc');
    await page.locator('.viewing-unit-reset').first().click();       // back to the building overview
    await expectContact(page, 'cc', { live: false });                // gated again, contact kept
    await selectUnit(page, 'Room Type B');
    await expectContact(page, 'cc');
    expect(await waText(page.locator('#pt-wa-primary'))).toContain('Room Type B');
    await selectUnit(page, 'Room Type A');                           // switching straight to another unit
    await expectContact(page, 'cc');
    expect(await waText(page.locator('#pt-wa-primary'))).toContain('Room Type A');
  });

  test('a later contact pick replaces the earlier one (the last explicit choice wins)', async ({ page }) => {
    await open(page, MULTI(), 'en');
    await pick(page, 'b');
    await selectUnit(page, 'Room Type A');
    await pick(page, 'cc');
    await expectContact(page, 'cc');
    await selectUnit(page, 'Room Type B');                            // another re-render
    await expectContact(page, 'cc');
  });
});

// ═══ Unit first, then contact ═════════════════════════════════════════════════════
test.describe('unit first, then contact', () => {
  test('choosing a contact keeps the selected unit; the final link and the lead carry BOTH', async ({ page }) => {
    const { posts, errors } = await open(page, MULTI(), 'en');
    await selectUnit(page, 'Room Type B');
    await expectContact(page, 'a');                        // before any pick: the routed contact
    await pick(page, 'b');
    await expectContact(page, 'b');
    const cta = page.locator('#pt-wa-primary');
    const msg = await waText(cta);
    expect(msg).toContain('Room Type B'); expect(msg).toContain('$300 / month');
    await expect(page.locator('.viewing-unit-reset')).toHaveCount(1);       // the unit is still the selected one
    await cta.click();
    await page.waitForTimeout(300);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].contact_id).toBe('b');
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-b');
    expect(errors).toEqual([]);
  });

  test('mobile sticky bar: same result in either order', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const { posts } = await open(page, MULTI(), 'en');
    await selectUnit(page, 'Room Type A');
    await pick(page, 'cc');
    const m = page.locator('#pt-wa-mobile');
    await expect(m).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.cc + '\\?text='));
    expect(await waText(m)).toContain('Room Type A');
    await m.click();
    await page.waitForTimeout(300);
    expect(posts.lead_events[0].contact_id).toBe('cc');
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
  });
});

// ═══ Language: a manual pick survives EN -> LO -> ZH, the message does not ════════
test.describe('language switching with a manual contact pick', () => {
  const MSG = { en: "interested in this property", lo: 'ສະບາຍດີ', zh: '您好' };
  const UNIT_MSG = { en: 'interested in the Room Type A', lo: 'ຫ້ອງ ແບບ A', zh: 'A型房' };
  const HEADING = { en: 'Choose who to contact', lo: 'ເລືອກຜູ້ຕິດຕໍ່', zh: '选择联系人' };

  test('contact A selected -> EN -> LO -> ZH -> contact A is still selected while the WhatsApp message changes language', async ({ page }) => {
    // Start in ZH, where language routing would choose cc, and pick A by hand.
    const { posts, errors } = await open(page, prop(), 'zh');
    await expectContact(page, 'cc');                       // routed, before any pick
    await pick(page, 'a');
    await expectContact(page, 'a');
    expect(await waText(page.locator('#pt-wa-primary'))).toContain(MSG.zh);

    const seen = {};
    for (const lang of ['en', 'lo', 'zh']) {
      await setLang(page, lang);
      await expectContact(page, 'a');                      // contact A, in EVERY language -- routing would say cc for zh
      const msg = await waText(page.locator('#pt-wa-primary'));
      expect(msg, lang + ' message language').toContain(MSG[lang]);
      for (const other of Object.keys(MSG).filter((l) => l !== lang)) expect(msg, lang + ' must not be in ' + other).not.toContain(MSG[other]);
      expect(msg).toContain('lang=' + lang);
      seen[lang] = msg;
      // a manual pick is not a language match, so the heading never claims one
      await expect(page.locator('.cpick-label')).toHaveText(HEADING[lang]);
    }
    expect(new Set(Object.values(seen)).size).toBe(3);     // three genuinely different messages

    await page.click('#pt-wa-primary');
    await page.waitForTimeout(300);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].contact_id).toBe('a');
    expect(errors).toEqual([]);
  });

  test('a contact language routing would never choose (Thai-only B) also survives EN -> LO -> ZH', async ({ page }) => {
    await open(page, prop(), 'en');
    await pick(page, 'b');
    for (const lang of ['lo', 'zh', 'en', 'zh']) {
      await setLang(page, lang);
      await expectContact(page, 'b');
      expect(await waText(page.locator('#pt-wa-primary'))).toContain(MSG[lang]);
    }
  });

  test('multi-unit: contact AND unit both survive EN -> LO -> ZH, and the unit message follows the language', async ({ page }) => {
    const { posts } = await open(page, MULTI(), 'en');
    await pick(page, 'b');
    await selectUnit(page, 'Room Type A');
    for (const lang of ['lo', 'zh', 'en']) {
      await setLang(page, lang);
      await expectContact(page, 'b');
      await expect(page.locator('.viewing-unit-reset')).toHaveCount(1);          // the same unit stays selected
      const msg = await waText(page.locator('#pt-wa-primary'));
      expect(msg).toContain(UNIT_MSG[lang]);
    }
    await page.click('#pt-wa-primary');
    await page.waitForTimeout(300);
    expect(posts.lead_events[0].contact_id).toBe('b');
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
  });

  test('multi-unit, language switched BEFORE a unit is chosen: still gated, contact kept, then live on both', async ({ page }) => {
    await open(page, MULTI(), 'en');
    await pick(page, 'cc');
    await setLang(page, 'lo');
    await expectContact(page, 'cc', { live: false });
    await selectUnit(page, 'ຫ້ອງ ແບບ B');
    await expectContact(page, 'cc');
    expect(await waText(page.locator('#pt-wa-primary'))).toContain('ຫ້ອງ ແບບ B');
  });
});

// ═══ Language routing is unchanged when nothing was picked ════════════════════════
test.describe('no manual pick: routing exactly as before', () => {
  test('switching language re-routes (en -> a, zh -> cc), and a unit selection in between changes nothing', async ({ page }) => {
    await open(page, MULTI(), 'en');
    await expectContact(page, 'a', { live: false });
    await selectUnit(page, 'Room Type A');
    await expectContact(page, 'a');
    await setLang(page, 'zh');
    await expectContact(page, 'cc');                       // language routing still retargets
    await expect(page.locator('.cpick-label')).toContainText('中文');   // ...and may still say it matched a language
    await setLang(page, 'en');
    await expectContact(page, 'a');
  });

  test('once a contact IS picked, routing stops overriding it', async ({ page }) => {
    await open(page, prop(), 'en');
    await setLang(page, 'zh');
    await expectContact(page, 'cc');                       // routed
    await pick(page, 'a');
    await setLang(page, 'en'); await setLang(page, 'zh');
    await expectContact(page, 'a');                        // not back to cc
  });
});

// ═══ Fallback: a pick that no longer exists ═══════════════════════════════════════
test('a stale pick (the contact is no longer on the listing) falls back to language routing and is cleared', async ({ page }) => {
  await open(page, prop(), 'zh');
  await pick(page, 'a');
  await expectContact(page, 'a');
  // Simulate the picked contact disappearing from the listing, then any re-render.
  await page.evaluate(() => { window._pickedContactId = 'a-was-removed'; });
  await setLang(page, 'zh');                               // re-render
  await expectContact(page, 'cc');                         // routing applies again (zh -> cc)
  expect(await page.evaluate(() => window._pickedContactId)).toBe(null);
});

// ═══ Unchanged: single-unit and single-contact listings ═══════════════════════════
test.describe('unchanged cases', () => {
  test('single-unit listing, several contacts: picking a contact retargets the live CTA, as before', async ({ page }) => {
    const { posts } = await open(page, prop({ unit_types: [UNIT_A] }), 'en');
    await expect(page.locator('#pt-wa-primary')).not.toHaveAttribute('data-wa-needs-unit', '1');
    await pick(page, 'b');
    await expectContact(page, 'b');
    expect(await waText(page.locator('#pt-wa-primary'))).toContain('interested in this property');
    await page.click('#pt-wa-primary');
    await page.waitForTimeout(300);
    expect(posts.lead_events[0].contact_id).toBe('b');
    expect(posts.lead_events[0].unit_type_id).toBe(null);
  });

  test('multi-unit listing with ONE contact: no picker, unit selection works exactly as before', async ({ page }) => {
    const { posts } = await open(page, MULTI({ property_contacts: [{ sort_order: 0, is_primary: true, contacts: A }] }), 'en');
    await expect(page.locator('.contact-picker')).toHaveCount(0);
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('data-wa-needs-unit', '1');
    await selectUnit(page, 'Room Type A');
    await expect(page.locator('#pt-wa-primary')).toHaveAttribute('href', new RegExp('^https://wa\\.me/' + NUM.a + '\\?text='));
    await page.click('#pt-wa-primary');
    await page.waitForTimeout(300);
    expect(posts.lead_events[0].contact_id).toBe('a');
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
  });
});
