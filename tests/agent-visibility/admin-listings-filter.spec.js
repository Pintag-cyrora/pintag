// Admin → Listings retrieval controls: the real filterListings() from
// admin.html, run against a mock table + roster. Verifies the combined
// location/agent/title text search AND the canonical workflow_status filter
// (draft|active|archived) compose (both must pass), plus the subtle
// match-reason chip. Same extract-the-real-function approach as
// admin-visibility.spec.js so we test production code, not a copy.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

function extractFn(file, name) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const filterListings = extractFn('admin.html', 'filterListings');
const digitsOnly     = extractFn('admin.html', '_digitsOnly');

// Roster (managing agents) and listings, mirroring the fields the real
// LISTINGS_QS select provides. workflow_status is the canonical status axis.
const AGENTS = [
  { id: 'ag-daeng', name_en: 'Daeng Somphone', name_lo: 'ແດງ', agency_name: 'Pintag' },
  { id: 'ag-other', name_en: 'Other Agent',    name_lo: '',     agency_name: 'ACME' },
];
const LISTINGS = [
  { id: 'p1', title_en: 'Riverside Villa', district_en: 'Sisattanak',  village_en: 'Ban Phonsavanh',    workflow_status: 'draft',    managed_by_party_id: 'ag-daeng', owners: null, price_display: '$500' },
  { id: 'p2', title_en: 'City Condo',      district_en: 'Chanthabouly', village_en: 'Vientiane Center',  workflow_status: 'active',   managed_by_party_id: 'ag-other', owners: null, price_display: '$300' },
  { id: 'p3', title_en: 'Old Shophouse',   district_en: 'Sisattanak',  village_en: 'Vientiane Riverside', workflow_status: 'archived', managed_by_party_id: 'ag-daeng', owners: null, price_display: '$200' },
  { id: 'p4', title_en: 'Daeng Tower',     district_en: 'Xaythany',    village_en: 'Nonghai',           workflow_status: 'active',   managed_by_party_id: null,       owners: { name: 'Mr Owner', phone: '02055512345', whatsapp: '' }, price_display: '$900' },
];

function tableHtml() {
  const rows = LISTINGS.map(p =>
    `<tr data-property-id="${p.id}"><td><strong>${p.title_en}</strong><span class="match-why"></span></td></tr>`
  ).join('');
  return `
    <input id="listings-search" value="">
    <select id="listings-status-filter">
      <option value="all">All</option><option value="draft">Draft</option>
      <option value="active">Published</option><option value="archived">Archived</option>
    </select>
    <span id="listings-search-count"></span>
    <table class="listings-table"><tbody>${rows}</tbody></table>`;
}

async function boot(page) {
  await page.setContent(tableHtml());
  await page.evaluate(({ fL, dO, agents, listings }) => {
    window._agentsAll = agents;
    window._listingsAll = listings;
    // eslint-disable-next-line no-eval
    (0, eval)(dO); // _digitsOnly
    // eslint-disable-next-line no-eval
    (0, eval)(fL); // filterListings
  }, { fL: filterListings, dO: digitsOnly, agents: AGENTS, listings: LISTINGS });
}

// Set search + status, run filterListings, return which rows are visible,
// each visible row's match-reason chip text, and the count label.
async function run(page, search, status) {
  return page.evaluate(({ search, status }) => {
    document.getElementById('listings-search').value = search;
    document.getElementById('listings-status-filter').value = status;
    filterListings();
    const visible = [];
    const reasons = {};
    document.querySelectorAll('.listings-table tbody tr').forEach(tr => {
      if (tr.style.display !== 'none') {
        visible.push(tr.dataset.propertyId);
        reasons[tr.dataset.propertyId] = tr.querySelector('.match-why').textContent;
      }
    });
    return { visible, reasons, count: document.getElementById('listings-search-count').textContent };
  }, { search, status });
}

test.describe('admin.html filterListings (real function)', () => {
  test('Search Sisattanak + Draft → only the draft in that district', async ({ page }) => {
    await boot(page);
    const r = await run(page, 'Sisattanak', 'draft');
    expect(r.visible).toEqual(['p1']);          // p3 is Sisattanak but archived → excluded
    expect(r.reasons.p1).toBe('location');
    expect(r.count).toBe('1 of 4 listings');
  });

  test('Search Daeng (agent) + Draft → agent match, status-scoped', async ({ page }) => {
    await boot(page);
    const r = await run(page, 'Daeng', 'draft');
    expect(r.visible).toEqual(['p1']);          // p3 (Daeng, archived) + p4 ("Daeng Tower", active) excluded by status
    expect(r.reasons.p1).toBe('agent');
  });

  test('Search Vientiane + Archived → archived village match', async ({ page }) => {
    await boot(page);
    const r = await run(page, 'Vientiane', 'archived');
    expect(r.visible).toEqual(['p3']);          // p2 (Vientiane Center) is active → excluded
    expect(r.reasons.p3).toBe('location');
  });

  test('Search an agent + Published → published listing for that agent', async ({ page }) => {
    await boot(page);
    const r = await run(page, 'Other', 'active');
    expect(r.visible).toEqual(['p2']);
    expect(r.reasons.p2).toBe('agent');
  });

  test('Case-insensitive + partial matches', async ({ page }) => {
    await boot(page);
    const r = await run(page, 'sisat', 'all');   // lowercase, partial
    expect(r.visible.sort()).toEqual(['p1', 'p3']);
  });

  test('Title match does not show a (redundant) reason chip', async ({ page }) => {
    await boot(page);
    const r = await run(page, 'Villa', 'all');
    expect(r.visible).toEqual(['p1']);
    expect(r.reasons.p1).toBe('');               // title is obvious; chip stays empty
  });

  test('Status filter alone (Draft, no text) narrows the list', async ({ page }) => {
    await boot(page);
    const r = await run(page, '', 'draft');
    expect(r.visible).toEqual(['p1']);
    expect(r.count).toBe('1 of 4 listings');
  });

  test('Empty search + All shows everything with no count label', async ({ page }) => {
    await boot(page);
    const r = await run(page, '', 'all');
    expect(r.visible.sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(r.count).toBe('');
  });

  test('Owner phone lookup (digits) still works', async ({ page }) => {
    await boot(page);
    const r = await run(page, '555123', 'all');
    expect(r.visible).toEqual(['p4']);
    expect(r.reasons.p4).toBe('phone');
  });
});
