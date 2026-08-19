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
  // API DELIVERY origin — where the browser sends /rest/v1, /auth/v1,
  // /functions/v1 and /storage/v1 requests. This is the ONLY value that moves
  // to https://api.pintag.io at cutover (see docs/API_PROXY.md); every call
  // site in the app reads it from here, so the cutover is this one line.
  // NOT flipped yet: the Worker and DNS must exist and be verified first.
  supabaseUrl: 'https://eoladhcljbpbhnrmmpev.supabase.co',

  // STORED/PUBLIC STORAGE origin — deliberately NOT the same knob.
  //
  // Public property-image URLs are PERSISTED in properties.images, so their
  // host is a data format, not a delivery choice. It must stay pinned to the
  // direct Supabase origin whatever supabaseUrl becomes: every existing row
  // already uses it, ptCdnImage() (components.js) matches on it to rewrite to
  // img.pintag.io, and the image CDN Worker fetches it. Letting the delivery
  // host leak into stored values would split the database into two URL shapes
  // and silently disable the image CDN for every listing photo taken before
  // the cutover.
  //
  // Uploads still POST through supabaseUrl (and therefore through Cloudflare);
  // only the URL written to the database is built from this constant.
  storagePublicOrigin: 'https://eoladhcljbpbhnrmmpev.supabase.co',

  // Supabase auth session key, pinned to the PROJECT REF rather than derived
  // from the hostname. supabase-js defaults storageKey to
  // `sb-<first DNS label of supabaseUrl>-auth-token`, so moving the API host to
  // api.pintag.io would silently change the key to `sb-api-auth-token` and log
  // every administrator and agent out mid-session (for the admin, that means
  // re-doing TOTP). Passing this explicitly at every createClient() call
  // decouples session identity from the delivery hostname permanently.
  authStorageKey: 'sb-eoladhcljbpbhnrmmpev-auth-token',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbGFkaGNsamJwYmhucm1tcGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTE4NDQsImV4cCI6MjA5MTgyNzg0NH0.z1K8CqRFPIqiC7Gvfv1GekcQLIIkLodgyOksio1Upn0',
  tag: 'PROD',
  label: 'production'
};
