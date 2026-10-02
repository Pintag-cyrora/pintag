// admin.html Google Maps link field: classify what was pasted as
//   Exact location | Named place | Unusable
// and say what each will do on the public site. Only an unusable link keeps the
// existing "will NOT place a pin" warning; a named place is explained, allowed
// and saved, and nothing here ever blocks a save.
const { test, expect } = require('@playwright/test');
const { fakeBackend, boot, SAVE, FORM_STATE } = require('./fixtures');

const REAL_CONTACT = { id: 'c-real', role: 'agent', name: 'Souksavanh', phone: '02055512345', whatsapp: '02055512345', party_id: null, is_verified: true, languages: ['lo'] };
const baseProp = (o) => Object.assign({
  id: 'prop-1', title_en: 'Studio House', slug: 'studio-house',
  workflow_status: 'active', market_status: 'available', status: 'active',
  property_type: 'house', transaction_type: 'for_rent', price_amount: 500, price_currency: 'USD', price_frequency: 'monthly',
  contact_id: 'c-real', images: [], deleted_at: null, owner_id: null,
}, o);
const patchOf = (backend, id) => backend.state.requests.find((r) => r.method === 'PATCH' && r.table === 'properties' && r.query.includes(id));

const PLACE_ID = '0x3123456789abcdef:0x7f9e8d7c6b5a4f3e';
const PLACE = 'https://www.google.com/maps?q=Lao+Plaza+Hotel,+Vientiane&ftid=' + PLACE_ID + '&entry=gps';
const EXACT = 'https://www.google.com/maps?q=17.9757,102.6331';

async function openEdit(page, stored) {
  const backend = fakeBackend({ seedContacts: [REAL_CONTACT], seedProperties: [baseProp({ map_embed_url: stored === undefined ? null : stored })] });
  const errors = await boot(page, backend);
  await page.evaluate(() => editListing('prop-1'));
  await expect.poll(() => page.evaluate(() => document.getElementById('f-title-en').value)).toBe('Studio House');
  return { backend, errors };
}
const paste = (page, value) => page.evaluate((v) => { const el = document.getElementById('f-map'); el.value = v; return resolveMapUrl(el); }, value);
const hint = (page) => page.locator('#f-map-hint');

test('Exact location: classified and described as an exact pin', async ({ page }) => {
  await openEdit(page);
  await paste(page, EXACT);
  await expect(hint(page)).toHaveAttribute('data-map-state', 'exact');
  await expect(hint(page)).toContainText('Exact location');
  await expect(hint(page)).toContainText('17.975700, 102.633100');
  await expect(hint(page)).toContainText('exact pin');
});

test('Exact location in a newer format (?q=lat, lng) is recognised too', async ({ page }) => {
  await openEdit(page);
  await paste(page, 'https://www.google.com/maps?q=17.9757, 102.6331');
  await expect(hint(page)).toHaveAttribute('data-map-state', 'exact');
});

test('Named place: explained as NOT an exact coordinate, label shown, and not styled as an error', async ({ page }) => {
  await openEdit(page);
  await paste(page, PLACE);
  await expect(hint(page)).toHaveAttribute('data-map-state', 'place');
  await expect(hint(page)).toContainText('Named place');
  await expect(hint(page)).toContainText('Lao Plaza Hotel, Vientiane');
  await expect(hint(page)).toContainText('no exact coordinates');
  await expect(hint(page)).toContainText('can be saved');
  await expect(hint(page)).toContainText('will NOT get an exact pin');
  await expect(hint(page)).not.toContainText('Unusable');
  expect(await hint(page).evaluate((e) => e.style.color)).not.toContain('danger');
});

test('Named place: saving is allowed and the original URL is stored untouched', async ({ page }) => {
  const { backend, errors } = await openEdit(page);
  await paste(page, PLACE);
  await page.evaluate(SAVE);
  const s = await page.evaluate(FORM_STATE);
  expect(s.msgClass, s.msg).toContain('success');
  expect(patchOf(backend, 'prop-1').body.map_embed_url).toBe(PLACE);
  expect(errors).toEqual([]);
});

test('Unusable link: the existing warning is kept (and saving is still not blocked, as before)', async ({ page }) => {
  const { backend } = await openEdit(page);
  await paste(page, 'https://www.google.com/maps?q=apartments+in+Vientiane');
  await expect(hint(page)).toHaveAttribute('data-map-state', 'invalid');
  await expect(hint(page)).toContainText('Unusable link');
  await expect(hint(page)).toContainText('will NOT place a pin');
  await expect(hint(page)).toContainText('copy the share link again');
  expect(await hint(page).evaluate((e) => e.style.color)).toContain('danger');
  await page.evaluate(SAVE);
  expect(patchOf(backend, 'prop-1').body.map_embed_url).toBe('https://www.google.com/maps?q=apartments+in+Vientiane');
});

test('Unusable: a reversed coordinate pair is named as such', async ({ page }) => {
  await openEdit(page);
  await paste(page, 'https://www.google.com/maps?q=102.6331, 17.9757');
  await expect(hint(page)).toHaveAttribute('data-map-state', 'invalid');
  await expect(hint(page)).toContainText('transposed');
});

test('Blank field: back to the default hint', async ({ page }) => {
  await openEdit(page);
  await paste(page, PLACE);
  await paste(page, '');
  await expect(hint(page)).toHaveAttribute('data-map-state', 'empty');
  await expect(hint(page)).toContainText('Paste any Google Maps share link');
});

test('a short link that expands to a named place is classified as a place (not an error)', async ({ page }) => {
  await page.route('**/functions/v1/resolve-map-url', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resolved_url: PLACE }) }));
  const { backend } = await openEdit(page);
  await paste(page, 'https://maps.app.goo.gl/AbCdEf');
  await expect(hint(page)).toHaveAttribute('data-map-state', 'place');
  expect(await page.evaluate(() => document.getElementById('f-map').value)).toBe(PLACE);
  await page.evaluate(SAVE);
  expect(patchOf(backend, 'prop-1').body.map_embed_url).toBe(PLACE);
});

test('opening a listing that already holds a place link shows the place state immediately', async ({ page }) => {
  await openEdit(page, PLACE);
  await expect(hint(page)).toHaveAttribute('data-map-state', 'place');
  await expect(hint(page)).toContainText('Lao Plaza Hotel, Vientiane');
});

test('a label with markup is shown as text, never as HTML', async ({ page }) => {
  await openEdit(page);
  await paste(page, 'https://www.google.com/maps?q=' + encodeURIComponent('<img src=x onerror=window.__pwned=1>') + '&ftid=' + PLACE_ID);
  await expect(hint(page)).toHaveAttribute('data-map-state', 'place');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await hint(page).locator('img').count()).toBe(0);
});
