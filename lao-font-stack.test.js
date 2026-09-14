// Regression guard for the self-hosted Phetsarath Lao font (2026-09-13).
//   node --test lao-font-stack.test.js
//
// WHY THIS FILE EXISTS
// --------------------
// Phetsarath was inserted into the EXISTING 'DM Sans'/'Noto Sans Lao'/
// 'Noto Sans SC' stack, immediately after DM Sans, across every one of its
// ~79 hand-duplicated occurrences in 16 top-level HTML files (this codebase
// has no single shared stylesheet/token governing body-level font-family —
// see each page's own <style>). There is no compiler/linter that would catch
// a future edit reintroducing a stack without Phetsarath, or a page that
// forgets its own @font-face pair, so this file audits the raw HTML source
// directly, plus the actual font files on disk and the CSP meta tag (which
// must stay unchanged: this font is self-hosted specifically so 'font-src'
// never needs to widen to a third-party CDN).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const PAGES = [
  'listing.html', 'listings.html', 'index.html', 'admin.html', 'agent.html',
  'agents.html', 'for-agents.html', 'dashboard.html', 'intelligence.html',
  'analytics.html', 'analytics-inspector.html', 'edit-listing.html',
  'agent-login.html', 'add-property.html', 'og-preview-gen.html',
  'og-preview-listings-gen.html',
];

function read(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }

test('the two Phetsarath font files and the OFL license/notice file exist on disk', () => {
  for (const f of ['fonts/phetsarath-regular.woff2', 'fonts/phetsarath-bold.woff2', 'fonts/OFL.txt']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' is missing');
  }
  // Sane, non-empty binary sizes -- catches an accidental empty/truncated commit.
  assert.ok(fs.statSync(path.join(ROOT, 'fonts/phetsarath-regular.woff2')).size > 5000);
  assert.ok(fs.statSync(path.join(ROOT, 'fonts/phetsarath-bold.woff2')).size > 5000);
});

test('the OFL license file carries the required copyright/license notice (OFL condition of redistribution)', () => {
  const txt = read('fonts/OFL.txt');
  assert.match(txt, /Ministry of Posts and Telecommunications, Laos/);
  assert.match(txt, /SIL Open Font License/);
});

for (const page of PAGES) {
  test(`${page}: every "Noto Sans Lao" font-family occurrence is immediately preceded by Phetsarath (never a bare stack)`, () => {
    const html = read(page);
    // Match either quote style, with or without a leading 'DM Sans', -- the
    // two shapes this codebase actually uses (see grep audit, 2026-09-13):
    //   'DM Sans','Noto Sans Lao','Noto Sans SC',sans-serif[!important]?
    //   'Noto Sans Lao',sans-serif   (a couple of admin-tool pages)
    const stacks = [...html.matchAll(/font-family:([^;]*Noto Sans Lao[^;]*);/g)].map((m) => m[1]);
    assert.ok(stacks.length > 0, `expected at least one Lao font-family stack in ${page}`);
    stacks.forEach((stack) => {
      assert.match(stack, /Phetsarath/, `${page}: stack "${stack}" is missing Phetsarath`);
      // Phetsarath must come BEFORE Noto Sans Lao (so it's tried first for
      // Lao glyphs), and immediately after DM Sans when DM Sans is present --
      // never re-ordered to the front (which would affect Latin) or dropped.
      const phIdx = stack.indexOf('Phetsarath');
      const laoIdx = stack.indexOf('Noto Sans Lao');
      assert.ok(phIdx < laoIdx, `${page}: Phetsarath must precede Noto Sans Lao in "${stack}"`);
      if (/DM Sans/.test(stack)) {
        const dmIdx = stack.indexOf('DM Sans');
        assert.ok(dmIdx < phIdx, `${page}: DM Sans must still precede Phetsarath in "${stack}" (Latin/Chinese must keep resolving to DM Sans first)`);
      }
    });
  });

  test(`${page}: declares both Phetsarath @font-face weights (400 regular, 700 bold), self-hosted under fonts/`, () => {
    const html = read(page);
    const faces = [...html.matchAll(/@font-face\{font-family:'Phetsarath';[^}]*\}/g)].map((m) => m[0]);
    assert.equal(faces.length, 2, `expected exactly 2 Phetsarath @font-face rules in ${page}, found ${faces.length}`);
    const weights = faces.map((f) => (f.match(/font-weight:(\d+)/) || [])[1]).sort();
    assert.deepEqual(weights, ['400', '700']);
    faces.forEach((f) => {
      assert.match(f, /url\('fonts\/phetsarath-(regular|bold)\.woff2'\) format\('woff2'\)/, `${page}: @font-face must reference the self-hosted fonts/ path, not an external CDN`);
      assert.match(f, /font-display:swap/);
    });
  });
}

test('CSP font-src is unchanged: still same-origin + fonts.gstatic.com only, no third-party CDN added for fonts', () => {
  // Spot-check a representative sample rather than every page -- the CSP
  // meta tag itself is generated/kept identical across all pages by
  // scripts/apply-csp.mjs, which is out of scope for this font change.
  for (const page of ['listings.html', 'listing.html', 'index.html']) {
    const html = read(page);
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert.ok(m, `${page}: CSP meta tag missing`);
    const fontSrc = (m[1].match(/font-src ([^;]+);/) || [])[1];
    assert.ok(fontSrc, `${page}: no font-src directive found`);
    assert.equal(fontSrc, "'self' data: https://fonts.gstatic.com", `${page}: font-src must stay self+gstatic only (Phetsarath is self-hosted, not loaded from a CDN) -- got "${fontSrc}"`);
  }
});

test('the Google Fonts <link> tag (Noto Sans Lao\'s own CDN source) is untouched -- Phetsarath does not replace it, only supplements it', () => {
  for (const page of ['listings.html', 'listing.html', 'index.html']) {
    const html = read(page);
    assert.match(html, /fonts\.googleapis\.com\/css2\?family=[^"]*Noto\+Sans\+Lao/, `${page}: still loads Noto Sans Lao from Google Fonts as the fallback`);
  }
});
