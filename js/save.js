/**
 * Returns the current saved-slugs Set read from storage.
 *
 * @param {Storage|null} [storage]  Defaults to window.localStorage.
 *                                  Pass a mock in tests to avoid touching real storage.
 * @returns {Set<string>}  Empty Set on any read or parse error.
 */
export function getSavedSet(storage) {
  var s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return new Set();
  try {
    return new Set(JSON.parse(s.getItem('pintag_saved') || '[]'));
  } catch (e) {
    return new Set();
  }
}

/**
 * Pure toggle: returns a NEW Set with `slug` added (if absent) or removed (if present).
 * Does NOT mutate the input Set.
 *
 * @param {string}      slug         Listing slug to toggle
 * @param {Set<string>} currentSaved Current saved Set
 * @returns {Set<string>}            New Set after toggle
 */
export function computeToggle(slug, currentSaved) {
  var next = new Set(currentSaved);
  if (next.has(slug)) {
    next.delete(slug);
  } else {
    next.add(slug);
  }
  return next;
}

/**
 * Serialises the saved Set back to storage as a JSON array.
 * Silently ignores write errors (e.g. quota exceeded in private browsing).
 *
 * @param {Set<string>}  savedSet  Set of saved slugs
 * @param {Storage|null} [storage] Defaults to window.localStorage.
 */
export function persistSaved(savedSet, storage) {
  var s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return;
  try {
    s.setItem('pintag_saved', JSON.stringify([...savedSet]));
  } catch (e) {
    // Silently ignore — quota exceeded in private browsing, etc.
  }
}
