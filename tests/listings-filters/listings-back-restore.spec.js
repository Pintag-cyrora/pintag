// Regression coverage for the Listings -> Listing -> Back restoration fix
// (audited separately, then implemented in listings.html):
//
//   1. Filters/sort still live entirely in the URL (_readFiltersFromUrl /
//      _writeFiltersToUrl, unchanged) -- this suite never touches that.
//   2. A new sessionStorage entry (PT_LISTINGS_RESTORE_KEY) records the
//      filter/sort signature, how many cards had to be rendered to include
//      the clicked card, the scroll position, and the clicked listing's
//      slug/id -- written synchronously in the card's click handler
//      (_ptSaveListingsRestoreState()), before the browser's own navigation
//      for that same click begins. Never wired to scroll/beforeunload/
//      unload/pagehide.
//   3. On the next listings.html load, _ptConsumeListingsRestoreState()
//      reads and immediately deletes that entry (one-shot, regardless of
//      whether it ends up used), then renderListings() renders enough
//      cards up front to include the previously-opened one and, once that
//      batch is actually in the DOM, scrolls that exact card into view
//      (falling back to the raw saved scrollY only if it can't be found).
//
// KNOWN, DELIBERATE LIMITATION (see the audit): listing.html's own "Back to
// Listings" link stays a bare <a href="listings.html"> with no query string
// (requirement: must keep working for a visitor arriving from an external
// referrer with no listings.html history at all) -- so returning via THAT
// link lands on a filter-less URL, whose signature will not match a
// filtered save, and restoration correctly no-ops. This suite's last test
// documents that intentionally, so it isn't mistaken for a regression.
// Native browser Back (and any path that preserves the query string, e.g.
// a mobile swipe-back gesture) DOES restore -- covered by every other test
// here via page.goBack().
const { test, expect } = require('@playwright/test');
const { ROWS, PARTY } = require('./fixtures');

// 20 rows (> PT_PAGE_SIZE=12) so infinite scroll genuinely has a second
// page to lose. Cloned from the shared fixture's own row shape so the
// listing.html-side fetch (by slug) is satisfied identically to every
// other suite in this directory.
const MANY_ROWS = [];
for (let i = 0; i < 20; i++) {
  MANY_ROWS.push(Object.assign({}, ROWS[0], { id: 'id-many-' + i, slug: 'many-' + i, title_en: 'Listing many-' + i }));
}

