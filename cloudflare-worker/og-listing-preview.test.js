// Unit + end-to-end tests for og-listing-preview.js -- run with
// `node --test cloudflare-worker/og-listing-preview.test.js`.
//
// AUDIT CONTEXT: written in response to a report that shared-link previews
// (WhatsApp/Facebook/Messenger) were always in Lao regardless of the
// ?lang= present in the shared URL, even though the page itself rendered
// in the correct language. Traced every step (request -> resolveLang() ->
// buildOgFields()/HOME_META_I18N/LISTINGS_META_I18N -> HTMLRewriter output)
// against the actual code -- see this repo's commit history and PR
// description for the full writeup. Conclusion: this file's language
// resolution and metadata generation are correct as written; every field
// (title, og:title, og:description, twitter:title, twitter:description,
// html[lang], og:locale) is threaded through the resolved `lang` with no
// point that silently falls back to the Lao default except an absent/
// invalid ?lang= value, exactly as intended. These tests exist to prove
// that with real assertions (not just re-read the source) and to catch
// any future regression here specifically, since this exact bug class
// ("preview always defaults to Lao") has already recurred once before
// (see commit abec21a, "i18n: fix share previews always Lao regardless of
// viewed language").
//
// Two layers of coverage:
//   1. Pure-logic tests (resolveLang/buildOgFields) -- no HTMLRewriter
//      needed, run directly against the real exported functions.
//   2. End-to-end tests that actually run rewriteListingHead()/
//      rewriteGenericHead() -- the functions that use the real
//      `HTMLRewriter` global, which only exists inside the Cloudflare
//      Workers runtime -- against a polyfill (./test/html-rewriter-
//      polyfill.js) fed REAL fixture HTML sliced from listing.html/
//      index.html/listings.html, and assert on the literal generated
//      <title>/og:title/og:description/og:locale/html[lang] strings. This
//      is what actually answers "does the Worker's OUTPUT change per
//      ?lang=", not just "does the intermediate data look right".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeHTMLRewriter } from './test/html-rewriter-polyfill.js';
// Must be set before any test calls rewriteListingHead()/rewriteGenericHead()
// -- both reference the `HTMLRewriter` global lazily (inside the function
// body, at call time), not at module-load time, so setting this after the
// static import above still works correctly.
globalThis.HTMLRewriter = FakeHTMLRewriter;

import {
  resolveLang,
  buildOgFields,
  rewriteListingHead,
  rewriteGenericHead,
  HOME_META_I18N,
  LISTINGS_META_I18N,
  withNoStore,
} from './og-listing-preview.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function extractHeadFixture(filePath) {
  // Real <head> content up to (not including) the first <style>/<script>
  // tag -- everything the Worker actually rewrites lives in that range;
  // the CSS/JS beyond it is irrelevant noise for this audit and would
  // just make the fixture enormous. Closed with a synthetic </head>
  // since the real close tag lives past the truncation point.
  const full = fs.readFileSync(filePath, 'utf8');
  const cut = full.search(/<style|<script/);
  assert.ok(cut > 0, `${filePath}: could not find a <style>/<script> boundary to truncate the fixture at`);
  return full.slice(0, cut) + '\n</head>\n</html>';
}

const REPO_ROOT = path.join(__dirname, '..');
const LISTING_FIXTURE = extractHeadFixture(path.join(REPO_ROOT, 'listing.html'));
const INDEX_FIXTURE = extractHeadFixture(path.join(REPO_ROOT, 'index.html'));
const LISTINGS_FIXTURE = extractHeadFixture(path.join(REPO_ROOT, 'listings.html'));

// Sanity: the fixtures must actually contain Lao text in their static
// defaults, or every test below would trivially "pass" without the
// polyfill/rewriter having done anything -- this is the same discipline
// as confirming a test can fail before trusting that it can pass.
test('fixture sanity: static defaults are Lao (html lang="lo"), so a rewrite is actually required to see en/zh', () => {
  for (const fixture of [LISTING_FIXTURE, INDEX_FIXTURE, LISTINGS_FIXTURE]) {
    assert.match(fixture, /<html lang="lo">/);
    assert.match(fixture, /<meta property="og:locale" content="lo_LA">/);
  }
});

test('resolveLang: valid values pass through unchanged', () => {
  assert.equal(resolveLang('lo'), 'lo');
  assert.equal(resolveLang('en'), 'en');
  assert.equal(resolveLang('zh'), 'zh');
});

test('resolveLang: only an absent or invalid value falls back to Lao', () => {
  assert.equal(resolveLang(null), 'lo');
  assert.equal(resolveLang(undefined), 'lo');
  assert.equal(resolveLang(''), 'lo');
  assert.equal(resolveLang('fr'), 'lo');
  assert.equal(resolveLang('LO'), 'lo'); // case-sensitive by design -- 'LO' isn't a recognized value
  assert.equal(resolveLang('en '), 'lo'); // no trimming -- an exact match is required
});

