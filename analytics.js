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
// Ranges (2026-09 rework): a range is two Asia/Vientiane calendar-date labels
// (laos-date.js), never browser-local Dates. Presets: Today / 7d / 30d / 90d /
// All time (from analytics_history_bounds()) / Custom. No RPC caps history;
// daily series are fetched in <=900-day chunks; every failure is shown as an
// error with Retry instead of zeros (analytics-core.js). The Leads tab drills
// down by day / listing through the keyset-paginated analytics_lead_activity().
// See supabase/migrations/20260921030000_* and 20260921040000_*.
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
const sbClient      = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// Unified administrator authentication — the SAME shared module every
// privileged Pintag page uses (admin-auth.js): only cyrora.trading@gmail.com,
// email + password + TOTP two-factor (AAL2), the session validated SERVER-SIDE
// on every page load. This replaces the old password-only legacy-admin-email
// login and the getSession() auto-login from a persisted localStorage session.
let _adminToken = null;
sbClient.auth.onAuthStateChange((event, session) => { _adminToken = session ? session.access_token : null; });
async function logout() { await PintagAdminAuth.logout(); }
function showAnScreen() {
  document.getElementById('an-screen').style.display = 'block';
  setRange('7d');
  startLivePolling();
}
// admin-auth.js injects its own login overlay, verifies an AAL2 cyrora session
// server-side, then calls bootAnalytics() exactly once.
async function bootAnalytics() {
  _adminToken = await PintagAdminAuth.token();
  showAnScreen();
}
PintagAdminAuth.protect(sbClient, bootAnalytics);

// ── RPC helper ──────────────────────────────────────────────────────
// Every failure THROWS a typed RpcError (see analytics-core.js). The old
// helper logged and returned null, and callers did `(await sbRpc(...)) || {}`,
// so a timeout or a denied session rendered as "0 leads / 0 views" -- wrong
// data that looks right. loadTab() now turns any thrown error into a visible
// error banner with a Retry button.
async function sbRpc(fn, params) {
  const token = _adminToken || SUPABASE_ANON;
  let res;
  try {
    res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {})
    });
  } catch (netErr) {
    throw PT_ANALYTICS_CORE.RpcError(fn, 'network', 0, String(netErr && netErr.message || netErr));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[Analytics] RPC error', fn, res.status, body);
    throw PT_ANALYTICS_CORE.classifyFailure(fn, res.status, body);
  }
  return res.json();
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Date range state ──────────────────────────────────────────────────
// A range is two calendar-date LABELS in Laos time ('YYYY-MM-DD'), never a
// Date: see laos-date.js for why (toISOString() shifted the requested day for
// any browser east of UTC). `endExclusive` is the day AFTER the last included
// day, the RPC contract. The server converts labels to instants with
// AT TIME ZONE 'Asia/Vientiane', so the browser's timezone can't matter.
const LAOS = PT_LAOS_DATE;
const CORE = PT_ANALYTICS_CORE;

let _range = null;        // {preset, start, endExclusive, label, text, days}
let _compareRange = null; // {start, endExclusive, beforeData} | null (All time)
let _compareOn = false;
let _activeTab = 'overview';
let _bounds = null;       // analytics_history_bounds(): earliest day + per-source first days
let _boundsPromise = null;
const _cache = {}; // per-tab cache, keyed by tab+range signature, cleared on range change

// {p_start, p_end} for any {start, endExclusive}-shaped range.
function rangeParams(r) { r = r || _range; return { p_start: r.start, p_end: r.endExclusive }; }

