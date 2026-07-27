// analytics.js — Pintag Analytics dashboard logic. Same auth-gate/REST-
// helper pattern as intelligence.js (this page's sibling staff tool).
//
// Data sources, all already covered by the existing event tables plus this
// migration's one new table (page_views) -- see analytics-tracking.js for
// what's captured client-side and 20260727000000_analytics_platform.sql
// for the new RPCs this page calls:
//   page_views        -- traffic, overview, behavior, location
//   search_events      -- search analytics
//   listing_events      -- listing analytics (views/impressions/clicks/save/share)
//   lead_events / leads  -- leads analytics
//   properties / parties -- admin insights
//
// Explicitly NOT built here, disclosed in the Location tab rather than
// faked: visitor country/city. No IP geolocation exists anywhere in this
// stack (every public page's CSP connect-src is locked to Supabase only,
// and nothing server-side reads geo headers today) -- see this page's own
// empty-state copy for the honest explanation and the real fix (a
// fetch-through Worker in front of every page, same shape as
// cloudflare-worker/og-listing-preview.js, not a client-side add-on).

const SUPABASE_URL  = window.PINTAG.supabaseUrl;
const SUPABASE_ANON = window.PINTAG.anonKey;
const ADMIN_EMAIL   = 'admin@pintag.io';
const sbClient      = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

let _adminToken = null;
sbClient.auth.onAuthStateChange((event, session) => { _adminToken = session ? session.access_token : null; });

async function login() {
  const pw  = document.getElementById('password-input').value;
  const btn = document.querySelector('.login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  const { data, error } = await sbClient.auth.signInWithPassword({ email: ADMIN_EMAIL, password: pw });
  btn.disabled = false; btn.textContent = 'Sign In';
  if (error) { document.getElementById('login-error').style.display = 'block'; return; }
  _adminToken = data.session.access_token;
  showAnScreen();
}
async function logout() { _adminToken = null; await sbClient.auth.signOut(); location.reload(); }
function showAnScreen() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('an-screen').style.display = 'block';
  setRange('7d');
  startLivePolling();
}
sbClient.auth.getSession().then(({ data: { session } }) => {
  if (session) { _adminToken = session.access_token; showAnScreen(); }
});

// ── REST / RPC helpers ───────────────────────────────────────────────
async function sbGet(path) {
  const token = _adminToken || SUPABASE_ANON;
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + token }
  });
  if (!res.ok) { console.error('[Analytics] REST error', path, res.status); return []; }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}
async function sbCount(path) {
  const token = _adminToken || SUPABASE_ANON;
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + token, Prefer: 'count=exact', Range: '0-0' }
  });
  if (!res.ok) return 0;
  const range = res.headers.get('content-range'); // "0-0/123"
  return range ? parseInt(range.split('/')[1], 10) || 0 : 0;
}
async function sbRpc(fn, params) {
  const token = _adminToken || SUPABASE_ANON;
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  if (!res.ok) { console.error('[Analytics] RPC error', fn, res.status, await res.text().catch(()=> '')); return null; }
  return res.json();
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Date range state ──────────────────────────────────────────────────
// p_end is always exclusive (the day AFTER the last included day) to match
// the RPC functions' own convention -- see the migration's own comment.
let _range = null;       // {start: Date, end: Date, label: string}
let _compareRange = null;
let _compareOn = false;
let _activeTab = 'overview';
const _cache = {}; // per-tab cache, keyed by tab+range signature, cleared on range change

function fmtIso(d) { return d.toISOString().slice(0, 10); }

function computeRange(preset) {
  const end = new Date(); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1); // exclusive, start of tomorrow
  const start = new Date(end);
  const days = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[preset] || 7;
  start.setDate(start.getDate() - days);
  return { start, end, label: preset === 'today' ? 'Today' : `Last ${days} days` };
}
function computeCompareRange(range) {
  const lengthMs = range.end - range.start;
  const end = new Date(range.start);
  const start = new Date(range.start.getTime() - lengthMs);
  return { start, end };
}

function setRange(preset) {
  document.querySelectorAll('.range-preset').forEach(b => b.classList.toggle('active', b.dataset.range === preset));
  _range = computeRange(preset);
  _compareRange = computeCompareRange(_range);
  document.getElementById('range-label').textContent =
    `${fmtIso(_range.start)} → ${fmtIso(new Date(_range.end - 86400000))}`;
  Object.keys(_cache).forEach(k => delete _cache[k]);
  loadTab(_activeTab);
}
function onCompareToggle() {
  _compareOn = document.getElementById('compare-toggle').checked;
  loadTab(_activeTab);
}

function switchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['overview','traffic','listings','search','behavior','leads','location','admin'].forEach(t => {
    document.getElementById('view-' + t).style.display = t === tab ? 'block' : 'none';
  });
  loadTab(tab);
}