const ROW = {
  slug: 'riverside-villa',
  title_en: 'Riverside Villa', title_lo: 'ວິນລ່າຮິມແມ່ນ້ຳ', title_zh: '河畔别墅',
  description_en: 'A spacious villa by the Mekong.',
  description_lo: 'ວິນລ່າກວ້າງຂວາງຢູ່ຮິມແມ່ນ້ຳຂອງ.',
  description_zh: '',
  property_highlight_en: '', property_highlight_zh: '', property_highlight: '',
  images: ['https://example.com/photo1.jpg'],
  market_status: 'available',
  price_amount: 1200, price_currency: 'USD', price_frequency: 'monthly', price_display: null,
  transaction_type: 'for_rent',
  district_en: 'Sisattanak', district_lo: 'ສີສະຫວາດ', district_zh: '西萨塔纳',
};

test('buildOgFields: title/desc are fully localized per requested language, with no cross-language leakage', () => {
  const lo = buildOgFields(ROW, 'lo');
  assert.match(lo.title, /ວິນລ່າຮິມແມ່ນ້ຳ/);
  assert.match(lo.desc, /ວິນລ່າກວ້າງຂວາງຢູ່ຮິມແມ່ນ້ຳຂອງ/);
  assert.match(lo.desc, /ສີສະຫວາດ/); // district in Lao
  assert.doesNotMatch(lo.title, /Riverside Villa|河畔别墅/);

  const en = buildOgFields(ROW, 'en');
  assert.match(en.title, /Riverside Villa/);
  assert.match(en.desc, /A spacious villa by the Mekong/);
  assert.match(en.desc, /Sisattanak/);
  assert.doesNotMatch(en.title, /ວິນລ່າຮິມແມ່ນ້ຳ|河畔别墅/);

  const zh = buildOgFields(ROW, 'zh');
  assert.match(zh.title, /河畔别墅/);
  // description_zh is '' (falsy) on this row -> falls back to English per
  // the documented fallback chain (requested lang -> en -> lo), NOT to Lao
  // directly -- this is the one legitimate, non-bug fallback in the file.
  assert.match(zh.desc, /A spacious villa by the Mekong/);
  assert.match(zh.desc, /西萨塔纳/); // district_zh IS present, so it's used
  assert.doesNotMatch(zh.title, /Riverside Villa|ວິນລ່າຮິມແມ່ນ້ຳ/);
});

test('buildOgFields: an unavailable listing gets a localized status suffix in every language', () => {
  const row = Object.assign({}, ROW, { market_status: 'rented' });
  assert.match(buildOgFields(row, 'en').title, /Rented/);
  assert.match(buildOgFields(row, 'lo').title, /ເຊົ່າແລ້ວ/);
  assert.match(buildOgFields(row, 'zh').title, /已出租/);
});

test('rewriteListingHead: real listing.html fixture, ?lang=lo/en/zh each produce the correctly localized <title>/og:title/og:description/og:locale/html[lang]', async () => {
  const cases = [
    { lang: 'lo', title: 'ວິນລ່າຮິມແມ່ນ້ຳ', desc: 'ວິນລ່າກວ້າງຂວາງຢູ່ຮິມແມ່ນ້ຳຂອງ', locale: 'lo_LA' },
    { lang: 'en', title: 'Riverside Villa', desc: 'A spacious villa by the Mekong', locale: 'en_US' },
    { lang: 'zh', title: '河畔别墅', desc: '西萨塔纳', locale: 'zh_CN' }, // desc falls back to EN text but district_zh still appears
  ];

  for (const c of cases) {
    const result = await rewriteListingHead(LISTING_FIXTURE, ROW, c.lang, ROW.slug);
    const html = await result.text();

    assert.match(html, new RegExp(`<html lang="${c.lang}">`), `[${c.lang}] html[lang]`);
    assert.match(html, new RegExp(`<title>[^<]*${escapeRe(c.title)}`), `[${c.lang}] <title>`);
    assert.match(html, new RegExp(`<meta property="og:title" content="[^"]*${escapeRe(c.title)}`), `[${c.lang}] og:title`);
    assert.match(html, new RegExp(`<meta property="og:description" content="[^"]*${escapeRe(c.desc)}`), `[${c.lang}] og:description`);
    assert.match(html, new RegExp(`<meta name="twitter:title" content="[^"]*${escapeRe(c.title)}`), `[${c.lang}] twitter:title`);
    assert.match(html, new RegExp(`<meta name="twitter:description" content="[^"]*${escapeRe(c.desc)}`), `[${c.lang}] twitter:description`);
    assert.match(html, new RegExp(`<meta property="og:locale" content="${c.locale}">`), `[${c.lang}] og:locale`);
    assert.match(html, new RegExp(`<meta name="description" content="[^"]*${escapeRe(c.desc)}`), `[${c.lang}] meta description`);
    // og:url is an attribute value, so the literal "&" between query params
    // is HTML-entity-escaped ("&amp;") on serialization -- correct,
    // expected behavior, not a bug (matches how the real HTMLRewriter/any
    // HTML serializer must write attribute values).
    assert.match(html, new RegExp(`<meta property="og:url" content="https://pintag\\.io/listing\\.html\\?slug=riverside-villa&amp;lang=${c.lang}">`), `[${c.lang}] og:url carries the same lang`);
  }
});

