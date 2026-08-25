#!/usr/bin/env node
// normalize-map-links.mjs — expand stored Google Maps SHORT links in place.
//
// WHAT THIS IS FOR
// properties.map_embed_url is the single source of truth for where a listing
// is. 29 of 59 public listings hold a maps.app.goo.gl / goo.gl short link,
// which carries no coordinate: the browser cannot follow the redirect (CORS
// makes the target opaque), so the map has nothing to place and the listing is
// correctly left off it. Expanding the link to the google.com/maps URL it
// already points at makes the coordinate readable.
//
// WHAT THIS IS NOT
// It is not a new coordinate store. It writes ONE existing column, in place,
// with the URL Google itself redirects to — the same value admin.html would
// have stored had the link been pasted today. No latitude/longitude column is
// written, no row is created or deleted, and no other field is touched. Run it
// twice and the second run is a no-op: an already-expanded link is skipped.
//
// SAFETY
//   * DRY RUN BY DEFAULT. --apply is required to write, and --apply refuses to
//     start without SUPABASE_SERVICE_ROLE_KEY.
//   * Expansion goes through the resolve-map-url edge function, which
//     allowlists the short-link hosts and validates the final host — this
//     script never fetches an arbitrary URL itself.
//   * A resolved URL is only written if the shared parser can actually get a
//     coordinate out of it AND that coordinate is inside Laos. An expansion
//     that lands somewhere unexpected is REPORTED and skipped, never stored:
//     the point is to stop guessing, not to guess faster.
//   * Every skip is printed with its reason, so "nothing happened" can always
//     be distinguished from "nothing needed to happen".
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MapLocation = require('../map-location.js');

const APPLY = process.argv.includes('--apply');
const cfg = readFileSync(new URL('../config.prod.js', import.meta.url), 'utf8');
const pick = (k) => (cfg.match(new RegExp(`${k}:\\s*'([^']+)'`)) || [])[1];

const SUPABASE_URL = pick('supabaseUrl');
const ANON = pick('anonKey');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !ANON) {
  console.error('Could not read supabaseUrl/anonKey from config.prod.js');
  process.exit(1);
}
if (APPLY && !SERVICE) {
  console.error('--apply requires SUPABASE_SERVICE_ROLE_KEY (writes go through the service role).');
  process.exit(1);
}

const REST = `${SUPABASE_URL}/rest/v1`;
const readHeaders = { apikey: ANON, Authorization: `Bearer ${ANON}` };
const writeHeaders = {
  apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
  'Content-Type': 'application/json', Prefer: 'return=minimal'
};

// A transient network failure must not be read as "this link is bad" — that
// would skip a listing that is perfectly fine. Retries are for 5xx/network
// only; a 4xx is the resolver telling us something definitive about the URL.
async function withRetry(fn, what, attempts = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= attempts || e.fatal) throw e;
      const wait = 500 * 2 ** (i - 1);
      console.warn(`  retry ${i}/${attempts - 1} for ${what} in ${wait}ms — ${e.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function req(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${res.status} ${body.slice(0, 200)}`);
    err.fatal = res.status >= 400 && res.status < 500;
    err.status = res.status;
    throw err;
  }
  return res;
}

async function resolveShortLink(url) {
  const res = await req(`${SUPABASE_URL}/functions/v1/resolve-map-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify({ url })
  });
  const data = await res.json();
  if (!data.resolved_url) throw Object.assign(new Error('resolver returned no resolved_url'), { fatal: true });
  return data.resolved_url;
}

const rows = await (await req(
  `${REST}/properties?select=id,slug,status,map_embed_url&map_embed_url=not.is.null&limit=1000`,
  { headers: readHeaders }
)).json();

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} listings carry a map link\n`);

const short = rows.filter((r) => MapLocation.isShortLink(r.map_embed_url));
const already = rows.length - short.length;
console.log(`  already expanded: ${already}`);
console.log(`  short links to expand: ${short.length}\n`);

let expanded = 0, skipped = 0, failed = 0;

for (const row of short) {
  let resolved;
  try {
    resolved = await withRetry(() => resolveShortLink(row.map_embed_url), row.slug);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${row.slug}\n      resolver failed: ${e.message}\n      keeping: ${row.map_embed_url}`);
    continue;
  }

  // The expansion is only useful if a coordinate actually falls out of it.
  const parsed = MapLocation.parseMapUrl(resolved);
  if (!parsed.ok) {
    skipped++;
    console.log(`  ⊘ ${row.slug}\n      resolved but unusable: ${MapLocation.describeFailure(parsed)}` +
                `\n      resolved to: ${resolved.slice(0, 140)}`);
    continue;
  }

  console.log(`  ✓ ${row.slug}\n      ${parsed.lat}, ${parsed.lng}  (${parsed.pattern})`);
  if (!APPLY) { expanded++; continue; }

  try {
    await withRetry(() => req(`${REST}/properties?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH', headers: writeHeaders,
      body: JSON.stringify({ map_embed_url: resolved })
    }), `write ${row.slug}`);
    expanded++;
  } catch (e) {
    failed++;
    console.log(`      WRITE FAILED: ${e.message}`);
  }
}

console.log(`\n${APPLY ? 'APPLIED' : 'WOULD EXPAND'}: ${expanded}   unusable: ${skipped}   failed: ${failed}`);
if (failed) process.exitCode = 1;
