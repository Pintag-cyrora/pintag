// Intelligence page logic — extracted from an inline <script> in
// intelligence.html as of the M1.1 stabilization pass. This keeps the
// zero-build-step convention (still a plain script tag, no bundler) while
// giving the page's own JS a home separate from its markup/CSS, matching
// the pattern already used for cross-page libraries (config.js,
// dev-banner.js, terminology.js, amenities.js) but scoped to this one
// page. See docs/intelligence/INTELLIGENCE_PAGE_ARCHITECTURE.md's
// "Modularization" section for the decision this reflects and why a
// further per-module split (e.g. intelligence-alerts.js) is deferred
// until Phase 2 modules actually exist to split around.
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
  showIntelScreen();
}
async function logout() { _adminToken = null; await sbClient.auth.signOut(); location.reload(); }
function showIntelScreen() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('intel-screen').style.display = 'block';
  switchTopTab('overview');
}
sbClient.auth.getSession().then(({ data: { session } }) => {
  if (session) { _adminToken = session.access_token; showIntelScreen(); }
});

// ── REST helpers ─────────────────────────────────────────────────────
async function sbGet(path) {
  const token = _adminToken || SUPABASE_ANON;
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + token }
  });
  if (!res.ok) { console.error('[Intelligence] REST error', path, res.status); return []; }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}
async function callGenerateReport(reportType, periodEnd, force) {
  const token = _adminToken || SUPABASE_ANON;
  const payload = { report_type: reportType };
  if (periodEnd) payload.period_end = periodEnd;
  if (force) payload.force = true;
  const res = await fetch(SUPABASE_URL + '/functions/v1/generate-intelligence-report', {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('Request failed: ' + res.status));
  return body;
}
async function sbDelete(path) {
  const token = _adminToken || SUPABASE_ANON;
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + token }
  });
  if (!res.ok) throw new Error('Delete failed: ' + res.status);
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
}
function fmtRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.round(hours / 24);
  return days + 'd ago';
}

// ══════════════════════════════════════════════════════════════════
// Minimal markdown renderer. The report prompt constrains Gemini to
// exactly this subset (# / ## headings, paragraphs, bullet lists, bold
// via **text**) — a full markdown library would be overkill and adds a
// dependency for syntax the model never produces. Every string is
// esc()-escaped before any markup is applied, so this cannot introduce
// an XSS path even if Gemini's output ever contained stray HTML.
// ══════════════════════════════════════════════════════════════════
function renderMarkdown(md) {
  if (!md) return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inList = false;
  let paraBuf = [];

  function inlineFormat(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
  function flushPara() {
    if (paraBuf.length) { html += '<p>' + inlineFormat(paraBuf.join(' ')) + '</p>'; paraBuf = []; }
  }
  function closeListIfOpen() {
    if (inList) { html += '</ul>'; inList = false; }
  }

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) { flushPara(); closeListIfOpen(); return; }
    if (trimmed.startsWith('# ')) { flushPara(); closeListIfOpen(); html += '<h1>' + inlineFormat(trimmed.slice(2)) + '</h1>'; return; }
    if (trimmed.startsWith('## ')) { flushPara(); closeListIfOpen(); html += '<h2>' + inlineFormat(trimmed.slice(3)) + '</h2>'; return; }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      flushPara();
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inlineFormat(trimmed.slice(2)) + '</li>';
      return;
    }
    closeListIfOpen();
    paraBuf.push(trimmed);
  });
  flushPara();
  closeListIfOpen();
  return html;
}

// ══════════════════════════════════════════════════════════════════
// Top-level tabs: Overview | Insights Archive
// ══════════════════════════════════════════════════════════════════
let currentReportId = null;
let latestReportId = null;
let reportHistory = [];

