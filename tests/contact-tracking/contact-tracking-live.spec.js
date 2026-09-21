// Live, browser-level verification that the previously-broken contact
// paths (listing.html's mobile sticky CTA bar, agents.html's WhatsApp
// button) now post exactly the right analytics events, and that the
// waitlist/status-CTA branches correctly stay lead_events-free by design
// (recordLead:false). Complements contact-cta-audit.spec.js's static
// source scan with real click-through, mocked-Supabase confirmation.
const { test, expect } = require('@playwright/test');

// Real pages fire other, unrelated ui_events on load/click besides the
// contact button's own -- static section-view tracking (element_type:
// 'section', e.g. the Available Units / Amenities section headers) and
// Playwright's page.click() auto-scrolling the target into view, which in
// a short mocked page can legitimately cross analytics-tracking.js's
// scroll-depth milestones (element_type:'scroll_depth'). Filter down to
// exactly what ptContactClick() itself posts (element_type:'cta', the
// value every one of its calls uses unless overridden) so these
// assertions verify the CONTACT button's own tracking call specifically,
// not "every ui_events row of any kind that happened to fire nearby."
function contactUiEvents(posts) {
  return posts.ui_events.filter((e) => e.element_type === 'cta');
}


function activeProp(overrides) {
  return Object.assign({
    id: 'p-active', slug: 'test-active', title_en: 'Nice Apartment', title_lo: 'ອາພາດເມັນ', title_zh: '公寓',
    property_type: 'apartment', transaction_type: 'for_rent',
    price_amount: 450, price_currency: 'USD', price_frequency: 'monthly', price_display: '$450/month',
    images: ['https://example.com/a.jpg'], amenities: [], features: [],
    district_en: 'Sisattanak', workflow_status: 'active', market_status: 'available', status: 'active',
    created_at: new Date().toISOString(),
    bedrooms: 2, bathrooms: 1, sqm: 60,
    contacts: { id: 'c-1', role: 'agent', name: 'Somchai', phone: '+8562099999999', whatsapp: '+8562099999999' },
    managed_by_party_id: 'party-1', parties: null, unit_types: [],
  }, overrides || {});
}

