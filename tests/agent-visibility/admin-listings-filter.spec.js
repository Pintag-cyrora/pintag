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
const normalizeText  = extractFn('admin.html', '_normalizeSearchText');
const nameMatch      = extractFn('admin.html', '_nameSearchMatch');
const phoneCanon     = extractFn('admin.html', '_phoneCanon');
const phoneMatch     = extractFn('admin.html', '_phoneSearchMatch');

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

function tableHtml(L) {
  const rows = (L || LISTINGS).map(p =>
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

async function boot(page, listings) {
  const L = listings || LISTINGS;
  await page.setContent(tableHtml(L));
  await page.evaluate(({ fL, dO, nT, nM, pC, pM, agents, listings }) => {
    window._agentsAll = agents;
    window._listingsAll = listings;
    // eslint-disable-next-line no-eval
    (0, eval)(dO); // _digitsOnly
    // eslint-disable-next-line no-eval
    (0, eval)(nT); // _normalizeSearchText
    // eslint-disable-next-line no-eval
    (0, eval)(nM); // _nameSearchMatch
    // eslint-disable-next-line no-eval
    (0, eval)(pC); // _phoneCanon
    // eslint-disable-next-line no-eval
    (0, eval)(pM); // _phoneSearchMatch
    // eslint-disable-next-line no-eval
    (0, eval)(fL); // filterListings
  }, { fL: filterListings, dO: digitsOnly, nT: normalizeText, nM: nameMatch, pC: phoneCanon, pM: phoneMatch, agents: AGENTS, listings: L });
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

// ── Owner-name search ───────────────────────────────────────────────────────────────────────────────────────────
// 'owner'           = the INTERNAL owners record (staff-only, embedded as owners(...) in the existing listings request)
// 'owner (contact)' = a buyer contact whose role is 'owner' (legacy contacts embed or a property_contacts row)
// Any other contact role is never matched. Names are matched normalised: NFKC, case-insensitive, punctuation -> space,
// whitespace collapsed, every word of the query present in any order, partial words allowed.
const OWNER_LISTINGS = [
  { id: 'o1', title_en: 'Lakeside House',  district_en: 'Hadxaifong', village_en: 'Nongping', workflow_status: 'draft',    owners: { name: 'Mr. Somchai   Phommachanh', phone: '02011111111', whatsapp: '' }, price_display: '$410' },
  { id: 'o2', title_en: 'Garden Flat',     district_en: 'Sikhottabong', village_en: 'Dongdok', workflow_status: 'active',   owners: { name: 'Daeng Vongsa', phone: '', whatsapp: '' }, price_display: '$420' },
  { id: 'o3', title_en: 'Hill Retreat',    district_en: 'Xaythany',   village_en: 'Naxaithong', workflow_status: 'archived', owners: { name: 'ນາງ ສົມຈິດ ຈຳປາ', phone: '', whatsapp: '' }, price_display: '$430' },
  { id: 'o4', title_en: 'Market Shop',     district_en: 'Chanthabouly', village_en: 'Sisavath', workflow_status: 'active',  owners: null, contacts: { role: 'owner', name: 'Khamla Sihalath', phone: '02099999999' }, price_display: '$440' },
  { id: 'o5', title_en: 'Pine Cottage',    district_en: 'Saysettha',  village_en: 'Phonxay', workflow_status: 'draft',     owners: null, contacts: { role: 'agent', name: 'Khamla Agentonly', phone: '' },
    property_contacts: [{ contacts: { role: 'agent', name: 'Khamla Agentonly' } }, { contacts: { role: 'owner', name: '李 小龙' } }], price_display: '$450' },
  { id: 'o6', title_en: 'River Loft',      district_en: 'Sisattanak', village_en: 'Thatluang', workflow_status: 'archived', owners: null, contacts: { role: 'agent', name: 'Noorner Agent', phone: '' },
    property_contacts: [{ contacts: { role: 'reception', name: 'Bounmy Reception' } }, { contacts: { role: 'property_manager', name: 'Pm Manager' } }, { contacts: { role: 'other', name: 'Other Person' } }], price_display: '$460' },
  { id: 'o7', title_en: 'Sky Studio',      district_en: 'Xaysetha',   village_en: 'Donnokkhum', workflow_status: 'active',  owners: { name: '王小明', phone: '', whatsapp: '' }, price_display: '$470' },
  { id: 'o8', title_en: 'Pond Villa',      district_en: 'Pakngum',    village_en: 'Houay', workflow_status: 'active',       owners: { name: 'Ｓｕｋ Ｐａｎｙａ', phone: '', whatsapp: '' }, price_display: '$480' },
  { id: 'o9', title_en: 'No Owner Place',  district_en: 'Nasaithong', village_en: 'Bo', workflow_status: 'active',          owners: null, price_display: '$490' },
  { id: 'o11', title_en: 'Co-owned Villa',  district_en: 'Pakse',      village_en: 'Ban Na', workflow_status: 'archived', owners: null, contacts: null,
    property_contacts: [{ contacts: { role: 'agent', name: 'Helper Agent' } }, { contacts: { role: 'owner', name: 'Phet   Keo-Manivong' } }], price_display: '$499' },
  { id: 'o10', title_en: 'Null Contacts',  district_en: 'Nasaithong', village_en: 'Bo', workflow_status: 'active',          owners: null, contacts: null, property_contacts: [null, { contacts: null }, { contacts: { role: 'owner', name: null } }], price_display: '$495' },
];
const ownerRun = async (page, search, status) => { await boot(page, OWNER_LISTINGS); return run(page, search, status || 'all'); };

test.describe('owner-name search: internal owners', () => {
  test('partial name, any case', async ({ page }) => {
    const r = await ownerRun(page, 'SOMCH');
    expect(r.visible).toEqual(['o1']);
    expect(r.reasons.o1).toBe('owner');
  });
  test('extra whitespace in the stored name and in the query', async ({ page }) => {
    for (const q of ['somchai phommachanh', 'somchai    phommachanh', '  Somchai   Phom  ', 'mr somchai']) {
      expect((await ownerRun(page, q)).visible, q).toEqual(['o1']);
    }
  });
  test('punctuation is treated as a space (both in the name and in the query)', async ({ page }) => {
    for (const q of ['Mr.Somchai', 'mr, somchai', 'Mr-Somchai', '(Somchai) Phommachanh', 'somchai/phommachanh']) {
      expect((await ownerRun(page, q)).visible, q).toEqual(['o1']);
    }
  });
  test('multi-word queries match in any order and as partial words', async ({ page }) => {
    for (const q of ['phommachanh somchai', 'phom som', 'vongsa daeng', 'sa dae']) {
      const r = await ownerRun(page, q);
      expect(r.visible.length, q).toBe(1);
    }
    expect((await ownerRun(page, 'vongsa daeng')).visible).toEqual(['o2']);
  });
  test('every word must match: one wrong word means no match', async ({ page }) => {
    expect((await ownerRun(page, 'somchai vongsa')).visible).toEqual([]);
    expect((await ownerRun(page, 'daeng zzz')).visible).toEqual([]);
  });
  test('Latin words are never matched across word boundaries', async ({ page }) => {
    expect((await ownerRun(page, 'daengvongsa')).visible).toEqual([]);
    expect((await ownerRun(page, 'somchaiphom')).visible).toEqual([]);
  });
  test('full-width Latin is normalised (NFKC) in both directions', async ({ page }) => {
    expect((await ownerRun(page, 'suk panya')).visible).toEqual(['o8']);
    expect((await ownerRun(page, 'ＳＵＫ')).visible).toEqual(['o8']);
    expect((await ownerRun(page, 'ｐａｎｙａ ｓｕｋ')).visible).toEqual(['o8']);
  });
  test('a query of only punctuation or spaces matches no owner (and not everything)', async ({ page }) => {
    for (const q of ['...', '- -', ',', '()']) expect((await ownerRun(page, q)).visible, q).toEqual([]);
    expect((await ownerRun(page, '   ')).visible.length).toBe(OWNER_LISTINGS.length);          // blank = no text query: everything
  });
});

test.describe('owner-name search: Lao and Chinese names', () => {
  test('Lao: whole name, either word, partial, reversed order', async ({ page }) => {
    for (const q of ['ສົມຈິດ', 'ຈຳປາ', 'ນາງ ສົມຈິດ ຈຳປາ', 'ຈຳປາ ສົມຈິດ', 'ສົມ', 'ປາ ສົມ']) {
      const r = await ownerRun(page, q);
      expect(r.visible, q).toEqual(['o3']);
      expect(r.reasons.o3).toBe('owner');
    }
  });
  test('Lao combining marks survive normalisation (they are not treated as punctuation) and a query typed in decomposed form matches', async ({ page }) => {
    const out = await page.evaluate((nT) => { (0, eval)(nT); return { composed: _normalizeSearchText('ຈຳປາ'), nonMark: _normalizeSearchText('ສົມຈິດ') }; }, normalizeText);
    expect(out.nonMark).toBe('ສົມຈິດ');                          // the vowel/tone marks are still there
    expect(out.composed.length).toBeGreaterThan(2);
    // U+0EB3 (sara am) vs its decomposition U+0ECD U+0EB2: NFKC makes both sides identical
    const decomposed = 'ຈໍາປາ';
    expect((await ownerRun(page, decomposed)).visible).toEqual(['o3']);
    expect((await ownerRun(page, 'ຈຳປາ')).visible).toEqual(['o3']);
  });
  test('Lao: a different name does not match', async ({ page }) => {
    expect((await ownerRun(page, 'ສົມພອນ')).visible).toEqual([]);
  });
  test('Chinese, unspaced stored name: whole, partial single characters, spaced query', async ({ page }) => {
    for (const q of ['王小明', '小明', '明', '王', '王 小明', '小明 王']) {
      const r = await ownerRun(page, q);
      expect(r.visible, q).toEqual(['o7']);
      expect(r.reasons.o7).toBe('owner');
    }
  });
  test('Chinese, spaced stored name (owner contact): spaced, reversed and unspaced queries all match', async ({ page }) => {
    for (const q of ['李 小龙', '小龙 李', '李小龙', '小龙', '李']) {
      const r = await ownerRun(page, q);
      expect(r.visible, q).toEqual(['o5']);
      expect(r.reasons.o5).toBe('owner (contact)');
    }
  });
  test('Chinese: a different name does not match; ideographic spaces and CJK punctuation are separators', async ({ page }) => {
    expect((await ownerRun(page, '王小红')).visible).toEqual([]);
    expect((await ownerRun(page, '王　小明')).visible).toEqual(['o7']);
    expect((await ownerRun(page, '李·小龙')).visible).toEqual(['o5']);
    expect((await ownerRun(page, '小龙，李')).visible).toEqual(['o5']);
  });
});

test.describe('owner-name search: owner-role buyer contacts', () => {
  test('a legacy contact with role owner matches and is labelled "owner (contact)"', async ({ page }) => {
    const r = await ownerRun(page, 'khamla sihalath');
    expect(r.visible).toEqual(['o4']);
    expect(r.reasons.o4).toBe('owner (contact)');
  });
  test('a property_contacts row with role owner matches (any status), with partial / punctuated / reordered queries', async ({ page }) => {
    for (const q of ['phet', 'keo manivong', 'KEO-MANI', 'manivong  phet']) {
      const r = await ownerRun(page, q);
      expect(r.visible, q).toEqual(['o11']);
      expect(r.reasons.o11).toBe('owner (contact)');
    }
    expect((await ownerRun(page, 'phet', 'archived')).visible).toEqual(['o11']);
    expect((await ownerRun(page, 'phet', 'active')).visible).toEqual([]);
    expect((await ownerRun(page, 'helper')).visible).toEqual([]);                    // the agent-role contact on the same listing
  });
  test('contacts with any OTHER role are never matched, by name', async ({ page }) => {
    for (const q of ['agentonly', 'noorner', 'reception', 'bounmy', 'pm manager', 'other person']) {
      expect((await ownerRun(page, q)).visible, q).toEqual([]);
    }
  });
  test('"khamla" finds only the owner-role contact, not the agent-role one on another listing', async ({ page }) => {
    const r = await ownerRun(page, 'khamla');
    expect(r.visible).toEqual(['o4']);
  });
  test('the internal owner label and the contact label are distinct', async ({ page }) => {
    expect((await ownerRun(page, 'somchai')).reasons.o1).toBe('owner');
    expect((await ownerRun(page, 'sihalath')).reasons.o4).toBe('owner (contact)');
  });
  test('missing / null contacts and null names never throw or match', async ({ page }) => {
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const r = await ownerRun(page, 'anything');
    expect(r.visible).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('owner-name search: every visibility status', () => {
  test('finds draft, published and archived listings with the status filter on All', async ({ page }) => {
    expect((await ownerRun(page, 'somchai', 'all')).visible).toEqual(['o1']);        // draft
    expect((await ownerRun(page, 'daeng', 'all')).visible).toEqual(['o2']);          // published
    expect((await ownerRun(page, 'ສົມຈິດ', 'all')).visible).toEqual(['o3']);         // archived
    expect((await ownerRun(page, 'li xiaolong 小龙', 'all')).visible).toEqual([]);   // every word must match
  });
  test('the status filter still narrows owner-name results (both must pass)', async ({ page }) => {
    expect((await ownerRun(page, 'somchai', 'draft')).visible).toEqual(['o1']);
    expect((await ownerRun(page, 'somchai', 'active')).visible).toEqual([]);
    expect((await ownerRun(page, 'somchai', 'archived')).visible).toEqual([]);
    expect((await ownerRun(page, 'daeng', 'active')).visible).toEqual(['o2']);
    expect((await ownerRun(page, 'daeng', 'draft')).visible).toEqual([]);
    expect((await ownerRun(page, 'ຈຳປາ', 'archived')).visible).toEqual(['o3']);
    expect((await ownerRun(page, 'ຈຳປາ', 'active')).visible).toEqual([]);
    expect((await ownerRun(page, '小龙', 'draft')).visible).toEqual(['o5']);         // owner-role contact on a draft
    expect((await ownerRun(page, '小龙', 'archived')).visible).toEqual([]);
    expect((await ownerRun(page, 'sihalath', 'active')).visible).toEqual(['o4']);
  });
  test('the count label reflects owner matches', async ({ page }) => {
    const r = await ownerRun(page, 'somchai');
    expect(r.count).toBe('1 of ' + OWNER_LISTINGS.length + ' listings');
  });
});

test.describe('owner-name search: existing behaviour unchanged', () => {
  test('title, location, agent, price and phone searches give the same rows and chips as before', async ({ page }) => {
    await boot(page);                                                   // the original 4-listing fixture
    const t = await run(page, 'tower', 'all');          expect(t.visible).toEqual(['p4']); expect(t.reasons.p4).toBe('');          // title: no chip
    const l = await run(page, 'chanthabouly', 'all');   expect(l.visible).toEqual(['p2']); expect(l.reasons.p2).toBe('location');
    const a = await run(page, 'somphone', 'all');       expect(a.visible.sort()).toEqual(['p1', 'p3']); expect(a.reasons.p1).toBe('agent');
    const pr = await run(page, '$500', 'all');          expect(pr.visible).toEqual(['p1']); expect(pr.reasons.p1).toBe('price');
    const ph = await run(page, '555123', 'all');        expect(ph.visible).toEqual(['p4']); expect(ph.reasons.p4).toBe('phone');
    const ow = await run(page, 'mr owner', 'all');      expect(ow.visible).toEqual(['p4']); expect(ow.reasons.p4).toBe('owner');
  });
  test('priority is unchanged: a title hit keeps no chip even if an owner also matches', async ({ page }) => {
    const L = [{ id: 'x1', title_en: 'Somchai Residence', district_en: 'A', village_en: 'B', workflow_status: 'active', owners: { name: 'Somchai Phom' }, price_display: '$1' }];
    await boot(page, L);
    const r = await run(page, 'somchai', 'all');
    expect(r.visible).toEqual(['x1']);
    expect(r.reasons.x1).toBe('');
  });
  test('searching an owner does not make unrelated listings appear', async ({ page }) => {
    const r = await ownerRun(page, 'somchai phommachanh');
    expect(r.visible).toEqual(['o1']);
    const all = await ownerRun(page, '', 'all');
    expect(all.visible.length).toBe(OWNER_LISTINGS.length);
  });
});

// ── Phone search: internal owner + owner-role contacts, country-code / trunk-zero tolerant ─────────────────────────
// 'phone'           = the INTERNAL owners record's phone / WhatsApp (existing label)
// 'phone (contact)' = the phone / WhatsApp of a buyer contact whose role is exactly 'owner' (legacy contacts embed or a
//                     property_contacts row). Agent / reception / every other role is never matched by number.
// Numbers are compared as digits (spaces, hyphens, parentheses, dots, + ignored) and ALSO with the country code (856 /
// 00856) and one trunk zero removed, so "+856 20 5551 2345" == "020 5551 2345". A query needs >= 3 digits, and >= 3
// meaningful digits after the country code / zero are stripped for the tolerant comparison.
const PHONE_LISTINGS = [
  { id: 'ph1', title_en: 'Phone One',   district_en: 'A1', village_en: 'B1', workflow_status: 'draft',    owners: { name: 'Ann', phone: '+856 20 5551 2345', whatsapp: '020-9900-1122' }, price_display: '$11' },
  { id: 'ph2', title_en: 'Phone Two',   district_en: 'A2', village_en: 'B2', workflow_status: 'active',   owners: { name: 'Bob', phone: '020 7777 8888', whatsapp: '' }, price_display: '$12' },
  { id: 'ph3', title_en: 'Phone Three', district_en: 'A3', village_en: 'B3', workflow_status: 'archived', owners: null, contacts: { role: 'owner', name: 'Cat', phone: '(020) 4444-3333', whatsapp: '+856 30 222 1111' }, price_display: '$13' },
  { id: 'ph4', title_en: 'Phone Four',  district_en: 'A4', village_en: 'B4', workflow_status: 'active',   owners: null, contacts: null,
    property_contacts: [{ contacts: { role: 'owner', name: 'Dan', phone: '00856 20 6666 5555', whatsapp: null } }, { contacts: { role: 'agent', name: 'Agt', phone: '020 1212 3434', whatsapp: '030 5656 7878' } }], price_display: '$14' },
  { id: 'ph5', title_en: 'Phone Five',  district_en: 'A5', village_en: 'B5', workflow_status: 'draft',    owners: null, contacts: { role: 'agent', name: 'Agent Five', phone: '020 9191 9292', whatsapp: '020 8181 8282' },
    property_contacts: [{ contacts: { role: 'reception', name: 'R', phone: '020 3131 3232', whatsapp: '020 3232 3131' } }, { contacts: { role: 'property_manager', name: 'P', phone: '020 4141 4242', whatsapp: null } },
      { contacts: { role: 'other', name: 'O', phone: '020 5151 5252', whatsapp: null } }, { contacts: { role: 'sales_office', name: 'S', phone: '020 6161 6262', whatsapp: null } },
      { contacts: { role: 'developer', name: 'D', phone: '020 7171 7272', whatsapp: null } }, { contacts: { role: 'family_representative', name: 'F', phone: '020 8282 8383', whatsapp: null } }], price_display: '$15' },
  { id: 'ph6', title_en: 'Phone Six',   district_en: 'A6', village_en: 'B6', workflow_status: 'archived', owners: null,
    property_contacts: [{ contacts: { role: 'owner', name: 'Eve', phone: null, whatsapp: '856 20 3030 4040' } }], price_display: '$16' },
  { id: 'ph7', title_en: 'Phone Seven', district_en: 'A7', village_en: 'B7', workflow_status: 'active',   owners: null, price_display: '$17' },
  { id: 'ph8', title_en: 'Phone Eight', district_en: 'A8', village_en: 'B8', workflow_status: 'active',   owners: null, contacts: { role: 'owner', name: 'Gus', phone: 208889999, whatsapp: undefined },
    property_contacts: [null, { contacts: null }, { contacts: { role: 'owner', name: null, phone: null, whatsapp: null } }, 'x'], price_display: '$18' },
];
const phoneRun = async (page, q, status) => { await boot(page, PHONE_LISTINGS); return run(page, q, status || 'all'); };
const ids = async (page, q, status) => (await phoneRun(page, q, status)).visible;

test.describe('phone helpers (_phoneCanon / _phoneSearchMatch)', () => {
  test('canonical form: country code and one trunk zero removed, all formatting ignored', async ({ page }) => {
    await boot(page);
    const out = await page.evaluate(() => ['+856 20 5551 2345', '00856-20-55512345', '856 20 5551 2345', '020 5551 2345', '(20) 5551-2345', '20.5551.2345', '2055512345', '0', '', null, undefined, 205551234, '00', '+856']
      .map((v) => _phoneCanon(v)));
    expect(out).toEqual(['2055512345', '2055512345', '2055512345', '2055512345', '2055512345', '2055512345', '2055512345', '', '', '', '', '205551234', '0', '']);   // only ONE trunk zero is stripped ("00" -> "0")
  });
  test('match rules: >= 3 digits; tolerant comparison needs >= 3 digits AFTER stripping; either direction', async ({ page }) => {
    await boot(page);
    const m = await page.evaluate(() => {
      const t = (stored, q) => _phoneSearchMatch(stored, q);
      return {
        existing: t('020 5551 2345', '5551'), existingExactDigits: t('020 5551 2345', '02055512345'),
        intlQueryLocalStored: t('020 5551 2345', '+856 20 5551 2345'), localQueryIntlStored: t('+856 20 5551 2345', '020 5551 2345'),
        zeroZeroForms: t('00856 20 5551 2345', '020-5551-2345'), parens: t('+856 20 5551 2345', '(020) 5551'),
        partialAfterStrip: t('+856 20 5551 2345', '020 5551'),
        twoDigits: t('020 5551 2345', '20'), oneDigit: t('020 5551 2345', '5'), empty: t('020 5551 2345', ''), noStored: t('', '5551'), nullStored: t(null, '5551'),
        justCountryCode: t('+856 20 5551 2345', '+856'), justZeroPrefix: t('+856 20 5551 2345', '020'),
        afterStripTooShort: t('+856 20 5551 2345', '+856 20'), wrong: t('020 5551 2345', '020 5552'), letters: t('020 5551 2345', 'abc'),
      };
    });
    expect(m).toEqual({
      existing: true, existingExactDigits: true,
      intlQueryLocalStored: true, localQueryIntlStored: true, zeroZeroForms: true, parens: true, partialAfterStrip: true,
      twoDigits: false, oneDigit: false, empty: false, noStored: false, nullStored: false,
      justCountryCode: true,                 // 3 raw digits "856" appear in the stored digits: the EXISTING behaviour, unchanged
      justZeroPrefix: false,                 // "020" is not a raw substring of "856205551 2345", and only 2 digits remain after the zero: no tolerant match
      afterStripTooShort: true,              // "+856 20" = raw "85620": the existing raw substring test still applies
      wrong: false, letters: false,
    });
  });
});

test.describe('phone search: internal owner record (existing label "phone"), now country-code tolerant', () => {
  test('every common formatting of the stored number finds the listing', async ({ page }) => {
    for (const q of ['5551 2345', '55512345', '(20) 5551', '+856 20 5551 2345', '020 5551 2345', '020-5551-2345', '00856 20 5551 2345', '856205551234', '+856-20-5551-2345', '020.5551.2345']) {
      const r = await phoneRun(page, q);
      expect(r.visible, q).toEqual(['ph1']);
      expect(r.reasons.ph1, q).toBe('phone');
    }
  });
  test('WhatsApp of the internal owner, local and international forms', async ({ page }) => {
    for (const q of ['9900 1122', '020 9900 1122', '+856 20 9900 1122']) {
      const r = await phoneRun(page, q);
      expect(r.visible, q).toEqual(['ph1']);
      expect(r.reasons.ph1).toBe('phone');
    }
  });
  test('a local stored number is found by the international query and vice versa', async ({ page }) => {
    expect((await ids(page, '+856 20 7777 8888'))).toEqual(['ph2']);
    expect((await ids(page, '00856-20-77778888'))).toEqual(['ph2']);
    expect((await ids(page, '020 7777'))).toEqual(['ph2']);
  });
  test('a different number does not match', async ({ page }) => {
    expect(await ids(page, '020 5551 2346')).toEqual([]);
    expect(await ids(page, '+856 20 0000 0000')).toEqual([]);
  });
});

test.describe('phone search: owner-role contacts (label "phone (contact)")', () => {
  test('legacy contact with role owner: phone and WhatsApp, any formatting', async ({ page }) => {
    for (const q of ['4444 3333', '020 4444 3333', '(020) 4444-3333', '+856 20 4444 3333', '030 222 1111', '+856 30 222 1111', '00856 30 222 1111']) {
      const r = await phoneRun(page, q);
      expect(r.visible, q).toEqual(['ph3']);
      expect(r.reasons.ph3, q).toBe('phone (contact)');
    }
  });
  test('property_contacts row with role owner: phone (stored with 00856) in local / international / partial forms', async ({ page }) => {
    for (const q of ['6666 5555', '020 6666 5555', '+856 20 6666 5555', '00856 20 6666 5555', '2066665555', '020 6666']) {
      const r = await phoneRun(page, q);
      expect(r.visible, q).toEqual(['ph4']);
      expect(r.reasons.ph4, q).toBe('phone (contact)');
    }
  });
  test('an owner-role contact with ONLY a WhatsApp number (phone null)', async ({ page }) => {
    for (const q of ['3030 4040', '020 3030 4040', '+856 20 3030 4040']) {
      const r = await phoneRun(page, q);
      expect(r.visible, q).toEqual(['ph6']);
      expect(r.reasons.ph6).toBe('phone (contact)');
    }
  });
  test('a numeric phone value, null names and null phones never throw', async ({ page }) => {
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    expect(await ids(page, '8889 999')).toEqual(['ph8']);
    expect(await ids(page, '99999999')).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('phone search: contacts with any OTHER role are never matched by number', () => {
  test('agent / reception / property_manager / other / sales_office / developer / family_representative', async ({ page }) => {
    for (const q of ['1212 3434', '020 1212 3434', '+856 20 1212 3434', '5656 7878', '030 5656 7878',      // agent on ph4 (an owner-role contact sits on the same listing)
                     '9191 9292', '8181 8282', '020 3131 3232', '3232 3131', '4141 4242', '5151 5252', '6161 6262', '7171 7272', '8282 8383']) {
      expect(await ids(page, q), q).toEqual([]);
    }
  });
  test('the owner-role contact on the same listing as an agent is still found, and only for its own number', async ({ page }) => {
    expect(await ids(page, '6666 5555')).toEqual(['ph4']);
    expect(await ids(page, '1212 3434')).toEqual([]);
  });
});

test.describe('phone search: the 3-digit minimum', () => {
  test('1 or 2 digits never trigger phone search', async ({ page }) => {
    // (digits can still hit a title / price / district by the existing plain-text search; what must never happen is a PHONE match)
    for (const q of ['5', '55', '20', '+8', '0 2', '(2)', '85', '6', '66']) {
      const r = await phoneRun(page, q);
      Object.values(r.reasons).forEach((label) => expect(['phone', 'phone (contact)'], q).not.toContain(label));
    }
  });
  test('3 raw digits still work exactly as before (existing behaviour), e.g. "555" and "856"', async ({ page }) => {
    expect((await ids(page, '555')).sort()).toEqual(['ph1', 'ph4']);
    expect((await ids(page, '856')).sort()).toEqual(['ph1', 'ph3', 'ph4', 'ph6']);
  });
  test('"020" alone adds no tolerant match: only numbers that literally contain 020 (internationally stored ones are not found by it)', async ({ page }) => {
    const v = await ids(page, '020');
    expect(v.includes('ph4')).toBe(false);                       // stored 00856 20 6666 5555: no literal "020"
    expect(v.includes('ph2')).toBe(true);                        // stored 020 7777 8888
  });
  test('the tolerant comparison needs 3 digits after stripping: "+856 20" finds only literal "85620" numbers', async ({ page }) => {
    const v = (await ids(page, '+856 20')).sort();
    expect(v).toEqual(['ph1', 'ph4', 'ph6']);
  });
});

test.describe('phone search: statuses and existing labels', () => {
  test('internal-owner and contact phone matches respect the status filter (draft / published / archived)', async ({ page }) => {
    expect(await ids(page, '5551 2345', 'draft')).toEqual(['ph1']);
    expect(await ids(page, '5551 2345', 'active')).toEqual([]);
    expect(await ids(page, '7777 8888', 'active')).toEqual(['ph2']);
    expect(await ids(page, '7777 8888', 'archived')).toEqual([]);
    expect(await ids(page, '4444 3333', 'archived')).toEqual(['ph3']);
    expect(await ids(page, '4444 3333', 'draft')).toEqual([]);
    expect(await ids(page, '6666 5555', 'active')).toEqual(['ph4']);
    expect(await ids(page, '3030 4040', 'archived')).toEqual(['ph6']);
    expect(await ids(page, '3030 4040', 'active')).toEqual([]);
  });
  test('labels stay distinct: phone / phone (contact) / owner (contact) / owner', async ({ page }) => {
    expect((await phoneRun(page, '5551 2345')).reasons.ph1).toBe('phone');
    expect((await phoneRun(page, '4444 3333')).reasons.ph3).toBe('phone (contact)');
    expect((await phoneRun(page, 'cat')).reasons.ph3).toBe('owner (contact)');
    expect((await phoneRun(page, 'ann')).reasons.ph1).toBe('owner');
  });
  test('owner-name search is unchanged next to phone listings', async ({ page }) => {
    expect(await ids(page, 'dan')).toEqual(['ph4']);
    expect(await ids(page, 'agt')).toEqual([]);                 // agent-role name
    expect(await ids(page, 'bob')).toEqual(['ph2']);
  });
});

// ── Differential: the new filterListings vs the version merged in #151 ──────────────────────────────────────────────
// For a large generated set of queries x status filters, EVERY row the old version showed must still be shown with the
// SAME label; any newly shown row must be a phone / phone (contact) hit. (The old version is a frozen copy in fixtures/.)
test.describe('differential: nothing that matched before is lost or relabelled', () => {
  test('old (#151) vs new over generated queries and all four status filters', async ({ page }) => {
    const OLD_SRC = fs.readFileSync(path.join(__dirname, 'fixtures', 'filterListings.before-contact-phone.js'), 'utf8').replace(/^\/\/.*$/gm, '');
    const ALL = LISTINGS.concat(OWNER_LISTINGS, PHONE_LISTINGS);
    const queries = new Set(['', '  ', 'x', '$', '$500', '500', '300', 'tower', 'TOWER', 'villa', 'sisattanak', 'ban', 'daeng', 'somphone', 'acme', 'owner', 'mr owner', '555123', '020', '856', '+856', '20', '0', '.', '...']);
    const addVals = (v) => { if (v == null) return; const t = String(v); queries.add(t); t.split(/\s+/).forEach((w) => { if (w) { queries.add(w); for (let k = 1; k <= Math.min(4, w.length); k++) { queries.add(w.slice(0, k)); queries.add(w.slice(-k)); } } }); };
    ALL.forEach((p) => { [p.title_en, p.district_en, p.village_en, p.price_display].forEach(addVals);
      if (p.owners) [p.owners.name, p.owners.phone, p.owners.whatsapp].forEach(addVals);
      [p.contacts].concat((Array.isArray(p.property_contacts) ? p.property_contacts : []).map((x) => x && x.contacts)).forEach((c) => { if (c && typeof c === 'object') [c.name, c.phone, c.whatsapp].forEach(addVals); }); });
    AGENTS.forEach((a) => [a.name_en, a.name_lo, a.agency_name].forEach(addVals));
    // phone variants of every stored number
    ['+856 20 5551 2345', '020 5551 2345', '00856 20 5551 2345', '(20) 5551-2345', '2055512345', '020 6666', '+856 20 6666 5555', '030 222 1111'].forEach((q) => queries.add(q));
    const res = await page.evaluate(({ oldSrc, newSrc, helpers, agents, listings, queries }) => {
      const mkRun = (src) => (q, st) => {
        document.body.innerHTML = '<input id="listings-search"><select id="listings-status-filter"><option value="all">a</option><option value="draft">d</option><option value="active">p</option><option value="archived">r</option></select><span id="listings-search-count"></span><table class="listings-table"><tbody>' + listings.map((p) => '<tr data-property-id="' + p.id + '"><td><span class="match-why"></span></td></tr>').join('') + '</tbody></table>';
        window._agentsAll = agents; window._listingsAll = listings;
        (0, eval)(helpers); (0, eval)(src);
        document.getElementById('listings-search').value = q; document.getElementById('listings-status-filter').value = st;
        window.filterListings();
        const out = {}; document.querySelectorAll('.listings-table tbody tr').forEach((t) => { if (t.style.display !== 'none') out[t.dataset.propertyId] = t.querySelector('.match-why').textContent; });
        return out;
      };
      const runOld = mkRun(oldSrc), runNew = mkRun(newSrc);
      const problems = []; let added = 0, total = 0;
      const labels = {};
      for (const q of queries) for (const st of ['all', 'draft', 'active', 'archived']) {
        total++;
        const a = runOld(q, st), b = runNew(q, st);
        for (const id of Object.keys(a)) { if (!(id in b)) problems.push(['LOST', q, st, id]); else if (a[id] !== b[id]) problems.push(['RELABELLED', q, st, id, a[id], b[id]]); }
        for (const id of Object.keys(b)) if (!(id in a)) { added++; labels[b[id]] = (labels[b[id]] || 0) + 1; if (b[id] !== 'phone' && b[id] !== 'phone (contact)') problems.push(['NEW_NON_PHONE', q, st, id, b[id]]); if (_digitsOnly(q).length < 3) problems.push(['NEW_UNDER_3_DIGITS', q, st, id]); }
      }
      return { problems: problems.slice(0, 10), nProblems: problems.length, added, total, labels };
    }, { oldSrc: OLD_SRC, newSrc: filterListings, helpers: [digitsOnly, normalizeText, nameMatch, phoneCanon, phoneMatch].join('\n'), agents: AGENTS, listings: ALL, queries: [...queries] });
    expect(res.problems).toEqual([]);
    expect(res.nProblems).toBe(0);
    expect(res.total).toBeGreaterThan(800);
    expect(res.added).toBeGreaterThan(0);                                     // the new feature does add matches...
    expect(Object.keys(res.labels).sort()).toEqual(['phone', 'phone (contact)']);   // ...and only phone ones
  });
});
