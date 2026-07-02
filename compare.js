// ══════════════════════════════════════════════════════════════════
// compare.js — shared "property comparison" selection.
// Deliberately kept separate from favorites.js: "saved" (wishlist) and
// "selected for comparison" are different intents — someone may save
// a dozen properties over weeks but only ever compare 2-4 at a time.
// Mirrors favorites.js's shape closely so both are easy to maintain
// side by side. Storage: localStorage['pintag_compare'], a JSON array
// of slugs, capped at COMPARE_MAX.
// ══════════════════════════════════════════════════════════════════
var COMPARE_MAX = 4;

function getCompareSet() {
  try { return new Set(JSON.parse(localStorage.getItem('pintag_compare') || '[]')); }
  catch (e) { return new Set(); }
}

function isComparing(slug) {
  return getCompareSet().has(slug);
}

// Toggles membership. Returns {comparing, limitReached} — limitReached
// is true only when trying to ADD a 5th item, so callers can show a
// brief nudge instead of silently dropping an earlier selection.
function toggleCompare(slug, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  var set = getCompareSet();
  var limitReached = false;
  if (set.has(slug)) {
    set.delete(slug);
  } else if (set.size >= COMPARE_MAX) {
    limitReached = true;
  } else {
    set.add(slug);
  }
  try { localStorage.setItem('pintag_compare', JSON.stringify(Array.from(set))); } catch (err) {}
  var nowComparing = set.has(slug);
  document.querySelectorAll('[data-compare="' + slug + '"]').forEach(function (btn) {
    btn.classList.toggle('comparing', nowComparing);
    btn.setAttribute('aria-pressed', nowComparing ? 'true' : 'false');
  });
  document.dispatchEvent(new CustomEvent('pintag:compare-changed'));
  return { comparing: nowComparing, limitReached: limitReached };
}

// Explicit removal (used by the floating bar and the comparison page
// itself) — same effect as toggling off, but reads clearly at call sites
// that only ever remove, never add.
function removeFromCompare(slug) {
  var set = getCompareSet();
  if (!set.has(slug)) return;
  set.delete(slug);
  try { localStorage.setItem('pintag_compare', JSON.stringify(Array.from(set))); } catch (err) {}
  document.querySelectorAll('[data-compare="' + slug + '"]').forEach(function (btn) {
    btn.classList.remove('comparing');
    btn.setAttribute('aria-pressed', 'false');
  });
  document.dispatchEvent(new CustomEvent('pintag:compare-changed'));
}