function mockRestMany(page) {
  page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}}};}};' }));
  page.route('**/unpkg.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  page.route('**/fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  page.route('**/functions/v1/**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  page.route('**/rest/v1/**', (r) => {
    const u = new URL(r.request().url());
    const t = u.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (d) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    if (t.startsWith('rpc/')) return json({});
    if (t === 'properties') {
      const slug = (u.searchParams.get('slug') || '').replace(/^eq\./, '');
      if (slug) return json(MANY_ROWS.filter((x) => x.slug === slug));
      return json(MANY_ROWS);
    }
    if (t === 'parties') return json([PARTY]);
    return json([]);
  });
}

async function openListingsFiltered(page, extraQuery) {
  mockRestMany(page);
  await page.goto('/listings.html?lang=en' + (extraQuery || ''));
  await page.waitForFunction(() => typeof window.setTxFilter === 'function');
  await page.waitForFunction(() => window._listingsLoaded === true);
}

const cardCount = (page) => page.evaluate(() => document.querySelectorAll('.pt-card').length);
const scrollY = (page) => page.evaluate(() => window.scrollY);

// Waits for listings.html's own window._ptRestoreApplied signal (set the
// instant _ptRestoreScrollPosition()'s rAF callback runs) instead of a fixed
// sleep. A fixed sleep here previously produced flaky mutation-test results:
// long enough to sometimes let the grid's OWN organic IntersectionObserver
// fire independently of anything this fix does, which could make a test
// pass "by accident" even with the fix fully reverted. This resolves as
// soon as restoration genuinely ran, and simply times out (never throws --
// callers assert on the real DOM state afterwards) when it didn't, which is
// exactly the signal a mutation test needs to be trustworthy.
async function waitForRestoreSignal(page) {
  await page.waitForFunction(() => window._ptRestoreApplied === true, { timeout: 2000 }).catch(() => {});
}

test.describe('listings.html -- back-navigation restoration', () => {
  test('filters and sort in the URL survive a native Back exactly as before (unchanged mechanism)', async ({ page }) => {
    await openListingsFiltered(page);
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    await page.evaluate(() => setSort('price_desc'));
    await page.waitForTimeout(150);
    expect(page.url()).toContain('tx=for_rent');
    expect(page.url()).toContain('sort=price_desc');

    await page.locator('.pt-card').first().click();
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.goBack();
    await page.waitForFunction(() => document.readyState === 'complete');

    expect(page.url()).toContain('tx=for_rent');
    expect(page.url()).toContain('sort=price_desc');
  });

  test('multiple infinite-scroll pages are re-rendered on restore, not just the first 12', async ({ page }) => {
    await openListingsFiltered(page);
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    await page.waitForTimeout(150);

    // Scroll to trigger the second infinite-scroll page.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    const before = await cardCount(page);
    expect(before).toBeGreaterThan(12);

    await page.locator('.pt-card').last().click();
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.goBack();
    await page.waitForFunction(() => document.readyState === 'complete');
    await waitForRestoreSignal(page);

    const after = await cardCount(page);
    expect(after).toBe(before);
  });

  test('scroll position is restored (not left at 0, not a bare window.scrollTo before cards exist)', async ({ page }) => {
    await openListingsFiltered(page);
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    const yBefore = await scrollY(page);
    expect(yBefore).toBeGreaterThan(500);

    await page.locator('.pt-card').last().click();
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.goBack();
    await page.waitForFunction(() => document.readyState === 'complete');
    await waitForRestoreSignal(page);

    const yAfter = await scrollY(page);
    // A bare ">0" here would be satisfied even without this fix -- the
    // browser's own native reload scroll-memory alone lands around 564 in
    // this exact scenario (measured directly, mutation-tested). The real
    // restoration -- scrolling the previously-opened card back into view --
    // lands far higher (measured ~3688 here). 1500 sits well clear of both,
    // so this only passes when OUR mechanism did the restoring.
    expect(yAfter).toBeGreaterThan(1500);
  });

  test('the exact opened card is scrolled into view, not just an approximate Y offset', async ({ page }) => {
    await openListingsFiltered(page);
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);

    const clicked = page.locator('.pt-card').last();
    const clickedHref = await clicked.getAttribute('href');
    await clicked.click();
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.goBack();
    await page.waitForFunction(() => document.readyState === 'complete');
    await waitForRestoreSignal(page);

    const restored = page.locator('a[href="' + clickedHref + '"]');
    await expect(restored).toBeVisible();
    const box = await restored.boundingBox();
    const viewport = page.viewportSize();
    // "In view" -- within the visible viewport, not merely present in the DOM.
    expect(box.y).toBeGreaterThanOrEqual(-50);
    expect(box.y).toBeLessThanOrEqual(viewport.height + 50);
  });

  test('a changed filter before returning is treated as stale -- no restoration applied', async ({ page }) => {
    await openListingsFiltered(page);
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);

    await page.locator('.pt-card').last().click();
    await page.waitForFunction(() => document.readyState === 'complete');

    // Simulate returning to a DIFFERENT filter/sort combination (e.g. the
    // visitor navigated to a different pre-filtered link, or the saved
    // entry is simply stale for any other reason) rather than the exact
    // page they left -- same mechanism a changed URL after goBack() would
    // trigger, exercised directly here for a deterministic, single-page
    // repro of "signature mismatch -> ignored".
    mockRestMany(page);
    await page.goto('/listings.html?lang=en&tx=for_sale');
    await page.waitForFunction(() => window._listingsLoaded === true);
    await page.waitForTimeout(300);

    // Normal, un-restored first page: exactly PT_PAGE_SIZE, scrolled to top.
    expect(await cardCount(page)).toBeLessThanOrEqual(12);
    expect(await scrollY(page)).toBe(0);
  });

  test('a direct visit to listings.html (no prior listing opened) never restores anything', async ({ page }) => {
    await openListingsFiltered(page, '&tx=for_rent');
    await page.waitForTimeout(300);

    expect(await cardCount(page)).toBeLessThanOrEqual(12);
    expect(await scrollY(page)).toBe(0);
  });

  test('refreshing listings.html after a restore already happened does not re-trap the visitor (one-shot consume)', async ({ page }) => {
    await openListingsFiltered(page);
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);

    await page.locator('.pt-card').last().click();
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.goBack();
    await page.waitForFunction(() => document.readyState === 'complete');
    await waitForRestoreSignal(page);
    expect(await cardCount(page)).toBeGreaterThan(12);   // restored once, as expected

    // A plain reload of the now-restored page -- the sessionStorage entry
    // was already deleted the moment it was read, so THIS mechanism must
    // NOT restore again (it would otherwise "trap" the visitor at the old
    // scroll depth forever, even after they've scrolled back up
    // themselves). Card count is what actually proves that: it stays at a
    // normal single first-page render rather than jumping back to the
    // previously-restored count.
    //
    // scrollY is deliberately NOT asserted to be exactly 0 here: a same-URL
    // reload also triggers the BROWSER's own native scroll-position memory
    // (history.scrollRestoration, independent of sessionStorage and of
    // anything in this fix), which was already the case before this change
    // and is out of scope -- overriding it site-wide was not part of this
    // fix and risks unrelated side effects on every other page's reload
    // behavior. What matters here is that OUR mechanism didn't re-fire.
    await page.reload();
    await page.waitForFunction(() => window._listingsLoaded === true);
    await page.waitForTimeout(300);
    expect(await cardCount(page)).toBeLessThanOrEqual(12);
  });

  test('Listings (filtered) -> listing -> "Back to Listings" link itself now carries the exact filters/sort forward, and clicking it restores cards + scroll', async ({ page }) => {
    // The requirement this covers: listing.html's own bare
    // <a href="listings.html"> used to lose every filter/sort the moment it
    // was clicked, so the sessionStorage restoration above (correct on its
    // own) never got a chance to fire via that link. _ptFixBackToListingsLink()
    // (listing.html) now rewrites that link's href -- ONLY when its saved
    // propertyKey matches the exact listing this page was navigated to --
    // to the precise listings.html URL (filters, sort, everything) the
    // visitor actually came from, so the existing signature check downstream
    // finds a match and restores normally.
    await openListingsFiltered(page);
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    await page.evaluate(() => setSort('price_desc'));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    const originUrl = new URL(page.url());

    await page.locator('.pt-card').last().click();
    await page.waitForFunction(() => document.readyState === 'complete');

    // The link's href is rewritten to point at exactly the Listings URL the
    // visitor left -- verified directly, before ever clicking it.
    const backHref = await page.locator('a.back-to-listings').getAttribute('href');
    expect(backHref).toBe('listings.html' + originUrl.search);

    await page.click('a.back-to-listings');
    await page.waitForFunction(() => document.readyState === 'complete');
    expect(page.url()).toContain('tx=for_rent');
    expect(page.url()).toContain('sort=price_desc');

    await waitForRestoreSignal(page);
    expect(await cardCount(page)).toBeGreaterThan(12);
    expect(await scrollY(page)).toBeGreaterThan(1500);
  });

  test('a visitor viewing a DIFFERENT listing than the saved entry still gets the plain, unmodified Back to Listings link', async ({ page }) => {
    // An intervening navigation (e.g. a Similar Properties click) landed the
    // visitor on a listing OTHER than the one the sessionStorage entry was
    // written for -- the link must not be rewritten to a stale Listings URL
    // that has nothing to do with what's actually on screen.
    await openListingsFiltered(page);
    await page.evaluate(() => setTxFilter('for_rent', document.querySelector('.tx-btn[data-filter="for_rent"]')));
    await page.waitForTimeout(150);
    await page.locator('.pt-card').first().click();   // saves state for THIS card
    await page.waitForFunction(() => document.readyState === 'complete');

    // Simulate landing on a different listing instead (same tab, so the
    // sessionStorage entry from the click above is still present).
    mockRestMany(page);
    await page.goto('/listing.html?slug=many-15&lang=en');
    await page.waitForFunction(() => document.readyState === 'complete');

    const backHref = await page.locator('a.back-to-listings').getAttribute('href');
    expect(backHref).toBe('listings.html');
  });

  test('direct/external arrival at a listing (WhatsApp/Facebook/Google/bookmark) keeps the plain Back to Listings link, and it leads to a normal clean Listings page', async ({ page }) => {
    // No prior listings.html visit in this browser context at all -- the
    // sessionStorage entry _ptFixBackToListingsLink() looks for was never
    // written, exactly as for a visitor arriving from an external referrer.
    mockRestMany(page);
    await page.goto('/listing.html?slug=many-3&lang=en');
    await page.waitForFunction(() => document.readyState === 'complete');

    const backHref = await page.locator('a.back-to-listings').getAttribute('href');
    expect(backHref).toBe('listings.html');

    await page.click('a.back-to-listings');
    await page.waitForFunction(() => window._listingsLoaded === true);
    await page.waitForTimeout(300);

    expect(page.url()).not.toContain('tx=');
    expect(page.url()).not.toContain('sort=');
    expect(await cardCount(page)).toBeLessThanOrEqual(12);
    expect(await scrollY(page)).toBe(0);
  });
});
