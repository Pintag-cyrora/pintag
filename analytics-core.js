// analytics-core.js — pure (DOM-free, network-free) helpers behind the Admin
// Analytics page: RPC failure classification, the PostgREST 1000-row guard,
// chunked daily-series fetching, keyset paging of lead activity, CSV row
// shaping, and the HTML builders for the lead drill-down table. Kept separate
// from analytics.js so every piece can be unit-tested in node
// (tests/analytics/analytics-core.test.js) without a browser.
//
// Dual-runtime like laos-date.js: classic <script> in the browser
// (window.PT_ANALYTICS_CORE, needs window.PT_LAOS_DATE loaded first) and
// require() from node --test.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./laos-date.js'));
  else root.PT_ANALYTICS_CORE = factory(root.PT_LAOS_DATE);
})(typeof self !== 'undefined' ? self : this, function (laos) {
  'use strict';

  // PostgREST truncates any set-returning RPC at its configured max-rows
  // (1000 by default, and the hosted project's value is not visible to us).
  // A result that reaches this size is treated as possibly truncated.
  var MAX_ROWS = 1000;
  // Additive per-day series are fetched in windows of at most this many days:
  // safely under MAX_ROWS even at one row per day.
  var CHUNK_DAYS = 900;
  var DRILLDOWN_PAGE = 100;   // rows per page in the UI
  var EXPORT_PAGE = 500;      // rows per request while exporting (server max)

  // ── Errors: a failed RPC must be VISIBLE, never rendered as zeros ─────────
  function RpcError(fn, kind, status, detail) {
    var e = new Error(describe({ fn: fn, kind: kind, status: status, detail: detail }));
    e.name = 'RpcError';
    e.fn = fn; e.kind = kind; e.status = status; e.detail = detail || '';
    return e;
  }

  function describe(e) {
    switch (e.kind) {
      case 'timeout':
        return 'The database took too long to answer (' + e.fn + '). Try a shorter date range.';
      case 'denied':
        return 'Not allowed (' + e.fn + '): your session may have expired. Reload and sign in again.';
      case 'invalid':
        return 'The request was rejected as invalid (' + e.fn + '): ' + (e.detail || 'bad date range') + '.';
      case 'truncated':
        return 'The answer for ' + e.fn + ' may have been cut off at the ' + MAX_ROWS + '-row API limit, so it is not shown.';
      case 'incomplete':
        return 'The answer for ' + e.fn + ' was incomplete (' + (e.detail || 'missing days') + '), so it is not shown.';
      case 'network':
        return 'Could not reach the server (' + e.fn + '). Check your connection.';
      default:
        return 'The request failed (' + e.fn + (e.status ? ', HTTP ' + e.status : '') + ').';
    }
  }

  // status + raw response body text -> RpcError (used by sbRpc).
  function classifyFailure(fn, status, bodyText) {
    var code = '', msg = '';
    try { var j = JSON.parse(bodyText || '{}'); code = String(j.code || ''); msg = String(j.message || ''); } catch (_) { msg = String(bodyText || ''); }
    if (code === '57014' || /statement timeout/i.test(msg)) return RpcError(fn, 'timeout', status, msg);
    if (status === 401 || status === 403 || code === '42501' || /Access denied/i.test(msg)) return RpcError(fn, 'denied', status, msg);
    if (code === '22023' || /Invalid date range/i.test(msg)) return RpcError(fn, 'invalid', status, msg);
    return RpcError(fn, 'http', status, msg);
  }

  // A result set that reached the API row cap may have been cut off.
  function guardRows(fn, rows, limit) {
    var cap = limit || MAX_ROWS;
    if (!Array.isArray(rows)) throw RpcError(fn, 'incomplete', 200, 'not a list');
    if (rows.length >= cap) throw RpcError(fn, 'truncated', 200, rows.length + ' rows');
    return rows;
  }

  // ── Additive daily series, chunked ───────────────────────────────────────
  // Concatenate chunk results in day order; a repeated day means overlapping
  // windows (a bug), so it throws rather than double counting.
  function mergeDaily(chunks, key) {
    var k = key || 'day';
    var all = [].concat.apply([], chunks);
    all.sort(function (a, b) { return a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0; });
    for (var i = 1; i < all.length; i++) {
      if (all[i][k] === all[i - 1][k]) throw RpcError('merge', 'incomplete', 200, 'duplicate day ' + all[i][k]);
    }
    return all;
  }

  // callRpc(fn, params) -> Promise<rows>. The daily RPC zero-fills, so a
  // complete answer has exactly one row per day; anything else is an error.
  function fetchDailyChunked(callRpc, fn, start, endExclusive, opts) {
    var chunkDays = (opts && opts.chunkDays) || CHUNK_DAYS;
    var windows = laos.chunkRanges(start, endExclusive, chunkDays);
    return Promise.all(windows.map(function (w) {
      return Promise.resolve(callRpc(fn, { p_start: w.start, p_end: w.endExclusive })).then(function (rows) {
        guardRows(fn, rows, (opts && opts.maxRows) || MAX_ROWS);
        var want = laos.diffDays(w.start, w.endExclusive);
        if (rows.length !== want) throw RpcError(fn, 'incomplete', 200, rows.length + ' of ' + want + ' days for ' + w.start + '..' + w.endExclusive);
        return rows;
      });
    })).then(function (chunks) { return mergeDaily(chunks, 'day'); });
  }

  // Drop leading days from before a source started being recorded, so an
  // all-time chart does not open with a stretch of misleading zeros.
  function trimBeforeCoverage(rows, key, firstDay) {
    if (!firstDay) return rows;
    var k = key || 'day';
    return rows.filter(function (r) { return r[k] >= firstDay; });
  }

  // ── Keyset paging of lead activity ───────────────────────────────────────
  // callRpc('analytics_lead_activity', params) -> Promise<{rows,totals,has_more,next_cursor}>.
  // The cursor is passed back VERBATIM (never through Date): the server's
  // timestamps carry microseconds, which a JS Date would truncate.
  function leadActivityParams(view, pageSize, cursor) {
    return {
      p_start: view.start, p_end: view.endExclusive,
      p_property_id: view.propertyId || null,
      p_limit: pageSize,
      p_cursor_at: cursor ? cursor.at : null,
      p_cursor_id: cursor ? cursor.id : null
    };
  }

  function pageAllLeadActivity(callRpc, view, opts) {
    var pageSize = (opts && opts.pageSize) || EXPORT_PAGE;
    var maxPages = (opts && opts.maxPages) || 100000;
    var onProgress = (opts && opts.onProgress) || function () {};
    var rows = [], totals = null, pages = 0, lastCursorKey = null;
    function step(cursor) {
      return Promise.resolve(callRpc('analytics_lead_activity', leadActivityParams(view, pageSize, cursor))).then(function (res) {
        if (!res || !Array.isArray(res.rows)) throw RpcError('analytics_lead_activity', 'incomplete', 200, 'malformed page');
        pages++;
        rows = rows.concat(res.rows);
        totals = res.totals || totals;
        onProgress(rows.length, totals);
        if (!res.has_more) return { rows: rows, totals: totals, pages: pages };
        var c = res.next_cursor;
        if (!c || !c.at || !c.id) throw RpcError('analytics_lead_activity', 'incomplete', 200, 'has_more without a cursor');
        var key = c.at + '|' + c.id;
        if (key === lastCursorKey || pages >= maxPages) throw RpcError('analytics_lead_activity', 'incomplete', 200, 'paging did not advance');
        lastCursorKey = key;
        return step(c);
      });
    }
    return step(null);
  }

  // ── CSV ──────────────────────────────────────────────────────────────────
  var LEAD_CSV_HEADERS = [
    'laos_day', 'laos_time', 'record_type', 'listing_title', 'property_id', 'listing_resolution', 'listing_deleted',
    'unit_type', 'unit_type_id', 'agent', 'contact_name', 'contact_role', 'crm_status', 'channel', 'contact_action',
    'first_touch_source', 'lead_id', 'lead_event_id', 'session_id'
  ];
  // A spreadsheet treats a leading = + - @ as a formula; listing titles are
  // user-entered text, so neutralise them (OWASP CSV injection).
  function csvSafe(v) {
    if (v == null) return '';
    v = String(v);
    return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  }
  function leadRowToCsv(r) {
    return {
      laos_day: r.laos_day, laos_time: laos.laosDateTimeString(r.event_at), record_type: r.kind,
      listing_title: csvSafe(r.listing_title), property_id: r.property_id, listing_resolution: r.listing_resolution,
      listing_deleted: r.property_id ? (r.is_deleted ? 'yes' : 'no') : '',
      unit_type: csvSafe(r.unit_type_name), unit_type_id: r.unit_type_id, agent: csvSafe(r.agent_name),
      contact_name: csvSafe(r.contact_name), contact_role: r.contact_role, crm_status: r.lead_status,
      channel: r.channel, contact_action: r.contact_action, first_touch_source: csvSafe(r.first_touch_source),
      lead_id: r.lead_id, lead_event_id: r.lead_event_id, session_id: r.session_id
    };
  }

  // ── HTML builders (every dynamic value is escaped) ───────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function shortId(id) { return id ? String(id).slice(0, 8) : ''; }

  var KIND_META = {
    lead: { label: 'Lead', cls: 'badge-lead', tip: 'Official CRM lead' },
    legacy_event: { label: 'Legacy event', cls: 'badge-legacy', tip: 'A lead click with a listing but no CRM lead record (pre-CRM, or the CRM record no longer exists). Shown for completeness; not counted as a lead.' },
    unattributed_event: { label: 'Unattributed event', cls: 'badge-unattr', tip: 'A lead click with no listing and no CRM lead record, so it cannot be attributed to a listing.' }
  };
  function kindBadge(kind) {
    var m = KIND_META[kind] || { label: kind || '—', cls: 'badge-lead', tip: '' };
    return '<span class="badge ' + m.cls + '" title="' + esc(m.tip) + '">' + esc(m.label) + '</span>';
  }

  function resolutionBadge(r) {
    if (!r.property_id) return '';
    var res = r.listing_resolution;
    if (res === 'unknown') return '<span class="badge badge-unknown" title="This listing id no longer resolves to any stored listing. The id is preserved.">Unknown listing</span>';
    if (res === 'soft_deleted') return '<span class="badge badge-deleted" title="Soft-deleted listing (still stored)">Deleted listing</span>';
    if (res === 'snapshot') return '<span class="badge badge-deleted" title="Deleted listing; details recovered from its deletion snapshot">Deleted listing · snapshot</span>';
    if (res === 'removal_log') return '<span class="badge badge-deleted" title="Deleted listing; title recovered from the removal log">Deleted listing · removal log</span>';
    return '';
  }

  function listingCell(r) {
    if (!r.property_id) return '<span class="muted">No listing</span>';
    var title = esc(r.listing_title || 'Unknown listing');
    var canLink = !r.is_deleted && UUID_RE.test(r.property_id);
    var head = canLink ? '<a href="listing.html?id=' + encodeURIComponent(r.property_id) + '" target="_blank" rel="noopener">' + title + '</a>' : '<span>' + title + '</span>';
    return head + ' ' + resolutionBadge(r) +
      '<div class="idline"><code title="' + esc(r.property_id) + '">' + esc(shortId(r.property_id)) + '</code> ' +
      '<button type="button" class="link-btn" data-act="filter-listing" data-property-id="' + esc(r.property_id) + '" data-label="' + esc(r.listing_title || '') + '">only this listing</button></div>';
  }

  function personCell(r) {
    var parts = [];
    if (r.agent_name) parts.push('<div>' + esc(r.agent_name) + '</div>');
    if (r.contact_name) parts.push('<div class="muted">' + esc(r.contact_name) + (r.contact_role ? ' · ' + esc(r.contact_role) : '') + '</div>');
    return parts.length ? parts.join('') : '<span class="muted">—</span>';
  }

  function idsCell(r) {
    var out = [];
    if (r.lead_id) out.push('lead <code title="' + esc(r.lead_id) + '">' + esc(shortId(r.lead_id)) + '</code>');
    if (r.lead_event_id) out.push('event <code title="' + esc(r.lead_event_id) + '">' + esc(shortId(r.lead_event_id)) + '</code>');
    return out.join('<br>') || '<span class="muted">—</span>';
  }

  function renderLeadActivityTable(rows) {
    if (!rows.length) return '<div class="an-empty">No lead activity in this period.</div>';
    var body = rows.map(function (r) {
      return '<tr data-kind="' + esc(r.kind) + '">' +
        '<td class="nowrap">' + esc(laos.laosDateTimeString(r.event_at)) + '<div>' + kindBadge(r.kind) + '</div></td>' +
        '<td>' + listingCell(r) + '</td>' +
        '<td>' + (r.unit_type_name ? esc(r.unit_type_name) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + personCell(r) + '</td>' +
        '<td>' + (r.lead_status ? esc(r.lead_status) : '<span class="muted" title="No CRM record">—</span>') + '</td>' +
        '<td>' + esc(r.channel || '') + '<div class="muted">' + esc(r.contact_action || '') + '</div></td>' +
        '<td>' + (r.first_touch_source ? esc(r.first_touch_source) : '<span class="muted">—</span>') + '</td>' +
        '<td class="idcell">' + idsCell(r) + '</td>' +
        '</tr>';
    }).join('');
    return '<div style="overflow-x:auto;"><table class="an-table lead-activity"><thead><tr>' +
      ['Time (Laos)', 'Listing', 'Unit type', 'Agent / contact', 'CRM status', 'Channel / action', 'Source', 'IDs'].map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  // "Top 10 of N" note for ranked lists whose tail is otherwise invisible.
  function topNote(shown, total, other, unattributedLabel, unattributed, deleted) {
    var bits = [];
    if (total > shown) bits.push('Top ' + shown + ' of ' + total + (other ? ' (+' + other + ' more)' : ''));
    if (unattributed) bits.push(unattributed + ' ' + unattributedLabel);
    if (deleted) bits.push(deleted + ' on deleted listings');
    return bits.join(' · ');
  }

  function errorBannerHtml(message, retryCall) {
    return '<div class="an-error" role="alert"><strong>Couldn’t load this data.</strong> ' + esc(message) +
      ' <span class="an-error-note">Nothing was hidden or replaced with zeros.</span> ' +
      (retryCall ? '<button type="button" class="export-btn" onclick="' + esc(retryCall) + '">Retry</button>' : '') + '</div>';
  }

  return {
    MAX_ROWS: MAX_ROWS, CHUNK_DAYS: CHUNK_DAYS, DRILLDOWN_PAGE: DRILLDOWN_PAGE, EXPORT_PAGE: EXPORT_PAGE,
    RpcError: RpcError, describe: describe, classifyFailure: classifyFailure, guardRows: guardRows,
    mergeDaily: mergeDaily, fetchDailyChunked: fetchDailyChunked, trimBeforeCoverage: trimBeforeCoverage,
    leadActivityParams: leadActivityParams, pageAllLeadActivity: pageAllLeadActivity,
    LEAD_CSV_HEADERS: LEAD_CSV_HEADERS, csvSafe: csvSafe, leadRowToCsv: leadRowToCsv,
    esc: esc, shortId: shortId, kindBadge: kindBadge, resolutionBadge: resolutionBadge,
    listingCell: listingCell, renderLeadActivityTable: renderLeadActivityTable,
    topNote: topNote, errorBannerHtml: errorBannerHtml
  };
});
