// facebook-listing-fetcher — one ADAPTER in Smart Import's ingestion
// pipeline: Source -> Adapter -> ImportResult -> AI Enrichment ->
// Validation -> Populate Form. This adapter turns a Facebook Marketplace
// URL into raw material (title, description, price_display, images[]) —
// admin.html folds that into the same description text + image list the
// manual-paste adapter already produces, then hands it to
// smart-listing-importer (AI Enrichment), which is where the actual
// confidence-tagged ImportResult gets assembled. See that function's
// header comment for the full ImportResult/ImportImage/FieldValue shapes.
//
// Any future adapter (a property portal, a PDF, a Word doc, OCR, email)
// only needs to produce this same raw-material shape — AI Enrichment and
// Populate Form never need to know or care which adapter it came from.
//
// This function does NOT touch any database table (no properties, no
// contacts) — the one Supabase-facing side effect it has is uploading
// fetched photos to the property-images Storage bucket, using the
// caller's own forwarded bearer token, the exact same bucket and pattern
// admin.html's handleImportImageUpload() already uses for manually-picked
// photos (see admin.html; storage writes for photos are explicitly
// unchanged/out of scope for the "no auto-save" refactor — only writes to
// the `properties`/`contacts` tables are).
//
// HONEST LIMITATION, worth knowing before relying on this: Facebook serves
// full un-authenticated page content only to its own crawler/officially
// intended for link-preview consumers via OpenGraph <meta> tags. A plain
// server-side fetch — no login, no JS execution — realistically only
// yields the OG title/description/primary image, NOT the listing's full
// photo gallery or full multi-paragraph description, which Facebook only
// renders client-side behind its login wall. This function extracts
// whatever OG tags are present (title, description, every og:image found,
// price if Facebook happens to include product:price meta) and nothing
// more — it does not attempt to reverse-engineer Facebook's internal
// GraphQL/state payloads, which would be fragile and outside the
// intended-for-scraping surface Facebook actually exposes. When a listing
// only yields 1 photo and a short description, that's expected, not a bug
// — staff can still fall back to the manual paste-text + upload-photos
// path in the same panel for anything auto-fetch comes back thin on.

// Shared shape with smart-listing-importer's ImportImage — see that file
// for the full ImportResult contract this adapter feeds into.
interface ImportImage {
  originalUrl?: string;
  storageUrl?: string;
  width?: number;   // reserved for future use (dedup/ranking) — not populated by this adapter
  height?: number;  // reserved for future use — not populated by this adapter
  primary?: boolean;
  source: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_IMAGES = 10;

// Facebook-family hosts only — same allowlist-first SSRF defense already
// used by smart-listing-importer's ALLOWED_IMAGE_HOSTS. Rejects everything
// else, including redirect targets checked again after fetch (see below).
const ALLOWED_FACEBOOK_HOSTS = /^([a-z0-9-]+\.)*(facebook\.com|fb\.watch)$/i;

// og:image URLs are attacker-influencable content extracted from a fetched
// page — they get their OWN allowlist (Facebook's CDN family), never a blind
// fetch. This was the one server-side fetch without a guard (audit
// 2026-08-06); it now has the same checklist as every other fetch here:
// https-only, host allowlist, final-redirect-host re-check, content-type
// must be an image, and a hard byte cap.
const ALLOWED_OG_IMAGE_HOSTS = /^([a-z0-9-]+\.)*(fbcdn\.net|fbsbx\.com)$/i;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// AAL2 (MFA) enforcement — L1 baseline. The claim is read from a token that
// /auth/v1/user has ALREADY validated server-side (same literal string), so
// decoding without re-verifying the signature is sound here. A session that
// has not completed TOTP carries aal='aal1'. Fail closed: parse failure = aal1.
function tokenAal(token: string): string {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return typeof payload.aal === 'string' ? payload.aal : 'aal1';
  } catch {
    return 'aal1';
  }
}

async function requireAdmin(req: Request): Promise<{ error: string | null; status: number; token: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) return { error: 'Server misconfigured', status: 500, token: '' };
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return { error: 'Missing auth token', status: 401, token: '' };
  const token = auth.slice(7);
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey },
  });
  if (!r.ok) return { error: 'Invalid token', status: 401, token: '' };
  const user = await r.json();
  if (!user?.id) return { error: 'Invalid token', status: 401, token: '' };
  // MFA gate (defense in depth: is_pintag_admin() below ALSO enforces
  // aal2 in the database since 20260806010000). 403 + structured security
  // log, never perform the operation.
  if (tokenAal(token) !== 'aal2') {
    console.error(JSON.stringify({ security_event: 'aal2_required', fn: 'facebook-listing-fetcher', user: user.id, at: new Date().toISOString() }));
    return { error: 'MFA required', status: 403, token: '' };
  }
  // Authorization boundary: the is_pintag_admin() Postgres function (the single
  // admin allowlist, admin_accounts — cyrora.trading@gmail.com today). It is
  // SECURITY DEFINER and granted to authenticated, so the caller's own token
  // resolves it. Replaces the retired parties.type='staff' lookup (the staff
  // model is gone); fails CLOSED (denies) on any error.
  const adminCheck = await fetch(`${supabaseUrl}/rest/v1/rpc/is_pintag_admin`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_uid: user.id }),
  });
  if (!adminCheck.ok) return { error: 'Server misconfigured', status: 500, token: '' };
  if ((await adminCheck.json()) !== true) {
    console.error(JSON.stringify({ security_event: 'admin_denied', fn: 'facebook-listing-fetcher', user: user.id, at: new Date().toISOString() }));
    return { error: 'Admin only', status: 403, token: '' };
  }
  return { error: null, status: 200, token };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractMeta(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]).trim();
  }
  return null;
}

