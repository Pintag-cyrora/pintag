// Regression guard for the impressions redesign: every impression producer
// in the app (search/grid, Similar Properties, homepage, agent profile) must
// use the viewport-based mechanism -- one unbatched POST per card, sent only
// once a card has been >=50% visible for a continuous 500ms via components.js's
// shared _ptObserveForImpression()/_ptReleaseImpressionObserver() -- never the
// old "post one impression row per rendered card, all batched into a single
// array, the instant the fetch resolves" mechanism this replaced. That old
// shape was demonstrated to be unsafe: a single duplicate row in the batch
// aborts the ENTIRE INSERT under RLS's atomic bulk-insert behavior, silently
// dropping every other legitimate impression in the same batch.
//
// This file scans every top-level .html/.js source file (the same
// non-recursive convention as static-contact-links.test.js -- app pages and
// shared components live at repo root; tests/, supabase/, and node_modules/
// are deliberately out of scope).
//
//   node --test no-legacy-batch-impressions.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROOT = new URL('.', import.meta.url);
const SELF = 'no-legacy-batch-impressions.test.js';
const SOURCE_FILES = fs.readdirSync(ROOT).filter((f) => (f.endsWith('.html') || f.endsWith('.js')) && f !== SELF);

test('every postEvent(\'listing_events\', ...) call passes a single inline object, never a batched array/variable', () => {
  // The old batch producers all shared the same tell: the row(s) were built
  // separately (via .map()) and the resulting ARRAY was passed by reference
  // as postEvent's second argument -- postEvent('listing_events', rows) /
  // postEvent('listing_events',impressionRows). Every current call (click,
  // view, contact, save, share, and the new single-attempt impression calls)
  // instead passes an inline object literal directly, so checking that the
  // first non-whitespace character after the comma is '{' is a precise,
  // low-false-positive way to catch a reintroduced batch, regardless of
  // whether it's built via .map(), an array literal, or anything else.
  const offenders = [];
  for (const file of SOURCE_FILES) {
    const src = fs.readFileSync(new URL('./' + file, ROOT), 'utf8');
    for (const m of src.matchAll(/postEvent\(\s*['"]listing_events['"]\s*,\s*(\S)/g)) {
      if (m[1] !== '{') offenders.push({ file, next: m[1] });
    }
  }
  assert.deepEqual(offenders, [], 'postEvent("listing_events", ...) called with something other than an inline object literal: ' + JSON.stringify(offenders));
});

test('every known impression surface wires into the shared viewport observer', () => {
  // Absence of the old pattern (above) is not proof the new one is present --
  // this closes that gap by requiring each of the four surfaces to reference
  // the shared mechanism, either via renderPropertyCard/renderPropertyPreview's
  // opts.trackImpression (listings.html, listing.html, index.html) or a direct
  // _ptObserveForImpression() call (agent.html's hand-rolled cards).
  const IMPRESSION_SURFACES = ['listings.html', 'listing.html', 'index.html', 'agent.html'];
  for (const file of IMPRESSION_SURFACES) {
    const src = fs.readFileSync(new URL('./' + file, ROOT), 'utf8');
    const usesSharedObserver = /trackImpression\s*:/.test(src) || /_ptObserveForImpression\(/.test(src);
    assert.ok(usesSharedObserver, `${file} does not reference trackImpression/_ptObserveForImpression`);
  }
});

test('no page defines its own legacy batch-impression helper function', () => {
  // Pins the two functions removed in this change so they can't quietly come
  // back under a new page (postHomepageImpressions was index.html's; the
  // equivalent inline block in agent.html and listing.html had no named
  // function, but this still guards the one that did have a name, plus any
  // future reintroduction using the same one).
  const src = SOURCE_FILES.map((f) => fs.readFileSync(new URL('./' + f, ROOT), 'utf8')).join('\n');
  assert.doesNotMatch(src, /function\s+postHomepageImpressions\s*\(/);
});
