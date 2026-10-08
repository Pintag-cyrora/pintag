// contact-intent-funnel.js — the Contact Intent funnel's model + HTML, as pure functions.
//
// Turns the jsonb of analytics_contact_intent_funnel(p_start, p_end)
// (supabase/migrations/20261008000000_analytics_contact_intent_funnel.sql) into the section
// shown at the top of the admin Analytics "Leads" tab. DOM-free and network-free so every rate,
// suppression rule and caveat is unit-tested in node (tests/analytics/contact-intent-funnel.test.js).
//
// Dual-runtime like analytics-core.js: classic <script> in the browser
// (window.PT_CONTACT_INTENT_FUNNEL), require() from node --test.
//
// WHAT THE NUMBERS MEAN (the server file header is the full definition):
//   * Unit = an "Ask visit": a distinct (session, listing) with a contact_intent_open in range.
//   * CONTACT INTENT (engagement): Where / Price / Availability / Photos are SELF-SERVICE intents.
//     They are shown as engagement, never as a failed conversion step. Unit selection is the step
//     on multi-unit listings that unlocks Book a viewing / Contact agent.
//   * HIGH-INTENT CONVERSION: Book viewing, Call agent, WhatsApp, Contact clicks.
//   * Rates are suppressed under MIN_VISITS_FOR_RATES Ask visits: a percentage of a handful of
//     visits is noise. Counts are always shown.
//   * Per-intent lead attribution, listing / language / availability / unit / surface breakdowns
//     are DIAGNOSTIC and live in a collapsed block.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PT_CONTACT_INTENT_FUNNEL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Below this many Ask visits a rate is "low volume", not a number.
  var MIN_VISITS_FOR_RATES = 30;
  // A listing needs at least this many Ask visits before its row shows rates.
  var MIN_LISTING_VISITS = 10;
  // First Laos day the mobile Ask sheet had its final layout (no WhatsApp button in the sticky bar).
  // Earlier days mix older layouts, so open -> action rates are not comparable across this line.
  var FINAL_LAYOUT_DAY = '2026-10-08';

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function n(v) { var x = Number(v); return isFinite(x) && x >= 0 ? Math.floor(x) : 0; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function arr(v) { return Array.isArray(v) ? v : []; }

  // A rate that knows when it must not be shown. `suppressed` => value null, text '—'.
  function rate(num, den, minDen) {
    num = n(num); den = n(den);
    if (den === 0) return { value: null, text: '—', suppressed: true, reason: 'none' };
    if (den < (minDen == null ? MIN_VISITS_FOR_RATES : minDen)) return { value: null, text: '—', suppressed: true, reason: 'low-volume' };
    var v = Math.round(num / den * 1000) / 10;
    return { value: v, text: v + '%', suppressed: false, reason: null };
  }

  function required(raw) {
    var ok = raw && typeof raw === 'object' && obj(raw.ask).visits != null && raw.contact_intent && raw.high_intent && raw.clicks && raw.range;
    return !!ok;
  }

  // raw RPC jsonb -> model. Throws (so the UI shows an error + Retry, never zeros) when the payload
  // is not the expected shape.
  function buildModel(raw) {
    if (!required(raw)) {
      var e = new Error('The answer for analytics_contact_intent_funnel was incomplete (missing sections), so it is not shown.');
      e.name = 'RpcError'; e.fn = 'analytics_contact_intent_funnel'; e.kind = 'incomplete';
      throw e;
    }
    var rg = obj(raw.range), ask = obj(raw.ask), ci = obj(raw.contact_intent), hi = obj(raw.high_intent);
    var uf = obj(raw.unit_flow), ck = obj(raw.clicks), dg = obj(raw.diagnostics);
    var visits = n(ask.visits);

    var m = {
      range: {
        start: rg.start || null, endExclusive: rg.end_exclusive || null, today: rg.today || null,
        includesToday: !!rg.includes_today, outcomesIncomplete: !!rg.outcomes_incomplete,
        windowHours: n(rg.outcome_window_hours) || 24, firstOpenDay: rg.first_open_day || null
      },
      visits: visits,
      openEvents: n(ask.open_events),
      repeatOpenVisits: n(ask.repeat_open_visits),
      excluded: { nullSession: n(ask.excluded_null_session), nullProperty: n(ask.excluded_null_property) },
      lowVolume: visits < MIN_VISITS_FOR_RATES,
      // ── CONTACT INTENT block ──
      contactIntent: [
        { key: 'opened',       label: 'Ask opened',            count: visits,                   rate: null, note: 'Distinct (visitor session, listing) pairs that opened the Ask menu.' },
        { key: 'chosen',       label: 'Intent chosen',         count: n(ci.intent_chosen_visits), rate: rate(ci.intent_chosen_visits, visits), note: 'Picked at least one option: a self-service answer, a unit, or an action.' },
        { key: 'where',        label: 'Where',                 count: n(ci.where_visits),         rate: rate(ci.where_visits, visits),        self: true },
        { key: 'price',        label: 'Price',                 count: n(ci.price_visits),         rate: rate(ci.price_visits, visits),        self: true },
        { key: 'availability', label: 'Availability',          count: n(ci.availability_visits),  rate: rate(ci.availability_visits, visits), self: true },
        { key: 'photos',       label: 'Photos',                count: n(ci.photos_visits),        rate: rate(ci.photos_visits, visits),       self: true },
        { key: 'unit',         label: 'Unit selection',        count: n(ci.unit_select_visits),   rate: rate(ci.unit_select_visits, visits),  note: 'Multi-unit listings only.' }
      ],
      selfServiceVisits: n(ci.self_service_visits),
      // ── HIGH-INTENT CONVERSION block ──
      highIntent: [
        { key: 'book',     label: 'Book viewing',   count: n(hi.book_visits),  rate: rate(hi.book_visits, visits) },
        { key: 'call',     label: 'Call agent',     count: n(hi.call_visits),  rate: rate(hi.call_visits, visits), note: 'Includes the older desktop Call button.' },
        { key: 'whatsapp', label: 'WhatsApp',       count: n(hi.whatsapp_visits), rate: rate(hi.whatsapp_visits, visits), note: 'Contact agent on WhatsApp, not Book a viewing.' },
        { key: 'clicks',   label: 'Contact clicks', count: n(hi.contact_click_visits), rate: rate(hi.contact_click_visits, visits), note: 'Visits with a recorded WhatsApp or call click (the lead record). A Book viewing also produces a WhatsApp click.' }
      ],
      agentContactVisits: n(hi.agent_contact_visits),
      agentContactViaMenuVisits: n(hi.agent_contact_via_menu_visits),
      highIntentVisits: n(hi.high_intent_visits),
      contactClicks: { total: n(hi.contact_clicks), call: n(hi.call_clicks), whatsapp: n(hi.whatsapp_clicks) },
      // ── headline KPIs ──
      kpis: {
        askVisits: visits,
        selfServiceRate: rate(ci.self_service_visits, visits),
        agentContactRate: rate(hi.agent_contact_visits, visits),
        bookRate: rate(hi.book_visits, visits),
        callVisits: n(hi.call_visits),
        whatsappVisits: n(hi.whatsapp_visits),
        contactClicks: n(hi.contact_clicks)
      },
      unitFlow: { selected: n(uf.unit_select_visits), thenContact: n(uf.unit_then_contact_visits) },
      // ── range-wide reconciliation (all contact clicks, whatever their path) ──
      clicks: {
        total: n(ck.total), call: n(ck.call), whatsapp: n(ck.whatsapp),
        viaAsk: pick(ck.via_ask), direct: pick(ck.direct), unlinked: pick(ck.unlinked)
      },
      diagnostics: {
        bySurface: dims(dg.by_surface), byLang: dims(dg.by_lang), byAvailability: dims(dg.by_availability),
        byUnit: arr(dg.by_unit).map(function (u) { return { id: u.unit_type_id, name: u.unit_name || null, visits: n(u.visits), thenContact: n(u.then_contact_visits) }; }),
        listings: arr(dg.listings).map(function (l) {
          var v = n(l.ask_visits);
          return {
            id: l.property_id, title: l.title || null, slug: l.slug || null, isDeleted: !!l.is_deleted, resolution: l.resolution || null,
            visits: v, lowVolume: v < MIN_LISTING_VISITS,
            selfService: n(l.self_service_visits), agentContact: n(l.agent_contact_visits), book: n(l.book_visits), clicks: n(l.contact_click_visits)
          };
        }),
        attribution: attribution(dg.attribution),
        quality: {
          newRowsWithoutMetadata: n(obj(dg.data_quality).new_rows_without_metadata),
          legacyRows: n(obj(dg.data_quality).legacy_rows),
          legacyCallRows: n(obj(dg.data_quality).legacy_call_rows)
        }
      }
    };
    m.integrity = integrity(m);
    m.caveats = caveats(m);
    return m;
  }

  function pick(o) { o = obj(o); return { total: n(o.total), call: n(o.call), whatsapp: n(o.whatsapp) }; }
  function dims(a) {
    return arr(a).map(function (d) {
      return { key: String(d.key == null ? 'unknown' : d.key), visits: n(d.ask_visits), selfService: n(d.self_service_visits),
               agentContact: n(d.agent_contact_visits), book: n(d.book_visits), clicks: n(d.contact_click_visits) };
    });
  }
  function attribution(a) {
    a = obj(a);
    function k(o) { o = obj(o); return { book: n(o.book), call: n(o.call), whatsapp: n(o.whatsapp) }; }
    return { matched: k(a.matched), unmatched: k(a.unmatched), unlinkable: n(a.unlinkable_actions),
             leadsWithoutAction: n(a.leads_without_action), visitsWithClickButNoAction: n(a.visits_with_click_but_no_action) };
  }

  // Sanity checks that must hold by construction. A violation is SHOWN (a data or query bug), never hidden.
  function integrity(m) {
    var out = [], v = m.visits;
    function chk(ok, msg) { if (!ok) out.push(msg); }
    chk(m.selfServiceVisits <= v, 'Self-service visits exceed Ask visits.');
    chk(m.contactIntent[1].count <= v, 'Intent-chosen visits exceed Ask visits.');
    chk(m.highIntentVisits <= m.contactIntent[1].count, 'High-intent visits exceed intent-chosen visits.');
    chk(m.agentContactVisits <= m.highIntentVisits, 'Agent-contact visits exceed high-intent visits.');
    chk(m.clicks.viaAsk.total + m.clicks.direct.total + m.clicks.unlinked.total === m.clicks.total, 'Contact-click paths do not add up to the total.');
    chk(m.clicks.call + m.clicks.whatsapp === m.clicks.total, 'Call + WhatsApp clicks do not add up to the total.');
    return out;
  }

  // Everything an admin must know before trusting a number. Order = importance.
  function caveats(m) {
    var c = [];
    if (m.range.includesToday) {
      c.push({ id: 'today', level: 'warn', text: 'Today (Laos time) is still in progress. Visits from the last ' + m.range.windowHours + ' hours may still be completing actions, so today’s action and contact rates will rise as the day ends.' });
    } else if (m.range.outcomesIncomplete) {
      c.push({ id: 'window', level: 'warn', text: 'The last visits in this range are still inside their ' + m.range.windowHours + '-hour outcome window, so their actions may not all be counted yet.' });
    }
    if (m.range.start && m.range.start < FINAL_LAYOUT_DAY) {
      c.push({ id: 'epoch', level: 'info', text: 'Contact Intent tracking' + (m.range.firstOpenDay ? ' began on ' + m.range.firstOpenDay : ' has only just begun') +
        ' (Laos time). The Ask menu reached its current mobile layout on ' + FINAL_LAYOUT_DAY + '; before that the mobile bar still had its own WhatsApp button, so open → action rates are not comparable across that day. Earlier events were never converted into funnel data — nothing is backfilled.' });
    }
    if (m.lowVolume) {
      c.push({ id: 'volume', level: 'info', text: 'Only ' + m.visits + ' Ask visit' + (m.visits === 1 ? '' : 's') + ' in this range (rates need at least ' + MIN_VISITS_FOR_RATES + '). Counts are shown; percentages are withheld.' });
    }
    if (m.excluded.nullSession || m.excluded.nullProperty) {
      var bits = [];
      if (m.excluded.nullSession) bits.push(m.excluded.nullSession + ' open' + (m.excluded.nullSession === 1 ? '' : 's') + ' without a browser session');
      if (m.excluded.nullProperty) bits.push(m.excluded.nullProperty + ' open' + (m.excluded.nullProperty === 1 ? '' : 's') + ' on a listing that no longer exists');
      c.push({ id: 'excluded', level: 'info', text: 'Not linkable to a visit and therefore excluded: ' + bits.join(' and ') + '.' });
    }
    return c;
  }

  // ── HTML ───────────────────────────────────────────────────────────────────────────────────
  function bar(count, den, kind) {
    var w = den > 0 ? Math.max(count > 0 ? 2 : 0, Math.min(100, Math.round(count / den * 100))) : 0;
    return '<div class="cif-bar"><div class="cif-bar-fill cif-' + esc(kind || 'self') + '" style="width:' + w + '%"></div></div>';
  }

  function stageRows(rows, den, kind) {
    return rows.map(function (r) {
      var rt = r.rate;
      var pct = rt ? '<span class="cif-pct' + (rt.suppressed ? ' cif-pct-off' : '') + '"' + (rt.suppressed ? ' title="' + (rt.reason === 'low-volume' ? 'Too few Ask visits for a reliable percentage' : 'No Ask visits') + '"' : '') + '>' + esc(rt.text) + '</span>' : '<span class="cif-pct cif-pct-off">' + (den > 0 ? '100%' : '—') + '</span>';
      return '<tr data-stage="' + esc(r.key) + '"><td class="cif-label">' + esc(r.label) +
        (r.note ? '<div class="cif-note">' + esc(r.note) + '</div>' : '') + '</td>' +
        '<td class="cif-count">' + esc(r.count) + '</td><td class="cif-rate">' + pct + '</td><td class="cif-barcell">' + bar(r.count, den, r.self ? 'self' : kind) + '</td></tr>';
    }).join('');
  }

  function kpi(label, value, sub, title, key) {
    return '<div class="stat-card cif-kpi" data-kpi="' + esc(key) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div>' + (sub ? '<div class="cif-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function dimTable(title, rows, labelMap) {
    if (!rows.length) return '';
    return '<div><h3 class="cif-h3">' + esc(title) + '</h3><table class="an-table"><thead><tr><th></th><th>Ask visits</th><th>Self-service</th><th>Agent contact</th><th>Book</th><th>Contact clicks</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + esc((labelMap && labelMap[r.key]) || r.key) + '</td><td>' + r.visits + '</td><td>' + r.selfService + '</td><td>' + r.agentContact + '</td><td>' + r.book + '</td><td>' + r.clicks + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function render(m) {
    var k = m.kpis, v = m.visits;
    var caveats = m.caveats.map(function (c) {
      return '<div class="cif-caveat cif-' + esc(c.level) + '" data-caveat="' + esc(c.id) + '" role="note">' + esc(c.text) + '</div>';
    }).join('');
    var integrity = m.integrity.length ? '<div class="an-error" role="alert"><strong>Funnel arithmetic check failed.</strong> ' + esc(m.integrity.join(' ')) + ' These numbers should not be trusted until this is investigated.</div>' : '';

    var kpis =
      '<div class="stat-grid cif-kpis">' +
        kpi('Ask visits', k.askVisits, m.openEvents !== k.askVisits ? m.openEvents + ' opens in total (repeats collapse)' : '', 'Distinct (browser session, listing) pairs that opened the Ask menu.', 'visits') +
        kpi('Self-service intent rate', k.selfServiceRate.text, m.selfServiceVisits + ' of ' + v + ' visits', 'Share of Ask visits that used Where, Price, Availability or Photos. Self-service answers are engagement, not a failed conversion.', 'self-service') +
        kpi('Agent contact rate', k.agentContactRate.text, m.agentContactVisits + ' of ' + v + ' visits', 'Share of Ask visits that went on to Call or WhatsApp an agent.', 'agent-contact') +
        kpi('Book-viewing rate', k.bookRate.text, m.highIntent[0].count + ' of ' + v + ' visits', 'Share of Ask visits that used Book a viewing.', 'book') +
      '</div>' +
      '<div class="stat-grid cif-kpis">' +
        kpi('Call vs WhatsApp', k.callVisits + ' : ' + k.whatsappVisits, 'visits that called : messaged an agent', 'Agent-contact visits by channel. Book a viewing is counted separately.', 'call-vs-whatsapp') +
        kpi('Contact clicks', k.contactClicks, m.contactClicks.call + ' call · ' + m.contactClicks.whatsapp + ' WhatsApp', 'WhatsApp / call clicks recorded for these Ask visits (the lead record).', 'contact-clicks') +
        kpi('Unit selection → contact', m.unitFlow.thenContact + ' of ' + m.unitFlow.selected, 'multi-unit visits that chose a unit', 'Of visits that chose a unit, how many then booked or contacted an agent.', 'unit-flow') +
        kpi('Other contact paths', m.clicks.direct.total + m.clicks.unlinked.total, 'direct or unlinked clicks', 'Contact clicks in the range that did not come through the Ask menu.', 'other-paths') +
      '</div>';

    var table =
      '<div class="cif-blocks">' +
        '<div class="chart-card cif-block" data-block="contact-intent"><h3 class="cif-h3">Contact intent</h3>' +
          '<table class="an-table cif-table"><thead><tr><th>Stage</th><th>Ask visits</th><th>% of visits</th><th></th></tr></thead><tbody>' + stageRows(m.contactIntent, v, 'self') + '</tbody></table>' +
          '<p class="cif-foot">Where, Price, Availability and Photos are <b>self-service</b> answers. Visitors who use them have been helped, not lost.</p></div>' +
        '<div class="chart-card cif-block" data-block="high-intent"><h3 class="cif-h3">High-intent conversion</h3>' +
          '<table class="an-table cif-table"><thead><tr><th>Action</th><th>Ask visits</th><th>% of visits</th><th></th></tr></thead><tbody>' + stageRows(m.highIntent, v, 'hi') + '</tbody></table>' +
          '<p class="cif-foot">Percentages are of all Ask visits. A visit that does several things is counted once per row.</p></div>' +
      '</div>';

    var c = m.clicks;
    var recon = '<div class="chart-card cif-recon" data-block="reconciliation"><h3 class="cif-h3">All contact clicks in this range</h3>' +
      '<p>' + esc(c.total) + ' WhatsApp / call click' + (c.total === 1 ? '' : 's') + ' (' + esc(c.call) + ' call · ' + esc(c.whatsapp) + ' WhatsApp): ' +
      '<b>' + esc(c.viaAsk.total) + '</b> after the Ask menu was opened · <b>' + esc(c.direct.total) + '</b> direct (page buttons, no Ask) · <b>' + esc(c.unlinked.total) + '</b> unlinked (no browser session, or the listing is gone).</p>' +
      '<p class="cif-foot">Matches the Leads totals below, which count by the click’s own Laos day. Ask-visit contact clicks above are counted per visit within ' + esc(m.range.windowHours) + ' hours of opening, so the two can differ near the edges of a range. A WhatsApp click is also produced by Book a viewing.</p></div>';

    var diag = diagnostics(m);
    return '<div class="section-block cif" id="ci-funnel" data-testid="contact-intent-funnel">' +
      '<div class="section-header"><h2>Contact Intent</h2></div>' + caveats + integrity + kpis + table + recon + diag + '</div>';
  }

  function diagnostics(m) {
    var d = m.diagnostics, a = d.attribution;
    var listings = d.listings.length
      ? '<div><h3 class="cif-h3">By listing</h3><p class="cif-foot">Rates are shown only for listings with at least ' + MIN_LISTING_VISITS + ' Ask visits.</p><table class="an-table"><thead><tr><th>Listing</th><th>Ask visits</th><th>Self-service</th><th>Agent contact</th><th>Book</th><th>Contact clicks</th></tr></thead><tbody>' +
        d.listings.map(function (l) {
          var name = esc(l.title || l.slug || ('Listing ' + String(l.id || '').slice(0, 8))) + (l.isDeleted ? ' <span class="badge cif-deleted">deleted</span>' : '');
          var cell = function (x) { return l.lowVolume ? x + ' <span class="muted">·</span>' : x + ' <span class="muted">(' + rate(x, l.visits, MIN_LISTING_VISITS).text + ')</span>'; };
          return '<tr><td>' + name + (l.lowVolume ? ' <span class="muted" title="Too few Ask visits for rates">low volume</span>' : '') + '</td><td>' + l.visits + '</td><td>' + cell(l.selfService) + '</td><td>' + cell(l.agentContact) + '</td><td>' + cell(l.book) + '</td><td>' + cell(l.clicks) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '';
    var units = d.byUnit.length
      ? '<div><h3 class="cif-h3">Unit selection</h3><table class="an-table"><thead><tr><th>Unit type</th><th>Visits that chose it</th><th>Then booked / contacted</th></tr></thead><tbody>' +
        d.byUnit.map(function (u) { return '<tr><td>' + esc(u.name || ('Unit ' + String(u.id || '').slice(0, 8))) + '</td><td>' + u.visits + '</td><td>' + u.thenContact + '</td></tr>'; }).join('') + '</tbody></table></div>'
      : '';
    var attr = '<div><h3 class="cif-h3">Derived action → lead matching</h3><p class="cif-foot">Actions and leads share no id; they are matched by browser session, listing and timing (within seconds). A lead is a click, not a conversation. Treat as diagnostic.</p>' +
      '<table class="an-table"><thead><tr><th></th><th>Book viewing</th><th>Call</th><th>WhatsApp</th></tr></thead><tbody>' +
      '<tr><td>Action with a matching lead</td><td>' + a.matched.book + '</td><td>' + a.matched.call + '</td><td>' + a.matched.whatsapp + '</td></tr>' +
      '<tr><td>Action with no lead (repeat tap within 30 s, or a failed insert)</td><td>' + a.unmatched.book + '</td><td>' + a.unmatched.call + '</td><td>' + a.unmatched.whatsapp + '</td></tr>' +
      '</tbody></table><p class="cif-foot">' + a.leadsWithoutAction + ' lead(s) without a matching action · ' + a.visitsWithClickButNoAction + ' Ask visit(s) with a click but no action row · ' + a.unlinkable + ' action(s) with no browser session.</p></div>';
    var q = d.quality;
    var dq = '<div><h3 class="cif-h3">Data quality</h3><ul class="cif-list"><li>' + q.legacyRows + ' older-format contact row(s) (' + q.legacyCallRows + ' legacy Call) in range — folded into Call / WhatsApp, never rewritten.</li><li>' +
      q.newRowsWithoutMetadata + ' Contact Intent row(s) with no metadata (language, surface and availability unknown).</li></ul></div>';
    return '<details class="cif-diag" data-block="diagnostics"><summary>Diagnostics (low-volume breakdowns — not for decisions on their own)</summary><div class="cif-diag-body">' +
      dimTable('By surface', d.bySurface, { panel: 'Desktop panel', sheet: 'Mobile sheet', unknown: 'Unknown' }) +
      dimTable('By language', d.byLang, { en: 'English', lo: 'Lao', zh: 'Chinese', unknown: 'Unknown' }) +
      dimTable('By availability when opened', d.byAvailability, { on: 'Available', off: 'Not available', unknown: 'Unknown' }) +
      units + listings + attr + dq + '</div></details>';
  }

  function loadingHtml() { return '<div class="section-block cif" id="ci-funnel"><div class="section-header"><h2>Contact Intent</h2></div><div class="insp-loading">Loading…</div></div>'; }
  function errorHtml(bannerHtml) { return '<div class="section-block cif" id="ci-funnel"><div class="section-header"><h2>Contact Intent</h2></div>' + bannerHtml + '</div>'; }

  return {
    MIN_VISITS_FOR_RATES: MIN_VISITS_FOR_RATES, MIN_LISTING_VISITS: MIN_LISTING_VISITS, FINAL_LAYOUT_DAY: FINAL_LAYOUT_DAY,
    rate: rate, buildModel: buildModel, render: render, loadingHtml: loadingHtml, errorHtml: errorHtml, esc: esc
  };
});
