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
  // Was: a raw page_views fetch capped at 10,000 rows, aggregated by
  // source/referrer/campaign in JS. analytics_traffic_sources() does the
  // same three GROUP BYs server-side and returns only the aggregated
  // result (source counts, top-10 referrer hosts, top-20 campaigns) --
  // kilobytes instead of a payload that grows with total traffic.
  const [trend, sources] = await Promise.all([
    sbRpc('analytics_traffic_by_day', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) }),
    sbRpc('analytics_traffic_sources', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) })
  ]);
  const rows = trend || [];
  const src = sources || {};

  const bySource = src.by_source || {};
  const sourceOrder = ['direct', 'google', 'facebook', 'instagram', 'tiktok', 'whatsapp', 'referral'];
  const sourceSlices = sourceOrder.filter(s => bySource[s]).map(s => ({ label: s.charAt(0).toUpperCase() + s.slice(1), value: bySource[s] }));

  const topReferrers = src.top_referrers || [];

  const campaignRows = (src.campaigns || []).map(c => ({ campaign: c.campaign, source: c.source, medium: c.medium, sessions: c.sessions }));
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
  // Was: a raw listing_events fetch capped at 20,000 rows plus the entire
  // active-properties catalog (limit 5000), joined and aggregated per
  // property_id in JS. analytics_listing_engagement() does the same
  // per-property GROUP BY + the view-by-day rollup + the title join
  // server-side, returning only the top-10 lists the UI renders. The 3
  // stat-tile counts stay as sbCount() -- those already use
  // Prefer:count=exact + Range:0-0, which downloads zero rows, so they
  // were never the bottleneck.
  const [engagement, waClicks, callClicks, agentClicks] = await Promise.all([
    sbRpc('analytics_listing_engagement', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) }),
    sbCount(`lead_events?select=id&event_type=eq.whatsapp_click&${range}`),
    sbCount(`lead_events?select=id&event_type=eq.call_click&${range}`),
    sbCount(`ui_events?select=id&element_id=eq.agent-profile-link&${range}`)
  ]);
  const eng = engagement || {};
  const mostViewed = eng.most_viewed || [];
  const ctrRows = eng.top_ctr || [];
  const savesTotal = eng.saves_total || 0;
  const sharesTotal = eng.shares_total || 0;
  // Share UX Improvement: "Share Rate = Shares / Listing Views" -- the
  // metric that tells us whether the redesigned, more prominent Share
  // button actually increases organic distribution. share_rate is NULL
  // (not 0) from the RPC when there have been zero views in the period,
  // so this shows "—" rather than a fabricated "0%".
  const shareRate = eng.share_rate != null ? eng.share_rate + '%' : '—';

  const byDay = {}; (eng.views_by_day || []).forEach(r => { byDay[r.day] = r.views; });
  const days = Object.keys(byDay).sort();
  _lastRows.listings = mostViewed;

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Listing Engagement') +
      '<div class="stat-grid">' +
        statCard('WhatsApp clicks', waClicks) + statCard('Call clicks', callClicks) +
        statCard('Favorites / Saves', savesTotal) + statCard('Shares', sharesTotal) +
        statCard('Share Rate', shareRate) +
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
  // Was: a raw search_events fetch capped at 20,000 rows, aggregated by
  // type/transaction/district in JS. analytics_search_breakdown() does
  // the same 3 GROUP BYs plus the zero-result count server-side.
  const b = (await sbRpc('analytics_search_breakdown', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) })) || {};
  const total = b.total || 0;
  const zeroResult = b.zero_result || 0;
  const typeRows = b.by_type || [];
  const txSlices = (b.by_tx || []).map(r => ({ label: r.label === 'for_rent' ? 'Rent' : r.label === 'for_sale' ? 'Sale' : r.label, value: r.value }));
  const byDistrict = {}; (b.by_district || []).forEach(r => { byDistrict[r.label] = r.value; });
  const hasDistrictData = (b.by_district || []).length > 0;

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
  // Was: three raw fetches (page_views, ui_events clicks, ui_events
  // scroll), each capped at 20,000 rows -- up to 60,000 rows downloaded
  // for one tab -- then a hand-rolled session-ordered walk in JS to derive
  // entry/exit pages and time-on-page. analytics_behavior() computes the
  // exact same thing with SQL window functions (ROW_NUMBER/LEAD partitioned
  // by session_id) plus 2 more GROUP BYs for scroll/clicks, all in one
  // round trip returning only the top-8/top-10 lists actually rendered.
  const [funnel, behavior] = await Promise.all([
    sbRpc('analytics_funnel', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) }),
    sbRpc('analytics_behavior', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) })
  ]);
  const beh = behavior || {};
  const entryRows = beh.entry || [];
  const exitRows = beh.exit || [];
  const avgDurationRows = beh.avg_duration || [];
  const scrollBuckets = Object.assign({ '25': 0, '50': 0, '75': 0, '100': 0 }, beh.scroll || {});
  const topClicks = beh.top_clicks || [];

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
  // Was: 4 fetches (leads limit 10000, the ENTIRE properties catalog limit
  // 5000, parties limit 1000, lead_events limit 10000), then a SECOND,
  // sequential fetch of up to 20,000 more page_views rows just to resolve
  // first-touch attribution for the leads already in hand -- up to ~46,000
  // rows for one tab, only to render 3 stat cards, 2 top-10 charts, a
  // donut, and a 50-row table. analytics_leads_breakdown() computes all of
  // it server-side in one call, including the first-touch join (a LATERAL
  // join per lead instead of pulling every candidate page_views row into
  // the browser), and returns only the most recent 50 leads for the table
  // -- not the whole range, matching what's actually displayed.
  const lb = (await sbRpc('analytics_leads_breakdown', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) })) || {};

  const total = lb.total || 0;
  const closed = lb.closed || 0;
  const byListingRows = lb.by_listing || [];
  const byAgentRows = lb.by_agent || [];

  const byDay = {}; (lb.by_day || []).forEach(r => { byDay[r.day] = r.value; });
  const days = Object.keys(byDay).sort();

  const sourceSlices = Object.entries(lb.by_source || {}).map(([label, value]) => ({ label: label.charAt(0).toUpperCase() + label.slice(1), value }));

  // Capped server-side at the 50 most recent leads in range -- the CSV
  // export below reflects exactly what's on screen, not a hidden larger
  // set (see the "Recent Leads" heading/filename, renamed from "All
  // Leads" for the same reason).
  _lastRows.leads = lb.recent || [];

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
    '<div class="section-block">' + sectionHeader('Recent Leads (up to 50)', "exportCsv('recent-leads.csv',['id','listing','agent','status','created_at'],_lastRows.leads)") +
      renderTable(['Listing', 'Agent', 'Status', 'Date'], _lastRows.leads || [], r => [r.listing, r.agent || '—', r.status, r.created_at.slice(0, 10)], 'No leads in this period yet.') +
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
  // Was: a raw page_views fetch capped at 20,000 rows, aggregated by
  // device/browser/os/lang in JS. analytics_location_breakdown() does the
  // same 4 GROUP BYs server-side.
  const loc = (await sbRpc('analytics_location_breakdown', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) })) || {};
  const byDevice = loc.device || {}, byBrowser = loc.browser || {}, byOs = loc.os || {}, byLang = loc.lang || {};
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
  // Was: sbCount for new listings (cheap, kept) plus the ENTIRE properties
  // catalog fetched unfiltered (limit 5000, every column) just to compute
  // "no views" / "high view, low convert" client-side, plus leads (limit
  // 10000), parties (limit 1000), and listing_events views (limit 20000)
  // -- none of it actually date-scoped except the leads. This payload grew
  // with total catalog + total leads ever recorded, not with the ~10 rows
  // per list the UI shows. analytics_admin_insights() computes every
  // GROUP BY/EXISTS check server-side and returns only the top-10/top-15
  // lists rendered below.
  const [newListings, insights] = await Promise.all([
    sbCount(`properties?select=id&${range}`),
    sbRpc('analytics_admin_insights', { p_start: fmtIso(_range.start), p_end: fmtIso(_range.end) })
  ]);
  const adm = insights || {};
  const activeAgentRows = adm.by_agent || [];
  const districtRows = adm.by_district || [];
  const typeRows = adm.by_type || [];
  const highViewLowConvert = adm.high_view_low_convert || [];

  _lastRows.noViews = adm.no_views || [];

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
      renderTable(['Listing', 'District', 'Type'], _lastRows.noViews || [], r => [r.title, r.district || '—', r.type || '—'], 'Every active listing has at least one view — nice.') +
    '</div>' +
    '<div class="section-block">' + sectionHeader('High Views, Low Conversion (≥20 views, 0 leads in range)') +
      '<div class="chart-card"><div id="ad-highlow-chart"></div></div>' +
    '</div>';

  PT_CHART.renderBarChart(document.getElementById('ad-agents-chart'), { rows: activeAgentRows, labelWidth: 120, emptyLabel: 'No leads yet.' });
  PT_CHART.renderBarChart(document.getElementById('ad-districts-chart'), { rows: districtRows, labelWidth: 120, emptyLabel: 'No leads yet.' });
  PT_CHART.renderBarChart(document.getElementById('ad-types-chart'), { rows: typeRows, labelWidth: 120, emptyLabel: 'No leads yet.' });
  PT_CHART.renderBarChart(document.getElementById('ad-highlow-chart'), { rows: highViewLowConvert, labelWidth: 150, emptyLabel: 'No listings currently match this pattern — good sign.' });
}
