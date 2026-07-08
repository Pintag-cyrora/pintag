// Generates dashboard/intelligence.html — the Intelligence Department's
// control center (Dashboard + Explorer combined, see
// departments/intelligence/PLAYBOOK.md §16). A self-contained static file,
// same "single file, no build step, open it locally or host it anywhere
// static" pattern as dashboard/index.html — except this one embeds a data
// snapshot at generation time instead of calling a live Supabase project,
// since knowledge/ has no database backing it yet (that's the K2 roadmap
// track in ARCHITECTURE.md §11, deliberately not built).
//
// Run: npm run knowledge:dashboard
// Re-run any time to refresh the snapshot — this file is generated, not
// hand-edited.

import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from './lib/config.js';
import { loadAllKnowledgeEntries, relativeKnowledgePath, isWritableEntry, type KnowledgeEntry } from './lib/knowledge.js';

function gitHistory(filePath: string): string[] {
  try {
    const relPath = relative(REPO_ROOT, filePath);
    const out = execSync(`git log --follow --oneline -- ${JSON.stringify(relPath)}`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).slice(0, 10);
  } catch {
    return [];
  }
}

function currentMaturityLevel(): string {
  try {
    const playbook = readFileSync(join(REPO_ROOT, 'departments', 'intelligence', 'PLAYBOOK.md'), 'utf-8');
    const match = playbook.match(/\*\*Current level:\s*([^*]+)\*\*/);
    return match ? match[1].trim() : 'Unknown — see departments/intelligence/PLAYBOOK.md';
  } catch {
    return 'Unknown — departments/intelligence/PLAYBOOK.md not found';
  }
}

function buildSnapshot() {
  const entries = loadAllKnowledgeEntries();

  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = { 'knowledge/': 0, 'brain/lao/': 0 };
  const byCreatedDate: Record<string, number> = {};

  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    bySource[isWritableEntry(e) ? 'knowledge/' : 'brain/lao/']++;
    if (e.created) byCreatedDate[e.created] = (byCreatedDate[e.created] ?? 0) + 1;
  }

  const pendingReview = entries.filter((e) => e.status === 'draft' && isWritableEntry(e)).length;
  const recentlyApproved = entries
    .filter((e) => e.status === 'verified' || e.status === 'expert_reviewed')
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, 10);

  const entrySnapshots = entries.map((e) => ({
    id: e.id,
    title: e.title,
    category: e.category,
    status: e.status,
    confidence: e.confidence,
    tags: e.tags,
    source: e.source,
    contributedBy: e.contributedBy,
    created: e.created,
    updated: e.updated,
    relatedIds: e.relatedIds,
    supersededBy: e.supersededBy ?? null,
    reviewedBy: e.reviewedBy ?? null,
    reviewNotes: e.reviewNotes ?? null,
    body: e.body,
    path: relativeKnowledgePath(e),
    writable: isWritableEntry(e),
    history: gitHistory(e.filePath),
  }));

  return {
    generatedAt: new Date().toISOString(),
    maturityLevel: currentMaturityLevel(),
    kpis: {
      total: entries.length,
      byStatus,
      byCategory,
      bySource,
      byCreatedDate,
      pendingReview,
    },
    recentlyApprovedIds: recentlyApproved.map((e) => e.id),
    entries: entrySnapshots,
  };
}

