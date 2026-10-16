// Admin "search by owner name", on the REAL admin.html with the in-memory REST fake plus a spec-local feed for the listings
// request (the shared fake answers [] for list queries). What is pinned here, beyond the pure-function cases in
// tests/agent-visibility/admin-listings-filter.spec.js:
//   * it REUSES the one existing listings request (owner-role buyer contacts are an embed in it; nothing new is fetched,
//     no private owner fields are added) and that request still excludes soft-deleted listings
//   * typing triggers NO network requests at all (search is client-side), and nothing is ever written
//   * draft / published / archived listings are all searchable by owner name, composing with the status dropdown
const { test, expect } = require('@playwright/test');
const { fakeBackend, boot } = require('./fixtures');

const row = (id, title, status, o) => Object.assign({ id, slug: 's-' + id, title_en: title, price_display: '$500', property_type: 'house', transaction_type: 'for_rent',
  status: status === 'active' ? 'active' : status, workflow_status: status, market_status: 'available', is_featured: false, managed_by_party_id: null, district_en: 'Sisattanak',
  village_en: 'Thatluang', view_count: 0, contacts: null, property_contacts: [], owner_id: null, owners: null, unit_types: [], deleted_at: null }, o || {});
const ROWS = [
  row('a1', 'Draft Villa', 'draft',     { owner_id: 'ow1', owners: { id: 'ow1', name: 'Mr. Somchai   Phommachanh', phone: '02055512345', whatsapp: null } }),
  row('a2', 'Live Flat',   'active',    { owner_id: 'ow2', owners: { id: 'ow2', name: 'Daeng Vongsa', phone: null, whatsapp: null } }),
  row('a3', 'Old House',   'archived',  { owner_id: 'ow3', owners: { id: 'ow3', name: 'ນາງ ສົມຈິດ ຈຳປາ', phone: null, whatsapp: null } }),
  row('a4', 'Contact Owned', 'active',  { contacts: { role: 'agent', name: 'Agent Only', phone: '020' }, property_contacts: [{ contacts: { role: 'owner', name: '李 小龙' } }, { contacts: { role: 'agent', name: 'Khamla Helper' } }] }),
  row('a5', 'Deleted Place', 'active',  { deleted_at: '2026-10-01T00:00:00Z', owner_id: 'ow9', owners: { id: 'ow9', name: 'Zed Deletedowner', phone: null, whatsapp: null } }),
];