function ensureBounds() {
  if (_bounds) return Promise.resolve(_bounds);
  if (!_boundsPromise) {
    _boundsPromise = sbRpc('analytics_history_bounds', {}).then(b => { _bounds = b; return b; })
      .catch(e => { _boundsPromise = null; throw e; });
  }
  return _boundsPromise;
}
// First day a source has data (null while bounds are unknown / source empty).
function coverageStart(src) {
  return (_bounds && _bounds.sources && _bounds.sources[src] && _bounds.sources[src].first_day) || null;
}
// A short "tracking began" note when the range reaches before a source's first day.
function coverageNote(src, label) {
  const first = coverageStart(src);
  if (!first || !_range || _range.start >= first) return '';
  return '<p class="disclosure">' + esc(label) + ' has only been recorded since ' + esc(first) +
    '; earlier days are not shown because nothing was tracked then.</p>';
}

function showRangeError(err) {
  document.getElementById('range-error').innerHTML = CORE.errorBannerHtml(err.message || String(err), null);
}
function hideRangeError() { document.getElementById('range-error').innerHTML = ''; }

function setActivePreset(preset) {
  document.querySelectorAll('.range-preset').forEach(b => b.classList.toggle('active', b.dataset.range === preset));
}

async function setRange(preset) {
  hideRangeError();
  let range;
  try {
    if (preset === 'all') {
      const b = await ensureBounds();
      range = LAOS.presetRange('all', b.today || LAOS.todayLaos(), b.earliest_day);
    } else {
      range = LAOS.presetRange(preset, LAOS.todayLaos());
    }
  } catch (err) {
    // Never fall back to a guessed range: say what failed and keep the current view.
    showRangeError(err);
    return;
  }
  setCustomPanel(false);
  applyRange(range);
}

function applyRange(range) {
  _range = range;
  _compareRange = LAOS.compareRange(range, _bounds && _bounds.earliest_day);
  setActivePreset(range.preset);
  document.getElementById('range-label').textContent = range.label + ' · ' + range.text;
  const cmp = document.getElementById('compare-toggle');
  cmp.disabled = !_compareRange;
  if (!_compareRange && cmp.checked) { cmp.checked = false; _compareOn = false; }
  document.getElementById('compare-label').textContent = _compareRange
    ? 'Compare to previous period'
    : 'Compare (not available for All time)';
  Object.keys(_cache).forEach(k => delete _cache[k]);
  loadTab(_activeTab);
}