const TAB_LOADERS = {
  overview: loadOverviewTab,
  traffic: loadTrafficTab,
  listings: loadListingsTab,
  search: loadSearchTab,
  behavior: loadBehaviorTab,
  leads: loadLeadsTab,
  location: loadLocationTab,
  admin: loadAdminTab
};
function loadTab(tab) {
  const el = document.getElementById('view-' + tab);
  if (!el.dataset.loaded || el.dataset.loaded !== rangeKey()) {
    el.innerHTML = '<div class="insp-loading">Loading…</div>';
    Promise.resolve(TAB_LOADERS[tab]()).then(() => { el.dataset.loaded = rangeKey(); }).catch(err => {
      console.error('[Analytics] tab load failed', tab, err);
      el.innerHTML = '<div class="an-empty">Something went wrong loading this section.</div>';
    });
  }
}
function rangeKey() { return fmtIso(_range.start) + '_' + fmtIso(_range.end) + '_' + _compareOn; }

// ── Small shared render helpers ──────────────────────────────────────
function pctDelta(cur, prev) {
  if (prev == null || prev === 0) return null;
  const pct = ((cur - prev) / prev) * 100;
  return { pct: pct, dir: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat' };
}
function deltaHtml(cur, prev) {
  if (!_compareOn || prev == null) return '';
  const d = pctDelta(cur, prev);
  if (!d) return '';
  const sign = d.pct > 0 ? '+' : '';
  return `<div class="stat-delta ${d.dir}">${sign}${d.pct.toFixed(1)}% vs prev</div>`;
}
function statCard(label, value, deltaCurrent, deltaPrev) {
  return `<div class="stat-card"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div>${deltaHtml(deltaCurrent, deltaPrev)}</div>`;
}
function sectionHeader(title, exportFn) {
  return `<div class="section-header"><h2>${esc(title)}</h2>${exportFn ? `<button class="export-btn" onclick="${exportFn}">⇩ Export CSV</button>` : ''}</div>`;
}
function fmtSeconds(s) {
  s = Math.round(s || 0);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

// ── CSV export ────────────────────────────────────────────────────────
function exportCsv(filename, headers, rows) {
  const escCsv = v => {
    v = v == null ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [headers.map(escCsv).join(',')].concat(rows.map(r => headers.map(h => escCsv(r[h])).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
// Stash the last-rendered rows per section so the export button can reach
// them without a second fetch -- set by each loadXTab() just before render.
const _lastRows = {};

// ══════════════════════════════════════════════════════════════════════
// LIVE STRIP — polls every 20s regardless of which tab is open
// ══════════════════════════════════════════════════════════════════════
let _liveTimer = null;
function startLivePolling() {
  refreshLive();
  if (_liveTimer) clearInterval(_liveTimer);
  _liveTimer = setInterval(refreshLive, 20000);
}
async function refreshLive() {
  const snap = await sbRpc('analytics_realtime_snapshot', { p_minutes: 5 });
  if (!snap) return;
  document.getElementById('live-visitors').textContent = snap.active_visitors || 0;
  document.getElementById('live-searches').textContent = snap.live_searches || 0;
  document.getElementById('live-views').textContent = snap.live_listing_views || 0;
  const pages = Object.entries(snap.pages_now || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  document.getElementById('live-pages').textContent = pages.length
    ? 'Now viewing: ' + pages.map(([p, c]) => `${p} (${c})`).join(', ')
    : '';
}

// ══════════════════════════════════════════════════════════════════════
// OVERVIEW TAB
// ══════════════════════════════════════════════════════════════════════
async function loadOverviewTab() {
  const el = document.getElementById('view-overview');
  const [stats, prevStats, trend] = await Promise.all([
    sbRpc('analytics_session_stats', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) }),
    _compareOn ? sbRpc('analytics_session_stats', { p_start: fmtIso(_compareRange.start), p_end: fmtIso(_compareRange.end) }) : null,
    sbRpc('analytics_traffic_by_day', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) })
  ]);
  const s = stats || {}, p = prevStats || {};

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Website Overview') +
      '<div class="stat-grid">' +
        statCard('Page views', PT_CHART.fmtNum(s.page_views || 0), s.page_views, p.page_views) +
        statCard('Unique visitors', PT_CHART.fmtNum(s.unique_visitors || 0), s.unique_visitors, p.unique_visitors) +
        statCard('Returning visitors', PT_CHART.fmtNum(s.returning_visitors || 0), s.returning_visitors, p.returning_visitors) +
        statCard('Sessions', PT_CHART.fmtNum(s.sessions || 0), s.sessions, p.sessions) +
        statCard('Avg session duration', fmtSeconds(s.avg_session_duration_seconds), s.avg_session_duration_seconds, p.avg_session_duration_seconds) +
        statCard('Bounce rate', (s.bounce_rate || 0) + '%', s.bounce_rate, p.bounce_rate) +
        statCard('Pages / session', s.avg_pages_per_session || 0, s.avg_pages_per_session, p.avg_pages_per_session) +
        statCard('Total visitors', PT_CHART.fmtNum(s.page_views || 0), s.page_views, p.page_views) +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Traffic Trend') +
      '<div class="chart-card"><div id="ov-trend-chart"></div></div>' +
    '</div>';

  const rows = trend || [];
  PT_CHART.renderLineChart(document.getElementById('ov-trend-chart'), {
    series: [
      { label: 'Page views', points: rows.map(r => ({ y: r.page_views })) },
      { label: 'Sessions', points: rows.map(r => ({ y: r.sessions })) }
    ],
    xLabels: rows.map(r => r.day.slice(5)),
    height: 240,
    ariaLabel: 'Page views and sessions over time'
  });
}

// ══════════════════════════════════════════════════════════════════════
// TRAFFIC TAB
// ══════════════════════════════════════════════════════════════════════
async function loadTrafficTab() {
  const el = document.getElementById('view-traffic');
  const [trend, pvRows] = await Promise.all([
    sbRpc('analytics_traffic_by_day', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) }),
    sbGet(`page_views?select=referrer,referrer_source,utm_source,utm_medium,utm_campaign,session_id&created_at=gte.${_range.start.toISOString()}&created_at=lt.${_range.end.toISOString()}&limit=10000`)
  ]);
  const rows = trend || [];
  const pv = pvRows || [];

  const bySource = {};
  pv.forEach(r => { bySource[r.referrer_source || 'direct'] = (bySource[r.referrer_source || 'direct'] || 0) + 1; });
  const sourceOrder = ['direct', 'google', 'facebook', 'instagram', 'tiktok', 'whatsapp', 'referral'];
  const sourceSlices = sourceOrder.filter(s => bySource[s]).map(s => ({ label: s.charAt(0).toUpperCase() + s.slice(1), value: bySource[s] }));

  const byReferrer = {};
  pv.forEach(r => {
    if (!r.referrer || r.referrer_source === 'direct') return;
    let host; try { host = new URL(r.referrer).hostname.replace(/^www\./, ''); } catch (e) { return; }
    byReferrer[host] = (byReferrer[host] || 0) + 1;
  });
  const topReferrers = Object.entries(byReferrer).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label, value }));

  const byCampaign = {};
  pv.forEach(r => {
    if (!r.utm_campaign) return;
    const key = r.utm_campaign + '|' + (r.utm_source || '') + '|' + (r.utm_medium || '');
    byCampaign[key] = byCampaign[key] || { campaign: r.utm_campaign, source: r.utm_source, medium: r.utm_medium, sessions: new Set() };
    byCampaign[key].sessions.add(r.session_id);
  });
  const campaignRows = Object.values(byCampaign).map(c => ({ campaign: c.campaign, source: c.source || '—', medium: c.medium || '—', sessions: c.sessions.size }));
  _lastRows.campaigns = campaignRows;

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Traffic Over Time') +
      '<div class="chart-card"><div id="tr-trend-chart"></div></div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Traffic Source') + `<div id="tr-source-chart"></div></div>` +
        '<div class="chart-card">' + sectionHeader('Top Referrers') + `<div id="tr-referrer-chart"></div></div>` +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('UTM Campaign Performance', "exportCsv('utm-campaigns.csv',['campaign','source','medium','sessions'],_lastRows.campaigns)") +
      renderTable(['Campaign', 'Source', 'Medium', 'Sessions'], campaignRows, r => [r.campaign, r.source, r.medium, r.sessions], 'No UTM-tagged traffic in this period yet.') +
    '</div>';

  PT_CHART.renderLineChart(document.getElementById('tr-trend-chart'), {
    series: [{ label: 'Page views', points: rows.map(r => ({ y: r.page_views })) }],
    xLabels: rows.map(r => r.day.slice(5)), height: 220, ariaLabel: 'Traffic over time'
  });
  PT_CHART.renderDonutChart(document.getElementById('tr-source-chart'), { slices: sourceSlices, size: 170, emptyLabel: 'No traffic yet.' });
  PT_CHART.renderBarChart(document.getElementById('tr-referrer-chart'), { rows: topReferrers, labelWidth: 120, emptyLabel: 'No external referrers yet — all traffic is direct/internal.' });
}