test('rewriteListingHead: the three languages produce genuinely different output for the same row (no silent Lao collapse)', async () => {
  const lo = await (await rewriteListingHead(LISTING_FIXTURE, ROW, 'lo', ROW.slug)).text();
  const en = await (await rewriteListingHead(LISTING_FIXTURE, ROW, 'en', ROW.slug)).text();
  const zh = await (await rewriteListingHead(LISTING_FIXTURE, ROW, 'zh', ROW.slug)).text();
  assert.notEqual(lo, en);
  assert.notEqual(lo, zh);
  assert.notEqual(en, zh);
});

test('rewriteGenericHead: real index.html fixture localizes per language via HOME_META_I18N', async () => {
  for (const lang of ['lo', 'en', 'zh']) {
    const html = await (await rewriteGenericHead(INDEX_FIXTURE, lang, HOME_META_I18N)).text();
    const t = HOME_META_I18N[lang];
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    assert.match(html, new RegExp(`<title>${escapeRe(t.title)}</title>`));
    assert.match(html, new RegExp(`<meta property="og:title" content="${escapeRe(escapeAttr(t.title))}">`));
    assert.match(html, new RegExp(`<meta property="og:description" content="${escapeRe(escapeAttr(t.desc))}">`));
    const expectedLocale = { lo: 'lo_LA', en: 'en_US', zh: 'zh_CN' }[lang];
    assert.match(html, new RegExp(`<meta property="og:locale" content="${expectedLocale}">`));
  }
});

test('rewriteGenericHead: real listings.html fixture localizes per language via LISTINGS_META_I18N', async () => {
  for (const lang of ['lo', 'en', 'zh']) {
    const html = await (await rewriteGenericHead(LISTINGS_FIXTURE, lang, LISTINGS_META_I18N)).text();
    const t = LISTINGS_META_I18N[lang];
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    // <title> is text content (unescaped by the rewriter); og:title is an
    // attribute value, so "&" in the English copy ("Rent & Sale") comes
    // out as "&amp;" there -- expected HTML-attribute serialization, not
    // a language bug.
    assert.match(html, new RegExp(`<title>${escapeRe(t.title)}</title>`));
    assert.match(html, new RegExp(`<meta property="og:title" content="${escapeRe(escapeAttr(t.title))}">`));
    assert.match(html, new RegExp(`<meta property="og:description" content="${escapeRe(escapeAttr(t.desc))}">`));
  }
});

test('rewriteGenericHead: an unrecognized language falls back to the DEFAULT_LANG (lo) copy, not a thrown error', async () => {
  // Exercises the i18n[lang] || i18n[DEFAULT_LANG] fallback directly --
  // this function receives an already-resolved lang from resolveLang(), so
  // in the real request path this branch only fires if resolveLang()
  // itself were bypassed; still worth confirming it degrades safely rather
  // than crashing or emitting undefined text.
  const html = await (await rewriteGenericHead(INDEX_FIXTURE, 'fr', HOME_META_I18N)).text();
  assert.match(html, new RegExp(`<title>${escapeRe(HOME_META_I18N.lo.title)}</title>`));
});

test('withNoStore: forces Cache-Control: no-store, preserving status/body/other headers, regardless of what the origin sent', () => {
  // The one hardening added alongside this audit: correct language
  // resolution can still LOOK like "always Lao" if a cache in front of the
  // Worker (e.g. a Cloudflare Cache Rule that ignores the query string for
  // .html paths) collapses every ?lang= variant of the same path onto one
  // cached response. This guarantees the Worker's own response can never
  // be cached, regardless of that external configuration -- see the
  // function's own comment in og-listing-preview.js for the full
  // reasoning.
  const origin = new Response('<html>hi</html>', {
    status: 200,
    headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=600' },
  });
  const out = withNoStore(origin);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get('content-type'), 'text/html');
  assert.equal(out.headers.get('cache-control'), 'no-store');
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mirrors html-rewriter-polyfill.js's serializeTag() attribute escaping --
// used when asserting on attribute *values* (content="..."), as opposed to
// element text content (<title>...</title>), which the rewriter does not
// escape. Real HTML serializers escape "&"/`"`/"<" in attribute values;
// asserting on the raw, unescaped string would make a test fail for
// reasons that have nothing to do with language resolution.
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
