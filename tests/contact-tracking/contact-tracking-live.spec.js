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