// ══════════════════════════════════════════════════════════════════════
// LISTINGS TAB
// ══════════════════════════════════════════════════════════════════════
async function loadListingsTab() {
  const el = document.getElementById('view-listings');
  const range = `created_at=gte.${_range.start.toISOString()}&created_at=lt.${_range.end.toISOString()}`;
  const [events, properties] = await Promise.all([
    sbGet(`listing_events?select=property_id,event_type,created_at&${range}&limit=20000`),
    sbGet('properties?select=id,title_en,title_lo&status=eq.active&limit=5000')
  ]);
  const titleOf = {}; (properties || []).forEach(p => { titleOf[p.id] = p.title_en || p.title_lo || p.id; });

  const counts = {}; // property_id -> {view,impression,click,save,share}
  const byDay = {};  // day -> view count
  (events || []).forEach(e => {
    if (!e.property_id) return;
    counts[e.property_id] = counts[e.property_id] || { view: 0, impression: 0, click: 0, save: 0, share: 0 };
    if (counts[e.property_id][e.event_type] != null) counts[e.property_id][e.event_type]++;
    if (e.event_type === 'view') {
      const day = e.created_at.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
  });

  const mostViewed = Object.entries(counts).map(([id, c]) => ({ label: titleOf[id] || id, value: c.view })).filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);
  const ctrRows = Object.entries(counts).filter(([, c]) => c.impression >= 5).map(([id, c]) => ({ label: titleOf[id] || id, value: Math.round((c.click / c.impression) * 1000) / 10 })).sort((a, b) => b.value - a.value).slice(0, 10);
  const savesTotal = Object.values(counts).reduce((a, c) => a + c.save, 0);
  const sharesTotal = Object.values(counts).reduce((a, c) => a + c.share, 0);

  const [waClicks, callClicks, agentClicks] = await Promise.all([
    sbCount(`lead_events?select=id&event_type=eq.whatsapp_click&${range}`),
    sbCount(`lead_events?select=id&event_type=eq.call_click&${range}`),
    sbCount(`ui_events?select=id&element_id=eq.agent-profile-link&${range}`)
  ]);

  const days = Object.keys(byDay).sort();
  _lastRows.listings = mostViewed;

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Listing Engagement') +
      '<div class="stat-grid">' +
        statCard('WhatsApp clicks', waClicks) + statCard('Call clicks', callClicks) +
        statCard('Favorites / Saves', savesTotal) + statCard('Shares', sharesTotal) +
        statCard('Agent profile clicks', agentClicks) +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Listing Views Over Time') +
      '<div class="chart-card"><div id="li-trend-chart"></div></div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Most Viewed Listings', "exportCsv('most-viewed-listings.csv',['label','value'],_lastRows.listings)") + '<div id="li-mostviewed-chart"></div></div>' +
        '<div class="chart-card">' + sectionHeader('Click-Through Rate (% , ≥5 impressions)') + '<div id="li-ctr-chart"></div></div>' +
      '</div>' +
    '</div>';

  PT_CHART.renderLineChart(document.getElementById('li-trend-chart'), {
    series: [{ label: 'Views', points: days.map(d => ({ y: byDay[d] })) }],
    xLabels: days.map(d => d.slice(5)), height: 200, ariaLabel: 'Listing views over time', emptyLabel: 'No listing views in this period yet.'
  });
  PT_CHART.renderBarChart(document.getElementById('li-mostviewed-chart'), { rows: mostViewed, labelWidth: 130 });
  PT_CHART.renderBarChart(document.getElementById('li-ctr-chart'), { rows: ctrRows, labelWidth: 130, emptyLabel: 'Not enough impression volume yet (≥5 needed per listing).' });
}

