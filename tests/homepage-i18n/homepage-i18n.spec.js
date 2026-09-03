// index.html — homepage language switching.
//
// WHY THIS SUITE EXISTS
// The hero's two big panel labels (.panel-label — "Buyer/Renter" and
// "Seller/Landlord") were single hardcoded Lao strings with no en-i/zh-i
// counterpart at all, unlike every other string on this page. Switching
// to English or Chinese changed every other visible word on the homepage
// except these two — the most prominent text on the page. The same audit
// found a second bug: Card 2's Lao sublabel literally contained the raw,
// untranslated English word "Agent" ("Agent · ນາຍໜ້າ"), and the footer's
// location/nav links ("Listings", "For Agents", the Vientiane line) had
// no translation at all in either direction.
//
// This site's i18n mechanism is CSS-class-based, not a t()-style lookup:
// every translatable string is written three times as sibling
// <span class="lo-i/en-i/zh-i"> elements, and `body.lang-en .lo-i{display:none}`
// (etc.) shows only the active one. That means Playwright's `.innerText()`
// already excludes whatever is currently hidden — a Lao-script character
// appearing in innerText while body.lang-en is active is proof a string
// was never wrapped in the first place, not a flaky visual check.

const { test, expect } = require('@playwright/test');

const LAO_SCRIPT = /[຀-໿]/;
const CJK_SCRIPT = /[一-鿿]/;

