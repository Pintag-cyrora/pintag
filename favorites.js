// ══════════════════════════════════════════════════════════════════
// favorites.js — single shared "saved properties" implementation.
// Used by listings.html, listing.html, and any future Saved Properties
// page. Storage: localStorage['pintag_saved'], a JSON array of slugs.
//
// Contract for buttons: give the element a data-save="<slug>" attribute
// and an onclick of toggleSave('<slug>', event). This function finds
// every matching [data-save] element on the page and keeps it in sync,
// so a listing saved from a grid card and its own detail page (or any
// other page open at the same time) never disagree.
// ══════════════════════════════════════════════════════════════════
function getSavedSet() {
  try { return new Set(JSON.parse(localStorage.getItem('pintag_saved') || '[]')); }
  catch (e) { return new Set(); }
}

function isSaved(slug) {
  return getSavedSet().has(slug);
}

function toggleSave(slug, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  var saved = getSavedSet();
  if (saved.has(slug)) { saved.delete(slug); } else { saved.add(slug); }
  try { localStorage.setItem('pintag_saved', JSON.stringify([...saved])); } catch (err) {}
  var nowSaved = saved.has(slug);
  document.querySelectorAll('[data-save="' + slug + '"]').forEach(function (btn) {
    btn.classList.toggle('saved', nowSaved);
    btn.setAttribute('aria-pressed', nowSaved ? 'true' : 'false');
  });
  return nowSaved;
}
