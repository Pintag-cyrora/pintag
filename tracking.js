// tracking.js — first-party UI/product analytics (ui_events).
//
// Complements, never replaces, the existing business-intelligence event
// stream (search_events / listing_events / lead_events — see session.js
// for the shared session_id spine both layers use). This layer exists to
// answer UX questions the BI tables aren't shaped for: does anyone use the
// map toggle, does anyone expand the description, which filter gets
// touched before someone leaves.
//
// Usage: add data-track="<id>" to any clickable element and it is tracked
// automatically via event delegation on document.body — no per-button JS,
// no trackButton() calls to wire up. Optional attributes on the same
// element:
//   data-track-label="..."        human label (defaults to trimmed text content)
//   data-track-type="..."         element_type (defaults to the tag name)
//   data-track-meta='{"k":"v"}'   extra JSON merged into `metadata`
//   data-track-property-id="..."  property this element refers to, if any
//
// <select>/<input>/<textarea> also delegate on `change` (a native select's
// option list isn't a real DOM click target, so click alone never reveals
// which option was picked) — the control's current .value is merged into
// metadata automatically as `value` for these, no extra attribute needed.
// On single-property pages (listing.html), set
// window.PINTAG_CURRENT_PROPERTY_ID once the property loads and every
// data-track element on that page inherits it without needing the
// attribute individually.
//
// Fire-and-forget, never blocks navigation (keepalive POST, no await).
// Rapid duplicate clicks on the very same element within 300ms are
// dropped client-side (accidental double-click), matching the burst-limit
// pattern already used for listing_events/search_events server-side.
//
// Consumers: index.html, listings.html, listing.html, agent.html.

(function () {
  var DEDUP_MS = 300;
  var lastFired = new WeakMap(); // element -> last-fired timestamp

  function currentPage() {
    var seg = location.pathname.split('/').filter(Boolean).pop();
    return seg || 'index.html';
  }

  function postUiEvent(row) {
    if (!window.PINTAG || !window.PINTAG.supabaseUrl) return;
    fetch(window.PINTAG.supabaseUrl + '/rest/v1/ui_events', {
      method: 'POST',
      headers: {
        'apikey': window.PINTAG.anonKey,
        'Authorization': 'Bearer ' + window.PINTAG.anonKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(row),
      keepalive: true
    }).catch(function () {});
  }

  var VALUE_TAGS = { SELECT: true, INPUT: true, TEXTAREA: true };

  function handleTrackedEvent(e) {
    var el = e.target.closest('[data-track]');
    if (!el) return;
    // Buttons/links/cards fire on click; form controls fire on change
    // (a select's native option list never dispatches a click we can see).
    // Ignore the click half of a form control's pair so it isn't double-fired.
    if (e.type === 'click' && VALUE_TAGS[el.tagName]) return;

    var now = Date.now();
    var last = lastFired.get(el);
    if (last && (now - last) < DEDUP_MS) return;
    lastFired.set(el, now);

    var meta = null;
    var metaAttr = el.getAttribute('data-track-meta');
    if (metaAttr) {
      try { meta = JSON.parse(metaAttr); } catch (err) { meta = null; }
    }
    if (VALUE_TAGS[el.tagName]) {
      meta = meta || {};
      meta.value = el.value;
    }

    postUiEvent({
      session_id: (typeof getOrCreateSessionId === 'function') ? getOrCreateSessionId() : null,
      page: currentPage(),
      element_id: el.getAttribute('data-track'),
      element_type: el.getAttribute('data-track-type') || el.tagName.toLowerCase(),
      label: el.getAttribute('data-track-label') || (el.textContent || '').trim().slice(0, 120) || null,
      property_id: el.getAttribute('data-track-property-id') || window.PINTAG_CURRENT_PROPERTY_ID || null,
      metadata: meta
    });
  }

  function install() {
    document.body.addEventListener('click', handleTrackedEvent, true);
    document.body.addEventListener('change', handleTrackedEvent, true);
  }

  if (document.body) install();
  else document.addEventListener('DOMContentLoaded', install);
})();
