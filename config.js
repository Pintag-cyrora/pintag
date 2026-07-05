// Pintag environment config — auto-detects production vs. development by
// hostname so the same codebase can point at different Supabase projects
// without editing source files per deploy. Anon keys are public/embeddable
// by design (RLS is the real security boundary), so having both
// environments' keys here is not a secret-exposure concern.
//
// detectEnvironment() is the ONE place hostname logic lives. If Pintag ever
// changes hosting (new domain, different host entirely), this is the only
// function that needs to change.
//
// Defaults to DEVELOPMENT unless the hostname matches a known production
// domain. This is deliberate: an unrecognized preview host landing safely
// in development (a confusing blank dev DB) is a far cheaper mistake than
// an unrecognized host landing in production (real test data written to
// the live site real customers see). Only add to PRODUCTION_HOSTS when
// Pintag genuinely adds a new production domain — do not add preview/dev
// hosts here; they're supposed to fall through to the default.
//
// Configuration only — no DOM/UI code. See dev-banner.js for the visible
// environment indicator.
(function () {
  var PRODUCTION_HOSTS = ['pintag.io', 'www.pintag.io', 'pintag-cyrora.github.io'];

  function detectEnvironment(hostname) {
    return PRODUCTION_HOSTS.indexOf(hostname) !== -1 ? 'production' : 'development';
  }

  var ENV = detectEnvironment(window.location.hostname);

  var CONFIGS = {
    production: {
      url: 'https://eoladhcljbpbhnrmmpev.supabase.co',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbGFkaGNsamJwYmhucm1tcGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTE4NDQsImV4cCI6MjA5MTgyNzg0NH0.z1K8CqRFPIqiC7Gvfv1GekcQLIIkLodgyOksio1Upn0'
    },
    development: {
      // Filled in once, after the persistent pintag-dev Supabase project is
      // created (see PREVIEW.md) — a one-time edit, never touched again for
      // future branches.
      url: 'https://PINTAG_DEV_PROJECT_REF.supabase.co',
      anonKey: 'PINTAG_DEV_ANON_KEY'
    }
  };

  // Single namespaced global — everything Pintag-specific hangs off this
  // one object, not scattered window.* properties.
  window.PINTAG = {
    env: ENV,
    isProduction: ENV === 'production',
    supabaseUrl: CONFIGS[ENV].url,
    anonKey: CONFIGS[ENV].anonKey
  };
})();
