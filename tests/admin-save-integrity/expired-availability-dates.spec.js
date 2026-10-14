// Admin unit cards and expired availability dates (see expired-availability-dates.test.js at the repo root for the rule).
// The collapsed-card status badge and the hint under the date field must follow the same Lao-calendar-day expiry as the
// public site: an expired / malformed date is NOT shown in the badge ("Currently Unavailable (0/5)" instead of
// "Fully Occupied — Available from <past date>"), the admin is told why, and NOTHING is rewritten -- the stored value
// stays in the input (so staff can fix or clear it), and the other availability inputs are untouched.
//
// Fixed clock: 2026-10-13T18:00:00Z == 01:00 on 14 Oct in Vientiane while it is still 13 Oct in UTC and the US.
const { test, expect } = require('@playwright/test');
const { fakeBackend, boot } = require('./fixtures');

const NOW = '2026-10-13T18:00:00Z';
const UT = (o) => Object.assign({ name_en: 'Studio', bedrooms: 0, bathrooms: 1, price_amount: 300, price_currency: 'USD', price_frequency: 'monthly',
  is_available: true, available_count: 0, total_units: 5, next_available_date: null, sort_order: 0 }, o || {});

async function setup(page) {
  await page.clock.setFixedTime(NOW);
  const backend = fakeBackend(); await boot(page, backend);
  await page.evaluate(() => { showForm(); });
  return backend;
}
async function addCard(page, o) {
  await page.evaluate((u) => addUnitType(u), UT(o));
  const card = page.locator('.ut-card').last();
  await card.evaluate((el) => el.classList.add('expanded'));        // the date field and its hint live in the expanded body
  return card;
}
const badge = (card) => card.locator('.ut-avail-badge');
const hint = (card) => card.locator('.ut-date-expired-hint');

test('expired date: badge reads Currently Unavailable (no stale date), hint explains, the stored date stays in the field', async ({ page }) => {
  await setup(page);
  const card = await addCard(page, { next_available_date: '2026-10-13' });          // yesterday in Laos (still "today" in UTC / the US)
  await expect(badge(card)).toHaveText('Currently Unavailable (0/5)');
  await expect(badge(card)).not.toContainText(/Available from|13 Oct/);
  await expect(hint(card)).toBeVisible();
  await expect(hint(card)).toContainText('has passed');
  await expect(card.locator('.ut-next-available-date')).toHaveValue('2026-10-13');   // never rewritten
});

test('today (Laos) and future dates are live: unchanged badge, no hint', async ({ page }) => {
  await setup(page);
  const today = await addCard(page, { next_available_date: '2026-10-14' });
  await expect(badge(today)).toHaveText('Fully Occupied — Available from 14 Oct 2026 (0/5)');
  await expect(hint(today)).toBeHidden();
  const later = await addCard(page, { next_available_date: '2026-12-31' });
  await expect(badge(later)).toHaveText('Fully Occupied — Available from 31 Dec 2026 (0/5)');
  await expect(hint(later)).toBeHidden();
});

test('no date: Currently Unavailable and NO hint (a missing date is not an expired one)', async ({ page }) => {
  await setup(page);
  const card = await addCard(page, { next_available_date: null });
  await expect(badge(card)).toHaveText('Currently Unavailable (0/5)');
  await expect(hint(card)).toBeHidden();
});

test('positive count with an expired date stays Available Now; the settings are untouched', async ({ page }) => {
  await setup(page);
  const card = await addCard(page, { available_count: 3, next_available_date: '2026-10-01' });
  await expect(badge(card)).toHaveText('Available Now (3/5)');
  await expect(hint(card)).toBeVisible();                                           // the date is still stale; staff are told
  await expect(card.locator('.ut-available-count')).toHaveValue('3');
  await expect(card.locator('.ut-is-available')).toBeChecked();
  await expect(card.locator('.ut-total-units')).toHaveValue('5');
});

test('switched-off unit with an expired date keeps its own status', async ({ page }) => {
  await setup(page);
  const card = await addCard(page, { is_available: false, available_count: 0, total_units: 5, next_available_date: '2026-10-01' });
  await expect(badge(card)).toHaveText('Currently Unavailable (0/5)');               // coming_soon collapses to this public message, as before
  await expect(card.locator('.ut-is-available')).not.toBeChecked();
});

test('editing the date live: expired -> hint + stale label gone; fixing it to a live date restores the label; Clear hides the hint', async ({ page }) => {
  await setup(page);
  const card = await addCard(page, { next_available_date: '2026-11-15' });
  await expect(badge(card)).toHaveText('Fully Occupied — Available from 15 Nov 2026 (0/5)');
  const date = card.locator('.ut-next-available-date');
  await date.fill('2026-10-12');
  await expect(badge(card)).toHaveText('Currently Unavailable (0/5)');
  await expect(hint(card)).toBeVisible();
  await date.fill('2026-10-14');
  await expect(badge(card)).toHaveText('Fully Occupied — Available from 14 Oct 2026 (0/5)');
  await expect(hint(card)).toBeHidden();
  await date.fill('2026-10-01');
  await expect(hint(card)).toBeVisible();
  await card.locator('.ut-clear-date-btn').click();
  await expect(date).toHaveValue('');
  await expect(hint(card)).toBeHidden();
  await expect(badge(card)).toHaveText('Currently Unavailable (0/5)');
});

test('saving does not rewrite an expired date (the admin sends exactly what is in the field)', async ({ page }) => {
  await setup(page);
  const card = await addCard(page, { next_available_date: '2026-10-01' });
  const sent = await page.evaluate(() => getUnitTypesFromDom().map((u) => ({ d: u.next_available_date, c: u.available_count, a: u.is_available, t: u.total_units })));
  expect(sent).toEqual([{ d: '2026-10-01', c: 0, a: true, t: 5 }]);
  await expect(card.locator('.ut-next-available-date')).toHaveValue('2026-10-01');
});
