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
  await page.evaluate(({ fL, dO, nT, nM, agents, listings }) => {
    window._agentsAll = agents;
    window._listingsAll = listings;
    // eslint-disable-next-line no-eval
    (0, eval)(dO); // _digitsOnly
    // eslint-disable-next-line no-eval
    (0, eval)(nT); // _normalizeSearchText
    // eslint-disable-next-line no-eval
    (0, eval)(nM); // _nameSearchMatch
    // eslint-disable-next-line no-eval
    (0, eval)(fL); // filterListings
  }, { fL: filterListings, dO: digitsOnly, nT: normalizeText, nM: nameMatch, agents: AGENTS, listings: L });
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