function switchTopTab(tab) {
  document.querySelectorAll('#intel-tabs .tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  document.getElementById('overview-view').style.display = tab === 'overview' ? 'block' : 'none';
  document.getElementById('archive-view').style.display = tab === 'archive' ? 'block' : 'none';
  document.getElementById('timeline-view').style.display = 'none';

  if (tab === 'archive') {
    resetArchiveFilters();
  } else {
    loadOverview();
  }
}

// ══════════════════════════════════════════════════════════════════
// Overview — orchestrates Sections 1, 2, 3, 5 + the reserved-modules
// grid from one shared fetch of recent report history. Called on load
// and after every generate/delete action ("automatically refresh").
// ══════════════════════════════════════════════════════════════════
async function loadOverview() {
  renderFutureModules();

  reportHistory = await sbGet(
    'intelligence_reports?order=generated_at.desc&limit=50&select=id,report_type,title,period_start,period_end,generated_at,status,error_message'
  );

  renderOverviewStats(reportHistory);
  renderReportHistoryTable(reportHistory);
  renderSystemHealth(reportHistory);
  loadAlerts(reportHistory);
  loadListingsNeedingAttention();

  latestReportId = reportHistory.length ? reportHistory[0].id : null;
  if (latestReportId) {
    await viewReportById(latestReportId);
  } else {
    document.getElementById('report-container').innerHTML =
      '<div class="insp-empty">No reports have been generated yet. Use "Generate Report" below to create the first one.</div>';
    currentReportId = null;
    document.getElementById('delete-btn').disabled = true;
    document.getElementById('back-to-latest-link').style.display = 'none';
    renderHighlights([]);
  }
}

// ══════════════════════════════════════════════════════════════════
// Alerts (Phase 2A) — the "action required" area. Independent of which
// report is currently browsed (unlike Today's Highlights' latest-report
// pinning): an alert reflects current state, not a specific report's
// period. Three sources, none a new significance judgment:
//   1. Open data_quality + high/critical-severity intelligence_insights
//      (persistent conditions the Insight Engine already tracks).
//   2. Failed reports — derived from the reportHistory this function is
//      already handed by loadOverview(), no second query.
//   3. Recent new leads — a direct, ephemeral read (not persisted as an
//      insight; "a lead just arrived" isn't a tracked condition).
// See docs/intelligence/PHASE2_PLAN.md's "Confirmed Near-Term Scope".
// ══════════════════════════════════════════════════════════════════
// Per-rule presentation, so each data-quality alert answers "what
// happened / why it matters / what to do next" instead of a generic
// icon + "Fix now" for all three. All three rules still resolve to the
// same destination (the listing's edit form) -- only the label/reason
// text differs, reflecting what staff actually does once there.
const DATA_QUALITY_PRESENTATION = {
  missing_photos: { icon: '📷', reason: "No photos — buyers can't preview this listing", actionLabel: 'Edit listing' },
  missing_ai_description: { icon: '📝', reason: 'No description or AI highlight generated yet', actionLabel: 'Generate AI description' },
  stale_listing: { icon: '⏳', reason: 'Old listing with very few views', actionLabel: 'Review listing' },
};
const NEW_LEAD_WINDOW_HOURS = 24;
const MAX_ALERTS = 10;

function alertSeverityRank(severity) {
  return HIGHLIGHT_SEVERITY_WEIGHT[severity] || 1;
}

async function loadAlerts(reportHistory) {
  const el = document.getElementById('alerts-card');
  try {
    // Two separate queries rather than one PostgREST or=(...) clause: the
    // data-quality branch is scoped to an explicit metric_key allow-list
    // (the 3 conditions urgent enough for Alerts), not "every data_quality
    // insight regardless of severity" -- now that Phase 2B's Listings
    // Needing Attention section covers the full data_quality worklist
    // (including lower-priority conditions like missing_neighborhood_insight
    // or duplicate_listing), Alerts would otherwise flood with the same
    // items twice. See DATA_QUALITY_PRESENTATION below for the allow-list.
    const [urgentDataQuality, otherHighSeverity, leadRows] = await Promise.all([
      sbGet(
        'intelligence_insights?resolved_at=is.null&type=eq.data_quality' +
        '&metric_key=in.(' + Object.keys(DATA_QUALITY_PRESENTATION).join(',') + ')' +
        '&select=id,type,metric_key,severity,title,dimension_property_id&order=severity.desc&limit=25'
      ),
      sbGet(
        'intelligence_insights?resolved_at=is.null&type=neq.data_quality&severity=in.(high,critical)' +
        '&select=id,type,metric_key,severity,title,dimension_property_id&order=severity.desc&limit=25'
      ),
      sbGet(
        'leads?status=eq.new&created_at=gte.' + new Date(Date.now() - NEW_LEAD_WINDOW_HOURS * 3600 * 1000).toISOString() +
        '&select=id,created_at,property_id,properties(title_en)&order=created_at.desc&limit=10'
      ),
    ]);
    const insightRows = urgentDataQuality.concat(otherHighSeverity);

    const alerts = [];

    insightRows.forEach((ins) => {
      if (ins.type === 'data_quality') {
        const p = DATA_QUALITY_PRESENTATION[ins.metric_key] || { icon: '🧹', reason: 'Data quality issue', actionLabel: 'Fix now' };
        alerts.push({
          severity: ins.severity,
          icon: p.icon,
          title: ins.title,
          reason: p.reason,
          actionLabel: p.actionLabel,
          actionHref: ins.dimension_property_id ? ('admin.html?edit=' + encodeURIComponent(ins.dimension_property_id)) : null,
        });
      } else {
        alerts.push({
          severity: ins.severity,
          icon: HIGHLIGHT_TYPE_ICONS[ins.type] || '🚨',
          title: ins.title,
          reason: 'Significant ' + ins.type.replace(/_/g, ' '),
          actionLabel: null,
          actionHref: null,
        });
      }
    });

    // "Regenerate report" reuses Section 4's existing generateReportType()
    // (same function the manual Generate buttons call) rather than a
    // second code path -- the alert just scrolls it into view and clicks
    // it on the staff member's behalf.
    reportHistory.filter((r) => r.status === 'failed').forEach((r) => {
      alerts.push({
        severity: 'high',
        icon: '📄',
        title: 'Report generation failed: ' + r.report_type + ' (' + fmtDate(r.period_end) + ')',
        reason: r.error_message || 'See Report History for details',
        actionLabel: 'Regenerate report',
        actionOnClick: () => {
          const btn = document.getElementById('gen-btn-' + r.report_type);
          if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          generateReportType(r.report_type);
        },
      });
    });

    // No staff-facing single-lead view exists yet (dashboard.html's Leads
    // tab is the agent-facing CRM, not a staff tool) -- "View listing"
    // is the honest action available today: it takes staff to the
    // property the lead is about, not a lead detail page that doesn't
    // exist. Revisit once/if a staff lead view is built.
    leadRows.forEach((lead) => {
      const propertyTitle = (lead.properties && lead.properties.title_en) || 'a listing';
      alerts.push({
        severity: 'medium',
        icon: '📞',
        title: 'New lead: ' + propertyTitle,
        reason: 'Received ' + fmtRelative(lead.created_at),
        actionLabel: lead.property_id ? 'View listing' : null,
        actionHref: lead.property_id ? ('admin.html?edit=' + encodeURIComponent(lead.property_id)) : null,
      });
    });

    alerts.sort((a, b) => alertSeverityRank(b.severity) - alertSeverityRank(a.severity));
    renderAlerts(alerts.slice(0, MAX_ALERTS));
  } catch (e) {
    console.error('[Intelligence] Failed to load alerts', e);
    renderAlerts([]);
  }
}

function renderAlerts(alerts) {
  const el = document.getElementById('alerts-card');
  if (!alerts.length) {
    el.innerHTML = '<div class="alerts-empty">No alerts — everything looks healthy.</div>';
    return;
  }
  el.innerHTML = '<ul class="alerts-list">' + alerts.map((a, i) =>
    '<li class="alert-item">' +
      '<span class="alert-severity-dot ' + esc(a.severity) + '"></span>' +
      '<span class="alert-icon">' + a.icon + '</span>' +
      '<div class="alert-body">' +
        '<div class="alert-title">' + esc(a.title) + '</div>' +
        (a.reason ? '<div class="alert-reason">' + esc(a.reason) + '</div>' : '') +
      '</div>' +
      (a.actionHref ? '<a class="alert-action" href="' + esc(a.actionHref) + '" target="_blank" rel="noopener">' + esc(a.actionLabel || 'View') + '</a>' :
       a.actionOnClick ? '<button type="button" class="alert-action alert-action-btn" data-alert-index="' + i + '">' + esc(a.actionLabel || 'View') + '</button>' : '') +
    '</li>'
  ).join('') + '</ul>';
  // actionOnClick callbacks can't be serialized into the innerHTML string
  // above, so they're wired up via delegation after the fact -- el itself
  // is never replaced across renders (only its innerHTML), so this listener
  // never needs to be re-attached or leak duplicates across loadAlerts() calls.
  el.querySelectorAll('.alert-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = alerts[Number(btn.dataset.alertIndex)];
      if (a && a.actionOnClick) a.actionOnClick();
    });
  });
}

