// config.prod.js — production Supabase config. Copied to config.js by the
// prod deploy workflow (.github/workflows/deploy-prod.yml). Never referenced
// directly from HTML — only config.js is (<script src="config.js"></script>).
// Committed identically on every branch — this file never needs to differ
// per branch, so it merges cleanly with no conflicts. Anon keys are meant to
// be public/embeddable (RLS is the real security boundary), so having this
// value committed is not a secret-exposure concern.
window.PINTAG = {
  env: 'production',
  isProduction: true,
  supabaseUrl: 'https://eoladhcljbpbhnrmmpev.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbGFkaGNsamJwYmhucm1tcGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTE4NDQsImV4cCI6MjA5MTgyNzg0NH0.z1K8CqRFPIqiC7Gvfv1GekcQLIIkLodgyOksio1Upn0',
  tag: 'PROD',
  label: 'production'
};
