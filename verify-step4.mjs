#!/usr/bin/env node
// verify-step4.mjs — READ-ONLY post-write verification of properties.map_embed_url.
// TEMPORARY, scratch branch only. Issues GETs and nothing else.
//
// Deliberately independent of step 3's in-run audit: that audit compared the
// database against a snapshot it took itself minutes earlier, so re-running it
// would re-confirm its own arithmetic. This instead compares the database
// against the coordinates established in STEP 2, transcribed by hand from run
// 32830286455 — the acceptance test that went through the DEPLOYED resolver
// and cross-checked every value against an independent direct resolution.
//
// If a coordinate had been rounded, transposed, substituted, or invented at
// any point between step 2 and now, the stored value would disagree with this
// table.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('./map-location.js');

const cfg = readFileSync(new URL('./config.prod.js', import.meta.url), 'utf8');
const SUPABASE_URL = (cfg.match(/supabaseUrl:\s*'([^']+)'/) || [])[1];
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SERVICE) { console.error('SUPABASE_SERVICE_ROLE_KEY required (service role, so no row is hidden by RLS)'); process.exit(2); }

// STEP 2 REFERENCE. Slug prefixes as printed (the log truncates at 54 chars),
// matched with startsWith. Coordinates are verbatim.
const STEP2 = [
  ['fully-furnished-2-bedroom-apartment-with-lake-view-702', '17.9498242,102.6207476'],
  ['fully-furnished-room-for-rent-in-dongpalane-chanthabou', '17.963348,102.622093'],
  ['modern-commercial-building-with-4-beds-5-baths-for-ren', '18.020651,102.630333'],
  ['fully-furnished-apartment-with-security-and-cleaning-s', '18.0210869,102.6144531'],
  ['newly-stylish-furnished-apartment-for-rent-near-xang-j', '17.982599,102.552406'],
  ['city-apartment-on-khouvieng-road-near-parkson-vis-pis-', '17.944559,102.621292'],
  ['modern-apartment-with-balcony-view-491048',              '17.969587,102.586769'],
  ['modern-2-bedroom-house-near-lycee-francais-internation', '17.9109834,102.6393497'],
  ['modern-studio-apartment-with-kitchenette-in-thongsangn', '17.982363,102.616463'],
  ['modern-3-bedroom-apartment-with-river-view',             '17.9609143,102.6177841'],
  ['1-bed-1-bath-apartment-for-rent-in-nongtha-239015',      '18.009935,102.607132'],
  ['lao-style-house-for-rent-in-thongkang-sisattanak-vient', '17.9400262,102.6277036'],
  ['prime-land-for-sale-in-phonkheng-saysettha-district-vi', '17.9844698,102.6342928'],
  ['3-bedroom-townhouse-with-balcony-and-commercial-space-', '17.970139,102.608978'],
  ['house-for-rent-in-thongpong-village-sikhottabong-distr', '17.987701,102.534904'],
  ['2-bedroom-apartment-with-traditional-furnishings-in-ph', '17.961309,102.637787'],
  ['spacious-multi-level-home-with-rooftop-terrace-near-me', '17.9516911,102.61817'],
  ['modern-5-bedroom-house-in-thongphanthong-with-spacious', '17.9515893,102.6339266'],
  ['tuscan-style-townhouse-with-3-4-bedrooms-384903',        '17.9943291,102.6459936'],
  ['newly-opened-fully-furnished-apartment-in-phakhaw-vill', '18.016321,102.639854'],
  ['1-bedroom-1-bathroom-apartment-in-phonthan-555453',      '17.95352,102.641167'],
  ['modern-1-bedroom-apartment-with-parking-in-hadxaifong-', '17.9112282,102.6324329'],
  ['modern-1-bedroom-apartment-with-weekly-housekeeping-82', '17.9114059,102.6310341'],
];
const STEP2_NAME_ONLY = [
  'modern-1-bedroom-apartment-with-kitchen-in-nongdouang',
  'fully-furnished-studio-apartment-with-pool-gym-293416',
  'modern-1-bedroom-apartment-with-balcony-in-nonwaiy',
  'fully-furnished-apartment-in-donkoy-village-904034',
  'modern-studio-apartment-for-rent-near-itecc',
  'service-townhouse-for-rent-in-phoensinuan-vientiane-ca',
];