// ══════════════════════════════════════════════════════════════════
// Listings Needing Attention (Phase 2B) — a worklist, not a condition
// list: every open data_quality insight is grouped by the listing it's
// about, so a listing with 3 separate issues appears once with all 3
// reasons, not 3 separate rows. Prioritized by impact (the sum of each
// issue's severity weight for that listing), never by listing id or
// creation date, per the confirmed Phase 2B scope in PHASE2_PLAN.md.
//
// Deliberately reuses the exact same intelligence_insights rows Alerts
// reads (no second detector, no second significance judgment) -- this is
// the "resolve the conceptual overlap rather than shipping two
// overlapping worklists" instruction from PHASE2_PLAN.md, applied by
// having Alerts show only the 3 most urgent conditions (see
// DATA_QUALITY_PRESENTATION above) while this section shows the full
// worklist across every data_quality condition, grouped per-listing.
// ══════════════════════════════════════════════════════════════════
const LISTING_ISSUE_PRESENTATION = {
  missing_photos: { icon: '📷', label: 'No photos' },
  missing_price: { icon: '💲', label: 'Missing price' },
  missing_ai_highlight: { icon: '✨', label: 'Missing AI highlight' },
  missing_ai_description: { icon: '📝', label: 'Missing description' },
  missing_location: { icon: '📍', label: 'Missing location' },
  missing_neighborhood_insight: { icon: '🏘️', label: 'Missing neighborhood insight' },
  stale_listing: { icon: '⏳', label: 'Old listing, very few views' },
  no_leads: { icon: '📉', label: 'No leads yet' },
  duplicate_listing: { icon: '🧬', label: 'Possible duplicate' },
};
const MAX_ATTENTION_LISTINGS = 15;

function listingImpactScore(issues) {
  return issues.reduce((sum, i) => sum + (HIGHLIGHT_SEVERITY_WEIGHT[i.severity] || 1), 0);
}

