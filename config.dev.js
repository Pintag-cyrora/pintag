// config.dev.js — development Supabase config. Copied to config.js by the
// dev deploy workflow (.github/workflows/deploy-dev.yml). Never referenced
// directly from HTML — only config.js is (<script src="config.js"></script>).
// Committed identically on every branch — this file never needs to differ
// per branch, so it merges cleanly with no conflicts. Anon keys are meant to
// be public/embeddable (RLS is the real security boundary), so having this
// value committed is not a secret-exposure concern.
window.PINTAG = {
  env: 'development',
  isProduction: false,
  // See config.prod.js for the full rationale behind these three keys. Dev
  // keeps the direct origin for all three: the api.pintag.io proxy fronts the
  // PRODUCTION project only, so nothing here changes at cutover.
  supabaseUrl: 'https://ebtgoqrywdywuqrvudcp.supabase.co',
  storagePublicOrigin: 'https://ebtgoqrywdywuqrvudcp.supabase.co',
  authStorageKey: 'sb-ebtgoqrywdywuqrvudcp-auth-token',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVidGdvcXJ5d2R5d3VxcnZ1ZGNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyNTg1MjcsImV4cCI6MjA5ODgzNDUyN30.FbM5Az9bxUflHabIqVLWFyb3BqfLWfCu1ZP5xwowUb8',
  tag: 'DEV',
  label: 'pintag-dev'
};