// ══════════════════════════════════════════════════════════════════════
// SEARCH TAB
// ══════════════════════════════════════════════════════════════════════
async function loadSearchTab() {
  const el = document.getElementById('view-search');
  const rows = await sbGet(`search_events?select=property_type,transaction_type,district,result_count,created_at&created_at=gte.${_range.start.toISOString()}&created_at=lt.${_range.end.toISOString()}&limit=20000`);
  const total = (rows || []).length;
  const zeroResult = (rows || []).filter(r => r.result_count === 0).length;
  const byType = {}, byTx = {}, byDistrict = {};
  (rows || []).forEach(r => {
    if (r.property_type) byType[r.property_type] = (byType[r.property_type] || 0) + 1;
    if (r.transaction_type) byTx[r.transaction_type] = (byTx[r.transaction_type] || 0) + 1;
    if (r.district) byDistrict[r.district] = (byDistrict[r.district] || 0) + 1;
  });
  const typeRows = Object.entries(byType).sort((a,b) => b[1]-a[1]).map(([label, value]) => ({ label, value }));
  const txSlices = Object.entries(byTx).map(([label, value]) => ({ label: label === 'for_rent' ? 'Rent' : label === 'for_sale' ? 'Sale' : label, value }));
  const hasDistrictData = Object.keys(byDistrict).length > 0;

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Search Analytics') +
      '<div class="stat-grid">' +
        statCard('Total searches', PT_CHART.fmtNum(total)) +
        statCard('Searches with no results', PT_CHART.fmtNum(zeroResult)) +
        statCard('Zero-result rate', total ? Math.round(zeroResult / total * 1000) / 10 + '%' : '0%') +
      '</div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Property Types Searched') + '<div id="se-type-chart"></div></div>' +
        '<div class="chart-card">' + sectionHeader('Rent vs Sale Searches') + '<div id="se-tx-chart"></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Districts Searched') +
      '<div class="chart-card">' +
        (hasDistrictData
          ? '<div id="se-district-chart"></div>'
          : '<div class="disclosure">No district data yet — listings.html doesn\'t currently have a district filter for buyers to search by (only Property Type and Buy/Rent). The <code>district</code> column exists in this table and will populate automatically the moment that filter ships; nothing here is faked in the meantime.</div>') +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Popular Search Terms') +
      '<div class="chart-card"><div class="disclosure">Pintag\'s search doesn\'t currently have a free-text keyword box (only structured Property Type / Buy‑Rent filters) — there is no search-term data to show. This section will populate automatically if/when a keyword search is added.</div></div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Price Range Searches') +
      '<div class="chart-card"><div class="disclosure">No price-range filter exists in the search UI yet, so <code>price_min</code>/<code>price_max</code> have no data to report. Same as Districts above — the schema is ready, the filter UI isn\'t built.</div></div>' +
    '</div>';

  PT_CHART.renderBarChart(document.getElementById('se-type-chart'), { rows: typeRows, labelWidth: 110, emptyLabel: 'No searches yet.' });
  PT_CHART.renderDonutChart(document.getElementById('se-tx-chart'), { slices: txSlices, size: 160, emptyLabel: 'No searches yet.' });
  if (hasDistrictData) {
    PT_CHART.renderBarChart(document.getElementById('se-district-chart'), { rows: Object.entries(byDistrict).sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label,value})), labelWidth: 120 });
  }
}