async function loadListingsNeedingAttention() {
  const el = document.getElementById('attention-card');
  try {
    const rows = await sbGet(
      'intelligence_insights?resolved_at=is.null&type=eq.data_quality&dimension_property_id=not.is.null' +
      '&select=id,metric_key,severity,dimension_property_id,properties(title_en)' +
      '&order=severity.desc&limit=300'
    );
    const byListing = new Map();
    rows.forEach((ins) => {
      const id = ins.dimension_property_id;
      if (!byListing.has(id)) {
        byListing.set(id, {
          propertyId: id,
          title: (ins.properties && ins.properties.title_en) || 'Untitled listing',
          issues: [],
        });
      }
      byListing.get(id).issues.push({ metricKey: ins.metric_key, severity: ins.severity });
    });
    const listings = Array.from(byListing.values())
      .map((l) => ({ ...l, impact: listingImpactScore(l.issues) }))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, MAX_ATTENTION_LISTINGS);
    renderListingsNeedingAttention(listings);
  } catch (e) {
    console.error('[Intelligence] Failed to load Listings Needing Attention', e);
    renderListingsNeedingAttention([]);
  }
}

function renderListingsNeedingAttention(listings) {
  const el = document.getElementById('attention-card');
  if (!listings.length) {
    el.innerHTML = '<div class="alerts-empty">No listings need attention right now.</div>';
    return;
  }
  el.innerHTML = '<ul class="attention-list">' + listings.map((l) =>
    '<li class="attention-item">' +
      '<div class="attention-body">' +
        '<div class="attention-title">' + esc(l.title) + '</div>' +
        '<div class="attention-issues">' + l.issues.map((i) => {
          const p = LISTING_ISSUE_PRESENTATION[i.metricKey] || { icon: '🧹', label: i.metricKey };
          return '<span class="attention-issue">' + p.icon + ' ' + esc(p.label) + '</span>';
        }).join('') + '</div>' +
      '</div>' +
      '<a class="alert-action" href="' + esc('admin.html?edit=' + encodeURIComponent(l.propertyId)) + '" target="_blank" rel="noopener">Edit listing</a>' +
    '</li>'
  ).join('') + '</ul>';
}

// ── Today's Highlights — derived entirely from the latest report's own
// insight links (same data viewReportById already fetches for the chip
// row below; no second fetch, no new business logic). Kept as its own
// small pipeline — groupInsightsByRecency() -> deriveHighlights() ->
// renderHighlights() — so the ranking heuristic can be improved later
// without touching how it's fetched or displayed. ──────────────────────

// Classifies a report's linked insights into new/continuing/resolved for
// this specific report's period. Shared by the chip row (Section 2) and
// Today's Highlights so both read the exact same classification.
function groupInsightsByRecency(insights, report) {
  const groups = { new: [], continuing: [], resolved: [] };
  insights.forEach((ins) => {
    const resolvedInPeriod = ins.resolved_at && ins.resolved_at.slice(0, 10) >= report.period_start && ins.resolved_at.slice(0, 10) <= report.period_end;
    const firstSeenInPeriod = ins.first_seen >= report.period_start && ins.first_seen <= report.period_end;
    if (resolvedInPeriod) groups.resolved.push(ins);
    else if (firstSeenInPeriod) groups.new.push(ins);
    else groups.continuing.push(ins);
  });
  return groups;
}

const HIGHLIGHT_TYPE_ICONS = {
  demand_spike: '🔥', supply_shortage: '⚠️', ctr_decline: '📉', ctr_improvement: '📈',
  high_performing_listing: '⭐', low_performing_listing: '⚠️', ux_anomaly: '🐞',
  conversion_anomaly: '🚨', search_trend: '🔍', price_trend: '💰'
};
const HIGHLIGHT_SEVERITY_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };
const MAX_HIGHLIGHTS = 5;

// Ranking factors — each is a small, independent function taking
// (insight, group) and returning one numeric contribution to its
// highlight rank. Kept as a list rather than one inline formula, the same
// shape as DEFAULT_DETECTORS in insight-engine.js, so a future factor
// (Business Impact, User Impact, Urgency — see INTELLIGENCE_ARCHITECTURE.md
// discussion) is one more entry here, not a redesign of how ranking works.
// A new factor should return a contribution on roughly the same 0-4ish
// scale as the ones below, so it doesn't silently dominate the sum
// without an explicit weighting decision.
const HIGHLIGHT_RANK_FACTORS = [
  // Technical significance: how statistically severe/confident the signal is.
  (insight) => (HIGHLIGHT_SEVERITY_WEIGHT[insight.severity] || 1) * (typeof insight.confidence === 'number' ? insight.confidence : 0.5),
  // Editorial weight: the report composer already judged this the lead story.
  (insight) => (insight._role === 'biggest_story' ? 3 : 0),
  // Recency: a newly-opened or newly-resolved insight is more "news" than
  // one that's simply still open from before this period.
  (insight, group) => (group === 'new' ? 1 : group === 'resolved' ? 0.5 : 0),
  // Future factors slot in here as more entries, e.g.:
  //   (insight) => businessImpactScore(insight),
  //   (insight) => userImpactScore(insight),
  //   (insight) => urgencyScore(insight),
];

