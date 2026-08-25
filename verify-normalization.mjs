#!/usr/bin/env node
// verify-normalization.mjs — independent BEFORE/AFTER audit of the map link
// normalization. TEMPORARY, scratch branch only.
//
// Why this exists rather than reading the backfill's own summary: the script
// reporting "23 written" is the script grading its own homework. This reads
// the database directly, with the service role so nothing is hidden behind
// RLS, and compares every row — not just the 29 — before and after.
//
// It also captures, BEFORE the write, an independent resolution of each stored
// short link. That is the only moment it can be done: once a link is expanded
// in place the original short URL is gone, so afterwards there is nothing left
// to re-resolve and check the stored value against.
//
//   node verify-normalization.mjs before   -> writes /tmp/before.json + /tmp/expected.json
//   node verify-normalization.mjs after    -> reads them back, prints the audit, exits 1 on any failure
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('./map-location.js');

const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) {
  console.error('usage: verify-normalization.mjs before|after');
  process.exit(2);
}

const cfg = readFileSync(new URL('./config.prod.js', import.meta.url), 'utf8');
const pick = (k) => (cfg.match(new RegExp(`${k}:\\s*'([^']+)'`)) || [])[1];
const SUPABASE_URL = pick('supabaseUrl');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SERVICE) { console.error('SUPABASE_SERVICE_ROLE_KEY required for a complete audit'); process.exit(2); }

const UA = 'PintagMapLinkResolver/1.0 (+https://pintag.io)';

