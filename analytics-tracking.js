// analytics-tracking.js — the site-wide "did anyone load this page at all"
// layer, plus everything derived from that: unique/returning visitors,
// traffic source, UTM attribution, device/browser/OS, and scroll depth.
//
// Complements, never replaces, session.js (per-tab session_id) and
// tracking.js (per-element ui_events clicks). Self-installing — including
// this file after config.js/session.js is all a page needs; it fires one
// page_views row on load and wires up scroll-depth tracking automatically.
// No explicit call required, matching tracking.js's own ergonomics.
//
// Consumers: index.html, listings.html, listing.html, agent.html.

(function () {
  var VISITOR_KEY = 'pintag_visitor_id';
  var VISIT_COUNT_KEY = 'pintag_visit_count';
  var VISIT_COUNTED_THIS_SESSION_KEY = 'pintag_visit_counted';
  var UTM_KEY = 'pintag_utm';

  function currentPage() {
    var seg = location.pathname.split('/').filter(Boolean).pop();
    return seg || 'index.html';
  }

  function uuid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : (
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        var v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      })
    );
  }

  // The first PERSISTENT (localStorage, survives across tabs/sessions) id
  // this codebase has ever recorded — session_id (session.js) is
  // deliberately per-tab-session only, so it can never answer "has this
  // person been here before." This is what makes unique/returning visitor
  // counts real instead of just re-derived session counts.
  function getOrCreateVisitorId() {
    try {
      var id = localStorage.getItem(VISITOR_KEY);
      if (!id) { id = uuid(); localStorage.setItem(VISITOR_KEY, id); }
      return id;
    } catch (e) { return null; }
  }

  // "Returning" = this visitor_id has now started more than one session,
  // ever. The sessionStorage guard makes the increment happen once per
  // browser-tab session (not once per page view within that session).
  function isReturningVisitor() {
    try {
      if (sessionStorage.getItem(VISIT_COUNTED_THIS_SESSION_KEY)) {
        return parseInt(localStorage.getItem(VISIT_COUNT_KEY) || '0', 10) > 1;
      }
      var count = parseInt(localStorage.getItem(VISIT_COUNT_KEY) || '0', 10) + 1;
      localStorage.setItem(VISIT_COUNT_KEY, String(count));
      sessionStorage.setItem(VISIT_COUNTED_THIS_SESSION_KEY, '1');
      return count > 1;
    } catch (e) { return false; }
  }

  // First-touch UTM attribution: captured once per session (sessionStorage),
  // so a visitor who lands via a campaign link and then browses several
  // pages still attributes every page_view in that session back to the
  // original campaign, rather than losing it the moment the URL no longer
  // carries the params.
  function captureUtm() {
    try {
      var stored = sessionStorage.getItem(UTM_KEY);
      if (stored) return JSON.parse(stored);
      var params = new URLSearchParams(location.search);
      var utm = {
        utm_source: params.get('utm_source') || null,
        utm_medium: params.get('utm_medium') || null,
        utm_campaign: params.get('utm_campaign') || null
      };
      sessionStorage.setItem(UTM_KEY, JSON.stringify(utm));
      return utm;
    } catch (e) { return { utm_source: null, utm_medium: null, utm_campaign: null }; }
  }

  // Buckets a raw referrer into the categories the product actually cares
  // about (matches the Traffic section's requested breakdown). Anything
  // recognized-but-not-listed falls to 'referral' with the raw domain kept
  // in the `referrer` column itself for a Top Referrers breakdown — this
  // classification is intentionally coarse, not a full attribution engine.
  function classifyReferrer(referrer) {
    if (!referrer) return 'direct';
    var host;
    try { host = new URL(referrer).hostname.replace(/^www\./, ''); } catch (e) { return 'direct'; }
    if (typeof location !== 'undefined' && host === location.hostname) return 'direct'; // internal nav between Pintag pages
    if (host.indexOf('google.') !== -1) return 'google';
    if (host.indexOf('facebook.com') !== -1 || host === 'fb.com' || host === 'm.facebook.com' || host === 'l.facebook.com') return 'facebook';
    if (host.indexOf('instagram.com') !== -1) return 'instagram';
    if (host.indexOf('tiktok.com') !== -1) return 'tiktok';
    if (host.indexOf('whatsapp.com') !== -1 || host === 'wa.me') return 'whatsapp';
    return 'referral';
  }

  // Lightweight regex UA parse -- not a full device-detection library (none
  // is allowed by this codebase's zero-external-dependency convention, and
  // public-page CSP blocks CDN script loading anyway), but the standard
  // set of substring checks covers the real-world distribution well enough
  // for "which browsers/OSes/device types are visitors actually using."
  function parseUserAgent(ua) {
    ua = ua || '';
    var device = 'desktop';
    if (/iPad|Tablet(?!.*Mobile)/i.test(ua)) device = 'tablet';
    else if (/Mobi|iPhone|iPod|Android.*Mobile/i.test(ua)) device = 'mobile';

    var browser = 'Other';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
    else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
    else if (/CriOS/.test(ua)) browser = 'Chrome';
    else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
    else if (/FxiOS/.test(ua) || /Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';

    var os = 'Other';
    if (/Windows/.test(ua)) os = 'Windows';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    return { device: device, browser: browser, os: os };
  }

  function postJson(table, row) {
    if (!window.PINTAG || !window.PINTAG.supabaseUrl) return;
    fetch(window.PINTAG.supabaseUrl + '/rest/v1/' + table, {
      method: 'POST',
      headers: {
        apikey: window.PINTAG.anonKey,
        Authorization: 'Bearer ' + window.PINTAG.anonKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row),
      keepalive: true
    }).catch(function () {});
  }

  function trackPageView() {
    var parsed = parseUserAgent(navigator.userAgent);
    var vw = window.innerWidth || 0;
    // Viewport-width cross-check: a UA that doesn't clearly say
    // mobile/tablet (e.g. an unrecognized browser) still gets a reasonable
    // device_type from actual screen size rather than defaulting blindly
    // to desktop.
    if (parsed.device === 'desktop' && vw > 0) {
      if (vw < 768) parsed.device = 'mobile';
      else if (vw < 1024) parsed.device = 'tablet';
    }
    var utm = captureUtm();
    postJson('page_views', {
      session_id: (typeof getOrCreateSessionId === 'function') ? getOrCreateSessionId() : null,
      visitor_id: getOrCreateVisitorId(),
      page: currentPage(),
      referrer: document.referrer || null,
      referrer_source: classifyReferrer(document.referrer),
      utm_source: utm.utm_source,
      utm_medium: utm.utm_medium,
      utm_campaign: utm.utm_campaign,
      lang: (typeof getCurrentLang === 'function') ? getCurrentLang() : (document.documentElement.getAttribute('lang') || null),
      device_type: parsed.device,
      browser: parsed.browser,
      os: parsed.os,
      viewport_width: vw || null,
      is_returning: isReturningVisitor()
    });
  }

  // Milestone-based scroll depth (25/50/75/100%), throttled to one check
  // per animation frame. Each milestone fires at most once per page view.
  // Reuses ui_events (event_type='scroll') rather than a new table --
  // element_id carries the milestone bucket, matching how this schema
  // already extends event_type instead of adding tables for a same-shape
  // signal (see listing_events' impression/click addition).
  function installScrollTracker() {
    var milestones = [25, 50, 75, 100];
    var fired = {};
    var ticking = false;
    function check() {
      ticking = false;
      var doc = document.documentElement;
      var scrollable = doc.scrollHeight - doc.clientHeight;
      if (scrollable <= 0) return;
      var pct = Math.min(100, Math.round(((window.pageYOffset || doc.scrollTop) / scrollable) * 100));
      milestones.forEach(function (m) {
        if (pct >= m && !fired[m]) {
          fired[m] = true;
          postJson('ui_events', {
            session_id: (typeof getOrCreateSessionId === 'function') ? getOrCreateSessionId() : null,
            page: currentPage(),
            element_id: String(m),
            element_type: 'scroll_depth',
            event_type: 'scroll',
            label: m + '%'
          });
        }
      });
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(check); }
    }, { passive: true });
  }

  function install() {
    trackPageView();
    installScrollTracker();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install);
    } else {
      install();
    }
  }

  // Exposes the pure classification helpers for Node-based unit testing
  // only -- the browser never takes this branch (no `module` global there).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyReferrer: classifyReferrer, parseUserAgent: parseUserAgent };
  }
})();