// Ranks by the summed factors above — not by which section of the report
// an insight happened to land in or how early it appears in
// body_markdown — this is what keeps highlights from just echoing the
// report's first few lines.
function rankInsightForHighlight(insight, group) {
  return HIGHLIGHT_RANK_FACTORS.reduce((total, factor) => total + factor(insight, group), 0);
}

function deriveHighlights(groups) {
  const ranked = []
    .concat(groups.new.map((i) => ({ insight: i, group: 'new' })))
    .concat(groups.continuing.map((i) => ({ insight: i, group: 'continuing' })))
    .concat(groups.resolved.map((i) => ({ insight: i, group: 'resolved' })))
    .map((x) => Object.assign({ score: rankInsightForHighlight(x.insight, x.group) }, x))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HIGHLIGHTS);

  return ranked.map(({ insight, group }) => ({
    icon: group === 'resolved' ? '✅' : (HIGHLIGHT_TYPE_ICONS[insight.type] || '🔎'),
    text: insight.title
  }));
}

function renderHighlights(items) {
  const el = document.getElementById('highlights-card');
  if (!items.length) {
    el.innerHTML = '<div class="highlights-empty">No major highlights today.</div>';
    return;
  }
  el.innerHTML = '<ul class="highlights-list">' + items.map((h) =>
    '<li class="highlights-item"><span class="highlights-icon">' + h.icon + '</span><span class="highlights-text">' + esc(h.text) + '</span></li>'
  ).join('') + '</ul>';
}

// ── Section 1: Overview stat cards ──────────────────────────────────
function renderOverviewStats(history) {
  const el = document.getElementById('overview-stats');
  if (!history.length) {
    el.innerHTML =
      '<div class="stat-card"><div class="stat-label">Latest Report</div><div class="stat-value status-none">No reports yet</div></div>' +
      '<div class="stat-card"><div class="stat-label">Report Type</div><div class="stat-value status-none">—</div></div>' +
      '<div class="stat-card"><div class="stat-label">Generation Time</div><div class="stat-value status-none">—</div></div>' +
      '<div class="stat-card"><div class="stat-label">Status</div><div class="stat-value status-none">—</div></div>';
    return;
  }
  const latest = history[0];
  const statusClass = latest.status === 'generated' ? 'status-ok' : 'status-error';
  const statusText = latest.status === 'generated' ? '✅ Healthy' : '⚠️ Last run failed';
  el.innerHTML =
    '<div class="stat-card"><div class="stat-label">Latest Report</div><div class="stat-value">' + esc(fmtDate(latest.period_end)) + '</div><div class="stat-value sub">' + esc(fmtRelative(latest.generated_at)) + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">Report Type</div><div class="stat-value"><span class="type-pill">' + esc(latest.report_type) + '</span></div></div>' +
    '<div class="stat-card"><div class="stat-label">Generation Time</div><div class="stat-value">' + esc(fmtDateTime(latest.generated_at)) + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">Status</div><div class="stat-value ' + statusClass + '">' + statusText + '</div></div>';
}