function mockProperties(page) {
  return page.route('**/rest/v1/properties**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}
function stubAnalytics(page) {
  return Promise.all(['listing_events', 'ui_events', 'page_views', 'search_events'].map(t =>
    page.route('**/rest/v1/' + t + '**', r => r.fulfill({ status: 201, body: '' }))
  ));
}

async function mount(page) {
  await mockProperties(page);
  await stubAnalytics(page);
  await page.goto('/index.html');
  await expect(page.locator('.panel-buyer .panel-label')).toBeVisible();
}

// `.toHaveText()` reads `textContent`, which includes whatever is
// currently `display:none` -- exactly the wrong tool here, since every
// lo-i/en-i/zh-i triple has two hidden siblings at all times. `.innerText()`
// is CSS-visibility-aware (matches what a real visitor actually sees), so
// asserting through it is what makes a passing test mean the string was
// really localized, not just present somewhere in the DOM.
async function visibleText(locator) {
  return (await locator.innerText()).trim();
}

// Full-page text minus the language switcher (.nav-center) -- "EN / ລາວ /
// 中文" is meant to always show all three, so it isn't content this page
// translates and would otherwise be a false positive on every script check
// below (e.g. "中文" the button label always contains CJK characters, even
// with body.lang-lo/lang-en active). `.innerText()` needs a real layout
// box, so this reads both while still attached to the document rather than
// diffing a detached clone (which would report empty text).
async function contentText(page) {
  const full = await page.locator('body').innerText();
  const nav = await page.locator('.nav-center').innerText();
  return full.split(nav).join('');
}

test.describe('default load (no language switch) is Lao', () => {
  test('hero labels and footer render in Lao, no CJK characters visible', async ({ page }) => {
    await mount(page);
    expect(await visibleText(page.locator('.panel-buyer .panel-label'))).toBe('ຜູ້ຊື້ / ຜູ້ເຊົ່າ');
    expect(await visibleText(page.locator('.panel-agent .panel-label'))).toBe('ຜູ້ຂາຍ/ນາຍຫນ້າ');
    const bodyText = await contentText(page);
    expect(CJK_SCRIPT.test(bodyText)).toBe(false);
  });

  test('Card 2 sublabel no longer contains the raw English word "Agent"', async ({ page }) => {
    // The specific mixed-language bug: the Lao span literally read
    // "Agent · ນາຍໜ້າ" -- untranslated English baked into a Lao string.
    await mount(page);
    const sublabel = await page.locator('.panel-agent .panel-sublabel .lo-i').innerText();
    expect(sublabel).not.toMatch(/Agent/i);
    expect(LAO_SCRIPT.test(sublabel)).toBe(true);
  });
});

test.describe('switching to English updates every visible string, immediately, no reload', () => {
  test('hero labels switch to English; zero Lao script characters remain visible anywhere', async ({ page }) => {
    await mount(page);

    // Proves the switch never reloads the page: a marker set before the
    // click can only survive if setLang() is a pure in-page DOM mutation.
    await page.evaluate(() => { window.__noReloadMarker = 'still-here'; });

    await page.locator('.nav-lang-item[data-lang="en"]').click();

    await expect(page.evaluate(() => window.__noReloadMarker)).resolves.toBe('still-here');
    expect(await visibleText(page.locator('.panel-buyer .panel-label'))).toBe('Buyer / Renter');
    expect(await visibleText(page.locator('.panel-agent .panel-label'))).toBe('Seller / Landlord');

    const bodyText = await contentText(page);
    expect(LAO_SCRIPT.test(bodyText)).toBe(false);
  });

  test('CTAs and footer read in English', async ({ page }) => {
    await mount(page);
    await page.locator('.nav-lang-item[data-lang="en"]').click();

    await expect(page.locator('.panel-buyer .panel-cta')).toContainText('Browse listings');
    await expect(page.locator('.panel-agent .panel-sublabel')).toContainText('List Your Property');
    await expect(page.locator('footer')).toContainText('Vientiane, Laos');
    await expect(page.locator('footer')).toContainText('Listings');
    await expect(page.locator('footer')).toContainText('For Agents');
  });
});

test.describe('switching to Chinese updates every visible string, immediately, no reload', () => {
  test('hero labels switch to Chinese; zero Lao script characters remain visible anywhere', async ({ page }) => {
    await mount(page);
    await page.evaluate(() => { window.__noReloadMarker = 'still-here'; });

    await page.locator('.nav-lang-item[data-lang="zh"]').click();

    await expect(page.evaluate(() => window.__noReloadMarker)).resolves.toBe('still-here');
    expect(await visibleText(page.locator('.panel-buyer .panel-label'))).toBe('买家 / 租客');
    expect(await visibleText(page.locator('.panel-agent .panel-label'))).toBe('卖家 / 房东');

    const bodyText = await contentText(page);
    expect(LAO_SCRIPT.test(bodyText)).toBe(false);
  });

  test('previously-hardcoded English footer strings are gone when Chinese is active', async ({ page }) => {
    // The regression this specifically guards: before the fix, the footer's
    // nav links were bare English text nodes with no zh-i counterpart, so
    // they stayed "Listings" / "For Agents" regardless of language.
    await mount(page);
    await page.locator('.nav-lang-item[data-lang="zh"]').click();

    const footerText = await page.locator('footer').innerText();
    expect(footerText).not.toContain('Listings');
    expect(footerText).not.toContain('For Agents');
    expect(footerText).not.toContain('Vientiane');
    expect(footerText).toContain('房源');
    expect(footerText).toContain('经纪人');
    expect(footerText).toContain('万象');
  });

  test('CTAs read in Chinese', async ({ page }) => {
    await mount(page);
    await page.locator('.nav-lang-item[data-lang="zh"]').click();
    await expect(page.locator('.panel-buyer .panel-cta')).toContainText('浏览房源');
    await expect(page.locator('.panel-agent .panel-sublabel')).toContainText('发布房源');
  });
});

test('switching back to Lao restores the entire page to Lao, no leftover English/Chinese', async ({ page }) => {
  await mount(page);
  await page.locator('.nav-lang-item[data-lang="en"]').click();
  await page.locator('.nav-lang-item[data-lang="zh"]').click();
  await page.locator('.nav-lang-item[data-lang="lo"]').click();

  expect(await visibleText(page.locator('.panel-buyer .panel-label'))).toBe('ຜູ້ຊື້ / ຜູ້ເຊົ່າ');
  expect(await visibleText(page.locator('.panel-agent .panel-label'))).toBe('ຜູ້ຂາຍ/ນາຍຫນ້າ');
  const bodyText = await contentText(page);
  expect(CJK_SCRIPT.test(bodyText)).toBe(false);
});

test('the active language button reflects the currently-selected language', async ({ page }) => {
  await mount(page);
  await page.locator('.nav-lang-item[data-lang="zh"]').click();
  await expect(page.locator('.nav-lang-item[data-lang="zh"]')).toHaveClass(/active/);
  await expect(page.locator('.nav-lang-item[data-lang="lo"]')).not.toHaveClass(/active/);
  await expect(page.locator('.nav-lang-item[data-lang="en"]')).not.toHaveClass(/active/);
});

// ── Homepage cards get the same embeds as listings.html (2026-09-03) ───────
// The homepage query selected contacts(name) and parties(type,name_en,
// photo_url) and no unit_types at all, so the SAME card component rendered
// "Price on request" for an occupied multi-unit building the search page
// priced, labelled every owner as a generic "Contact", and showed agents'
// Latin names on the Lao (default) homepage.
test.describe('homepage card data', () => {
  const ROW = {
    id: 'p-1', slug: 'bldg', status: 'active', workflow_status: 'active', market_status: 'fully_occupied',
    property_type: 'apartment', transaction_type: 'for_rent', title_lo: 'ອາພາດເມັນ', title_en: 'Apartment', images: [],
    price_amount: null, price_currency: null, price_frequency: null, district_lo: 'ສີສັດຕະນາກ', district_en: 'Sisattanak',
    created_at: '2026-08-01T00:00:00Z', is_featured: true,
    contacts: { role: 'owner', name: 'Mr Li' }, parties: null,
    unit_types: [{ id: 'u1', sort_order: 0, name_en: 'Studio', price_amount: 350, price_currency: 'USD', price_frequency: 'monthly', is_available: false, available_count: 0, total_units: 4, next_available_date: null }],
  };
  const AGENT_ROW = Object.assign({}, ROW, { id: 'p-2', slug: 'agented', market_status: 'available', price_amount: 900, price_currency: 'USD', price_frequency: 'monthly', unit_types: [],
    contacts: { role: 'agent', name: 'Somchai' }, parties: { type: 'agent', name_en: 'Somchai', name_lo: 'ສົມໄຊ', photo_url: null } });

  test('the query embeds unit_types, the contact role and the party name_lo; the cards use them', async ({ page }) => {
    let url = '';
    await page.route('**/rest/v1/properties**', (r) => { url = r.request().url(); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([ROW, AGENT_ROW]) }); });
    await stubAnalytics(page);
    await page.goto('/index.html?lang=lo');
    await expect(page.locator('#card-grid .pt-card')).toHaveCount(2);
    expect(url).toContain('unit_types(');
    expect(url).toContain('contacts(role,name)');
    expect(url).toContain('parties(type,name_en,name_lo,photo_url)');
    const text = await page.locator('#card-grid').innerText();
    expect(text).toContain('$350');                 // priced from its unit types, not "Price on request"
    expect(text).not.toContain('ສອບຖາມລາຄາ');
    expect(text).toContain('ເຈົ້າຂອງ');             // Owner, not the generic Contact label
    expect(text).toContain('ສົມໄຊ');                // the agent's Lao name on the Lao homepage
    expect(text).not.toContain('Somchai');
  });
});