function renderTable(headers, rows, rowFn, emptyLabel) {
  if (!rows.length) return `<div class="chart-card"><div class="an-empty">${esc(emptyLabel || 'No data in this period yet.')}</div></div>`;
  return '<div class="chart-card" style="overflow-x:auto;"><table class="an-table"><thead><tr>' +
    headers.map(h => `<th>${esc(h)}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + rowFn(r).map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

// ══════════════════════════════════════════════════════════════════════
// BEHAVIOR TAB — journey funnel, entry/exit pages, scroll depth,
// time-on-page, click frequency ranking (this codebase's honest version
// of "heatmap data" -- no x/y click coordinates are captured, so this is
// a ranked-frequency view, not a spatial overlay; disclosed in the
// section copy rather than implied).
// ══════════════════════════════════════════════════════════════════════
async function loadBehaviorTab() {
  const el = document.getElementById('view-behavior');
  const range = `created_at=gte.${_range.start.toISOString()}&created_at=lt.${_range.end.toISOString()}`;
  const [funnel, pvRows, clickRows, scrollRows] = await Promise.all([
    sbRpc('analytics_funnel', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) }),
    sbGet(`page_views?select=session_id,page,created_at&${range}&order=session_id,created_at&limit=20000`),
    sbGet(`ui_events?select=element_id,element_type,label&event_type=eq.click&${range}&limit=20000`),
    sbGet(`ui_events?select=element_id&event_type=eq.scroll&${range}&limit=20000`)
  ]);

  // Entry/exit pages + time-on-page, all derived from one ordered pass over
  // each session's page_views (already ordered by session_id,created_at).
  const entryCounts = {}, exitCounts = {}, pageDurations = {}; // page -> [seconds]
  let curSession = null, sessionPages = [];
  function flushSession() {
    if (!sessionPages.length) return;
    entryCounts[sessionPages[0].page] = (entryCounts[sessionPages[0].page] || 0) + 1;
    exitCounts[sessionPages[sessionPages.length - 1].page] = (exitCounts[sessionPages[sessionPages.length - 1].page] || 0) + 1;
    for (let i = 0; i < sessionPages.length - 1; i++) {
      const secs = (new Date(sessionPages[i + 1].created_at) - new Date(sessionPages[i].created_at)) / 1000;
      if (secs >= 0 && secs < 3600) { // discard obvious outliers (tab left open overnight, etc.)
        (pageDurations[sessionPages[i].page] = pageDurations[sessionPages[i].page] || []).push(secs);
      }
    }
  }
  (pvRows || []).forEach(r => {
    if (r.session_id !== curSession) { flushSession(); curSession = r.session_id; sessionPages = []; }
    sessionPages.push(r);
  });
  flushSession();

  const entryRows = Object.entries(entryCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value }));
  const exitRows = Object.entries(exitCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value }));
  const avgDurationRows = Object.entries(pageDurations).map(([label, arr]) => ({ label, value: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) })).sort((a, b) => b.value - a.value).slice(0, 8);

  const scrollBuckets = { '25': 0, '50': 0, '75': 0, '100': 0 };
  (scrollRows || []).forEach(r => { if (scrollBuckets[r.element_id] != null) scrollBuckets[r.element_id]++; });

  const clickCounts = {};
  (clickRows || []).forEach(r => {
    const key = r.label || r.element_id;
    clickCounts[key] = (clickCounts[key] || 0) + 1;
  });
  const topClicks = Object.entries(clickCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label, value }));

  const f = {}; (funnel || []).forEach(row => { f[row.stage] = row.sessions; });
  const funnelRows = [
    { label: 'Landed', value: f.landed || 0 },
    { label: 'Searched', value: f.searched || 0 },
    { label: 'Viewed a listing', value: f.viewed_listing || 0 },
    { label: 'Contacted (WhatsApp/Call)', value: f.contacted || 0 },
    { label: 'Deal closed', value: f.closed || 0 }
  ];

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Conversion Funnel — Landing → Search → Listing → WhatsApp → Closed') +
      '<div class="chart-card"><div id="be-funnel-chart"></div>' +
      '<p class="disclosure">Each stage counts distinct SESSIONS that reached it, not raw event volume — a session that searched five times still counts once toward "Searched."</p></div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Entry Pages') + '<div id="be-entry-chart"></div></div>' +
        '<div class="chart-card">' + sectionHeader('Exit Pages') + '<div id="be-exit-chart"></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Avg Time on Page') + '<div id="be-duration-chart"></div></div>' +
        '<div class="chart-card">' + sectionHeader('Scroll Depth Reached') + '<div id="be-scroll-chart"></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Most-Clicked Elements') +
      '<div class="chart-card"><div id="be-click-chart"></div>' +
      '<p class="disclosure">Ranked by click frequency, not screen position — this codebase doesn\'t capture click x/y coordinates, so it can\'t render a true spatial heatmap image. This is the honest substitute: exactly which elements get engagement, ranked.</p></div>' +
    '</div>';

  PT_CHART.renderBarChart(document.getElementById('be-funnel-chart'), { rows: funnelRows, labelWidth: 190, color: PT_CHART.TEAL });
  PT_CHART.renderBarChart(document.getElementById('be-entry-chart'), { rows: entryRows, labelWidth: 110, emptyLabel: 'No sessions yet.' });
  PT_CHART.renderBarChart(document.getElementById('be-exit-chart'), { rows: exitRows, labelWidth: 110, emptyLabel: 'No sessions yet.' });
  PT_CHART.renderBarChart(document.getElementById('be-duration-chart'), {
    rows: avgDurationRows.map(r => ({ label: r.label, value: r.value })), labelWidth: 110,
    emptyLabel: 'Not enough multi-page sessions yet to estimate time-on-page.'
  });
  PT_CHART.renderDonutChart(document.getElementById('be-scroll-chart'), {
    slices: [25, 50, 75, 100].filter(m => scrollBuckets[m]).map(m => ({ label: m + '%', value: scrollBuckets[m] })),
    size: 160, emptyLabel: 'No scroll data yet.'
  });
  PT_CHART.renderBarChart(document.getElementById('be-click-chart'), { rows: topClicks, labelWidth: 160, emptyLabel: 'No tracked clicks yet.' });
}

// ══════════════════════════════════════════════════════════════════════
// LEADS TAB
// ══════════════════════════════════════════════════════════════════════
async function loadLeadsTab() {
  const el = document.getElementById('view-leads');
  const range = `created_at=gte.${_range.start.toISOString()}&created_at=lt.${_range.end.toISOString()}`;
  const [leads, properties, parties, leadEvents] = await Promise.all([
    sbGet(`leads?select=id,property_id,party_id,lead_event_id,status,created_at&${range}&limit=10000`),
    sbGet('properties?select=id,title_en,title_lo&limit=5000'),
    sbGet('parties?select=id,name_en&type=eq.agent&limit=1000'),
    sbGet(`lead_events?select=id,session_id&${range}&limit=10000`)
  ]);
  const titleOf = {}; (properties || []).forEach(p => { titleOf[p.id] = p.title_en || p.title_lo || p.id; });
  const nameOf = {}; (parties || []).forEach(p => { nameOf[p.id] = p.name_en || p.id; });
  const sessionOfLeadEvent = {}; (leadEvents || []).forEach(e => { sessionOfLeadEvent[e.id] = e.session_id; });

  const total = (leads || []).length;
  const closed = (leads || []).filter(l => l.status === 'closed').length;

  const byListing = {}, byAgent = {};
  (leads || []).forEach(l => {
    if (l.property_id) byListing[l.property_id] = (byListing[l.property_id] || 0) + 1;
    if (l.party_id) byAgent[l.party_id] = (byAgent[l.party_id] || 0) + 1;
  });
  const byListingRows = Object.entries(byListing).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, value]) => ({ label: titleOf[id] || id, value }));
  const byAgentRows = Object.entries(byAgent).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, value]) => ({ label: nameOf[id] || 'Unassigned', value }));

  // Leads by day
  const byDay = {};
  (leads || []).forEach(l => { const d = l.created_at.slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; });
  const days = Object.keys(byDay).sort();

  // Leads by source: first-touch referrer_source of the originating session,
  // via lead_event_id -> lead_events.session_id -> that session's earliest
  // page_view. Sessions with no page_views row (e.g. captured before this
  // migration shipped) fall into "unknown" rather than being dropped.
  const sessionIds = [...new Set(Object.values(sessionOfLeadEvent).filter(Boolean))];
  let sourceBySession = {};
  if (sessionIds.length) {
    const inList = sessionIds.map(s => `"${s}"`).join(',');
    const firstTouch = await sbGet(`page_views?select=session_id,referrer_source,created_at&session_id=in.(${inList})&order=session_id,created_at&limit=20000`);
    (firstTouch || []).forEach(r => { if (!sourceBySession[r.session_id]) sourceBySession[r.session_id] = r.referrer_source; });
  }
  const bySource = {};
  (leads || []).forEach(l => {
    const sess = sessionOfLeadEvent[l.lead_event_id];
    const src = (sess && sourceBySession[sess]) || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
  });
  const sourceSlices = Object.entries(bySource).map(([label, value]) => ({ label: label.charAt(0).toUpperCase() + label.slice(1), value }));

  _lastRows.leads = (leads || []).map(l => ({ id: l.id, listing: titleOf[l.property_id] || '', agent: nameOf[l.party_id] || '', status: l.status, created_at: l.created_at }));

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Leads') +
      '<div class="stat-grid">' +
        statCard('Total leads', total) +
        statCard('Closed deals', closed) +
        statCard('Conversion rate', total ? Math.round(closed / total * 1000) / 10 + '%' : '0%') +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Leads Over Time') + '<div class="chart-card"><div id="ld-trend-chart"></div></div></div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Leads by Listing') + '<div id="ld-listing-chart"></div></div>' +
        '<div class="chart-card">' + sectionHeader('Leads by Agent') + '<div id="ld-agent-chart"></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Leads by Source') +
      '<div class="chart-card"><div id="ld-source-chart"></div>' +
      '<p class="disclosure">First-touch attribution: the referrer source of the earliest page view in the same browser session that generated the lead.</p></div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('All Leads', "exportCsv('leads.csv',['id','listing','agent','status','created_at'],_lastRows.leads)") +
      renderTable(['Listing', 'Agent', 'Status', 'Date'], (_lastRows.leads || []).slice(0, 50), r => [r.listing, r.agent || '—', r.status, r.created_at.slice(0, 10)], 'No leads in this period yet.') +
    '</div>';

  PT_CHART.renderLineChart(document.getElementById('ld-trend-chart'), {
    series: [{ label: 'Leads', points: days.map(d => ({ y: byDay[d] })) }],
    xLabels: days.map(d => d.slice(5)), height: 200, emptyLabel: 'No leads in this period yet.'
  });
  PT_CHART.renderBarChart(document.getElementById('ld-listing-chart'), { rows: byListingRows, labelWidth: 130, emptyLabel: 'No leads yet.' });
  PT_CHART.renderBarChart(document.getElementById('ld-agent-chart'), { rows: byAgentRows, labelWidth: 130, emptyLabel: 'No leads yet.' });
  PT_CHART.renderDonutChart(document.getElementById('ld-source-chart'), { slices: sourceSlices, size: 170, emptyLabel: 'No leads yet.' });
}

// ══════════════════════════════════════════════════════════════════════
// LOCATION TAB — device/browser/OS/language are real; country/city are
// explicitly not built (disclosed, not faked) -- see this file's header.
// ══════════════════════════════════════════════════════════════════════
async function loadLocationTab() {
  const el = document.getElementById('view-location');
  const rows = await sbGet(`page_views?select=device_type,browser,os,lang&created_at=gte.${_range.start.toISOString()}&created_at=lt.${_range.end.toISOString()}&limit=20000`);
  const byDevice = {}, byBrowser = {}, byOs = {}, byLang = {};
  (rows || []).forEach(r => {
    if (r.device_type) byDevice[r.device_type] = (byDevice[r.device_type] || 0) + 1;
    if (r.browser) byBrowser[r.browser] = (byBrowser[r.browser] || 0) + 1;
    if (r.os) byOs[r.os] = (byOs[r.os] || 0) + 1;
    if (r.lang) byLang[r.lang] = (byLang[r.lang] || 0) + 1;
  });
  const langNames = { en: 'English', lo: 'Lao', zh: 'Chinese' };

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Visitor Location') +
      '<div class="chart-card"><div class="disclosure"><b>Country / city are not available.</b> This site has no IP-geolocation step anywhere in its stack — every public page\'s Content-Security-Policy locks outbound requests to Supabase only, and nothing server-side reads geo headers today. The honest way to add this is a fetch-through Cloudflare Worker in front of every page (the same pattern already built for OG link previews in <code>cloudflare-worker/og-listing-preview.js</code>, which has access to real client geo headers) — not a client-side add-on, and not a third-party IP-lookup API bolted on here, which would mean a new CSP exception, per-request cost, and a privacy tradeoff worth a real decision rather than a default. Flagging this clearly rather than shipping guessed data.</div></div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Language Used') + '<div id="lo-lang-chart"></div></div>' +
        '<div class="chart-card">' + sectionHeader('Device') + '<div id="lo-device-chart"></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Browser') + '<div id="lo-browser-chart"></div></div>' +
        '<div class="chart-card">' + sectionHeader('Operating System') + '<div id="lo-os-chart"></div></div>' +
      '</div>' +
    '</div>';

  PT_CHART.renderDonutChart(document.getElementById('lo-lang-chart'), { slices: Object.entries(byLang).map(([l, v]) => ({ label: langNames[l] || l, value: v })), size: 160, emptyLabel: 'No data yet.' });
  PT_CHART.renderDonutChart(document.getElementById('lo-device-chart'), { slices: Object.entries(byDevice).map(([l, v]) => ({ label: l.charAt(0).toUpperCase() + l.slice(1), value: v })), size: 160, emptyLabel: 'No data yet.' });
  PT_CHART.renderBarChart(document.getElementById('lo-browser-chart'), { rows: Object.entries(byBrowser).sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label,value})), labelWidth: 100, emptyLabel: 'No data yet.' });
  PT_CHART.renderBarChart(document.getElementById('lo-os-chart'), { rows: Object.entries(byOs).sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label,value})), labelWidth: 100, emptyLabel: 'No data yet.' });
}

// ══════════════════════════════════════════════════════════════════════
// ADMIN INSIGHTS TAB
// ══════════════════════════════════════════════════════════════════════
async function loadAdminTab() {
  const el = document.getElementById('view-admin');
  const range = `created_at=gte.${_range.start.toISOString()}&created_at=lt.${_range.end.toISOString()}`;
  const [newListings, allProperties, leads, parties, viewEvents] = await Promise.all([
    sbCount(`properties?select=id&${range}`),
    sbGet('properties?select=id,title_en,title_lo,district_en,property_type,managed_by_party_id,view_count,status&limit=5000'),
    sbGet(`leads?select=property_id,party_id&${range}&limit=10000`),
    sbGet('parties?select=id,name_en&type=eq.agent&limit=1000'),
    sbGet(`listing_events?select=property_id&event_type=eq.view&${range}&limit=20000`)
  ]);
  const nameOf = {}; (parties || []).forEach(p => { nameOf[p.id] = p.name_en || p.id; });
  const titleOf = {}; (allProperties || []).forEach(p => { titleOf[p.id] = p.title_en || p.title_lo || p.id; });

  const leadsByAgent = {}, leadsByDistrict = {}, leadsByType = {}, leadsByListing = {};
  const districtOf = {}, typeOf = {};
  (allProperties || []).forEach(p => { districtOf[p.id] = p.district_en; typeOf[p.id] = p.property_type; });
  (leads || []).forEach(l => {
    if (l.party_id) leadsByAgent[l.party_id] = (leadsByAgent[l.party_id] || 0) + 1;
    if (l.property_id) {
      leadsByListing[l.property_id] = (leadsByListing[l.property_id] || 0) + 1;
      const d = districtOf[l.property_id]; if (d) leadsByDistrict[d] = (leadsByDistrict[d] || 0) + 1;
      const t = typeOf[l.property_id]; if (t) leadsByType[t] = (leadsByType[t] || 0) + 1;
    }
  });
  const activeAgentRows = Object.entries(leadsByAgent).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, value]) => ({ label: nameOf[id] || 'Unassigned', value }));
  const districtRows = Object.entries(leadsByDistrict).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label, value }));
  const typeRows = Object.entries(leadsByType).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));

  const viewCountInRange = {};
  (viewEvents || []).forEach(e => { if (e.property_id) viewCountInRange[e.property_id] = (viewCountInRange[e.property_id] || 0) + 1; });

  const activeListings = (allProperties || []).filter(p => p.status === 'active');
  const noViews = activeListings.filter(p => !p.view_count || p.view_count === 0).slice(0, 15).map(p => ({ label: titleOf[p.id], value: 0 }));
  const highViewLowConvert = activeListings
    .filter(p => (p.view_count || 0) >= 20 && !leadsByListing[p.id])
    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
    .slice(0, 10)
    .map(p => ({ label: titleOf[p.id], value: p.view_count }));

  _lastRows.noViews = (allProperties || []).filter(p => p.status === 'active' && (!p.view_count || p.view_count === 0)).map(p => ({ title: titleOf[p.id], district: p.district_en, type: p.property_type }));

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Admin Insights') +
      '<div class="stat-grid">' + statCard('New listings added', newListings) + '</div>' +
    '</div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Most Active Agents (by leads)') + '<div id="ad-agents-chart"></div></div>' +
        '<div class="chart-card">' + sectionHeader('Top Performing Districts (by leads)') + '<div id="ad-districts-chart"></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Top Performing Property Types (by leads)') + '<div class="chart-card"><div id="ad-types-chart"></div></div></div>' +
    '<div class="section-block">' + sectionHeader('Listings With No Views', "exportCsv('no-view-listings.csv',['title','district','type'],_lastRows.noViews)") +
      renderTable(['Listing', 'District', 'Type'], (_lastRows.noViews || []).slice(0, 15), r => [r.title, r.district || '—', r.type || '—'], 'Every active listing has at least one view — nice.') +
    '</div>' +
    '<div class="section-block">' + sectionHeader('High Views, Low Conversion (≥20 views, 0 leads in range)') +
      '<div class="chart-card"><div id="ad-highlow-chart"></div></div>' +
    '</div>';

  PT_CHART.renderBarChart(document.getElementById('ad-agents-chart'), { rows: activeAgentRows, labelWidth: 120, emptyLabel: 'No leads yet.' });
  PT_CHART.renderBarChart(document.getElementById('ad-districts-chart'), { rows: districtRows, labelWidth: 120, emptyLabel: 'No leads yet.' });
  PT_CHART.renderBarChart(document.getElementById('ad-types-chart'), { rows: typeRows, labelWidth: 120, emptyLabel: 'No leads yet.' });
  PT_CHART.renderBarChart(document.getElementById('ad-highlow-chart'), { rows: highViewLowConvert, labelWidth: 150, emptyLabel: 'No listings currently match this pattern — good sign.' });
}
