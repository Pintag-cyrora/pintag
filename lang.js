// lang.js — the single source of truth for how Pintag resolves which of
// the three supported languages (en/lo/zh) a given page view renders in.
// Every page with a language switcher (index.html, listings.html,
// listing.html) loads this before its own inline script and calls
// resolvePintagLang() exactly once, at init, before any metadata or
// content is rendered in a specific language.
//
// Precedence, highest to lowest:
//   1. ?lang= in the URL -- explicit, and the ONLY signal a server-side
//      crawler/Worker can ever see (see cloudflare-worker/og-listing-preview.js,
//      which mirrors this exact precedence server-side for the metadata it
//      rewrites -- kept in sync with this file's logic by hand, since a
//      Cloudflare Worker runs in a separate deploy from the static site and
//      can't literally import a browser file).
//   2. a previously persisted choice (localStorage) -- sticky across visits
//      once a visitor has explicitly picked a language via the nav switcher.
//   3. the browser's own language (navigator.language), mapped to our 3
//      supported languages by prefix match.
//   4. 'lo' -- the final fallback (Laos-based site). Never a hardcoded
//      override of an actual signal above it -- this is the literal answer
//      to "don't hardcode Lao as the metadata language, only as the
//      fallback when nothing else resolved."
//
// Whenever the resolution did NOT come from an explicit ?lang= (i.e. it
// used the persisted preference, the browser-language fallback, or the
// final default), the caller MUST reflect the resolved language back into
// the URL bar via reflectLangInUrl() below. Without this, a resolution
// based on localStorage or navigator.language can never survive being
// copy-pasted into WhatsApp/Facebook/Telegram -- those crawlers see only
// the raw URL, never a visitor's browser storage. Reflecting the resolved
// language into ?lang= is what makes "share the page I'm looking at"
// actually preserve the language I'm looking at it in.
var PINTAG_VALID_LANGS = ['en', 'lo', 'zh'];
var PINTAG_LANG_STORAGE_KEY = 'pintag_lang';
var PINTAG_DEFAULT_LANG = 'lo';

function _pintagLangFromBrowser() {
  try {
    var candidates = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language];
    for (var i = 0; i < candidates.length; i++) {
      var raw = String(candidates[i] || '').toLowerCase();
      if (raw.indexOf('zh') === 0) return 'zh';
      if (raw.indexOf('en') === 0) return 'en';
      if (raw.indexOf('lo') === 0) return 'lo';
    }
  } catch (e) {}
  return null;
}

// resolvePintagLang() -- call once at page init, before rendering anything
// language-specific. Pure read; never mutates the URL or storage itself
// (see persistPintagLang()/reflectLangInUrl() for the write side, called
// separately so this function stays a simple, side-effect-free resolver).
function resolvePintagLang() {
  try {
    var urlLang = new URLSearchParams(window.location.search).get('lang');
    if (urlLang && PINTAG_VALID_LANGS.indexOf(urlLang) !== -1) return urlLang;
  } catch (e) {}
  try {
    var stored = localStorage.getItem(PINTAG_LANG_STORAGE_KEY);
    if (stored && PINTAG_VALID_LANGS.indexOf(stored) !== -1) return stored;
  } catch (e) {}
  var browserLang = _pintagLangFromBrowser();
  if (browserLang) return browserLang;
  return PINTAG_DEFAULT_LANG;
}

// Persists an explicit user choice so it's remembered on the next visit
// even without ?lang= in the URL. Call from every language-switcher click
// handler (setLang() on each page), alongside reflectLangInUrl().
function persistPintagLang(lang) {
  try { localStorage.setItem(PINTAG_LANG_STORAGE_KEY, lang); } catch (e) {}
}

// Reflects the resolved language into the current URL's ?lang= param via
// history.replaceState -- no navigation, no reload -- so that copying the
// address bar (or a raw share of window.location.href) always carries the
// language actually being viewed, regardless of which precedence tier
// produced it. Idempotent: a no-op when the URL already has this exact
// value.
function reflectLangInUrl(lang) {
  try {
    var url = new URL(window.location.href);
    if (url.searchParams.get('lang') === lang) return;
    url.searchParams.set('lang', lang);
    history.replaceState(null, '', url.toString());
  } catch (e) {}
}