// Offline test hook for THIS script's own logic. Never set in CI; without it
// the read goes to the real database. A bug here would otherwise be
// indistinguishable from a bad database state, which is the failure mode this
// whole gate exists to avoid.
let rows;
if (process.env.STEP4_FIXTURE) {
  rows = JSON.parse(readFileSync(process.env.STEP4_FIXTURE, 'utf8'));
} else {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/properties?select=id,slug,status,map_embed_url,latitude,longitude&limit=2000`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) { console.error(`read failed: ${res.status} ${await res.text()}`); process.exit(2); }
  rows = await res.json();
}

let fail = 0;
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const ok = (m) => console.log(`  ✓ ${m}`);
const coordOf = (u) => { const r = M.parseMapUrl(u); return r.ok ? { c: `${r.lat},${r.lng}`, p: r.pattern } : null; };
// At least one production row has slug NULL. Reading .startsWith on it threw
// and killed the audit mid-check, so every slug access goes through this.
const sl = (r) => (r && typeof r.slug === 'string' ? r.slug : '');
const hasSlug = (pre) => (x) => sl(x).startsWith(pre);

// Classify every row by what its CURRENT stored value actually is.
const withLink = rows.filter((r) => r.map_embed_url);
const noLink   = rows.filter((r) => !r.map_embed_url);
const exact    = withLink.filter((r) => coordOf(r.map_embed_url));
const shortLnk = withLink.filter((r) => M.isShortLink(r.map_embed_url));
const other    = withLink.filter((r) => !coordOf(r.map_embed_url) && !M.isShortLink(r.map_embed_url));

console.log(`── inventory (service role, every row, all statuses) ────`);
console.log(`  total property rows:                 ${rows.length}`);
console.log(`  with a map_embed_url:                ${withLink.length}`);
console.log(`  map_embed_url IS NULL:               ${noLink.length}`);
console.log(`  -> yields an EXACT coordinate:       ${exact.length}`);
console.log(`  -> still an unexpanded short link:   ${shortLnk.length}`);
console.log(`  -> neither (unexpected):             ${other.length}`);
for (const r of other) console.log(`       ${sl(r) || '(null slug)'} [${r.status}]: ${String(r.map_embed_url).slice(0, 100)}`);

// IN SCOPE = one of the 29 links this exercise dealt with. The database also
// contains rows that already held a coordinate URL and were never short links,
// so counting every coordinate-bearing row would measure the wrong thing.
const inScope = (r) => STEP2.some(([pre]) => hasSlug(pre)(r)) || STEP2_NAME_ONLY.some((pre) => hasSlug(pre)(r));

console.log(`\n── 1. exactly 23 of the 29 hold exact-coordinate URLs ──`);
const exactInScope = exact.filter(inScope);
console.log(`  coordinate-bearing rows in the database: ${exact.length}`);
console.log(`  of those, within the 29-link scope:      ${exactInScope.length}`);
exactInScope.length === STEP2.length
  ? ok(`${STEP2.length} of the 29 now yield an exact coordinate`)
  : bad(`expected ${STEP2.length} in-scope, found ${exactInScope.length}`);

console.log(`\n── 2. exactly 6 still hold their original short links ──`);
shortLnk.length === 6 ? ok('6 rows still hold an unexpanded short link') : bad(`expected 6, found ${shortLnk.length}`);
for (const pre of STEP2_NAME_ONLY) {
  const r = shortLnk.find(hasSlug(pre));
  if (!r) bad(`name-only listing "${pre}…" is NOT among the remaining short links`);
  else if (!/^https:\/\/maps\.app\.goo\.gl\/|^https:\/\/goo\.gl\//.test(r.map_embed_url))
    bad(`${sl(r)}: no longer an original Google short link — ${r.map_embed_url.slice(0, 80)}`);
}
if (!fail) ok('all 6 are the exact listings Step 2 classified as name-only, still short links');

console.log(`\n── 3. every other row accounted for ────────────────────`);
// Do not assume 130-29. The partition is measured: rows either have no link,
// or their link is exact / short / something else. Anything in "something
// else" is a row the normalization never touched, and it has to be NAMED
// rather than folded into an arithmetic mismatch.
console.log(`  map_embed_url IS NULL:            ${noLink.length}`);
console.log(`  carries a link:                   ${withLink.length}  (exact ${exact.length} + short ${shortLnk.length} + other ${other.length})`);
exact.length + shortLnk.length + other.length === withLink.length
  ? ok('the link-bearing rows partition exactly into exact / short / other')
  : bad('classification does not partition the link-bearing rows');
noLink.length + withLink.length === rows.length
  ? ok(`${noLink.length} + ${withLink.length} = ${rows.length} — every row accounted for`)
  : bad('row classification does not sum to the row count');
// A row in "other" must not be one this exercise ever touched.
for (const r of other) {
  const touched = STEP2.some(([pre]) => hasSlug(pre)(r)) || STEP2_NAME_ONLY.some((pre) => hasSlug(pre)(r));
  touched
    ? bad(`${sl(r)}: is one of the 29 but its link is now neither exact nor a short link`)
    : ok(`${sl(r) || '(null slug)'} [${r.status}]: carries a link but is NOT one of the 29 — outside this exercise, untouched`);
}

console.log(`\n── 4/5. stored coordinates vs the STEP 2 reference ─────`);
let matched = 0;
for (const [pre, want] of STEP2) {
  const r = exact.find(hasSlug(pre));
  if (!r) { bad(`no row found for "${pre}…"`); continue; }
  const got = coordOf(r.map_embed_url);
  // String equality: a rounded, reformatted, transposed or substituted value
  // all fail here. Numeric comparison with a tolerance would hide rounding,
  // which is one of the things being checked for.
  if (got.c !== want) bad(`${r.slug}\n        stored ${got.c}\n        step 2 ${want}`);
  else { matched++; console.log(`  ✓ ${sl(r).slice(0, 54).padEnd(54)} ${got.c}  (${got.p})`); }
}
matched === STEP2.length
  ? ok(`all ${matched} match Step 2 exactly — no rounding, transposition, substitution or invention`)
  : bad(`${STEP2.length - matched} coordinate(s) disagree with Step 2`);

console.log(`\n── 6. no plus code decoded, no geocoding, nothing invented ──`);
// A decoded plus code would appear as a coordinate on a row Step 2 classified
// name-only. Equivalently: no name-only listing may now yield a coordinate.
let inferred = 0;
for (const pre of STEP2_NAME_ONLY) {
  const r = rows.find(hasSlug(pre));
  if (r && r.map_embed_url && coordOf(r.map_embed_url)) { bad(`${sl(r)}: now yields a coordinate — a plus code or name was resolved into a location`); inferred++; }
}
if (!inferred) ok('no name-only listing gained a coordinate — no plus code decoded, no geocoding');
// And every stored coordinate must trace to a link Step 2 verified, so none
// was invented for a listing that never had one.
const preExisting = exact.filter((r) => !inScope(r));
if (preExisting.length === 0) {
  ok('every coordinate-bearing row is one Step 2 verified');
} else {
  // Not a failure. A row outside the 29 was never a short link and was never
  // touched -- it already carried a coordinate URL. Failing on it would be
  // failing on the database for containing correct data.
  ok(`${preExisting.length} row(s) carry a coordinate but are OUTSIDE the 29-link scope — pre-existing, never touched:`);
  for (const r of preExisting) console.log(`      ${sl(r) || '(null slug)'} [${r.status}]  ${coordOf(r.map_embed_url).c}\n        ${String(r.map_embed_url).slice(0, 110)}`);
}
// The real invariant: nothing IN scope gained a coordinate it should not have.
const scopedExact = exact.filter(inScope);
scopedExact.length === STEP2.length
  ? ok(`exactly ${STEP2.length} in-scope rows carry a coordinate — none invented or inferred`)
  : bad(`${scopedExact.length} in-scope rows carry a coordinate, expected ${STEP2.length}`);

console.log(`\n── 7. no duplicate location model ──────────────────────`);
const ll = rows.filter((r) => r.latitude !== null || r.longitude !== null);
ll.length === 0
  ? ok(`latitude/longitude NULL on all ${rows.length} rows — map_embed_url remains the only location field`)
  : bad(`${ll.length} row(s) carry latitude/longitude`);

console.log(`\n── 8. the frontend parser accepts all 23 ───────────────`);
// The same map-location.js listings.html loads. Parsing here is the identical
// code path a visitor's browser runs.
// Assert against the 23 we normalized, not against every coordinate in the
// database -- the pre-existing row above is not ours to account for here.
const parsedScoped = scopedExact.map((r) => coordOf(r.map_embed_url)).filter(Boolean);
parsedScoped.length === STEP2.length
  ? ok(`map-location.js parses all ${STEP2.length} normalized values into coordinates`)
  : bad(`parser accepted ${parsedScoped.length} of ${STEP2.length} normalized values`);
const parsed = parsedScoped;
const byPattern = parsed.reduce((a, p) => (a[p.p] = (a[p.p] || 0) + 1, a), {});
for (const [p, n] of Object.entries(byPattern)) console.log(`      ${n} via ${p}`);
const uniq = new Set(parsed.map((p) => p.c));
uniq.size === parsed.length ? ok(`all ${uniq.size} normalized coordinates are distinct — no shared or default value`) : bad(`only ${uniq.size} distinct coordinates among ${parsed.length}`);

const lats = parsed.map((p) => +p.c.split(',')[0]), lngs = parsed.map((p) => +p.c.split(',')[1]);
console.log(`      lat ${Math.min(...lats).toFixed(6)}..${Math.max(...lats).toFixed(6)}   lng ${Math.min(...lngs).toFixed(6)}..${Math.max(...lngs).toFixed(6)}`);

console.log(`\n${fail === 0 ? 'STEP 4 VERIFICATION: PASS' : `STEP 4 VERIFICATION: FAILED (${fail} discrepancy/discrepancies)`}`);
process.exit(fail === 0 ? 0 : 1);