// ── Section 2: Latest Intelligence Report (also used to view history rows) ──
async function viewReportById(id) {
  const rows = await sbGet('intelligence_reports?id=eq.' + id + '&select=*');
  if (!rows.length) return;
  const report = rows[0];
  currentReportId = report.id;
  document.getElementById('delete-btn').disabled = false;

  const isLatest = report.id === latestReportId;
  document.getElementById('latest-report-heading').textContent = isLatest ? 'Latest Intelligence Report' : 'Viewing: ' + (report.title || fmtDate(report.period_end));
  document.getElementById('back-to-latest-link').style.display = isLatest ? 'none' : 'inline-block';
  document.getElementById('generate-date-input').value = report.period_end || '';
  document.getElementById('advanced-type-select').value = report.report_type;

  const container = document.getElementById('report-container');

  if (report.status === 'failed') {
    container.innerHTML =
      '<div class="report-card"><div class="report-meta">' + esc(report.report_type) + ' · ' + esc(fmtDateTime(report.generated_at)) + ' · FAILED</div>' +
      '<p style="color:var(--red);font-size:13.5px;">' + esc(report.error_message || 'Report generation failed.') + '</p></div>';
    if (isLatest) renderHighlights([]);
    return;
  }

  const links = await sbGet('report_insights?report_id=eq.' + report.id + '&select=role,intelligence_insights(*)');
  const insights = links.map((l) => Object.assign({ _role: l.role }, l.intelligence_insights)).filter((i) => i && i.id);

  const groups = groupInsightsByRecency(insights, report);
  if (isLatest) renderHighlights(deriveHighlights(groups));

  const chipHtml = (arr, cls, dot) => arr.map((i) =>
    '<span class="chip ' + cls + '" onclick="openInsightTimelineById(\'' + i.id + '\')" title="' + esc(i.summary || '') + '">' +
    '<span class="dot">' + dot + '</span>' + esc(i.title) + '</span>'
  ).join('');

  const metrics = report.metrics_snapshot || {};
  const scalarKeys = ['listing_impressions', 'listing_clicks', 'listing_views', 'listing_ctr', 'whatsapp_clicks', 'call_clicks', 'leads_created', 'leads_closed', 'sessions_total'];
  const metricCards = scalarKeys.filter((k) => metrics[k] !== undefined).map((k) =>
    '<div class="metric-card"><div class="metric-label">' + esc(k.replace(/_/g, ' ')) + '</div><div class="metric-value">' + esc(metrics[k]) + '</div></div>'
  ).join('');

  container.innerHTML =
    '<div class="report-card">' +
      '<div class="report-meta">' + esc(report.report_type.toUpperCase()) + ' · ' + esc(fmtDate(report.period_start)) +
        (report.period_start !== report.period_end ? ' – ' + esc(fmtDate(report.period_end)) : '') +
        ' · generated ' + esc(fmtDateTime(report.generated_at)) + '</div>' +
      '<div class="report-title">' + esc(report.title || 'Untitled report') + '</div>' +
      (report.executive_summary ? '<div class="report-summary">' + esc(report.executive_summary) + '</div>' : '') +
      (insights.length ? '<div class="chip-row">' +
        chipHtml(groups.new, 'new', '🟢') +
        chipHtml(groups.continuing, 'continuing', '🔴') +
        chipHtml(groups.resolved, 'resolved', '✅') +
      '</div>' : '') +
      '<div class="report-body">' + renderMarkdown(report.body_markdown) + '</div>' +
      (metricCards ? '<div class="supporting-toggle" onclick="this.nextElementSibling.classList.toggle(\'open\')">▸ Supporting data</div>' +
        '<div class="supporting-panel"><div class="metric-grid">' + metricCards + '</div></div>' : '') +
    '</div>';
}

function loadLatestReport() {
  if (latestReportId) viewReportById(latestReportId);
}

function toggleAdvancedControls() {
  const el = document.getElementById('advanced-controls');
  el.style.display = el.style.display === 'none' ? 'flex' : 'none';
}

// ── Section 3: Report History table ─────────────────────────────────
function renderReportHistoryTable(history) {
  const container = document.getElementById('history-container');
  if (!history.length) {
    container.innerHTML = '<div class="insp-empty">No reports yet.</div>';
    return;
  }
  container.innerHTML =
    '<table class="history-table"><thead><tr><th>Date</th><th>Type</th><th>Title</th><th>Status</th></tr></thead><tbody>' +
    history.map((r) =>
      '<tr class="clickable" onclick="viewReportById(\'' + r.id + '\')">' +
        '<td>' + esc(fmtDate(r.period_end)) + '</td>' +
        '<td><span class="type-pill">' + esc(r.report_type) + '</span></td>' +
        '<td>' + esc(r.title || 'Untitled') + '</td>' +
        '<td><span class="status-pill ' + esc(r.status) + '">' + (r.status === 'generated' ? 'Generated' : 'Failed') + '</span></td>' +
      '</tr>'
    ).join('') +
    '</tbody></table>';
}

// ── Section 4: Generate Report — three independent buttons ──────────
// Always sends force:true, matching the established manual-generate
// convention (see INTELLIGENCE_ARCHITECTURE.md): an explicit staff click
// should always produce a fresh report for the default period, replacing
// any existing one for that exact period rather than silently no-op'ing.
async function generateReportType(type) {
  const btn = document.getElementById('gen-btn-' + type);
  const status = document.getElementById('gen-status-' + type);
  btn.disabled = true;
  status.className = 'generate-status';
  status.textContent = 'Generating…';
  try {
    await callGenerateReport(type, undefined, true);
    status.className = 'generate-status ok';
    status.textContent = '✅ Generated';
    await loadOverview();
  } catch (e) {
    status.className = 'generate-status err';
    status.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
    setTimeout(() => { if (status.textContent.indexOf('❌') === -1) status.textContent = ''; }, 4000);
  }
}

// ── Advanced: generate for a specific date/type (preserves the earlier
// manual preview workflow — Generate for any period, then Review/Delete). ──
async function generateForDate() {
  const type = document.getElementById('advanced-type-select').value;
  const dateValue = document.getElementById('generate-date-input').value || undefined;
  try {
    await callGenerateReport(type, dateValue, true);
    await loadOverview();
  } catch (e) {
    alert('Failed to generate report: ' + e.message);
  }
}

async function deleteCurrentReport() {
  if (!currentReportId) return;
  if (!confirm('Delete this report? Its NEW/CONTINUING/RESOLVED links are removed too, but the underlying insights themselves are not affected.')) return;
  const btn = document.getElementById('delete-btn');
  btn.disabled = true;
  try {
    await sbDelete('intelligence_reports?id=eq.' + currentReportId);
    currentReportId = null;
    await loadOverview();
  } catch (e) {
    alert('Failed to delete report: ' + e.message);
    btn.disabled = false;
  }
}

