// Regression tests for the customer-first homepage redirect ("/" and
// "/index.html" -> "/listings.html", implemented in
// cloudflare-worker/og-listing-preview.js -- see that file's own test suite,
// cloudflare-worker/og-listing-preview.test.js, for the redirect/maintenance-
// mode behavior itself).
//
//   node --test homepage-redirect.test.js
//
// This file covers what the redirect implies for the STATIC PAGES and their
// navigation, which live outside the Worker:
//   - listings.html is now the de facto public entry page, so its logo must
//     point at "/" (not the old "index.html", which now just redirects back
//     here) and its old "-> Home" link must be gone -- left in place, it
//     would bounce a visitor straight back to the page they're already on.
//   - agent/seller functionality ("for-agents.html") must remain reachable
//     from listings.html via a small, non-primary footer link, since
//     index.html's old nav ("Agent login") and footer ("For Agents") are no
//     longer part of the public entry path.
//   - every other public page's logo (listing.html, for-agents.html,
//     agent.html, agents.html) must be repointed the same way, so clicking
//     "home" from any of them lands through the one redirect rule instead of
//     a hard-coded page.
//   - index.html itself must be completely untouched (dormant, not
//     redesigned) -- the product may reinstate it later.
//   - analytics-inspector.html's "Homepage opened" first-entry inference must
//     recognize listings.html (not just the old index.html) as the entry
//     page, or every real session's timeline silently loses its "🏠
//     Homepage opened" marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
function read(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }

// ── listings.html: the new de facto entry page ──────────────────────────
test('listings.html: nav-logo points at "/" (not the old index.html, which now just redirects back here)', () => {
  const html = read('listings.html');
  assert.match(html, /<a href="\/" class="nav-logo">/);
  assert.doesNotMatch(html, /<a href="index\.html" class="nav-logo">/);
});

test('listings.html: the old "<- Home" link (nav-home) is gone -- it would otherwise loop straight back to this same page', () => {
  const html = read('listings.html');
  assert.doesNotMatch(html, /class="nav-home"/);
  assert.doesNotMatch(html, /<a href="index\.html"/, 'no remaining href="index.html" anywhere in listings.html');
});

test('listings.html: a small, non-primary "For Agents" footer link keeps agent/seller functionality reachable', () => {
  const html = read('listings.html');
  const footerMatch = html.match(/<footer class="pt-footer">[\s\S]*?<\/footer>/);
  assert.ok(footerMatch, 'expected a <footer class="pt-footer"> block');
  assert.match(footerMatch[0], /href="for-agents\.html"/);
  // Non-primary by construction: a single small footer link, not a nav item
  // or a prominent CTA button -- assert it does NOT appear inside <nav>.
  const navMatch = html.match(/<nav>[\s\S]*?<\/nav>/);
  assert.ok(navMatch, 'expected a <nav> block');
  assert.doesNotMatch(navMatch[0], /for-agents\.html/, 'For Agents must not be promoted into the primary nav');
});

// ── Every other public page's logo now goes through the one redirect rule ──
for (const page of ['listing.html', 'for-agents.html', 'agent.html', 'agents.html']) {
  test(`${page}: nav-logo points at "/" (repointed off the old index.html target)`, () => {
    const html = read(page);
    assert.match(html, /<a href="\/" class="nav-logo">/, `${page}: nav-logo should link to "/"`);
    assert.doesNotMatch(html, /<a href="index\.html" class="nav-logo">/, `${page}: no stale index.html nav-logo target`);
  });
}

// ── index.html itself: dormant, not redesigned ──────────────────────────
test('index.html: left completely untouched -- still the buyer/seller split homepage, still self-referential (dormant, reachable only by direct link once the Worker redirects "/" away from it)', () => {
  const html = read('index.html');
  assert.match(html, /<a href="index\.html" class="nav-logo">/);
  assert.match(html, /<a href="index\.html" class="footer-brand">/);
  assert.match(html, /panel-buyer/);
  assert.match(html, /panel-agent/);
  assert.match(html, /nav-agent-btn/);
});

// ── cloudflare-worker/wrangler.toml: routing config unchanged ───────────
// The redirect is implemented inside the Worker's own JS logic (fetch()),
// not by changing which paths route to it -- the Worker must keep fronting
// exactly the same four patterns it always has.
test('cloudflare-worker/wrangler.toml: still fronts "/", "/index.html*", "/listings.html*", "/listing.html*" -- unchanged by the redirect feature', () => {
  const toml = read('cloudflare-worker/wrangler.toml');
  for (const pattern of ['pintag.io/listing.html*', 'pintag.io/listings.html*', 'pintag.io/', 'pintag.io/index.html*']) {
    assert.match(toml, new RegExp(`pattern = "${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), `missing route pattern: ${pattern}`);
  }
});

// ── analytics-inspector.html: "Homepage opened" recognizes the new entry page ──
// Extracts the REAL pageMarkerDisplay() function shipped in the page (same
// "test the actual extracted source" convention as xss-inline-handlers.test.js's
// extractFn()), so a future edit that silently narrows the check back to only
// 'index.html' fails here.
function extractFn(file, name) {
  const src = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
function loadFn(file, name) {
  const ctx = vm.createContext({});
  vm.runInContext(extractFn(file, name) + ';' + name, ctx);
  return vm.runInContext(name, ctx);
}

const pageMarkerDisplay = loadFn('analytics-inspector.html', 'pageMarkerDisplay');

test('analytics-inspector.html pageMarkerDisplay(): the first page of a session gets the "Homepage opened" marker for listings.html, the new public entry page', () => {
  const d = pageMarkerDisplay('listings.html', true);
  assert.equal(d.icon, '🏠');
  assert.equal(d.title, 'Homepage opened (inferred)');
});

test('analytics-inspector.html pageMarkerDisplay(): index.html is still recognized too (historical rows / Worker fail-open case)', () => {
  const d = pageMarkerDisplay('index.html', true);
  assert.equal(d.icon, '🏠');
  assert.equal(d.title, 'Homepage opened (inferred)');
});

test('analytics-inspector.html pageMarkerDisplay(): only the FIRST page of a session is "Homepage opened" -- a later visit to listings.html is just "Opened listings.html"', () => {
  const d = pageMarkerDisplay('listings.html', false);
  assert.equal(d.icon, '📄');
  assert.equal(d.title, 'Opened listings.html (inferred)');
});

test('analytics-inspector.html pageMarkerDisplay(): a first page that is neither index.html nor listings.html (e.g. a direct deep link to listing.html) is not mislabeled "Homepage opened"', () => {
  const d = pageMarkerDisplay('listing.html', true);
  assert.equal(d.icon, '📄');
  assert.equal(d.title, 'Opened listing.html (inferred)');
});
