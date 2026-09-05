// session.js — shared client-side session id for the behavioral event stream.
//
// One id per browser tab session (sessionStorage, not localStorage — a new
// tab/visit is a new session, matching how search_events/listing_events/
// lead_events are meant to be joined per-visit, not per-device forever).
// Generated once on first call, then reused by every subsequent call in
// that tab. Consumers: listings.html, index.html, listing.html, agent.html
// (search_events + listing_events impression/click inserts, and
// trackLead()'s optional session_id field).
var PINTAG_SESSION_KEY = 'pintag_session_id';

// Cryptographically-sourced UUID v4 — crypto.randomUUID() when available
// (the common case), otherwise assembled by hand from
// crypto.getRandomValues() (supported far more broadly than randomUUID()
// itself, including non-HTTPS contexts in some browsers where randomUUID
// is withheld). Math.random() is never used: even though session_id
// carries no authentication/authorization role here — it is a purely
// client-generated correlation id used only to join search_events/
// listing_events/lead_events rows for analytics, never a credential —
// there is no reason to prefer a lower-quality, predictable generator
// when a secure one is this cheap to use (flagged by CodeQL as insecure
// randomness; fixed rather than dismissed).
function generateSecureUUID() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  var hex = Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

function getOrCreateSessionId() {
  try {
    var existing = sessionStorage.getItem(PINTAG_SESSION_KEY);
    if (existing) return existing;
    var id = generateSecureUUID();
    sessionStorage.setItem(PINTAG_SESSION_KEY, id);
    return id;
  } catch (e) {
    // sessionStorage or crypto unavailable (private browsing edge cases,
    // an ancient browser lacking crypto.getRandomValues, etc.) — fail to
    // null rather than throwing; events still insert, they just won't
    // correlate within that session.
    return null;
  }
}