function renderHtml(snapshot: ReturnType<typeof buildSnapshot>): string {
  const dataJson = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Intelligence Department — Control Center</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{--teal:#2D8C8C;--teal-light:#38A8A8;--teal-dim:rgba(45,140,140,0.08);--teal-border:rgba(45,140,140,0.22);
  --ink:#1A2428;--ink-soft:#3D5058;--ink-muted:#7A9098;--warm:#F7F3EC;--warm-deep:#EDE8E0;--white:#fff;
  --border:rgba(26,36,40,0.1);--green:#1E6B45;--red:#C0392B;--gold:#B8860B;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;background:var(--warm);color:var(--ink);line-height:1.6;}
.nav{background:var(--ink);padding:0 24px;height:52px;display:flex;align-items:center;justify-content:space-between;}
.nav-logo{font-size:16px;font-weight:600;color:#fff;}
.nav-logo span{color:var(--teal-light);}
.nav-meta{font-size:11px;color:rgba(255,255,255,0.4);}
.body{max-width:1000px;margin:0 auto;padding:28px 20px 64px;}
h1{font-size:22px;font-weight:600;margin-bottom:4px;}
.sub{font-size:13px;color:var(--ink-muted);margin-bottom:20px;}
.tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid var(--border);}
.tab{padding:10px 18px;font-size:13px;font-weight:500;cursor:pointer;color:var(--ink-muted);border-bottom:2px solid transparent;}
.tab.active{color:var(--teal);border-bottom-color:var(--teal);}
.view{display:none;}
.view.active{display:block;}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;}
.kpi{background:var(--white);border:1px solid var(--border);border-radius:6px;padding:16px;}
.kpi-num{font-size:26px;font-weight:700;color:var(--teal);}
.kpi-label{font-size:11px;color:var(--ink-muted);text-transform:uppercase;letter-spacing:0.06em;margin-top:2px;}
.card{background:var(--white);border:1px solid var(--border);border-radius:6px;padding:20px 22px;margin-bottom:16px;}
.card-title{font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:14px;}
.bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:13px;}
.bar-label{width:170px;flex-shrink:0;color:var(--ink-soft);}
.bar-track{flex:1;height:8px;background:var(--warm-deep);border-radius:4px;overflow:hidden;}
.bar-fill{height:100%;background:var(--teal);}
.bar-count{width:32px;text-align:right;font-weight:600;}
.controls{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;}
.controls input,.controls select{padding:8px 12px;border:1px solid var(--border);border-radius:4px;font-size:13px;font-family:inherit;background:var(--white);}
.controls input{flex:1;min-width:180px;}
.entry{border:1px solid var(--border);border-radius:6px;padding:14px 16px;margin-bottom:10px;cursor:pointer;}
.entry-top{display:flex;justify-content:space-between;align-items:center;gap:10px;}
.entry-title{font-weight:600;font-size:14px;}
.badge{font-size:10px;font-weight:600;padding:3px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.04em;}
.badge.draft{background:rgba(184,134,11,0.12);color:var(--gold);}
.badge.verified{background:rgba(30,107,69,0.12);color:var(--green);}
.badge.expert_reviewed{background:rgba(45,140,140,0.15);color:var(--teal);}
.badge.deprecated{background:rgba(192,57,43,0.1);color:var(--red);}
.entry-meta{font-size:12px;color:var(--ink-muted);margin-top:4px;}
.entry-detail{display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);font-size:13px;color:var(--ink-soft);white-space:pre-wrap;}
.entry.open .entry-detail{display:block;}
.history-list{margin-top:8px;font-size:11px;color:var(--ink-muted);font-family:monospace;}
.empty-note{font-size:13px;color:var(--ink-muted);font-style:italic;}
</style>
</head>
<body>
<div class="nav">
  <div class="nav-logo">Intelligence <span>Control Center</span></div>
  <div class="nav-meta" id="generated-at"></div>
</div>
<div class="body">
  <h1>Intelligence Department</h1>
  <div class="sub" id="maturity-line"></div>

  <div class="tabs">
    <div class="tab active" data-view="overview">Overview</div>
    <div class="tab" data-view="explore">Explore</div>
  </div>

  <div class="view active" id="view-overview">
    <div class="kpi-grid" id="kpi-grid"></div>
    <div class="card">
      <div class="card-title">By Category</div>
      <div id="by-category"></div>
    </div>
    <div class="card">
      <div class="card-title">By Source</div>
      <div id="by-source"></div>
    </div>
    <div class="card">
      <div class="card-title">Recently Approved</div>
      <div id="recently-approved"></div>
    </div>
  </div>

  <div class="view" id="view-explore">
    <div class="controls">
      <input type="text" id="search-input" placeholder="Search title, tags, body…">
      <select id="category-filter"><option value="">All categories</option></select>
      <select id="status-filter">
        <option value="">All statuses</option>
        <option value="draft">Draft</option>
        <option value="verified">Verified</option>
        <option value="expert_reviewed">Expert Reviewed</option>
        <option value="deprecated">Deprecated</option>
      </select>
    </div>
    <div id="entry-list"></div>
  </div>
</div>

<script id="knowledge-data" type="application/json">${dataJson}</script>
<script>
const DATA = JSON.parse(document.getElementById('knowledge-data').textContent);