async function open(page) {
  const backend = fakeBackend();
  await boot(page, backend);
  const log = { listQueries: [] };
  await page.route('**/rest/v1/properties?*', (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() !== 'GET' || !(u.searchParams.get('select') || '').includes('view_count')) return route.fallback();
    log.listQueries.push(u.search);
    const rows = ROWS.filter((r) => (u.searchParams.get('deleted_at') === 'is.null' ? !r.deleted_at : true));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  await page.evaluate(() => showListings());
  await page.waitForSelector('.listings-table tbody tr');
  return { backend, log };
}
const visible = (page) => page.evaluate(() => [...document.querySelectorAll('.listings-table tbody tr')].filter((t) => t.style.display !== 'none').map((t) => t.dataset.propertyId).sort());
const chips = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.listings-table tbody tr')].filter((t) => t.style.display !== 'none').map((t) => [t.dataset.propertyId, t.querySelector('.match-why').textContent])));
const search = (page, q) => page.fill('#listings-search', q);

test('the placeholder tells you owner names and phones are searchable', async ({ page }) => {
  await open(page);
  await expect(page.locator('#listings-search')).toHaveAttribute('placeholder', 'Search by listing, location, agent, owner name or phone…');
});

test('it reuses the ONE listings request: owner-role contacts are an embed in it, no private owner fields are added, soft-deleted stay excluded', async ({ page }) => {
  const { log } = await open(page);
  expect(log.listQueries.length).toBe(1);
  const q = decodeURIComponent(log.listQueries[0]);
  expect(q).toContain('property_contacts(contacts(role,name))');          // the new embed: role + name only (no phone, no ids)
  expect(q).toContain('owners(id,name,phone,whatsapp)');                    // unchanged: the existing staff-only embed
  expect(q).not.toMatch(/owners\([^)]*(email|notes)/);                       // no new private owner fields
  expect(q).toContain('deleted_at=is.null');
  expect(q).not.toMatch(/limit=|offset=/);                                    // unchanged: still the single un-paged request
});

test('soft-deleted listings stay out of the table and out of owner search', async ({ page }) => {
  await open(page);
  expect(await visible(page)).toEqual(['a1', 'a2', 'a3', 'a4']);
  await search(page, 'deletedowner');
  expect(await visible(page)).toEqual([]);
  await search(page, 'zed');
  expect(await visible(page)).toEqual([]);
});

test('owner-name search finds draft, published and archived listings (Lao and Chinese included) with the right label', async ({ page }) => {
  await open(page);
  await search(page, 'somchai phom');   expect(await visible(page)).toEqual(['a1']); expect((await chips(page)).a1).toBe('owner');
  await search(page, 'VONGSA');         expect(await visible(page)).toEqual(['a2']); expect((await chips(page)).a2).toBe('owner');
  await search(page, 'ຈຳປາ ສົມຈິດ');    expect(await visible(page)).toEqual(['a3']); expect((await chips(page)).a3).toBe('owner');
  await search(page, '小龙');            expect(await visible(page)).toEqual(['a4']); expect((await chips(page)).a4).toBe('owner (contact)');
  await search(page, 'agent only');     expect(await visible(page)).toEqual([]);      // an agent-role contact is not an owner
  await search(page, 'khamla');         expect(await visible(page)).toEqual([]);
  await expect(page.locator('#listings-search-count')).toHaveText('0 of 4 listings');
});

test('composes with the status dropdown and existing searches still work', async ({ page }) => {
  await open(page);
  await page.selectOption('#listings-status-filter', 'archived');
  await search(page, 'ສົມຈິດ');         expect(await visible(page)).toEqual(['a3']);
  await search(page, 'somchai');        expect(await visible(page)).toEqual([]);
  await page.selectOption('#listings-status-filter', 'draft');
  await search(page, 'somchai');        expect(await visible(page)).toEqual(['a1']);
  await search(page, '555123');         expect(await visible(page)).toEqual(['a1']); expect((await chips(page)).a1).toBe('phone');
  await page.selectOption('#listings-status-filter', 'all');
  await search(page, 'live flat');      expect(await visible(page)).toEqual(['a2']); expect((await chips(page)).a2).toBe('');
  await search(page, 'sisattanak');     expect(await visible(page)).toEqual(['a1', 'a2', 'a3', 'a4']);
  await search(page, '');               expect(await visible(page)).toEqual(['a1', 'a2', 'a3', 'a4']);
});

test('typing issues NO network requests (client-side), and nothing is ever written', async ({ page }) => {
  const { backend, log } = await open(page);
  const before = backend.state.requests.length, listBefore = log.listQueries.length;
  const reqs = []; page.on('request', (r) => { if (r.url().includes('/rest/v1/') || r.url().includes('/functions/')) reqs.push(r.method() + ' ' + r.url()); });
  await page.locator('#listings-search').pressSequentially('somchai phommachanh', { delay: 30 });
  await page.locator('#listings-search').press('Backspace');
  await page.locator('#listings-search').pressSequentially('李 小龙', { delay: 30 });
  await page.selectOption('#listings-status-filter', 'active');
  await page.waitForTimeout(400);
  expect(reqs).toEqual([]);
  expect(backend.state.requests.length).toBe(before);
  expect(log.listQueries.length).toBe(listBefore);
  expect(backend.state.requests.filter((r) => r.method !== 'GET')).toEqual([]);
});

test('the page still works end to end: opening a found listing for editing is unchanged', async ({ page }) => {
  await open(page);
  await search(page, 'daeng vongsa');
  await page.locator('tr[data-property-id="a2"] .btn-edit').click();
  await expect(page.locator('#form-panel')).toBeVisible();
  await expect(page.locator('#edit-id')).toHaveValue('a2');
});
