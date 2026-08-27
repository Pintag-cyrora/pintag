#!/usr/bin/env node
// audit-listing-titles.mjs — find ACTIVE listings whose title does not say
// where the property is, and (with --apply) locate them from the structured
// fields they already carry.
//
// WHAT THIS IS FOR
// A title is the only line that reaches a shared link's preview, where the
// district field does not follow it. New and regenerated titles are located by
// listing-title.js at the point of generation; this closes the same gap on
// listings that were written before that rule existed.
//
// WHAT THIS IS NOT
// It writes title_en/title_lo/title_zh and nothing else, on ACTIVE listings
// only, and only where the shared parser can build a location out of fields
// the row already has. No location is ever invented; a row with nothing usable
// is reported and skipped. No column is added, no row created or deleted.
//
// SAFETY
//   * DRY RUN BY DEFAULT. --apply is required to write, and refuses to start
//     without SUPABASE_SERVICE_ROLE_KEY.
//   * ACTIVE ONLY. workflow_status must be active (or unset — the legacy
//     default admin.html itself applies), status must not be draft/archived,
//     and deleted_at must be NULL. Drafts, archived and soft-deleted rows are
//     counted and skipped, never touched.
//   * IDEMPOTENT. ensureTitleLocation() is a no-op on a title that already
//     names its location, so a second run writes nothing.
//   * Every skip prints its reason, so "nothing happened" is always
//     distinguishable from "nothing needed to happen".
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../provinces.js');                       // publishes PintagProvinces
const Title = require('../listing-title.js');

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
// Reading with the service role when it is present so the audit sees the SAME
// rows the write would touch. With only the anon key it sees the public set,
// which is a narrower audit — reported, not hidden.
const readKey = SERVICE || ANON;
const readHeaders = { apikey: readKey, Authorization: `Bearer ${readKey}` };
const writeHeaders = {
  apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
  'Content-Type': 'application/json', Prefer: 'return=minimal'
};

async function req(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res;
}

const COLS = 'id,slug,status,workflow_status,deleted_at,title_en,title_lo,title_zh,' +
             'village_en,district_en,district_lo,district_zh,province_en,province_lo,province_zh';

const rows = await (await req(`${REST}/properties?select=${COLS}&limit=2000`, { headers: readHeaders })).json();

// The active-listing rule and the patch itself both live in the shared module,
// so this script cannot drift from what the tests actually prove.
const active = rows.filter(Title.isActiveListing);
const inactive = rows.length - active.length;

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} listings read` +
            `${SERVICE ? ' (service role)' : ' (anon key — public rows only)'}`);
console.log(`  active:            ${active.length}`);
console.log(`  not active (skipped, untouched): ${inactive}\n`);

let located = 0, alreadyOk = 0, noLocation = 0, noTitle = 0, failed = 0;

for (const row of active) {
  const { patch, changes, reason } = Title.titleLocationPatch(row);

  if (reason === 'no-title') {
    noTitle++; console.log(`  · ${row.slug || row.id} — no title in any language, skipped`); continue;
  }
  if (reason === 'no-usable-location') {
    noLocation++; console.log(`  ⊘ ${row.slug || row.id} — no usable location on the row; title left as-is`); continue;
  }
  if (reason === 'already-located') { alreadyOk++; continue; }

  console.log(`  ✓ ${row.slug || row.id}`);
  changes.forEach((c) => console.log(`      ${c.column}: ${c.from}  ->  ${c.to}`));
  if (!APPLY) { located++; continue; }

  try {
    await req(`${REST}/properties?id=eq.${encodeURIComponent(row.id)}`,
      { method: 'PATCH', headers: writeHeaders, body: JSON.stringify(patch) });
    located++;
  } catch (e) {
    failed++;
    console.log(`      WRITE FAILED: ${e.message}`);
  }
}

console.log(`\n${APPLY ? 'LOCATED' : 'WOULD LOCATE'}: ${located}` +
            `   already located: ${alreadyOk}` +
            `   no usable location: ${noLocation}` +
            `   no title: ${noTitle}` +
            `   failed: ${failed}`);
if (failed) process.exitCode = 1;