document.getElementById('generated-at').textContent = 'Generated ' + new Date(DATA.generatedAt).toLocaleString();
document.getElementById('maturity-line').textContent = 'Department Maturity: ' + DATA.maturityLevel;

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('view-' + tab.dataset.view).classList.add('active');
  });
});

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- Overview ----
const kpiGrid = document.getElementById('kpi-grid');
const statusOrder = ['draft', 'verified', 'expert_reviewed', 'deprecated'];
kpiGrid.innerHTML = [
  { label: 'Total entries', num: DATA.kpis.total },
  { label: 'Pending review', num: DATA.kpis.pendingReview },
  ...statusOrder.map(s => ({ label: s.replace('_',' '), num: DATA.kpis.byStatus[s] || 0 }))
].map(k => \`<div class="kpi"><div class="kpi-num">\${k.num}</div><div class="kpi-label">\${escapeHtml(k.label)}</div></div>\`).join('');

function renderBars(el, obj) {
  const max = Math.max(1, ...Object.values(obj));
  const rows = Object.entries(obj).sort((a,b) => b[1]-a[1]);
  el.innerHTML = rows.length ? rows.map(([label, count]) => \`
    <div class="bar-row">
      <div class="bar-label">\${escapeHtml(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:\${(count/max)*100}%"></div></div>
      <div class="bar-count">\${count}</div>
    </div>\`).join('') : '<div class="empty-note">No data yet.</div>';
}
renderBars(document.getElementById('by-category'), DATA.kpis.byCategory);
renderBars(document.getElementById('by-source'), DATA.kpis.bySource);

const recent = DATA.recentlyApprovedIds.map(id => DATA.entries.find(e => e.id === id)).filter(Boolean);
document.getElementById('recently-approved').innerHTML = recent.length
  ? recent.map(e => \`<div class="entry-meta">\${escapeHtml(e.updated)} — <b>\${escapeHtml(e.title)}</b> (\${escapeHtml(e.category)})</div>\`).join('')
  : '<div class="empty-note">Nothing approved yet.</div>';

// ---- Explore ----
const categories = [...new Set(DATA.entries.map(e => e.category))].sort();
const categorySelect = document.getElementById('category-filter');
categories.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; categorySelect.appendChild(o); });

const entryList = document.getElementById('entry-list');
const searchInput = document.getElementById('search-input');
const statusFilter = document.getElementById('status-filter');

function renderEntries() {
  const q = searchInput.value.toLowerCase();
  const cat = categorySelect.value;
  const status = statusFilter.value;
  const filtered = DATA.entries.filter(e => {
    if (cat && e.category !== cat) return false;
    if (status && e.status !== status) return false;
    if (q && !(e.title.toLowerCase().includes(q) || e.tags.join(' ').toLowerCase().includes(q) || e.body.toLowerCase().includes(q))) return false;
    return true;
  });

  entryList.innerHTML = filtered.length ? filtered.map(e => \`
    <div class="entry" data-id="\${e.id}">
      <div class="entry-top">
        <div class="entry-title">\${escapeHtml(e.title)}</div>
        <span class="badge \${e.status}">\${escapeHtml(e.status.replace('_',' '))}</span>
      </div>
      <div class="entry-meta">\${escapeHtml(e.category)} · \${escapeHtml(e.tags.join(', '))} · confidence \${e.confidence} · \${e.writable ? 'knowledge/' : 'brain/lao/'}</div>
      <div class="entry-detail">
        <div>\${escapeHtml(e.body)}</div>
        <div style="margin-top:10px;"><b>Source:</b> \${escapeHtml(e.source.type)} — \${escapeHtml(e.source.reference)}</div>
        <div><b>Contributed by:</b> \${escapeHtml(e.contributedBy)} · <b>Created:</b> \${escapeHtml(e.created)} · <b>Updated:</b> \${escapeHtml(e.updated)}</div>
        \${e.reviewedBy ? \`<div><b>Reviewed by:</b> \${escapeHtml(e.reviewedBy)}\${e.reviewNotes ? ' — ' + escapeHtml(e.reviewNotes) : ''}</div>\` : ''}
        \${e.relatedIds.length ? \`<div><b>Related:</b> \${escapeHtml(e.relatedIds.join(', '))}</div>\` : ''}
        \${e.supersededBy ? \`<div><b>Superseded by:</b> \${escapeHtml(e.supersededBy)}</div>\` : ''}
        <div class="history-list">\${e.history.length ? 'History:<br>' + e.history.map(escapeHtml).join('<br>') : 'No git history yet (uncommitted).'}</div>
      </div>
    </div>\`).join('') : '<div class="empty-note">No entries match.</div>';

  entryList.querySelectorAll('.entry').forEach(el => el.addEventListener('click', () => el.classList.toggle('open')));
}
[searchInput, categorySelect, statusFilter].forEach(el => el.addEventListener('input', renderEntries));
renderEntries();
</script>
</body>
</html>
`;
}

function main(): void {
  const snapshot = buildSnapshot();
  const outPath = join(REPO_ROOT, 'dashboard', 'intelligence.html');
  writeFileSync(outPath, renderHtml(snapshot), 'utf-8');
  console.log(`[Knowledge Dashboard] ${snapshot.kpis.total} entries snapshotted -> dashboard/intelligence.html`);
  console.log(`  by status: ${JSON.stringify(snapshot.kpis.byStatus)}`);
  console.log(`  pending review: ${snapshot.kpis.pendingReview}`);
}

main();