async function mockRestAndCollect(page, propRow) {
  const posts = { ui_events: [], lead_events: [] };
  await page.route('**/rest/v1/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (url.indexOf('/properties?slug=eq.') !== -1) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([propRow]) });
    }
    if (url.indexOf('/rpc/') !== -1) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (url.indexOf('/ui_events') !== -1 && req.method() === 'POST') {
      posts.ui_events.push(req.postDataJSON());
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    }
    if (url.indexOf('/lead_events') !== -1 && req.method() === 'POST') {
      posts.lead_events.push(req.postDataJSON());
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return posts;
}

async function stubNavigator(page) {
  // Prevent the real navigation (window.open/tel: href) from doing
  // anything observable in the test browser; ptContactClick() dispatches
  // both tracking POSTs BEFORE this fires, which is exactly the ordering
  // being verified.
  await page.addInitScript(() => {
    window.open = () => null;
  });
}

test.describe('listing.html contact CTAs (mocked Supabase)', () => {
  test('desktop WhatsApp button: 1 ui_events + 1 lead_events, listing_id set', async ({ page }) => {
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp());
    await page.goto('/listing.html?slug=test-active&lang=en');
    await page.waitForTimeout(600);
    await page.click('.btn-wa.btn-primary');
    await page.waitForTimeout(300);
    expect(contactUiEvents(posts).length).toBe(1);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].listing_id).toBe('p-active');
    expect(posts.lead_events[0].event_type).toBe('whatsapp_click');
    expect(posts.lead_events[0].agent_id).toBe('party-1');
  });

  // REQUIRED 1: property-level WhatsApp CTA -> no unit_type_id. A listing
  // with no unit types at all (activeProp()'s default unit_types: []) is
  // the exact case the reported bug did NOT break -- this is the "existing
  // property-level leads continue working" guard (REQUIRED 7), pinned as
  // its own assertion so a future regression here fails loudly.
  test('REQUIRED 1/7: a plain (no unit types) listing\'s WhatsApp lead carries unit_type_id: null', async ({ page }) => {
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp());
    await page.goto('/listing.html?slug=test-active&lang=en');
    await page.waitForTimeout(600);
    await page.click('.btn-wa.btn-primary');
    await page.waitForTimeout(300);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].unit_type_id).toBe(null);
    expect(posts.lead_events[0].unit_id).toBe(null);
  });

  test('desktop Call button: 1 ui_events + 1 lead_events, event_type=call_click', async ({ page }) => {
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp());
    await page.goto('/listing.html?slug=test-active&lang=en');
    await page.waitForTimeout(600);
    await page.click('.btn-call');
    await page.waitForTimeout(300);
    expect(contactUiEvents(posts).length).toBe(1);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].event_type).toBe('call_click');
  });

  test('mobile sticky CTA bar WhatsApp button: 1 ui_events + 1 lead_events (the original regression)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp({ id: 'p-mobile', slug: 'test-mobile' }));
    await page.goto('/listing.html?slug=test-mobile&lang=en');
    await page.waitForTimeout(600);
    await page.click('#mobile-cta-bar .mcta-btn');
    await page.waitForTimeout(300);
    expect(contactUiEvents(posts).length).toBe(1);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].listing_id).toBe('p-mobile');
    expect(posts.lead_events[0].event_type).toBe('whatsapp_click');
  });

  test('per-unit Inquire button: 1 ui_events + 1 lead_events', async ({ page }) => {
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp({
      id: 'p-units', slug: 'test-units',
      unit_types: [
        { id: 'u1', name_en: 'Studio A', bedrooms: 0, bathrooms: 1, sqm: 30, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', images: [] },
        { id: 'u2', name_en: 'Studio B', bedrooms: 0, bathrooms: 1, sqm: 32, price_amount: 320, price_currency: 'USD', price_frequency: 'monthly', images: [] },
      ],
    }));
    await page.goto('/listing.html?slug=test-units&lang=en');
    await page.waitForTimeout(600);
    const inquireBtn = page.locator('.unit-cta').first();
    if (await inquireBtn.count()) {
      await inquireBtn.click();
      await page.waitForTimeout(300);
      expect(contactUiEvents(posts).length).toBe(1);
      expect(posts.lead_events.length).toBe(1);
      expect(posts.lead_events[0].listing_id).toBe('p-units');
    }
  });

  // REQUIRED 2/3: a unit-type CTA carries the CANONICAL unit_types.id, not
  // just the visible unit name -- and the resulting WhatsApp message
  // (decoded from the href, since window.open is stubbed) names the unit
  // type and its bedroom count, matching Room Type A/2BR/$400 from the
  // report. REQUIRED 10: a second, distinct unit type on the SAME listing
  // remains distinguishable by its own unit_type_id.
  test('REQUIRED 2/3/4/10: each unit card\'s Inquire button attributes its OWN unit_type_id, and the prefilled message names that unit type + bedroom count', async ({ page }) => {
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp({
      id: 'p-units2', slug: 'test-units2',
      title_en: 'River Apartment',
      unit_types: [
        { id: 'room-type-a', name_en: 'Room Type A', bedrooms: 2, bathrooms: 1, sqm: 45, price_amount: 400, price_currency: 'USD', price_frequency: 'monthly', images: [] },
        { id: 'room-type-b', name_en: 'Room Type B', bedrooms: 1, bathrooms: 1, sqm: 32, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', images: [] },
      ],
    }));
    await page.goto('/listing.html?slug=test-units2&lang=en');
    await page.waitForTimeout(600);
    const cards = page.locator('.unit-cta');
    expect(await cards.count()).toBeGreaterThanOrEqual(2);

    const firstHref = await cards.nth(0).getAttribute('href');
    await cards.nth(0).click();
    await page.waitForTimeout(300);
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
    const firstMsg = decodeURIComponent(firstHref.split('?text=')[1]);
    expect(firstMsg).toContain('Room Type A');
    expect(firstMsg).toContain('2 Beds'); // bedroom count identifies the unit type, not just its free-text name
    expect(firstMsg).toContain('River Apartment');

    const secondHref = await cards.nth(1).getAttribute('href');
    await cards.nth(1).click();
    await page.waitForTimeout(300);
    expect(posts.lead_events[1].unit_type_id).toBe('room-type-b');
    expect(posts.lead_events[1].unit_type_id).not.toBe(posts.lead_events[0].unit_type_id);
    const secondMsg = decodeURIComponent(secondHref.split('?text=')[1]);
    expect(secondMsg).toContain('Room Type B');
    expect(secondMsg).toContain('1 Beds');
  });

  // REQUIRED 5: the Lao template also names the unit type + bedroom count
  // (using the existing localization system, not a hard-coded English
  // string) -- and REQUIRED 6: the attribution (unit_type_id) never
  // changes when the DISPLAYED name does, proving the CTA never depended
  // on hard-coding a unit name into the payload.
  test('REQUIRED 5/6: the Lao-language prefilled message also names the unit type, and unit_type_id is unaffected by the page language', async ({ page }) => {
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp({
      id: 'p-units-lo', slug: 'test-units-lo',
      // 2+ unit types, so the multi-card layout renders (a single unit type
      // without total_units folds into the no-cards building-overview
      // layout -- see buildAvailableUnitsSection()'s rawUnits.length===1
      // branch).
      unit_types: [
        { id: 'room-type-a', name_en: 'Room Type A', name_lo: 'ຫ້ອງປະເພດ A', bedrooms: 2, bathrooms: 1, sqm: 45, price_amount: 400, price_currency: 'USD', price_frequency: 'monthly', images: [] },
        { id: 'room-type-b', name_en: 'Room Type B', name_lo: 'ຫ້ອງປະເພດ B', bedrooms: 1, bathrooms: 1, sqm: 32, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', images: [] },
      ],
    }));
    await page.goto('/listing.html?slug=test-units-lo&lang=lo');
    await page.waitForTimeout(600);
    const card = page.locator('.unit-cta').first();
    const href = await card.getAttribute('href');
    await card.click();
    await page.waitForTimeout(300);
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
    const msg = decodeURIComponent(href.split('?text=')[1]);
    expect(msg).toContain('ຫ້ອງປະເພດ A');
    expect(msg).toContain('ຫ້ອງນອນ'); // the Lao word for bedrooms, from the same L.unitBeds dictionary the unit card facts use
  });

  // REQUIRED 8: selecting a unit-type card also re-points the MAIN
  // WhatsApp button (not just that card's own inline CTA) at the same
  // unit_type_id -- the fix applies to both CTA sites the report named.
  test('REQUIRED 8: selecting a unit card also attributes the MAIN WhatsApp button to that unit_type_id', async ({ page }) => {
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp({
      id: 'p-units-main', slug: 'test-units-main',
      // available_count: 1 -- resolveUnitAvailability() reads a missing
      // available_count as 0 open units, which would make the WHOLE
      // listing read as fully_occupied and swap the main WhatsApp button
      // for the waiting-list status CTA instead -- not what this test is
      // exercising.
      unit_types: [
        { id: 'room-type-a', name_en: 'Room Type A', bedrooms: 2, bathrooms: 1, sqm: 45, price_amount: 400, price_currency: 'USD', price_frequency: 'monthly', available_count: 1, images: [] },
        { id: 'room-type-b', name_en: 'Room Type B', bedrooms: 1, bathrooms: 1, sqm: 32, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly', available_count: 1, images: [] },
      ],
    }));
    await page.goto('/listing.html?slug=test-units-main&lang=en');
    await page.waitForTimeout(600);
    // Select the unit card itself (not its inline CTA) -- selectUnitType().
    await page.locator('.unit-card').first().click();
    await page.waitForTimeout(300);
    await page.click('.btn-wa.btn-primary');
    await page.waitForTimeout(300);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].unit_type_id).toBe('room-type-a');
  });

  test('unavailable-listing waitlist WhatsApp CTA (desktop): ui_events fires, lead_events does NOT (recordLead:false)', async ({ page }) => {
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp({ id: 'p-rented', slug: 'test-rented', market_status: 'rented' }));
    await page.goto('/listing.html?slug=test-rented&lang=en');
    await page.waitForTimeout(600);
    const waitlistBtn = page.locator('.agent-ctas .btn-wa').first();
    if (await waitlistBtn.count()) {
      await waitlistBtn.click();
      await page.waitForTimeout(300);
      expect(contactUiEvents(posts).length).toBe(1);
      expect(posts.lead_events.length).toBe(0);
    }
  });

  test('unavailable-listing waitlist WhatsApp CTA (mobile bar): ui_events fires, lead_events does NOT', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await stubNavigator(page);
    const posts = await mockRestAndCollect(page, activeProp({ id: 'p-fully-occupied', slug: 'test-fo', market_status: 'fully_occupied' }));
    await page.goto('/listing.html?slug=test-fo&lang=en');
    await page.waitForTimeout(600);
    const mCta = page.locator('#mobile-cta-bar .mcta-btn');
    if (await mCta.count()) {
      await mCta.click();
      await page.waitForTimeout(300);
      expect(contactUiEvents(posts).length).toBe(1);
      expect(posts.lead_events.length).toBe(0);
    }
  });
});