// Service role, so the audit covers EVERY row — a normalization bug that
// touched a draft listing would be invisible through the anon key.
async function allRows() {
  // Offline audit-logic test hook. Never set in CI; without it every read goes
  // to the real database. Exists because a bug in THIS file would otherwise be
  // indistinguishable from a bad write.
  if (process.env.AUDIT_FIXTURE) {
    return JSON.parse(readFileSync(process.env.AUDIT_FIXTURE, 'utf8'))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/properties?select=id,slug,status,map_embed_url,latitude,longitude&limit=2000`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function resolveDirect(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    return r.url;
  } catch { return ''; }
}

const coordOf = (u) => { const r = M.parseMapUrl(u); return r.ok ? `${r.lat},${r.lng}` : null; };

if (phase === 'before') {
  const rows = await allRows();
  writeFileSync('/tmp/before.json', JSON.stringify(rows));
  console.log(`BEFORE: ${rows.length} property rows captured (service role, all statuses)`);

  const shorts = rows.filter((r) => r.map_embed_url && M.isShortLink(r.map_embed_url));
  const expected = {};
  for (const r of shorts) {
    const final = await resolveDirect(r.map_embed_url);
    expected[r.id] = { slug: r.slug, original: r.map_embed_url, final, coord: coordOf(final) };
  }
  writeFileSync('/tmp/expected.json', JSON.stringify(expected));
  const withCoord = Object.values(expected).filter((e) => e.coord).length;
  console.log(`BEFORE: ${shorts.length} short links; independent resolution yields ${withCoord} exact, ${shorts.length - withCoord} without a coordinate`);
  process.exit(0);
}

// ── AFTER ──────────────────────────────────────────────────────────────────
const before = JSON.parse(readFileSync('/tmp/before.json', 'utf8'));
const expected = JSON.parse(readFileSync('/tmp/expected.json', 'utf8'));
const after = await allRows();

const bById = new Map(before.map((r) => [r.id, r]));
const aById = new Map(after.map((r) => [r.id, r]));

let fail = 0;
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const ok = (m) => console.log(`  ✓ ${m}`);

console.log(`\n── row inventory ────────────────────────────────────────`);
console.log(`  before: ${before.length} rows    after: ${after.length} rows`);
if (before.length !== after.length) bad('row COUNT changed — the backfill must never insert or delete');
else ok('row count unchanged (no inserts, no deletes)');

for (const id of bById.keys()) if (!aById.has(id)) bad(`row ${id} disappeared`);
for (const id of aById.keys()) if (!bById.has(id)) bad(`row ${id} appeared`);

// Which rows actually changed, measured rather than assumed.
const changed = [];
for (const [id, b] of bById) {
  const a = aById.get(id);
  if (!a) continue;
  if (a.map_embed_url !== b.map_embed_url) changed.push({ id, slug: b.slug, from: b.map_embed_url, to: a.map_embed_url });
}

const expectExact = Object.entries(expected).filter(([, e]) => e.coord).map(([id]) => id);
const expectUntouched = Object.entries(expected).filter(([, e]) => !e.coord).map(([id]) => id);

console.log(`\n── 1. how many listings were normalized ─────────────────`);
console.log(`  rows whose map_embed_url changed: ${changed.length}`);
changed.length === expectExact.length
  ? ok(`matches the ${expectExact.length} independently-verified exact links`)
  : bad(`expected ${expectExact.length} changes, saw ${changed.length}`);

console.log(`\n── 2. every stored value matches the verified coordinate ─`);
for (const c of changed) {
  const e = expected[c.id];
  if (!e) { bad(`${c.slug}: changed but was never in the verified set`); continue; }
  if (!e.coord) { bad(`${c.slug}: NAME-ONLY link was written — must have been left alone`); continue; }
  const stored = coordOf(c.to);
  if (stored === null) bad(`${c.slug}: stored value yields NO coordinate`);
  // String comparison, not numeric: catches a value that was rounded or
  // reformatted as well as one that is simply wrong.
  else if (stored !== e.coord) bad(`${c.slug}: stored ${stored} != verified ${e.coord}`);
}
if (!fail) ok(`all ${changed.length} stored coordinates are byte-identical to the independent reference`);

console.log(`\n── 3. the name-only links are untouched ─────────────────`);
let nameOnlyOk = true;
for (const id of expectUntouched) {
  const b = bById.get(id), a = aById.get(id);
  if (a.map_embed_url !== b.map_embed_url) { bad(`${b.slug}: name-only link was MODIFIED`); nameOnlyOk = false; }
}
if (nameOnlyOk) ok(`all ${expectUntouched.length} name-only links still hold their original short URL`);

console.log(`\n── 4. no unrelated listing was modified ─────────────────`);
const changedIds = new Set(changed.map((c) => c.id));
const unrelated = [...changedIds].filter((id) => !expectExact.includes(id));
unrelated.length === 0
  ? ok('every changed row is one of the verified-exact links, and nothing else')
  : bad(`${unrelated.length} unrelated row(s) changed: ${unrelated.join(', ')}`);

// Any row that was NOT supposed to change must be byte-identical, including
// the 30 listings that never had a link and any non-public row.
let untouchedOk = true;
for (const [id, b] of bById) {
  if (expectExact.includes(id)) continue;
  const a = aById.get(id);
  if (a && a.map_embed_url !== b.map_embed_url) { bad(`${b.slug}: unexpected change`); untouchedOk = false; }
}
if (untouchedOk) ok(`all ${before.length - changed.length} other rows are byte-identical`);

console.log(`\n── 5. no new location model ─────────────────────────────`);
const latlngWritten = after.filter((r) => r.latitude !== null || r.longitude !== null);
latlngWritten.length === 0
  ? ok('latitude/longitude remain NULL on every row — nothing wrote a duplicate coordinate model')
  : bad(`${latlngWritten.length} row(s) now carry latitude/longitude`);

console.log(`\n── 6. final split ───────────────────────────────────────`);
const shortsAfter = after.filter((r) => r.map_embed_url && M.isShortLink(r.map_embed_url));
const exactAfter = after.filter((r) => r.map_embed_url && coordOf(r.map_embed_url));
console.log(`  rows with a link that yields an EXACT coordinate: ${exactAfter.length}`);
console.log(`  rows still holding an unexpanded short link:      ${shortsAfter.length}`);
exactAfter.length === expectExact.length
  ? ok(`${expectExact.length} exact, as expected`)
  : bad(`expected ${expectExact.length} exact, database has ${exactAfter.length}`);
shortsAfter.length === expectUntouched.length
  ? ok(`${expectUntouched.length} name-only short links remain, as expected`)
  : bad(`expected ${expectUntouched.length} remaining short links, database has ${shortsAfter.length}`);

console.log(`\n${fail === 0 ? 'NORMALIZATION AUDIT: PASS' : `NORMALIZATION AUDIT: FAILED (${fail} check(s))`}`);
process.exit(fail === 0 ? 0 : 1);