// ── Section 5: System Health — derived entirely from the same history
// fetch loadOverview() already made; no extra query, no duplicated logic. ──
function renderSystemHealth(history) {
  const el = document.getElementById('health-stats');
  const lastSuccess = history.find((r) => r.status === 'generated') || null;
  const lastExecution = history.length ? history[0] : null;
  const lastError = history.find((r) => r.status === 'failed') || null;

  el.innerHTML =
    '<div class="stat-card"><div class="stat-label">Last Successful Run</div>' +
      (lastSuccess
        ? '<div class="stat-value status-ok">' + esc(fmtRelative(lastSuccess.generated_at)) + '</div><div class="stat-value sub">' + esc(fmtDateTime(lastSuccess.generated_at)) + ' · ' + esc(lastSuccess.report_type) + '</div>'
        : '<div class="stat-value status-none">None yet</div>') +
    '</div>' +
    '<div class="stat-card"><div class="stat-label">Last Execution</div>' +
      (lastExecution
        ? '<div class="stat-value">' + esc(fmtRelative(lastExecution.generated_at)) + '</div><div class="stat-value sub">' + esc(fmtDateTime(lastExecution.generated_at)) + ' · ' + esc(lastExecution.report_type) + '</div>'
        : '<div class="stat-value status-none">None yet</div>') +
    '</div>' +
    '<div class="stat-card"><div class="stat-label">Duration</div><div class="stat-value status-none">Not tracked</div><div class="stat-value sub">See Phase 2 recommendations</div></div>' +
    '<div class="stat-card"><div class="stat-label">Last Error</div>' +
      (lastError
        ? '<div class="stat-value status-error">' + esc(fmtRelative(lastError.generated_at)) + '</div><div class="stat-value sub" title="' + esc(lastError.error_message || '') + '">' + esc((lastError.error_message || '').slice(0, 60)) + '</div>'
        : '<div class="stat-value status-ok">No errors recorded</div>') +
    '</div>';
}

// ── Reserved future Intelligence modules — data-driven placeholder grid.
// Adding a module later is a one-line addition here, not new markup. ──
const FUTURE_MODULES = [
  { icon: '🩺', label: 'Platform Health' },
  { icon: '🏚️', label: 'Listings Needing Attention' },
  { icon: '📞', label: 'Lead Activity' },
  { icon: '🔍', label: 'Search Trends' },
  { icon: '📈', label: 'Market Trends' },
  { icon: '🧹', label: 'Data Quality' },
  { icon: '🤖', label: 'AI Recommendations' },
  { icon: '🔮', label: 'Forecasts' },
  { icon: '🚨', label: 'Alerts' },
];
function renderFutureModules() {
  document.getElementById('future-modules-grid').innerHTML = FUTURE_MODULES.map((m) =>
    '<div class="future-card"><div class="future-icon">' + m.icon + '</div><div class="future-label">' + esc(m.label) + '</div></div>'
  ).join('');
}

// ══════════════════════════════════════════════════════════════════
// Insights Archive (unchanged from the previous build)
// ══════════════════════════════════════════════════════════════════
function resetArchiveFilters() {
  ['af-status', 'af-severity', 'af-type'].forEach((id) => document.getElementById(id).value = '');
  ['af-district', 'af-property-type', 'af-keyword'].forEach((id) => document.getElementById(id).value = '');
  applyArchiveFilters();
}

async function applyArchiveFilters() {
  const container = document.getElementById('archive-container');
  container.innerHTML = '<div class="insp-loading">Loading insights…</div>';

  const status = document.getElementById('af-status').value;
  const severity = document.getElementById('af-severity').value;
  const type = document.getElementById('af-type').value;
  const district = document.getElementById('af-district').value.trim();
  const propertyType = document.getElementById('af-property-type').value.trim();
  const keyword = document.getElementById('af-keyword').value.trim();

  const params = ['select=*', 'order=first_seen.desc', 'limit=100'];
  if (status === 'open') params.push('resolved_at=is.null');
  if (status === 'resolved') params.push('resolved_at=not.is.null');
  if (severity) params.push('severity=eq.' + encodeURIComponent(severity));
  if (type) params.push('type=eq.' + encodeURIComponent(type));
  if (district) params.push('dimension_district=ilike.*' + encodeURIComponent(district) + '*');
  if (propertyType) params.push('dimension_property_type=ilike.*' + encodeURIComponent(propertyType) + '*');
  if (keyword) {
    const kw = encodeURIComponent(keyword);
    params.push('or=(title.ilike.*' + kw + '*,summary.ilike.*' + kw + '*)');
  }

  const rows = await sbGet('intelligence_insights?' + params.join('&'));
  renderArchiveTable(rows);
}