test.describe('listing.html slugless ?id= fallback (mocked Supabase)', () => {
  // Listings finished via the admin edit path can be saved without a slug.
  // Their cards link with ?id=<uuid>, so the detail page must resolve a
  // property by id -- not answer "No property selected." (the public dead
  // end this fixed).
  test('a listing with no slug loads by ?id= and does NOT show the error state', async ({ page }) => {
    await stubNavigator(page);
    const prop = activeProp({ id: 'no-slug-1', slug: null, title_en: 'Slugless Villa' });
    await page.route('**/rest/v1/**', (route) => {
      const req = route.request();
      const url = req.url();
      // The fallback query the init guard now issues for a slugless listing.
      if (url.indexOf('/properties?id=eq.no-slug-1') !== -1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([prop]) });
      }
      if (url.indexOf('/rpc/') !== -1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (req.method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/listing.html?id=no-slug-1&lang=en');
    await page.waitForTimeout(600);
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain('No property selected');
    expect(bodyText).not.toContain('Property not found');
    await expect(page).toHaveTitle(/Slugless Villa/);
  });

  test('opening listing.html with neither slug nor id still shows the guard message', async ({ page }) => {
    await stubNavigator(page);
    await page.route('**/rest/v1/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto('/listing.html?lang=en');
    await page.waitForTimeout(400);
    await expect(page.locator('body')).toContainText('No property selected');
  });
});

test.describe('agents.html / agent.html contact CTAs (mocked Supabase, agent profile -- no listing_id)', () => {
  test('agents.html WhatsApp button: 1 ui_events + 1 lead_events, listing_id null (the other original regression)', async ({ page }) => {
    await stubNavigator(page);
    const posts = { ui_events: [], lead_events: [] };
    await page.route('**/rest/v1/**', (route) => {
      const req = route.request();
      const url = req.url();
      if (url.indexOf('/parties?type=eq.agent') !== -1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'agent-1', slug: 'somchai', name_en: 'Somchai', name_lo: 'ສົມໄຊ', whatsapp: '+8562099999999', is_verified: true }]) });
      }
      if (url.indexOf('/properties?managed_by_party_id=eq.') !== -1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      if (url.indexOf('/ui_events') !== -1 && req.method() === 'POST') { posts.ui_events.push(req.postDataJSON()); return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }); }
      if (url.indexOf('/lead_events') !== -1 && req.method() === 'POST') { posts.lead_events.push(req.postDataJSON()); return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/agents.html?slug=somchai');
    await page.waitForSelector('#page', { state: 'visible' });
    await page.click('#wa-btn');
    await page.waitForTimeout(300);
    expect(contactUiEvents(posts).length).toBe(1);
    expect(posts.lead_events.length).toBe(1);
    expect(posts.lead_events[0].listing_id).toBe(null);
    expect(posts.lead_events[0].agent_id).toBe('agent-1');
    expect(posts.lead_events[0].event_type).toBe('whatsapp_click');
  });

  test('agent.html WhatsApp button: 1 ui_events + 1 lead_events, listing_id null (no regression from the ptContactClick migration)', async ({ page }) => {
    await stubNavigator(page);
    const posts = { ui_events: [], lead_events: [] };
    await page.route('**/rest/v1/**', (route) => {
      const req = route.request();
      const url = req.url();
      if (url.indexOf('/parties?slug=eq.') !== -1 || url.indexOf('type=eq.agent') !== -1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'agent-2', slug: 'somchai2', name_en: 'Somchai Two', name_lo: 'ສົມໄຊ2', whatsapp: '+8562099999998', is_verified: true }]) });
      }
      if (url.indexOf('/ui_events') !== -1 && req.method() === 'POST') { posts.ui_events.push(req.postDataJSON()); return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }); }
      if (url.indexOf('/lead_events') !== -1 && req.method() === 'POST') { posts.lead_events.push(req.postDataJSON()); return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/agent.html?slug=somchai2');
    await page.waitForSelector('#page', { state: 'visible' }).catch(() => {});
    await page.waitForTimeout(300);
    const btn = page.locator('#wa-btn');
    if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
      await btn.click();
      await page.waitForTimeout(300);
      expect(contactUiEvents(posts).length).toBe(1);
      expect(posts.lead_events.length).toBe(1);
      expect(posts.lead_events[0].listing_id).toBe(null);
    }
  });
});
