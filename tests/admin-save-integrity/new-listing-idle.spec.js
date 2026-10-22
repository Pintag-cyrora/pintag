// Guard for the reported symptom: "while I am filling out the New Listing form the page jumps back to the Admin
// listings page by itself, with no tap before it".
//
// Drives the REAL admin.html with the REAL admin-auth.js (not the harness stub) against a controllable fake Supabase
// auth client, instruments every navigation-relevant function and every main-frame navigation, and lets two hours
// of virtual time pass (Playwright's clock) with the form open and untouched.
//
// Result when this was written: NO navigation occurs from the idle form on the current code -- through the normal
// flows, session refreshes (SIGNED_IN / TOKEN_REFRESHED / USER_UPDATED), and visibility/focus/pageshow events. These
// tests pin that, so a regression (a new timer, a stale callback, a handler that reloads or calls showListings())
// is caught. They do NOT claim to have found the user's trigger: the only code paths that can leave the form on their
// own are a full reload (admin-auth.js forceLogout() on a null-session auth event, or a browser-initiated reload) --
// see the investigation report. The post-save timer case lives in new-listing-navigation.spec.js.

const { test, expect } = require('@playwright/test');
const { fakeBackend, FILL_NEW_LISTING, SAVE, FORM_STATE } = require('./fixtures');
const { bootRealAuth, view } = require('./idle-helpers');

const TWO_HOURS = '02:00:00';

async function quietReport(page, ctx, before) {
  const nav = await page.evaluate(() => window.__nav);
  return { calls: nav.slice(before), navigations: ctx.navigations.length, pageErrors: ctx.pageErrors };
}

async function openFormViaSmartImport(page) {
  await page.locator('.btn-import').click();
  await page.fill('#import-description', '2 bedroom condo for sale');
  await page.locator('#import-gen-btn').click();
  await page.waitForFunction(() => document.getElementById('form-panel').style.display === 'block');
}

async function idleWithNoise(page) {
  await page.clock.fastForward(TWO_HOURS);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('offline'));
    // Session housekeeping that keeps a signed-in admin signed in. (A null-session event is deliberately NOT here.)
    ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].forEach((ev) => window.__authCbs.forEach((cb) => cb(ev, { access_token: 'refreshed' })));
  });
  await page.waitForTimeout(300);
}

test.describe('idle New Listing form stays put', () => {
  test('Smart Import panel: open "+ New Listing", do nothing for two hours -> still on Smart Import, no navigation', async ({ page }) => {
    await page.clock.install();
    const ctx = await bootRealAuth(page);
    await page.locator('.btn-import').click();
    await page.fill('#import-description', 'half-typed description');
    const mark = (await page.evaluate(() => window.__nav)).length;
    await idleWithNoise(page);
    const v = await view(page);
    expect(v).toMatchObject({ import: 'block', listings: 'none', form: 'none', overlay: false });
    expect(await page.inputValue('#import-description')).toBe('half-typed description');
    const r = await quietReport(page, ctx, mark);
    expect(r.calls).toEqual([]);                 // no showListings / revealFormPanel / resetListingForm / loadListings
    expect(r.navigations).toBe(1);               // the initial page load only: no reload
    expect(r.pageErrors).toEqual([]);
    expect(mark).toBeGreaterThan(0);             // the instrumentation really is wired (showImportPanel/resetListingForm were seen)
  });

  test('Smart Import -> Generate -> form: fill some fields, never press Save, idle -> form stays and keeps every typed value', async ({ page }) => {
    await page.clock.install();
    const ctx = await bootRealAuth(page);
    await openFormViaSmartImport(page);
    await page.fill('#f-title-en', 'Typing a new listing');
    await page.fill('#f-contact-name', 'Some Owner');
    await page.fill('#f-contact-phone', '02055512345');
    const mark = (await page.evaluate(() => window.__nav)).length;
    await idleWithNoise(page);
    const v = await view(page);
    expect(v).toMatchObject({ form: 'block', listings: 'none', import: 'none', overlay: false });
    expect(await page.inputValue('#f-title-en')).toBe('Typing a new listing');
    expect(await page.inputValue('#f-contact-name')).toBe('Some Owner');
    expect(await page.inputValue('#f-contact-phone')).toBe('02055512345');
    const r = await quietReport(page, ctx, mark);
    expect(r.calls).toEqual([]);
    expect(r.navigations).toBe(1);
    expect(r.pageErrors).toEqual([]);
  });

  test('blank New Listing form (showForm) filled by hand, idle -> stays', async ({ page }) => {
    await page.clock.install();
    const ctx = await bootRealAuth(page);
    await page.evaluate(() => { showForm(); });
    await page.evaluate(FILL_NEW_LISTING);
    const mark = (await page.evaluate(() => window.__nav)).length;
    await idleWithNoise(page);
    expect(await view(page)).toMatchObject({ form: 'block', listings: 'none' });
    expect(await page.inputValue('#f-title-en')).toBe('Integrity Test House');
    const r = await quietReport(page, ctx, mark);
    expect(r.calls).toEqual([]);
    expect(r.navigations).toBe(1);
  });

  test('after an earlier listing was saved and the list came back, a later New Listing also stays put when idle', async ({ page }) => {
    await page.clock.install();
    const ctx = await bootRealAuth(page, fakeBackend());
    await page.evaluate(() => { showForm(); });
    await page.evaluate(FILL_NEW_LISTING);
    await page.evaluate(SAVE);
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    await page.clock.fastForward(2000);                            // the post-save return fires, as designed
    await expect.poll(async () => (await view(page)).listings).toBe('block');

    await openFormViaSmartImport(page);                            // the NEXT listing
    await page.fill('#f-title-en', 'Second listing');
    const mark = (await page.evaluate(() => window.__nav)).length;
    await idleWithNoise(page);
    expect(await view(page)).toMatchObject({ form: 'block', listings: 'none' });
    expect(await page.inputValue('#f-title-en')).toBe('Second listing');
    const r = await quietReport(page, ctx, mark);
    expect(r.calls).toEqual([]);
    expect(r.navigations).toBe(1);
  });
});
