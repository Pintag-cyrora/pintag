// Gallery Recovery "✓ Finished" — a recovery-only worklist mark.
//
// It must persist locally (localStorage), survive a reload, be reversible, and
// NEVER touch workflow_status / public visibility. We run the REAL setDoneMark
// / isDoneMark extracted from gallery-recovery.html against a same-origin page
// so localStorage is available.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

function extractFn(file, name) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const setDoneMark = extractFn('gallery-recovery.html', 'setDoneMark');
const isDoneMark  = extractFn('gallery-recovery.html', 'isDoneMark');

test.describe('Gallery Recovery "Finished" worklist mark', () => {
  test('marks persist to localStorage, survive reload, and reverse cleanly', async ({ page }) => {
    await page.route('**/blank-harness', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('http://localhost:8956/blank-harness');

    const r = await page.evaluate(({ setSrc, isSrc }) => {
      const KEY = 'pintag_gr_done';
      window.GR_DONE_KEY = KEY;
      window.GR_DONE = new Set();
      (0, eval)(isSrc);   // defines global isDoneMark
      (0, eval)(setSrc);  // defines global setDoneMark

      const out = {};
      setDoneMark('listing-A', true);
      out.marked = isDoneMark('listing-A');
      out.storedAfterMark = JSON.parse(localStorage.getItem(KEY));

      // Simulate a page reload: rebuild the set from localStorage (the IIFE init).
      window.GR_DONE = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
      out.survivesReload = isDoneMark('listing-A');

      setDoneMark('listing-A', false);
      out.unmarked = isDoneMark('listing-A');
      out.storedAfterUnmark = JSON.parse(localStorage.getItem(KEY));
      return out;
    }, { setSrc: setDoneMark, isSrc: isDoneMark });

    expect(r.marked).toBe(true);
    expect(r.storedAfterMark).toEqual(['listing-A']);
    expect(r.survivesReload).toBe(true);          // persists across reloads
    expect(r.unmarked).toBe(false);
    expect(r.storedAfterUnmark).toEqual([]);       // fully reversible
  });

  test('Finished is worklist-only: no workflow_status write, hidden by default, reversible label', () => {
    const src = fs.readFileSync(path.join(REPO, 'gallery-recovery.html'), 'utf8');
    // Button toggles between mark and undo.
    expect(src).toContain("'✓ Finished'");
    expect(src).toContain("'↺ Undo finished'");
    // Finished listings are hidden from the worklist unless "Show finished".
    expect(src).toContain('if (!SHOW_DONE && isDoneMark(p.id)) return false;');
    // The mark writes ONLY localStorage — it must not set workflow_status.
    expect(setDoneMark).not.toMatch(/workflow_status/);
    expect(setDoneMark).toMatch(/localStorage\.setItem/);
  });
});
