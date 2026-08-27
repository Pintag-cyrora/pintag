#!/usr/bin/env node
// verify-titles.mjs — READ ONLY confirmation that every ACTIVE listing's title
// names where the property is.
//
// Independent of the script that did the writing: it re-reads production and
// asks the question directly, rather than trusting the writer's own tally.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./provinces.js');
const Title = require('./listing-title.js');

const cfg = readFileSync(new URL('./config.prod.js', import.meta.url), 'utf8');
const pick = (k) => (cfg.match(new RegExp(`${k}:\\s*'([^']+)'`)) || [])[1];
const SUPABASE_URL = pick('supabaseUrl');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || pick('anonKey');

const COLS = 'id,slug,status,workflow_status,deleted_at,title_en,title_lo,title_zh,' +
             'village_en,district_en,district_lo,district_zh,province_en,province_lo,province_zh';
const res = await fetch(`${SUPABASE_URL}/rest/v1/properties?select=${COLS}&limit=2000`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
if (!res.ok) { console.error(`read failed: ${res.status}`); process.exit(1); }
const rows = await res.json();

const active = rows.filter(Title.isActiveListing);
console.log(`${rows.length} listings read, ${active.length} active, ${rows.length - active.length} not active (untouched)\n`);

let located = 0, missing = [], noLocationData = [], noTitle = [];
const dup = [];

for (const r of active) {
  const en = typeof r.title_en === 'string' ? r.title_en.trim() : '';
  if (!en) { noTitle.push(r.slug || r.id); continue; }

  if (Title.titleHasLocation(en, r, 'en')) {
    located++;
    // The failure the requirement names explicitly: the same place twice.
    const parts = Title.locationParts(r, 'en');
    for (const p of [parts.village, parts.district, parts.city].filter(Boolean)) {
      const n = (en.match(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
      if (n > 1) dup.push(`${r.slug}: "${p}" appears ${n}x -> ${en}`);
    }
  } else if (!Title.locationPhrase(r, 'en')) {
    // Not a failure of the title — the row simply carries no location to name.
    noLocationData.push(`${r.slug || r.id}  (title: ${en})`);
  } else {
    missing.push(`${r.slug || r.id}  (title: ${en}  |  available: ${Title.locationPhrase(r, 'en')})`);
  }
}

console.log(`ACTIVE listings with location in the title : ${located}`);
console.log(`ACTIVE listings still WITHOUT              : ${missing.length}`);
console.log(`ACTIVE listings with no location data      : ${noLocationData.length}`);
console.log(`ACTIVE listings with no English title      : ${noTitle.length}`);
console.log(`Duplicated location in a title             : ${dup.length}`);

if (missing.length)        { console.log('\nSTILL MISSING:');        missing.forEach((m) => console.log('  ✗ ' + m)); }
if (noLocationData.length) { console.log('\nNO LOCATION DATA (correctly left alone — never invented):');
                             noLocationData.forEach((m) => console.log('  ⊘ ' + m)); }
if (noTitle.length)        { console.log('\nNO ENGLISH TITLE:');     noTitle.forEach((m) => console.log('  · ' + m)); }
if (dup.length)            { console.log('\nDUPLICATED LOCATION:');  dup.forEach((m) => console.log('  ✗ ' + m)); }

const ok = missing.length === 0 && dup.length === 0;
console.log(`\n${ok ? 'VERIFIED: every active listing that has location data names it in its title'
                    : 'FAILED'}`);
process.exit(ok ? 0 : 1);
