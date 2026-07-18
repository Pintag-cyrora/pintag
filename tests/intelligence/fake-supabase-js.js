// Minimal stub of the @supabase/supabase-js v2 UMD bundle -- just enough
// surface for intelligence.html's usage: auth.signInWithPassword,
// auth.signOut, auth.getSession, auth.onAuthStateChange. Everything else
// intelligence.html does talks to Supabase via plain fetch() to /rest/v1
// and /functions/v1, which the Playwright spec intercepts directly -- this
// stub only needs to cover the auth SDK surface, served in place of the
// real CDN script so tests never need real network access.
(function () {
  function createClient(url, anonKey) {
    let currentSession = null;
    const listeners = [];

    function notify(event) {
      listeners.forEach((cb) => cb(event, currentSession));
    }

    return {
      auth: {
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
          notify('SIGNED_OUT');
          return { error: null };
        },
        async getSession() {
          return { data: { session: currentSession } };
        },
        onAuthStateChange(cb) {
          listeners.push(cb);
          return { data: { subscription: { unsubscribe() {} } } };
        },
      },
    };
  }

  window.supabase = { createClient };
})();
