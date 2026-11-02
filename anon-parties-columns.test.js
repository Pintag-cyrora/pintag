// Static companion to tests/security/regression/anon_parties_regression.sql (supabase/migrations/20261104000000_restrict_anon_parties_columns.sql).
// The database now lets anonymous visitors read only the public-profile columns of `parties`; a request that asks for anything else (or for every
// column) is refused. This suite proves every anonymous page request names only granted columns, so tightening the database cannot break a page.
// Run with: node --test anon-parties-columns.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MIGRATION = read('supabase/migrations/20261104000000_restrict_anon_parties_columns.sql');
const GRANTED = MIGRATION.match(/wanted text\[\] := ARRAY\[([^\]]+)\]/)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
const NEVER = ['auth_user_id', 'phone', 'email', 'created_by', 'updated_at', 'internal_notes', 'notes'];
// every file that reaches the data API with the public key
const PUBLIC_FILES = ['index.html', 'listings.html', 'listing.html', 'agents.html', 'agent.html', 'for-agents.html', 'components.js', 'session.js', 'tracking.js', 'analytics-tracking.js', 'contact-intent.js'];

function partyColumnLists(raw) {
  const text = raw.replace(/^\s*\/\/.*$/gm, '');   // comments are not requests
  const constant = /var PARTY_PUBLIC_COLUMNS='([^']+)'/.exec(text);
  const lists = [];
  for (const m of text.matchAll(/parties\(([^)]*)\)/g)) lists.push({ kind: 'embed', cols: m[1] });
  for (const m of text.matchAll(/parties\?([^;\n]*)/g)) {
    const rest = m[1];
    let cols = null;
    const lit = /(?:^|&)select=([^&'"`\s]+)/.exec(rest);
    if (lit) cols = lit[1];
    else if (/select='\+PARTY_PUBLIC_COLUMNS/.test(rest) && constant) cols = constant[1];
    lists.push({ kind: 'direct', cols, raw: rest.split("'")[0] });
  }
  return lists;
}

test('the migration grants exactly the public-profile columns and none of the sensitive ones', () => {
  assert.deepEqual(GRANTED.slice().sort(), ['agency_name', 'bio_en', 'bio_lo', 'created_at', 'id', 'is_active', 'is_verified', 'languages', 'name_en', 'name_lo', 'photo_url', 'slug', 'type', 'whatsapp']);
  for (const n of NEVER) assert.ok(!GRANTED.includes(n), n);
  assert.match(MIGRATION, /REVOKE ALL ON TABLE parties FROM anon/);
  assert.match(MIGRATION, /GRANT SELECT \(%s\) ON TABLE parties TO anon/);
  assert.match(MIGRATION, /CREATE POLICY "public read parties" ON parties FOR SELECT TO anon USING \(true\)/);
  assert.match(MIGRATION, /authenticated read own or admin parties[\s\S]*is_pintag_admin\(auth\.uid\(\)\) OR auth_user_id = auth\.uid\(\)/);
});

test('every anonymous request for parties names its columns, and only granted ones (no select=*, no parties(*), no bare request)', () => {
  let seen = 0;
  for (const f of PUBLIC_FILES) {
    for (const l of partyColumnLists(read(f))) {
      seen++;
      assert.ok(l.cols !== null && l.cols !== '', `${f}: a request for parties has no select list (that means every column): ${l.raw || l.kind}`);
      const cols = l.cols.split(',').map((c) => c.trim());
      for (const c of cols) {
        if (c.includes('(') || c.includes('*')) assert.fail(`${f}: ${c}`);
        assert.ok(GRANTED.includes(c.split(':')[0].trim()), `${f}: column "${c}" is not granted to anon`);
      }
    }
  }
  assert.ok(seen >= 6, 'the public pages that read parties were found');
});

test('agent.html and agents.html (which used to omit the select list) send the shared, granted column list', () => {
  for (const f of ['agent.html', 'agents.html']) {
    const t = read(f);
    const m = /var PARTY_PUBLIC_COLUMNS='([^']+)'/.exec(t);
    assert.ok(m, f);
    assert.deepEqual(m[1].split(',').sort(), GRANTED.slice().sort(), `${f}: the page's list equals the migration's grant list`);
    assert.match(t, /parties\?type=eq\.agent&is_active=eq\.true&slug=eq\.'\+encodeURIComponent\(slug\)\+'&limit=1&select='\+PARTY_PUBLIC_COLUMNS/);
  }
});

test('filters and ordering used on parties by public pages only touch granted columns (a filter or ORDER BY on a column also needs SELECT on it)', () => {
  for (const f of PUBLIC_FILES) for (const l of partyColumnLists(read(f))) {
    if (l.kind !== 'direct') continue;
    for (const part of l.raw.split('&')) {
      const [k, v] = part.split('=');
      if (['select', 'limit', 'offset'].includes(k)) continue;
      if (k === 'order') for (const o of v.split(',')) assert.ok(GRANTED.includes(o.split('.')[0]), `${f}: order by ${o}`);
      else if (k && !/^[a-z_]+$/.test(k) === false) assert.ok(GRANTED.includes(k), `${f}: filter on ${k}`);
    }
  }
});

test('the other anonymous consumers (link-preview Worker, public feed, edge functions) never read parties', () => {
  for (const f of ['cloudflare-worker/og-listing-preview.js', 'supabase/functions/public-listings-feed/index.ts']) assert.doesNotMatch(read(f), /parties/, f);
});
