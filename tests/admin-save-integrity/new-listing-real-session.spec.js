// Companion to new-listing-idle.spec.js, with the REAL @supabase/supabase-js (its own auth state machine, token refresh
// and events) instead of a stub, against a fake GoTrue server. While a New Listing form is open and never saved, the
// ordinary session life-cycle must not navigate, reload, raise a dialog or discard typed values.
//
// What the investigation established with this harness (see the report):
//   * token refresh OK / refresh 500 / refresh network failure / refresh invalid_grant / tab becoming visible again:
//     no navigation, no dialog, form and values intact (pinned below);
//   * the only app code that reloads the page is admin-auth.js forceLogout(), reached through a null-session auth event
//     or requireAdminSession(); forceLogout() calls signOut() first, which removes the stored session, so a reload from
//     that path ALWAYS ends on the login prompt -- never straight back on the Admin listings;
//   * therefore a jump that lands on the listings WITHOUT a login prompt is a reload with the session intact
//     (browser pull-to-refresh, a discarded/restored tab), which no in-page code path produces. Not asserted here: it
//     cannot be produced by page code, only by the browser.

const { test, expect } = require('@playwright/test');
const { bootRealSupabase, openNewListingAndType, state } = require('./real-auth-helpers');

async function expectFormUntouched(page, ctx, mark) {
  const s = await state(page);
  expect(s.form).toBe('block');
  expect(s.listings).toBe('none');
  expect(s.overlay).toBe(false);                       // no login prompt
  expect(s.title).toBe('Half-typed listing');          // typed values kept
  expect(await page.inputValue('#f-contact-phone')).toBe('02055512345');
  expect(ctx.navigations).toEqual([]);                 // no reload / navigation
  expect(ctx.dialogs).toEqual([]);                     // no "session expired" alert
  expect(ctx.pageErrors).toEqual([]);
  expect(s.nav.slice(mark)).toEqual([]);               // no showListings / revealFormPanel / resetListingForm / showImportPanel / showForm after the form was opened
}

// Makes the stored access token nearly expired and runs the library's own refresh tick, as the 30 s ticker would.
const tickRefresh = (page, ctx) => page.evaluate(async (key) => {
  const s = JSON.parse(localStorage.getItem(key)); s.expires_at = Math.floor(Date.now() / 1000) + 5;
  localStorage.setItem(key, JSON.stringify(s));
  await sbClient.auth._autoRefreshTokenTick();
}, ctx.key);

test.describe('open, unsaved New Listing form vs the real session life-cycle', () => {
  test.setTimeout(60000);
  const cases = [
    ['access token about to expire, refresh succeeds', { refresh: 'ok' }, 'refresh_token'],
    ['refresh network failure (offline blip, retried)', { refresh: 'netfail' }, 'refresh_token'],
    ['refresh rejected (invalid_grant)', { refresh: 'invalid' }, 'refresh_token'],
  ];
  for (const [name, mode, expectCall] of cases) {
    test(name + ' -> the form stays, nothing reloads', async ({ page }) => {
      const ctx = await bootRealSupabase(page, mode);
      await openNewListingAndType(page);
      const mark = (await state(page)).nav.length;
      const before = ctx.calls.length;
      await tickRefresh(page, ctx);
      await page.waitForTimeout(2500);
      expect(ctx.calls.slice(before).some((c) => c.includes(expectCall))).toBe(true);   // the refresh really happened
      await expectFormUntouched(page, ctx, mark);
    });
  }

  test('tab returns to the foreground (visibilitychange) -> the form stays', async ({ page }) => {
    const ctx = await bootRealSupabase(page, {});
    await openNewListingAndType(page);
    const mark = (await state(page)).nav.length;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1500);
    await expectFormUntouched(page, ctx, mark);
  });
});