// ── Custom range ─────────────────────────────────────────────────────
function setCustomPanel(open) {
  const panel = document.getElementById('range-custom');
  panel.classList.toggle('open', open);
  const btn = document.querySelector('.range-preset[data-range="custom"]');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function toggleCustomRange() {
  const panel = document.getElementById('range-custom');
  const open = !panel.classList.contains('open');
  setCustomPanel(open);
  if (open && _range) {
    document.getElementById('custom-from').value = _range.start;
    document.getElementById('custom-to').value = LAOS.addDays(_range.endExclusive, -1);
    document.getElementById('custom-msg').textContent = '';
  }
}
function applyCustomRange() {
  const msg = document.getElementById('custom-msg');
  const from = document.getElementById('custom-from').value;
  const to = document.getElementById('custom-to').value;
  const today = (_bounds && _bounds.today) || LAOS.todayLaos();
  const r = LAOS.customRange(from, to, today);
  if (r.error) { msg.textContent = r.message; return; }
  msg.textContent = '';
  hideRangeError();
  applyRange(r);
}

function onCompareToggle() {
  _compareOn = document.getElementById('compare-toggle').checked;
  loadTab(_activeTab);
}
// Compare deltas are only meaningful when a previous span with data exists.
function compareActive() { return _compareOn && !!_compareRange && !_compareRange.beforeData; }

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
function rangeKey() { return _range.start + '_' + _range.endExclusive + '_' + _compareOn; }
function loadTab(tab) {
  if (!_range) return;
  const el = document.getElementById('view-' + tab);
  const key = rangeKey();
  if (el.dataset.loaded === key) return;
  el.innerHTML = '<div class="insp-loading">Loading…</div>';
  // Bounds feed the "tracking since" notes; a failure there is not fatal for
  // presets other than All time (which already failed visibly in setRange).
  ensureBounds().catch(() => null)
    .then(() => TAB_LOADERS[tab]())
    .then(() => {
      if (rangeKey() === key) el.dataset.loaded = key;
      else if (_activeTab === tab) loadTab(tab); // range changed while loading: never leave stale numbers on screen
    })
    .catch(err => {
      console.error('[Analytics] tab load failed', tab, err);
      if (rangeKey() !== key) { if (_activeTab === tab) loadTab(tab); return; }
      delete el.dataset.loaded;
      el.innerHTML = CORE.errorBannerHtml(err && err.message ? err.message : 'Unexpected error.', 'retryTab()');
    });
}
function retryTab() {
  const el = document.getElementById('view-' + _activeTab);
  delete el.dataset.loaded;
  loadTab(_activeTab);
}

// Daily traffic series: chunked (<= 900 days per request, exact because it is
// a per-day metric) so PostgREST's 1000-row cap can never silently truncate a
// long history; days before page_views tracking began are trimmed off.
async function fetchTrafficByDay() {
  const rows = await CORE.fetchDailyChunked(sbRpc, 'analytics_traffic_by_day', _range.start, _range.endExclusive);
  return CORE.trimBeforeCoverage(rows, 'day', coverageStart('page_views'));
}

// ── Small shared render helpers ──────────────────────────────────────
function pctDelta(cur, prev) {
  if (prev == null || prev === 0) return null;
  const pct = ((cur - prev) / prev) * 100;
  return { pct: pct, dir: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat' };
}
function deltaHtml(cur, prev) {
  if (!compareActive() || prev == null) return '';
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
  let snap;
  try { snap = await sbRpc('analytics_realtime_snapshot', { p_minutes: 5 }); }
  catch (e) { return; } // the live strip is best-effort; the tabs report their own errors
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
    sbRpc('analytics_session_stats', rangeParams()),
    compareActive() ? sbRpc('analytics_session_stats', rangeParams(_compareRange)) : null,
    fetchTrafficByDay()
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
      coverageNote('page_views', 'Website traffic') +
      (_compareOn && _compareRange && _compareRange.beforeData ? '<p class="disclosure">No data exists before ' + esc(_bounds && _bounds.earliest_day || 'the first day') + ', so there is no previous period to compare against.</p>' : '') +
    '</div>';

  const rows = trend || [];
  PT_CHART.renderLineChart(document.getElementById('ov-trend-chart'), {
    series: [
      { label: 'Page views', points: rows.map(r => ({ y: r.page_views })) },
      { label: 'Sessions', points: rows.map(r => ({ y: r.sessions })) }
    ],
    xLabels: LAOS.axisLabels(rows.map(r => r.day)),
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
    fetchTrafficByDay(),
    sbRpc('analytics_traffic_sources', rangeParams())
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
      '<div class="chart-card"><div id="tr-trend-chart"></div></div>' + coverageNote('page_views', 'Website traffic') +
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
    xLabels: LAOS.axisLabels(rows.map(r => r.day)), height: 220, ariaLabel: 'Traffic over time'
  });
  PT_CHART.renderDonutChart(document.getElementById('tr-source-chart'), { slices: sourceSlices, size: 170, emptyLabel: 'No traffic yet.' });
  PT_CHART.renderBarChart(document.getElementById('tr-referrer-chart'), { rows: topReferrers, labelWidth: 120, emptyLabel: 'No external referrers yet — all traffic is direct/internal.' });
}

// ══════════════════════════════════════════════════════════════════════
// LISTINGS TAB
// ══════════════════════════════════════════════════════════════════════
async function loadListingsTab() {
  const el = document.getElementById('view-listings');
  // The three stat-tile counts (WhatsApp clicks, call clicks, agent-profile
  // clicks) used to be client-side sbCount() calls built from browser-local
  // instants, which disagreed with this RPC's day boundaries. They are now
  // fields of analytics_listing_engagement() itself, so every card and chart
  // on this tab uses the same Asia/Vientiane calendar days.
  const engagement = await sbRpc('analytics_listing_engagement', rangeParams());
  const waClicks = (engagement || {}).wa_clicks || 0;
  const callClicks = (engagement || {}).call_clicks || 0;
  const agentClicks = (engagement || {}).agent_profile_clicks || 0;
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

  // Share Strategy: "Every shared listing should create another listing
  // view, another potential lead, another opportunity to share again." --
  // these four read straight off the utm_source=pintag_share tag every
  // shared link carries (getShareableListingUrl() in listing.html) joined
  // through the existing session_id spine, no new columns. views_per_share
  // is deliberately labeled that way, not "CTR" -- Pintag never learns how
  // many people a share reached, only how many share actions were taken and
  // how many landing views carried the tag, so this is an honest
  // amplification ratio, not a fabricated per-recipient click-through rate.
  const sharedLinkViews = eng.shared_link_views || 0;
  const viewsPerShare = eng.views_per_share != null ? eng.views_per_share + 'x' : '—';
  const sharedLinkLeads = eng.shared_link_leads || 0;
  const secondaryShares = eng.secondary_shares || 0;

  const viewRows = CORE.trimBeforeCoverage(eng.views_by_day || [], 'day', coverageStart('listing_events'));
  const byDay = {}; viewRows.forEach(r => { byDay[r.day] = r.views; });
  const days = Object.keys(byDay).sort();
  _lastRows.listings = mostViewed;
  const mostViewedNote = CORE.topNote(mostViewed.length, eng.most_viewed_total || 0, 0, '', 0, 0);

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Listing Engagement') +
      '<div class="stat-grid">' +
        statCard('WhatsApp clicks', waClicks) + statCard('Call clicks', callClicks) +
        statCard('Favorites / Saves', savesTotal) + statCard('Shares', sharesTotal) +
        statCard('Share Rate', shareRate) +
        statCard('Agent profile clicks', agentClicks) +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Share Attribution — did the shared link bring someone in?') +
      '<div class="stat-grid">' +
        statCard('Views from shared links', sharedLinkViews) +
        statCard('Views per share', viewsPerShare) +
        statCard('Enquiries from shared links', sharedLinkLeads) +
        statCard('Secondary shares', secondaryShares) +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Listing Views Over Time') +
      '<div class="chart-card"><div id="li-trend-chart"></div></div>' + coverageNote('listing_events', 'Listing activity') +
    '</div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Most Viewed Listings', "exportCsv('most-viewed-listings.csv',['label','value'],_lastRows.listings)") + '<div id="li-mostviewed-chart"></div>' + (mostViewedNote ? '<div class="top-note">' + esc(mostViewedNote) + ' listings by views</div>' : '') + '</div>' +
        '<div class="chart-card">' + sectionHeader('Click-Through Rate (% , ≥5 impressions)') + '<div id="li-ctr-chart"></div></div>' +
      '</div>' +
    '</div>';

  PT_CHART.renderLineChart(document.getElementById('li-trend-chart'), {
    series: [{ label: 'Views', points: days.map(d => ({ y: byDay[d] })) }],
    xLabels: LAOS.axisLabels(days), height: 200, ariaLabel: 'Listing views over time', emptyLabel: 'No listing views in this period yet.'
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
  const b = (await sbRpc('analytics_search_breakdown', rangeParams())) || {};
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
          : '<div class="an-empty">No district searches recorded in this period yet. The District filter is live on the search page — this chart fills in as buyers use it.</div>') +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Popular Search Terms') +
      '<div class="chart-card"><div class="disclosure">Pintag\'s search doesn\'t currently have a free-text keyword box (only structured Property Type / Buy‑Rent filters) — there is no search-term data to show. This section will populate automatically if/when a keyword search is added.</div></div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Price Range Searches') +
      '<div class="chart-card"><div class="an-empty">The Price filter is live on the search page, and every search now records the chosen price range. A price-range demand summary will appear here as buyers use it.</div></div>' +
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
    sbRpc('analytics_funnel', rangeParams()),
    sbRpc('analytics_behavior', rangeParams())
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
  // analytics_leads_breakdown() computes every summary server-side over
  // whatever range is selected (no window cap). It counts OFFICIAL CRM leads
  // only; lead_events with no CRM row are reported separately as
  // `legacy_events` (they have a listing) and `unattributed_events` (they do
  // not). Ranked lists stay top-10 but say "Top 10 of N" and carry an
  // unattributed / deleted remainder so the parts always add up.
  const lb = await sbRpc('analytics_leads_breakdown', rangeParams());
  const total = lb.total || 0;
  const closed = lb.closed || 0;
  const legacy = lb.legacy_events || 0;
  const unattributed = lb.unattributed_events || 0;
  const byListingRows = (lb.by_listing || []).map(r => ({ label: r.label, value: r.value, property_id: r.property_id }));
  const byAgentRows = lb.by_agent || [];
  const listingNote = CORE.topNote(byListingRows.length, lb.by_listing_total || 0, lb.by_listing_other || 0, 'without a listing', lb.by_listing_unattributed || 0, lb.by_listing_deleted || 0);
  const agentNote = CORE.topNote(byAgentRows.length, lb.by_agent_total || 0, lb.by_agent_other || 0, 'unassigned', lb.by_agent_unassigned || 0, 0);

  const firstLeadDay = [coverageStart('leads'), coverageStart('lead_events')].filter(Boolean).sort()[0] || null;
  const dayRows = CORE.trimBeforeCoverage(lb.by_day || [], 'day', firstLeadDay);
  const days = dayRows.map(r => r.day);
  _leadDays = days;
  const activeDays = dayRows.filter(r => (r.value || 0) + (r.legacy || 0) + (r.unattributed || 0) > 0).slice().reverse();

  const sourceSlices = Object.entries(lb.by_source || {}).map(([label, value]) => ({ label: label.charAt(0).toUpperCase() + label.slice(1), value }));

  const daysTable = activeDays.length
    ? '<div style="max-height:260px;overflow:auto;"><table class="an-table day-table"><thead><tr><th>Day (Laos)</th><th>Leads</th><th>Legacy events</th><th>Unattributed</th></tr></thead><tbody>' +
      activeDays.map(r => '<tr><td><button type="button" class="day-btn" data-day="' + esc(r.day) + '">' + esc(r.day) + '</button></td><td>' + (r.value || 0) + '</td><td>' + (r.legacy || 0) + '</td><td>' + (r.unattributed || 0) + '</td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="an-empty">No lead activity in this period.</div>';

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Leads') +
      '<div class="stat-grid">' +
        statCard('Total leads', total) +
        statCard('Closed deals', closed) +
        statCard('Conversion rate', total ? Math.round(closed / total * 1000) / 10 + '%' : '0%') +
        '<div class="stat-card" title="Lead clicks that have a listing but no CRM lead record. Preserved for history; not counted as leads."><div class="stat-label">Legacy events (no CRM lead)</div><div class="stat-value">' + esc(legacy) + '</div></div>' +
      '</div>' +
      '<p class="disclosure"><b>Total leads</b> counts official CRM leads only. <b>Legacy events</b> are older lead clicks that have a listing but no CRM record; ' +
        (unattributed ? '<b>' + esc(unattributed) + ' unattributed event(s)</b> have neither a listing nor a CRM record. ' : '') +
        'Both are listed separately below and never added to the lead count.</p>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Leads Over Time (click a day to see its leads)') +
      '<div class="chart-card"><div id="ld-trend-chart"></div>' + coverageNote('lead_events', 'Lead tracking') + '</div></div>' +
    '<div class="section-block">' + sectionHeader('Days With Lead Activity') + '<div class="chart-card">' + daysTable + '</div></div>' +
    '<div class="section-block">' +
      '<div class="chart-row">' +
        '<div class="chart-card">' + sectionHeader('Leads by Listing (click a bar to filter)') + '<div id="ld-listing-chart"></div>' + (listingNote ? '<div class="top-note">' + esc(listingNote) + '</div>' : '') + '</div>' +
        '<div class="chart-card">' + sectionHeader('Leads by Agent') + '<div id="ld-agent-chart"></div>' + (agentNote ? '<div class="top-note">' + esc(agentNote) + '</div>' : '') + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="section-block">' + sectionHeader('Leads by Source') +
      '<div class="chart-card"><div id="ld-source-chart"></div>' +
      '<p class="disclosure">First-touch attribution: the referrer source of the earliest page view in the same browser session that generated the lead.</p></div>' +
    '</div>' +
    '<div class="section-block" id="la-section">' + sectionHeader('Lead Activity — which listing generated each lead', 'exportLeadActivityCsv()') +
      '<div class="la-toolbar">' +
        '<span id="la-scope"></span>' +
        '<label>Day <input type="date" id="la-day" aria-label="Show lead activity for a day"></label>' +
        '<button type="button" class="export-btn" id="la-day-go" onclick="openDayFromInput()">Show day</button>' +
        '<button type="button" class="export-btn" id="la-range-btn" onclick="showWholeRange()">Whole selected range</button>' +
        '<span id="la-chip"></span>' +
      '</div>' +
      '<div id="la-summary" class="top-note" style="margin:0 0 10px;"></div>' +
      '<div id="la-error"></div>' +
      '<div class="chart-card" id="la-table"></div>' +
      '<div class="la-foot"><button type="button" class="export-btn" id="la-more" onclick="loadLeadActivity(false)">Load more</button><span id="la-count"></span></div>' +
    '</div>';

  PT_CHART.renderLineChart(document.getElementById('ld-trend-chart'), {
    series: [{ label: 'Leads', points: dayRows.map(r => ({ y: r.value || 0 })) }]
      .concat(legacy ? [{ label: 'Legacy events', points: dayRows.map(r => ({ y: r.legacy || 0 })) }] : []),
    xLabels: LAOS.axisLabels(days), height: 200, emptyLabel: 'No leads in this period yet.',
    onPointClick: i => { if (days[i]) openLeadDay(days[i]); }
  });
  PT_CHART.renderBarChart(document.getElementById('ld-listing-chart'), {
    rows: byListingRows, labelWidth: 130, emptyLabel: 'No leads yet.',
    onRowClick: row => { if (row && row.property_id) filterLeadListing(row.property_id, row.label); }
  });
  PT_CHART.renderBarChart(document.getElementById('ld-agent-chart'), { rows: byAgentRows, labelWidth: 130, emptyLabel: 'No leads yet.' });
  PT_CHART.renderDonutChart(document.getElementById('ld-source-chart'), { slices: sourceSlices, size: 170, emptyLabel: 'No leads yet.' });

  // Default drill-down: every lead-type record in the selected range, newest first.
  _leadView = newLeadView(_range.start, _range.endExclusive, null, null);
  renderLeadActivity();
  loadLeadActivity(true);
}

// ── Lead activity drill-down (day / listing), keyset-paginated ───────────
let _leadDays = [];
let _leadView = null; // {start, endExclusive, propertyId, propertyLabel, rows, totals, hasMore, cursor, loading, error}

function newLeadView(start, endExclusive, propertyId, propertyLabel) {
  return { start, endExclusive, propertyId: propertyId || null, propertyLabel: propertyLabel || '', rows: [], totals: null, hasMore: false, cursor: null, loading: false, error: null };
}
function openLeadDay(day) {
  if (!LAOS.isLabel(day)) return;
  const keep = _leadView || {};
  _leadView = newLeadView(day, LAOS.addDays(day, 1), keep.propertyId, keep.propertyLabel);
  renderLeadActivity(true);
  loadLeadActivity(true);
}
function openDayFromInput() {
  const v = document.getElementById('la-day').value;
  if (!LAOS.isLabel(v)) { document.getElementById('la-error').innerHTML = CORE.errorBannerHtml('Pick a valid day first.', null); return; }
  openLeadDay(v);
}
function showWholeRange() {
  const keep = _leadView || {};
  _leadView = newLeadView(_range.start, _range.endExclusive, keep.propertyId, keep.propertyLabel);
  renderLeadActivity();
  loadLeadActivity(true);
}
function filterLeadListing(propertyId, label) {
  const keep = _leadView || newLeadView(_range.start, _range.endExclusive, null, null);
  _leadView = newLeadView(keep.start, keep.endExclusive, propertyId, label);
  renderLeadActivity(true);
  loadLeadActivity(true);
}
function clearLeadListingFilter() {
  const keep = _leadView;
  _leadView = newLeadView(keep.start, keep.endExclusive, null, null);
  renderLeadActivity();
  loadLeadActivity(true);
}

async function loadLeadActivity(reset) {
  const v = _leadView;
  if (!v || v.loading) return;
  v.loading = true; v.error = null;
  renderLeadActivity();
  try {
    const res = await sbRpc('analytics_lead_activity', CORE.leadActivityParams(v, CORE.DRILLDOWN_PAGE, reset ? null : v.cursor));
    if (v !== _leadView) return; // the view was replaced while this page was in flight
    if (!res || !Array.isArray(res.rows)) throw CORE.RpcError('analytics_lead_activity', 'incomplete', 200, 'malformed page');
    v.rows = reset ? res.rows : v.rows.concat(res.rows);
    v.totals = res.totals || v.totals;
    v.hasMore = !!res.has_more;
    v.cursor = res.next_cursor || null;
  } catch (err) {
    if (v === _leadView) v.error = err.message || String(err);
  } finally {
    v.loading = false;
    if (v === _leadView) renderLeadActivity();
  }
}

function renderLeadActivity(scrollIntoView) {
  const v = _leadView;
  const table = document.getElementById('la-table');
  if (!v || !table) return;
  const single = v.endExclusive === LAOS.addDays(v.start, 1);
  document.getElementById('la-scope').textContent = 'Showing ' + (single ? 'day ' + v.start : v.start + ' → ' + LAOS.addDays(v.endExclusive, -1)) + ' (Laos time)';
  document.getElementById('la-chip').innerHTML = v.propertyId
    ? '<span class="la-chip">Listing: ' + esc(v.propertyLabel || v.propertyId.slice(0, 8)) +
      ' <button type="button" class="link-btn" data-act="clear-filter" aria-label="Remove listing filter">✕ clear</button></span>'
    : '';
  document.getElementById('la-day').value = single ? v.start : '';
  const t = v.totals;
  document.getElementById('la-summary').textContent = t
    ? t.leads + ' lead' + (t.leads === 1 ? '' : 's') + ' · ' + t.legacy_events + ' legacy event' + (t.legacy_events === 1 ? '' : 's') +
      ' · ' + t.unattributed_events + ' unattributed · ' + t.distinct_listings + ' listing' + (t.distinct_listings === 1 ? '' : 's') +
      (t.deleted_listing_rows ? ' · ' + t.deleted_listing_rows + ' on deleted listings' : '')
    : '';
  document.getElementById('la-error').innerHTML = v.error ? CORE.errorBannerHtml(v.error, 'retryLeadActivity()') : '';
  if (v.loading && !v.rows.length) table.innerHTML = '<div class="insp-loading">Loading…</div>';
  else if (!v.error || v.rows.length) table.innerHTML = CORE.renderLeadActivityTable(v.rows);
  else table.innerHTML = '';
  const more = document.getElementById('la-more');
  more.style.display = v.hasMore ? '' : 'none';
  more.disabled = v.loading;
  more.textContent = v.loading ? 'Loading…' : 'Load more';
  const total = t ? t.leads + t.legacy_events + t.unattributed_events : null;
  document.getElementById('la-count').textContent = total != null ? 'Showing ' + v.rows.length + ' of ' + total : '';
  if (scrollIntoView) document.getElementById('la-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function retryLeadActivity() { if (_leadView) { _leadView.error = null; loadLeadActivity(_leadView.rows.length === 0); } }

// CSV of EVERYTHING in the current view (all pages), not just what is on screen.
async function exportLeadActivityCsv() {
  const v = _leadView;
  if (!v) return;
  const btn = document.querySelector('#la-section .export-btn');
  const original = btn ? btn.textContent : '';
  try {
    if (btn) btn.disabled = true;
    const { rows } = await CORE.pageAllLeadActivity(sbRpc, v, {
      pageSize: CORE.EXPORT_PAGE,
      onProgress: n => { if (btn) btn.textContent = 'Exporting… ' + n; }
    });
    const last = LAOS.addDays(v.endExclusive, -1);
    const name = 'lead-activity_' + v.start + (last === v.start ? '' : '_to_' + last) + (v.propertyId ? '_listing-' + v.propertyId.slice(0, 8) : '') + '.csv';
    exportCsv(name, CORE.LEAD_CSV_HEADERS, rows.map(CORE.leadRowToCsv));
  } catch (err) {
    document.getElementById('la-error').innerHTML = CORE.errorBannerHtml('Export failed: ' + (err.message || err), null);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original || '⇩ Export CSV'; }
  }
}

// One delegated handler for the buttons inside rendered tables.
document.addEventListener('click', ev => {
  const t = ev.target.closest && ev.target.closest('[data-day],[data-act]');
  if (!t) return;
  if (t.dataset.day) openLeadDay(t.dataset.day);
  else if (t.dataset.act === 'filter-listing') filterLeadListing(t.dataset.propertyId, t.dataset.label);
  else if (t.dataset.act === 'clear-filter') clearLeadListingFilter();
});

// ══════════════════════════════════════════════════════════════════════
// LOCATION TAB — device/browser/OS/language are real; country/city are
// explicitly not built (disclosed, not faked) -- see this file's header.
// ══════════════════════════════════════════════════════════════════════
async function loadLocationTab() {
  const el = document.getElementById('view-location');
  // Was: a raw page_views fetch capped at 20,000 rows, aggregated by
  // device/browser/os/lang in JS. analytics_location_breakdown() does the
  // same 4 GROUP BYs server-side.
  const loc = (await sbRpc('analytics_location_breakdown', rangeParams())) || {};
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
  // Was: sbCount for new listings plus the ENTIRE properties catalog fetched
  // unfiltered (limit 5000, every column) just to compute "no views" / "high
  // view, low convert" client-side, plus leads (limit 10000), parties (limit
  // 1000), and listing_events views (limit 20000). analytics_admin_insights()
  // computes every count and top-N list server-side (new_listings included,
  // on the same Laos calendar days as everything else).
  const insights = await sbRpc('analytics_admin_insights', rangeParams());
  const adm = insights || {};
  const activeAgentRows = adm.by_agent || [];
  const districtRows = adm.by_district || [];
  const typeRows = adm.by_type || [];
  const highViewLowConvert = adm.high_view_low_convert || [];

  _lastRows.noViews = adm.no_views || [];

  el.innerHTML =
    '<div class="section-block">' + sectionHeader('Admin Insights') +
      '<div class="stat-grid">' + statCard('New listings added', adm.new_listings || 0) + '</div>' +
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
