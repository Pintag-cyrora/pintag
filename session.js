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

function getOrCreateSessionId() {
  try {
    var existing = sessionStorage.getItem(PINTAG_SESSION_KEY);
    if (existing) return existing;
    var id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : (
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        var v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      })
    );
    sessionStorage.setItem(PINTAG_SESSION_KEY, id);
    return id;
  } catch (e) {
    // sessionStorage unavailable (private browsing edge cases, etc.) —
    // fall back to a per-call id rather than throwing; events still
    // insert, they just won't correlate within that session.
    return null;
  }
}