function extractAllMeta(html: string, property: string): string[] {
  // Same dual-order matching as extractMeta() above — Facebook doesn't
  // consistently emit `property` before `content` across every og:image
  // tag on a page, and a single-order regex would silently under-count
  // the gallery instead of just missing one field.
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'gi'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'gi'),
  ];
  const out: string[] = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) out.push(decodeHtmlEntities(m[1]).trim());
  }
  return out;
}

function extractTitleTag(html: string): string | null {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? decodeHtmlEntities(m[1]).trim() : null;
}

async function fetchFacebookPage(url: string): Promise<{ html: string; finalUrl: string } | { error: string }> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { error: 'Not a valid URL' }; }
  if (parsed.protocol !== 'https:') return { error: 'Only https:// URLs are supported' };
  if (!ALLOWED_FACEBOOK_HOSTS.test(parsed.hostname)) {
    return { error: 'Only facebook.com / fb.watch URLs are supported' };
  }
  try {
    const res = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(15000),
      headers: {
        // A plain browser-like UA — Facebook serves OG meta tags to any
        // requester (that's their intended link-preview surface); no
        // attempt is made to impersonate their own crawler or bypass any
        // access control.
        'User-Agent': 'Mozilla/5.0 (compatible; PintagListingFetcher/1.0)',
        'Accept': 'text/html',
      },
    });
    // Re-validate the *final* host after redirects (e.g. fb.watch ->
    // facebook.com) — still must land inside the same allowlist.
    const finalUrl = new URL(res.url || parsed.toString());
    if (!ALLOWED_FACEBOOK_HOSTS.test(finalUrl.hostname)) {
      return { error: 'Redirected outside facebook.com — refusing to follow' };
    }
    if (!res.ok) return { error: `Facebook returned ${res.status}` };
    const html = await res.text();
    return { html, finalUrl: finalUrl.toString() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Fetch failed' };
  }
}

async function uploadImageToStorage(
  originalUrl: string, supabaseUrl: string, anonKey: string, callerToken: string,
): Promise<ImportImage | null> {
  try {
    // SSRF guard on attacker-influencable og:image URLs: https-only + CDN
    // host allowlist BEFORE the fetch, final-host re-check AFTER redirects,
    // image content-type required, and a hard size cap (declared and actual).
    let parsed: URL;
    try { parsed = new URL(originalUrl); } catch { return null; }
    if (parsed.protocol !== 'https:') return null;
    if (!ALLOWED_OG_IMAGE_HOSTS.test(parsed.hostname)) return null;
    const res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const finalUrl = new URL(res.url || parsed.toString());
    if (finalUrl.protocol !== 'https:' || !ALLOWED_OG_IMAGE_HOSTS.test(finalUrl.hostname)) return null;
    const declared = Number(res.headers.get('content-length') || '0');
    if (declared > MAX_IMAGE_BYTES) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) return null;
    const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return null;
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const upload = await fetch(`${supabaseUrl}/storage/v1/object/property-images/${fileName}`, {
      method: 'POST',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${callerToken}`,
        'Content-Type': contentType,
        // P2: long immutable cache (new uploads only; content-unique names).
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
      body: buffer,
    });
    if (!upload.ok) return null;
    return {
      originalUrl,
      storageUrl: `${supabaseUrl}/storage/v1/object/public/property-images/${fileName}`,
      source: 'facebook_og',
    };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const { error: authErr, status: authStatus, token } = await requireAdmin(req);
  if (authErr) {
    return new Response(JSON.stringify({ error: authErr }), {
      status: authStatus,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== 'string') {
      throw new Error('Missing url');
    }

    const page = await fetchFacebookPage(url);
    if ('error' in page) throw new Error(page.error);

    const title = extractMeta(page.html, 'og:title') || extractTitleTag(page.html);
    const description = extractMeta(page.html, 'og:description');
    const priceAmount = extractMeta(page.html, 'product:price:amount') || extractMeta(page.html, 'og:price:amount');
    const priceCurrency = extractMeta(page.html, 'product:price:currency') || extractMeta(page.html, 'og:price:currency');
    const priceDisplay = priceAmount ? `${priceCurrency ? priceCurrency + ' ' : ''}${priceAmount}` : null;

    const rawImageUrls = [...new Set(extractAllMeta(page.html, 'og:image'))].slice(0, MAX_IMAGES);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const uploaded = await Promise.all(
      rawImageUrls.map(u => uploadImageToStorage(u, supabaseUrl, anonKey, token)),
    );
    const images = uploaded.filter((img): img is ImportImage => !!img);
    // Best-effort default hero — og:image order usually puts the listing's
    // main photo first. AI Enrichment's own photo analysis may override
    // this once it actually looks at the images.
    if (images.length) images[0].primary = true;

    const warnings: string[] = [];
    if (images.length <= 1) warnings.push('Facebook only exposed 1 photo (or none) to this unauthenticated fetch — the full gallery lives behind its login wall.');
    if (!description) warnings.push('No description found — Facebook may be showing a login-wall page for this listing.');

    if (!title && !description && images.length === 0) {
      throw new Error(
        'Could not extract anything from this Facebook page — it may be behind a login wall or the link is not public. ' +
        'Try pasting the description and photos manually below instead.'
      );
    }

    return new Response(
      JSON.stringify({
        title,
        description,
        price_display: priceDisplay,
        images,
        metadata: {
          source: 'facebook_og',
          fetchedAt: new Date().toISOString(),
          sourceUrl: page.finalUrl,
          warnings,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
