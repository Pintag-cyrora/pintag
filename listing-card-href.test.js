// Listing-card links preserve the visitor's current Pintag language.
//   node --test listing-card-href.test.js
//
// THE BUG. Card links were built as `listing.html?slug=<slug>` with no language,
// so a link copied from (or shared out of) a card while browsing in English
// carried no ?lang=. The Cloudflare Worker builds the WhatsApp/Facebook link
// preview from ?lang= alone and treats its absence as the Lao default, so that
// link unfurled in Lao. The fix: _ptListingHref(p, lang) appends &lang= (after
// the slug/id, which every consumer already reads first) when the caller passes
// a supported language.
//
// What these defend:
//   - lang=en / lo / zh are carried onto the URL;
//   - the slug part is byte-for-byte what it was (same encoding, same position);
//   - no lang, or an unsupported one, leaves the URL EXACTLY as before — so a
//     caller that doesn't know the language (Lao-only agent pages, dashboard)
//     is untouched;
//   - the ?id= fallback for slugless rows and the bare fallback keep working;
//   - nothing is ever injected through `lang`.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for (const f of ['lang.js', 'currency.js', 'terminology.js', 'unit-availability.js', 'listing-status.js', 'components.js']) {
  vm.runInThisContext(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8'), { filename: f });
}
const { _ptListingHref } = globalThis;

// ── 1 / 2. the language is carried ─────────────────────────────────────────
test('English page -> the card URL carries lang=en', () => {
  assert.equal(_ptListingHref({ slug: 'riverside-apartment-123' }, 'en'), 'listing.html?slug=riverside-apartment-123&lang=en');
});

test('Lao page -> the card URL carries lang=lo', () => {
  assert.equal(_ptListingHref({ slug: 'riverside-apartment-123' }, 'lo'), 'listing.html?slug=riverside-apartment-123&lang=lo');
});

test('Chinese page -> the card URL carries lang=zh', () => {
  assert.equal(_ptListingHref({ slug: 'riverside-apartment-123' }, 'zh'), 'listing.html?slug=riverside-apartment-123&lang=zh');
});

// ── 3. existing slug behaviour is intact ───────────────────────────────────
test('with no language the URL is exactly what it always was', () => {
  assert.equal(_ptListingHref({ slug: 'riverside-apartment-123' }), 'listing.html?slug=riverside-apartment-123');
  assert.equal(_ptListingHref({ slug: 'riverside-apartment-123' }, undefined), 'listing.html?slug=riverside-apartment-123');
  assert.equal(_ptListingHref({ slug: 'riverside-apartment-123' }, null), 'listing.html?slug=riverside-apartment-123');
  assert.equal(_ptListingHref({ slug: 'riverside-apartment-123' }, ''), 'listing.html?slug=riverside-apartment-123');
});

test('the slug is encoded exactly as before, and stays the FIRST parameter', () => {
  const slug = 'café & b/c?x=1#y';
  const before = 'listing.html?slug=' + encodeURIComponent(slug);
  assert.equal(_ptListingHref({ slug }), before);
  assert.equal(_ptListingHref({ slug }, 'en'), before + '&lang=en');
  // The reader every consumer uses (scroll-restore, listing.html's ?slug=) still gets the whole slug.
  const u = new URL('https://pintag.io/' + _ptListingHref({ slug }, 'en'));
  assert.equal(u.searchParams.get('slug'), slug);
  assert.equal(u.searchParams.get('lang'), 'en');
  assert.equal(/[?&]slug=([^&]+)/.exec(_ptListingHref({ slug }, 'en'))[1], encodeURIComponent(slug));
});

test('a Lao-script slug is percent-encoded and still round-trips', () => {
  const slug = 'ຝາ-123';
  const href = _ptListingHref({ slug }, 'lo');
  assert.equal(href, 'listing.html?slug=' + encodeURIComponent(slug) + '&lang=lo');
  assert.equal(new URL('https://pintag.io/' + href).searchParams.get('slug'), slug);
});

test('slugless rows still link by ?id=, with the language appended after it', () => {
  assert.equal(_ptListingHref({ id: 'abc-123' }), 'listing.html?id=abc-123');
  assert.equal(_ptListingHref({ id: 'abc-123' }, 'en'), 'listing.html?id=abc-123&lang=en');
  assert.equal(_ptListingHref({ slug: '', id: 'abc-123' }, 'lo'), 'listing.html?id=abc-123&lang=lo');
});

test('a row with neither slug nor id still gets the bare page (no dangling params)', () => {
  assert.equal(_ptListingHref({}), 'listing.html');
  assert.equal(_ptListingHref({}, 'en'), 'listing.html');
  assert.equal(_ptListingHref(null, 'en'), 'listing.html');
  assert.equal(_ptListingHref(undefined), 'listing.html');
});

// ── hardening: only supported languages ever reach the URL ─────────────────
test('an unsupported or hostile language value never reaches the URL', () => {
  for (const bad of ['fr', 'EN', 'en ', 'lo&x=1', 'en#frag', '../..', '<script>', 'th', 0, {}, []]) {
    assert.equal(_ptListingHref({ slug: 's' }, bad), 'listing.html?slug=s', 'rejected: ' + JSON.stringify(bad));
  }
});

test('the supported set is lang.js\'s own list, not a second copy that can drift', () => {
  for (const l of globalThis.PINTAG_VALID_LANGS) {
    assert.equal(_ptListingHref({ slug: 's' }, l), 'listing.html?slug=s&lang=' + l);
  }
  const src = fs.readFileSync(new URL('./components.js', import.meta.url), 'utf8');
  assert.match(src, /typeof PINTAG_VALID_LANGS !== 'undefined'/, 'components.js reads lang.js\'s list when loaded');
});

// ── the card builders hand the page's language through, and only when given ─
test('every _ptListingHref call site in the shared builders passes the caller\'s opts.lang', () => {
  const src = fs.readFileSync(new URL('./components.js', import.meta.url), 'utf8');
  const calls = src.match(/_ptListingHref\([^)]*\)/g).filter((c) => c.indexOf('function') < 0 && c !== '_ptListingHref(p, lang)');
  // renderPropertyCard + renderPropertyPreview, passing the RAW opts.lang (not the 'en'-defaulted local)
  assert.deepEqual(calls, ['_ptListingHref(p, opts.lang)', '_ptListingHref(p, opts.lang)']);
});

test('the map-preview "View" link in listings.html passes the page language too', () => {
  // showMapPreview() builds this link outside the shared card builders, so it needs its own guard.
  const src = fs.readFileSync(new URL('./listings.html', import.meta.url), 'utf8');
  assert.match(src, /getElementById\('mp-view-btn'\)\.href = _ptListingHref\(p, lang\);/);
  assert.doesNotMatch(src, /_ptListingHref\(p\)/, 'no call site left without the language');
});
