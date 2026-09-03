// Minimal stub of the @supabase/supabase-js v2 UMD bundle -- just enough
// surface for the privileged Pintag pages' usage. As of the single-admin
// lockdown (admin-auth.js), intelligence.html gates on the SHARED auth module,
// whose server-side verification path calls:
//   auth.getUser()                              -- server-validated identity
//   auth.mfa.getAuthenticatorAssuranceLevel()   -- AAL2 (TOTP) check
// alongside the older auth.signInWithPassword / signOut / getSession /
// onAuthStateChange. This stub covers exactly that surface, served in place of
// the real CDN script so tests never need real network access.
//
// Like real supabase-js, the client REHYDRATES a persisted session from
// storage on construction (here a well-known localStorage key the test seeds
// via mock-supabase.js), and getAuthenticatorAssuranceLevel() derives the
// current level from the access-token JWT's own `aal` claim -- it does not
// invent one. getUser() re-validates against the auth endpoint (intercepted by
// mock-supabase.js), so the real admin-auth.js verification path runs unchanged
// and still rejects a non-cyrora / non-aal2 session.
(function () {
  // The persisted-session key the test harness seeds (see mock-supabase.js).
  var SESSION_KEY = 'pintag.test.auth.session';

  function decodeJwtPayload(token) {
    // Decode (not verify) the JWT payload, exactly as supabase-js does client
    // side to read the `aal` claim. Signatures are never checked in-browser.
    var seg = String(token || '').split('.')[1];
    if (!seg) return {};
    seg = seg.replace(/-/g, '+').replace(/_/g, '/');
    while (seg.length % 4) seg += '=';
    try { return JSON.parse(atob(seg)); } catch (_) { return {}; }
  }

  function createClient(url, anonKey) {
    var currentSession = null;
    var listeners = [];

    // Rehydrate a persisted session, as the real SDK does from localStorage.
    try {
      var raw = window.localStorage.getItem(SESSION_KEY);
      if (raw) currentSession = JSON.parse(raw);
    } catch (_) { /* private-mode / unavailable storage -> no session */ }

    function notify(event) {
      listeners.forEach(function (cb) { cb(event, currentSession); });
    }

    var auth = {
      async signInWithPassword({ email, password }) {
        const res = await fetch(url + '/auth/v1/token?grant_type=password', {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
          return { data: { session: null, user: null }, error: { message: 'Invalid login credentials' } };
        }
        const body = await res.json();
        currentSession = { access_token: body.access_token, refresh_token: body.refresh_token, user: body.user };
        notify('SIGNED_IN');
        return { data: { session: currentSession, user: body.user }, error: null };
      },
      async signOut() {
        currentSession = null;
        try { window.localStorage.removeItem(SESSION_KEY); } catch (_) {}
        notify('SIGNED_OUT');
        return { error: null };
      },
      async getSession() {
        return { data: { session: currentSession } };
      },
      // Server-validated identity: re-checks the token against the auth
      // endpoint (mock-supabase.js answers /auth/v1/user). Mirrors the real
      // SDK's getUser(), which admin-auth.js uses as its server-side gate.
      async getUser() {
        if (!currentSession || !currentSession.access_token) {
          return { data: { user: null }, error: { message: 'No active session' } };
        }
        try {
          const res = await fetch(url + '/auth/v1/user', {
            headers: { apikey: anonKey, Authorization: 'Bearer ' + currentSession.access_token },
          });
          if (!res.ok) return { data: { user: null }, error: { message: 'Session invalid' } };
          const user = await res.json();
          return { data: { user: user }, error: null };
        } catch (e) {
          return { data: { user: null }, error: { message: String(e) } };
        }
      },
      onAuthStateChange(cb) {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      mfa: {
        // Current assurance level is read straight from the access-token JWT's
        // `aal` claim, exactly as real supabase-js computes it.
        async getAuthenticatorAssuranceLevel() {
          var lvl = currentSession && currentSession.access_token
            ? (decodeJwtPayload(currentSession.access_token).aal || 'aal1')
            : null;
          return { data: { currentLevel: lvl, nextLevel: lvl, currentAuthenticationMethods: [] }, error: null };
        },
        async listFactors() { return { data: { totp: [], all: [] }, error: null }; },
      },
    };

    return { auth: auth };
  }

  window.supabase = { createClient: createClient };
})();