function renderArchiveTable(rows) {
  const container = document.getElementById('archive-container');
  if (!rows.length) { container.innerHTML = '<div class="insp-empty">No insights match these filters.</div>'; return; }

  container.innerHTML =
    '<table class="archive-table"><thead><tr>' +
      '<th>Insight</th><th>Type</th><th>Dimension</th><th>Severity</th><th>Status</th><th>First Seen</th><th>Last Seen</th>' +
    '</tr></thead><tbody>' +
    rows.map((i) => {
      const dims = [i.dimension_district, i.dimension_property_type].filter(Boolean).join(' / ') || '—';
      const isOpen = !i.resolved_at;
      return '<tr class="clickable" onclick="openInsightTimelineById(\'' + i.id + '\')">' +
        '<td>' + esc(i.title) + '</td>' +
        '<td>' + esc(i.type.replace(/_/g, ' ')) + '</td>' +
        '<td>' + esc(dims) + '</td>' +
        '<td><span class="severity-pill ' + esc(i.severity) + '">' + esc(i.severity) + '</span></td>' +
        '<td><span class="status-pill ' + (isOpen ? 'open' : 'resolved') + '">' + (isOpen ? 'Open' : 'Resolved') + '</span></td>' +
        '<td>' + esc(fmtDate(i.first_seen)) + '</td>' +
        '<td>' + esc(fmtDate(i.last_seen)) + '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table>';
}

// ══════════════════════════════════════════════════════════════════
// Intelligence Timeline — one insight's full history across reports
// ══════════════════════════════════════════════════════════════════
async function openInsightTimelineById(id) {
  document.getElementById('overview-view').style.display = 'none';
  document.getElementById('archive-view').style.display = 'none';
  document.getElementById('timeline-view').style.display = 'block';
  document.getElementById('timeline-container').innerHTML = '<div class="insp-loading">Loading timeline…</div>';

  const [insightRows, links] = await Promise.all([
    sbGet('intelligence_insights?id=eq.' + id + '&select=*'),
    sbGet('report_insights?insight_id=eq.' + id + '&select=role,intelligence_reports(id,report_type,title,period_start,period_end,generated_at)')
  ]);
  if (!insightRows.length) { document.getElementById('timeline-container').innerHTML = '<div class="insp-empty">Insight not found.</div>'; return; }
  const insight = insightRows[0];
  const reports = links.map((l) => l.intelligence_reports).filter(Boolean)
    .sort((a, b) => a.generated_at < b.generated_at ? -1 : 1);

  const events = [];
  events.push({ date: insight.first_seen, text: '🟢 First detected — <strong>' + esc(insight.title) + '</strong>', resolved: false });
  reports.forEach((r) => {
    events.push({
      date: r.period_end,
      text: 'Discussed in <a href="#" onclick="jumpToReportFromTimeline(\'' + r.id + '\');return false;">' +
        esc(r.report_type) + ' report — ' + esc(r.title || fmtDate(r.period_end)) + '</a>',
      resolved: false
    });
  });
  if (insight.resolved_at) {
    events.push({ date: insight.resolved_at.slice(0, 10), text: '✅ Resolved', resolved: true });
  } else {
    events.push({ date: insight.last_seen, text: '🔴 Still active as of ' + esc(fmtDate(insight.last_seen)) + ' (trend: ' + esc(insight.trend) + ')', resolved: false });
  }
  events.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  document.getElementById('timeline-container').innerHTML =
    '<div class="report-card">' +
      '<div class="report-meta">' + esc(insight.type.replace(/_/g, ' ')) + ' · ' + esc(insight.severity) + ' severity · ' +
        Math.round((insight.confidence || 0) * 100) + '% confidence</div>' +
      '<div class="report-title">' + esc(insight.title) + '</div>' +
      (insight.summary ? '<p style="color:var(--ink-soft);margin-bottom:16px;">' + esc(insight.summary) + '</p>' : '') +
      (insight.recommendation ? '<p style="color:var(--ink-soft);margin-bottom:16px;"><strong>Suggested action:</strong> ' + esc(insight.recommendation) + '</p>' : '') +
      '<div class="report-meta" style="margin-top:20px;">Timeline</div>' +
      events.map((e) =>
        '<div class="timeline-item' + (e.resolved ? ' is-resolved' : '') + '"><div class="timeline-dot"></div>' +
        '<div class="timeline-date">' + esc(fmtDate(e.date)) + '</div><div class="timeline-text">' + e.text + '</div></div>'
      ).join('') +
      '<pre style="margin-top:16px;background:var(--ink);color:#B8E8E8;font-family:' + "'SF Mono',ui-monospace,monospace" + ';font-size:11.5px;padding:12px 14px;border-radius:6px;overflow-x:auto;">' + esc(JSON.stringify(insight.evidence, null, 2)) + '</pre>' +
    '</div>';
}

function backToArchive() {
  document.getElementById('timeline-view').style.display = 'none';
  document.getElementById('archive-view').style.display = 'block';
}

function jumpToReportFromTimeline(reportId) {
  switchTopTab('overview');
  setTimeout(() => viewReportById(reportId), 0);
}
