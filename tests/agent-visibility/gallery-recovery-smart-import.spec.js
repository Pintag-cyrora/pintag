// Gallery Recovery → ⚡ Smart Import handoff.
//
// The photo group's "⚡ Smart Import" buttons (gallery-recovery.html) call the
// existing sendToSmartImport(), which stages the selected photo URLs in
// localStorage['pintag_gr_to_import'] and navigates to admin.html. There, the
// REAL maybeIngestGalleryRecovery() drops them into the SAME Smart Import panel
// Admin uses. This verifies, at mobile width, that:
//   1. grouped photos arrive pre-attached in that panel (the panel opens, the
//      grid renders them, importImages is set, the handoff key is consumed);
//   2. the "⚡ Smart Import" action is visually distinct (its own .si accent,
//      not the ghost/"edit" styling) and, on mobile, a full-width bar button.
// No new pipeline/editor — we run admin.html's own extracted functions.

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

const maybeIngest = extractFn('admin.html', 'maybeIngestGalleryRecovery');
const showImport  = extractFn('admin.html', 'showImportPanel');
const refreshGrid = extractFn('admin.html', 'refreshImportImageGrid');

// The minimal Smart Import panel DOM those functions touch (ids copied from
// admin.html's #import-panel).
const PANEL_DOM = `
  <div id="listings-panel"></div>
  <div id="form-panel"></div>
  <div id="import-panel" style="display:none;">
    <input id="import-fb-url">
    <textarea id="import-description"></textarea>
    <div id="import-message" style="display:none;"></div>
    <div id="import-progress-steps" style="display:none;"></div>
    <button id="import-gen-btn"></button>
    <div id="import-image-grid" class="image-preview-grid"></div>
  </div>`;

test.describe('Gallery Recovery → ⚡ Smart Import (mobile width)', () => {
  test.use({ viewport: { width: 390, height: 844 } });   // phone

  test('grouped photos arrive pre-attached in the Admin Smart Import panel', async ({ page }) => {
    // A real same-origin http document so localStorage (the handoff medium) is
    // available; routed inline so no external scripts load.
    await page.route('**/blank-harness', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('http://localhost:8956/blank-harness');
    const r = await page.evaluate(({ maybeIngest, showImport, refreshGrid, panelDom }) => {
      document.body.innerHTML = panelDom;
      window.esc = (s) => (s == null ? '' : String(s));
      window.importImages = [];
      // Define admin.html's real functions in this page's scope.
      (0, eval)(refreshGrid);
      (0, eval)(showImport);
      (0, eval)(maybeIngest);
      // Simulate what gallery-recovery.html's sendToSmartImport() stages.
      const imgs = ['https://cdn/x/a.jpg', 'https://cdn/x/b.jpg', 'https://cdn/x/c.jpg'];
      localStorage.setItem('pintag_gr_to_import',
        JSON.stringify({ images: imgs, source: 'gallery_recovery', at: Date.now() }));
      // The exact call admin.html runs on boot.
      maybeIngestGalleryRecovery();
      return {
        panelDisplay: document.getElementById('import-panel').style.display,
        importImages: window.importImages,
        gridSrcs: Array.from(document.querySelectorAll('#import-image-grid img')).map(i => i.getAttribute('src')),
        message: document.getElementById('import-message').textContent,
        leftover: localStorage.getItem('pintag_gr_to_import'),
      };
    }, { maybeIngest, showImport, refreshGrid, panelDom: PANEL_DOM });

    expect(r.panelDisplay).toBe('block');                                   // Smart Import panel opened
    expect(r.importImages).toEqual(['https://cdn/x/a.jpg', 'https://cdn/x/b.jpg', 'https://cdn/x/c.jpg']); // attached
    expect(r.gridSrcs).toEqual(['https://cdn/x/a.jpg', 'https://cdn/x/b.jpg', 'https://cdn/x/c.jpg']);     // rendered
    expect(r.message).toContain('from Gallery Recovery attached');          // operator sees confirmation
    expect(r.leftover).toBeNull();                                          // one-shot handoff consumed
  });

  test('the ⚡ Smart Import action is visually distinct and mobile-prominent', () => {
    const src = fs.readFileSync(path.join(REPO, 'gallery-recovery.html'), 'utf8');
    // Every "⚡ Smart Import" button carries the distinct .si accent, never the
    // ghost/"edit-existing" styling — so create-new ≠ edit-existing everywhere.
    const btns = [...src.matchAll(/<button class="([^"]*)">⚡ Smart Import/g)].map(m => m[1]);
    expect(btns.length).toBe(4);
    btns.forEach((cls) => {
      const classes = cls.split(/\s+/);
      expect(classes).toContain('si');
      expect(classes).not.toContain('ghost');
    });
    // The distinct indigo accent is defined, separate from the teal edit color.
    expect(src).toMatch(/button\.si\s*\{[^}]*background:\s*#5B53D6/i);
    // On mobile the photo-group Smart Import button spans the full bar width.
    expect(src).toMatch(/\.mbar\s+\.b-new\s*\{[^}]*flex-basis:\s*100%/);
    // And it is wired to the existing handoff with no listing id (create new).
    expect(src).toMatch(/\.b-new'\)\.onclick[\s\S]*?sendToSmartImport\(names,\s*null\)/);
  });
});
