// scripts/diagnostics/orphan-originals/5-gallery-listing-state.sql + summarize_gallery.py + `run.sh gallery` +
// .github/workflows/reconcile-gallery-listings.yml: Gallery Recovery records vs current listing galleries, for the unreferenced
// originals. SYNTHETIC data only. Pins:
//   * the query reconstructs EXACTLY the population 2-diagnostic.sql counts and 3-reconcile.sql lists (real Postgres);
//   * the latest record per object; conflicting records tied at the latest instant -> 'ambiguous' (no listing picked);
//   * missing / soft-deleted / active-photo-absent listings are told apart; photo_in_gallery is a consistency probe;
//   * closed vocabularies; READ ONLY guard; no writes; privacy of stdout/log/summary; the private detail file's exact columns;
//   * the runner's gallery mode (gates, stage order, cross-check, cleanup), and the workflow's invariants.
// Run with: node --test reconcile-gallery-listings.test.js   (CI=true: a missing PostgreSQL install is a FAILURE, not a skip)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'reconcile-gallery-listings.yml');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const SECRET_URL = 'postgres://backup_ro:S3cr3tPassw0rd@db.example.invalid:5432/postgres';
const IDENT = /SYN-OBJ|SYNOBJ|PLANTED|0000aaaa|0000bbbb|rec-planted/i;   // markers carried by every planted name / listing id / record id

function findPgBin() {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const base = '/usr/lib/postgresql';
  if (fs.existsSync(base)) for (const v of fs.readdirSync(base).sort((a, b) => Number(b) - Number(a))) dirs.push(path.join(base, v, 'bin'));
  for (const d of dirs) if (d && fs.existsSync(path.join(d, 'initdb')) && fs.existsSync(path.join(d, 'pg_ctl'))) return d;
  return null;
}
const PGBIN = findPgBin();
const PSQL = spawnSync('psql', ['--version']).status === 0 ? 'psql' : (PGBIN && fs.existsSync(path.join(PGBIN, 'psql')) ? path.join(PGBIN, 'psql') : null);
const skip = !PGBIN || !PSQL;
const opts = { skip: skip ? 'no local PostgreSQL install (CI requires one)' : false };
let dir, sock, port, counter = 0;
const asPg = (cmd, args) => IS_ROOT ? spawnSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { encoding: 'utf8' }) : spawnSync(cmd, args, { encoding: 'utf8' });
const psqlRaw = (db, args, input) => spawnSync(PSQL, ['-h', sock, '-p', String(port), '-U', 'postgres', '-d', db, '-X', '-q', ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: dir } });

before(() => {
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL server binaries / psql: the gallery listing-state tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pggl-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  assert.equal(asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']).status, 0);
  assert.equal(asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']).status, 0);
  psqlRaw('postgres', [], 'CREATE ROLE gl_ro LOGIN BYPASSRLS;');
});
after(() => {
  if (!dir) return;
  asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
const B = 'https://x.supabase.co/storage/v1/object/public/property-images/';
const L = (n) => `00000000-0000-0000-aaaa-${String(n).padStart(12, '0')}`;   // planted listing ids (marker 0000aaaa)
const R = (n) => `00000000-0000-0000-bbbb-${String(n).padStart(12, '0')}`;   // planted record ids (marker 0000bbbb)
const O = (n) => `SYN-OBJ-${n}.jpg`;
const SCHEMA = `
CREATE SCHEMA storage;
CREATE TABLE storage.objects (bucket_id text, name text, created_at timestamptz, metadata jsonb);
CREATE TABLE public.properties (id uuid PRIMARY KEY, images jsonb, deleted_at timestamptz, updated_at timestamptz);
CREATE TABLE public.unit_types (images text[]);
CREATE TABLE public.parties (photo_url text);
CREATE TABLE public.property_images (storage_path text, status text);
CREATE TABLE public.gallery_assignments (id uuid PRIMARY KEY, op text, listing_id uuid, cluster_id text, photo_paths jsonb, confidence text, operator text, created_at timestamptz);
CREATE TABLE public.properties_row_snapshots (id uuid DEFAULT gen_random_uuid(), property_id uuid, op text, row_data jsonb, created_at timestamptz);
CREATE TABLE public.import_records (id uuid DEFAULT gen_random_uuid(), listing_id uuid, raw_payload jsonb, imported_at timestamptz);
CREATE TABLE public.listing_image_snapshots (id uuid DEFAULT gen_random_uuid(), listing_id uuid, storage_url text, storage_path text, created_at timestamptz);
CREATE TABLE public.import_images (id uuid DEFAULT gen_random_uuid(), import_id uuid, listing_id uuid, storage_url text, storage_path text, uploaded_at timestamptz);
`;
let rec = 0;
const ga = (op, listing, names, ts, { cluster = 'by-listing', conf = 'high', operator = 'someone@example.com', id } = {}) =>
  `INSERT INTO gallery_assignments (id, op, listing_id, cluster_id, photo_paths, confidence, operator, created_at) VALUES ('${id || R(++rec)}', ${q(op)}, ${listing ? q(listing) : 'NULL'}, ${q(cluster)}, ${q(JSON.stringify(names))}::jsonb, ${conf ? q(conf) : 'NULL'}, ${q(operator)}, ${q(ts)});`;
const obj = (name, size = 1000) => `INSERT INTO storage.objects VALUES ('property-images', ${q(name)}, '2026-08-01T00:00:00Z', ${q(JSON.stringify({ size }))}::jsonb);`;

// 1 active listing (4 gallery photos incl. one that is a live object), 2 active empty, 3 soft-deleted, (4 missing = no row), 5 active (changed AFTER its record)
const DATA = `
INSERT INTO properties VALUES ('${L(1)}', ${q(JSON.stringify([B + 'live-a.jpg', B + 'live-b.jpg', B + 'live-c.jpg', B + 'live-d.jpg']))}::jsonb, NULL, '2026-08-01T00:00:00Z');
INSERT INTO properties VALUES ('${L(2)}', '[]'::jsonb, NULL, '2026-07-01T00:00:00Z'), ('${L(3)}', NULL, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z'), ('${L(5)}', '"not-an-array"'::jsonb, NULL, '2026-09-30T00:00:00Z');
${['live-a.jpg', 'live-b.jpg', 'live-c.jpg', 'live-d.jpg'].map((n) => obj(n)).join('\n')}
${obj('unit-ref.jpg')} ${obj('agent-ref.jpg')} ${obj('registry-ref.jpg')} ${obj('my unit enc.jpg')}
INSERT INTO unit_types VALUES (ARRAY[${q(B + 'unit-ref.jpg')}, ${q(B + 'my%20unit%20enc.jpg')}]);
INSERT INTO parties VALUES (${q(B + 'agent-ref.jpg')});
INSERT INTO property_images VALUES ('registry-ref.jpg', 'removed');
INSERT INTO storage.objects VALUES ('other-bucket', ${q(O(99))}, now(), '{}'), ('property-images', 'renditions/${O(1)}/card.webp', now(), '{}');
-- the population (everything below is unreferenced); ASSIGN group:
${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((n) => obj(O(n), 1000 + n)).join('\n')}
${obj('SYN-OBJ-enc d.jpg', 500)} ${obj('SYN-OBJ-nohist.jpg', 700)}
${ga('assign', L(1), [O(1)], '2026-08-06T10:00:00Z', { conf: 'low', cluster: 'gallery-editor' })}
${ga('assign', L(1), [O(2)], '2026-08-06T10:00:00Z', { conf: 'medium' })}
${ga('assign', L(2), [O(3), 'SYN-OBJ-enc%20d.jpg'], '2026-08-07T00:00:00Z')}
${ga('assign', L(3), [O(4)], '2026-08-07T00:00:00Z')}
${ga('assign', L(4), [O(5)], '2026-08-07T00:00:00Z')}
${ga('assign', null, [O(6)], '2026-08-07T00:00:00Z')}
${ga('assign', L(5), [O(7)], '2026-08-08T00:00:00Z')}
-- latest record wins: earlier assign, later unassign (-> unassign); earlier unassign, later assign (-> assign)
${ga('assign', L(1), [O(8)], '2026-08-06T00:00:00Z')}
${ga('unassign', L(1), [O(8)], '2026-08-09T00:00:00Z', { cluster: 'move', conf: null })}
${ga('unassign', L(2), [O(9)], '2026-08-06T00:00:00Z', { cluster: 'move', conf: null })}
${ga('assign', L(2), [O(9)], '2026-08-10T00:00:00Z')}
-- unassign group: listing missing / soft-deleted / active
${ga('unassign', L(4), [O(10)], '2026-08-09T00:00:00Z', { conf: null })}
${ga('unassign', L(3), [O(11)], '2026-08-09T00:00:00Z', { conf: null })}
${ga('unassign', L(2), [O(12)], '2026-08-09T00:00:00Z', { conf: null })}
-- ambiguous: same instant, different listings / different operations; NOT ambiguous: identical duplicate records at one instant
${ga('assign', L(1), [O(13)], '2026-08-11T00:00:00Z')}
${ga('assign', L(2), [O(13)], '2026-08-11T00:00:00Z')}
${ga('assign', L(1), [O(14)], '2026-08-11T00:00:00Z')}
${ga('unassign', L(1), [O(14)], '2026-08-11T00:00:00Z', { conf: null })}
${ga('assign', L(2), [O(15)], '2026-08-11T00:00:00Z')}
${ga('assign', L(2), [O(15)], '2026-08-11T00:00:00Z')}
-- malformed history that must be ignored safely, and an out-of-vocabulary row
${ga('assign', L(2), { not: 'a list', n: 5, nested: [null, 7] }, '2026-08-01T00:00:00Z')}
${ga('assign', L(2), 'null', '2026-08-01T00:00:00Z')}
${ga('weird-op', L(2), [O(16)], '2026-08-12T00:00:00Z', { cluster: 'PLANTED-cluster-name', conf: 'PLANTED-confidence' })}
`;

function parseCsv(text) {
  const rows = []; let row = [], f = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inQ = false; } else f += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
function makeDb(extra = '') {
  const db = `g${++counter}`;
  assert.equal(psqlRaw('postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${db};`).status, 0);
  const s = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1'], SCHEMA + DATA + extra + `GRANT USAGE ON SCHEMA public, storage TO gl_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public, storage TO gl_ro;`);
  assert.equal(s.status, 0, s.stderr);
  return db;
}
function runSql(db, file, { readOnly = true } = {}) {
  const r = psqlRaw(db, ['--csv', '-v', 'ON_ERROR_STOP=1', ...(readOnly ? ['-c', 'BEGIN READ ONLY'] : []), '-f', path.join(D, file), ...(readOnly ? ['-c', 'ROLLBACK'] : [])]);
  assert.equal(r.status, 0, r.stderr);
  return parseCsv(r.stdout);
}
const by = (rows) => Object.fromEntries(rows.map((r) => [r.object_name, r]));

// ── the query ──
test('population: exactly the objects 2-diagnostic.sql counts and 3-reconcile.sql lists (referenced, encoded-referenced, renditions, other buckets excluded)', opts, () => {
  const db = makeDb();
  const rows = runSql(db, '5-gallery-listing-state.sql');
  const names = rows.map((r) => r.object_name).sort();
  const recon = runSql(db, '3-reconcile.sql').map((r) => r.object_name).sort();
  assert.deepEqual(names, recon, 'the same objects as the existing reconciliation');
  const d = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-c', 'BEGIN READ ONLY', '-f', path.join(D, '2-diagnostic.sql'), '-c', 'ROLLBACK']);
  assert.equal(Number(d.stdout.split('\n').find((l) => /TOTAL/.test(l)).split(' | ').pop()), rows.length);
  assert.equal(rows.length, 18);
  for (const excluded of ['live-a.jpg', 'unit-ref.jpg', 'agent-ref.jpg', 'registry-ref.jpg', 'my unit enc.jpg', O(99)]) assert.ok(!names.includes(excluded), excluded);
  assert.ok(!names.some((n) => n.startsWith('renditions/')));
  assert.equal(rows.filter((r) => r.has_history === 'f').length, 1);   // only the object with no history at all
});

test('latest record per object: later unassign beats earlier assign, later assign beats earlier unassign; encoded history names match', opts, () => {
  const r = by(runSql(makeDb(), '5-gallery-listing-state.sql'));
  assert.equal(r[O(8)].latest_op, 'unassign');
  assert.equal(r[O(9)].latest_op, 'assign');
  assert.equal(r['SYN-OBJ-enc d.jpg'].latest_op, 'assign');   // history stores 'SYN-OBJ-enc%20d.jpg'
  assert.equal(r['SYN-OBJ-enc d.jpg'].has_history, 't');
});

test('listing state: missing, soft-deleted and ACTIVE-with-the-photo-absent are told apart; no usable listing id is its own state', opts, () => {
  const r = by(runSql(makeDb(), '5-gallery-listing-state.sql'));
  assert.equal(r[O(1)].listing_state, 'listing_active');
  assert.equal(r[O(4)].listing_state, 'listing_soft_deleted');
  assert.equal(r[O(5)].listing_state, 'listing_missing');
  assert.equal(r[O(6)].listing_state, 'no_usable_listing_id');
  assert.equal(r[O(10)].listing_state, 'listing_missing');
  assert.equal(r[O(11)].listing_state, 'listing_soft_deleted');
  assert.equal(r[O(12)].listing_state, 'listing_active');
  for (const x of Object.values(r)) assert.equal(x.photo_in_gallery, 'f');   // by the population definition
});

test('active listing details: gallery size (array / empty / non-array), changed-after-record, confidence and how it was recorded', opts, () => {
  const r = by(runSql(makeDb(), '5-gallery-listing-state.sql'));
  assert.equal(r[O(1)].listing_gallery_size, '4');
  assert.equal(r[O(3)].listing_gallery_size, '0');
  assert.equal(r[O(7)].listing_gallery_size, '0');           // non-array images -> 0
  assert.equal(r[O(1)].listing_changed_after_record, 'not_changed_after_record');
  assert.equal(r[O(7)].listing_changed_after_record, 'changed_after_record');   // updated 2026-09-30, record 2026-08-08
  assert.equal(r[O(5)].listing_changed_after_record, 'unknown');                // no listing row
  assert.equal(r[O(1)].confidence, 'low'); assert.equal(r[O(1)].recorded_via, 'gallery-editor');
  assert.equal(r[O(2)].confidence, 'medium'); assert.equal(r[O(2)].recorded_via, 'by-listing');
});

test('ambiguity: records tied at the latest instant that disagree on listing OR operation -> ambiguous (no listing picked); identical duplicates are not a conflict', opts, () => {
  const r = by(runSql(makeDb(), '5-gallery-listing-state.sql'));
  for (const n of [13, 14]) {
    const x = r[O(n)];
    assert.equal(x.latest_op, 'ambiguous', O(n));
    assert.equal(x.listing_id, ''); assert.equal(x.record_id, ''); assert.equal(x.listing_state, '');
    assert.equal(x.confidence, ''); assert.equal(x.recorded_via, ''); assert.equal(x.listing_changed_after_record, 'unknown');
    assert.equal(x.tied_records, '2');
  }
  assert.equal(r[O(13)].tied_listings, '2');   // two different listings
  assert.equal(r[O(14)].tied_listings, '1');   // same listing, different operations
  assert.equal(r[O(15)].latest_op, 'assign');  // two identical records at one instant: not ambiguous
  assert.equal(r[O(15)].tied_records, '2');
  assert.equal(r[O(15)].listing_state, 'listing_active');
});

test('closed vocabularies: an unknown operation is "other", unknown cluster / confidence never echo; malformed JSON history is ignored', opts, () => {
  const rows = runSql(makeDb(), '5-gallery-listing-state.sql');
  const r = by(rows);
  assert.equal(r[O(16)].latest_op, 'other');
  assert.equal(r[O(16)].recorded_via, '(other)');
  assert.equal(r[O(16)].confidence, 'n/a');
  assert.doesNotMatch(JSON.stringify(rows), /PLANTED/);
});

test('READ ONLY guard: outside a READ ONLY transaction the query returns no rows; it never changes any table', opts, () => {
  const db = makeDb();
  assert.equal(runSql(db, '5-gallery-listing-state.sql', { readOnly: false }).length, 0);
  const count = () => psqlRaw(db, ['-A', '-t'], `SELECT (SELECT count(*) FROM storage.objects)||','||(SELECT count(*) FROM gallery_assignments)||','||(SELECT count(*) FROM properties);`).stdout.trim();
  const before = count(); runSql(db, '5-gallery-listing-state.sql');
  assert.equal(count(), before);
  const w = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY', '-c', 'DELETE FROM gallery_assignments']);
  assert.notEqual(w.status, 0); assert.match(w.stderr, /read-only transaction/);
});

test('the query selects no operator, title, contact or payload column', () => {
  const sql = fs.readFileSync(path.join(D, '5-gallery-listing-state.sql'), 'utf8').replace(/--.*$/gm, '');
  const outCols = sql.slice(sql.lastIndexOf('SELECT s.name AS object_name'));
  assert.doesNotMatch(outCols, /operator|title|phone|email|contact|raw_payload|row_data/i);
  const cols = [...outCols.matchAll(/ AS ([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(cols, ['object_name', 'size_bytes', 'has_history', 'latest_op', 'listing_id', 'record_id', 'record_date', 'listing_state', 'photo_in_gallery', 'listing_gallery_size', 'listing_changed_after_record', 'confidence', 'recorded_via'].filter((c) => cols.includes(c)));
});

// ── summarize_gallery.py ──
const SUM = path.join(D, 'summarize_gallery.py');
const IN_COLS = ['object_name', 'size_bytes', 'has_history', 'latest_op', 'listing_id', 'record_id', 'record_date', 'tied_records', 'tied_listings', 'listing_state', 'photo_in_gallery', 'listing_gallery_size', 'listing_changed_after_record', 'confidence', 'recorded_via'];
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
let n = 0;
const base = (o) => ({ object_name: `SYN-OBJ-s${++n}.jpg`, size_bytes: '1000', has_history: 't', latest_op: 'assign', listing_id: L(1), record_id: R(1), record_date: '2026-08-06 10:00:00+00', tied_records: '1', tied_listings: '1',
  listing_state: 'listing_active', photo_in_gallery: 'f', listing_gallery_size: '4', listing_changed_after_record: 'not_changed_after_record', confidence: 'high', recorded_via: 'by-listing', ...o });
const none = () => base({ has_history: 'f', latest_op: '', listing_id: '', record_id: '', record_date: '', tied_records: '', tied_listings: '', listing_state: '', listing_gallery_size: '', listing_changed_after_record: '', confidence: '', recorded_via: '' });
const amb = (rec = 2, lst = 2) => base({ latest_op: 'ambiguous', listing_id: '', record_id: '', tied_records: String(rec), tied_listings: String(lst), listing_state: '', listing_gallery_size: '', listing_changed_after_record: 'unknown', confidence: '', recorded_via: '' });
const ROWS = [
  base({ listing_gallery_size: '0', confidence: 'low' }), base({ listing_gallery_size: '3' }), base({ listing_gallery_size: '10', listing_changed_after_record: 'changed_after_record', recorded_via: 'gallery-editor' }),
  base({ listing_gallery_size: '30', listing_id: L(2), record_id: R(2) }),
  base({ listing_state: 'listing_missing', listing_id: L(8), record_id: R(3), listing_gallery_size: '', listing_changed_after_record: 'unknown' }),
  base({ listing_state: 'listing_missing', listing_id: L(8), record_id: R(3), listing_gallery_size: '', listing_changed_after_record: 'unknown', size_bytes: '' }),
  base({ listing_state: 'listing_soft_deleted', listing_id: L(3), record_id: R(4), listing_gallery_size: '0' }),
  base({ listing_state: 'no_usable_listing_id', listing_id: '', record_id: R(5), listing_gallery_size: '', listing_changed_after_record: 'unknown' }),
  base({ latest_op: 'unassign', listing_state: 'listing_missing', listing_id: L(9), record_id: R(6), confidence: 'n/a', recorded_via: 'move', listing_gallery_size: '' }),
  base({ latest_op: 'unassign', listing_state: 'listing_active', listing_id: L(1), record_id: R(7), confidence: 'n/a', recorded_via: 'move' }),
  amb(2, 2), amb(2, 1), amb(4, 3), none(), none(), none(),
];
const mkcsv = (rows, header = IN_COLS) => [header.join(','), ...rows.map((o) => header.map((c) => esc(o[c] ?? '')).join(','))].join('\n') + '\n';
function summarize(rows = ROWS, { expected = rows.length, text } = {}) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-'));
  fs.writeFileSync(path.join(w, 'in.csv'), text ?? mkcsv(rows));
  const r = spawnSync('python3', ['-I', '-B', SUM, '--objects', path.join(w, 'in.csv'), '--expected', String(expected), '--out-detail', path.join(w, 'detail.csv'), '--out-summary', path.join(w, 'sum.md')], { encoding: 'utf8' });
  const f = (x) => (fs.existsSync(path.join(w, x)) ? fs.readFileSync(path.join(w, x), 'utf8') : null);
  return { r, md: f('sum.md'), detail: f('detail.csv') };
}
const rowOf = (md, startsWith) => md.split('\n').find((l) => l.startsWith(startsWith));

test('summary: groups, outcomes (missing / soft-deleted / active-photo-absent / no usable id), sizes and distinct-listing counts reconcile to the population', () => {
  const { r, md } = summarize();
  assert.equal(r.status, 0, r.stderr);
  assert.match(md, /\*\*16 objects\. Counts reconcile to the stage-2 total \(16\)\.\*\* 13 have Gallery Recovery history; 3 have none\./);
  assert.match(rowOf(md, '| assign (main focus)'), /^\| assign \(main focus\) \| 8 \| 6\.8 KB \(\+1 unknown size\) \| 4 \|$/);
  assert.match(md, /\| unassign \(already detached by an operator\) \| 2 \|/);
  assert.match(md, /\| ambiguous \(conflicting records tied at the latest instant\) \| 3 \|/);
  assert.match(md, /\| no Gallery Recovery history \| 3 \|/);
  assert.match(md, /\| missing listing \(no properties row\) \| 2 \|/);
  assert.match(md, /\| soft-deleted listing \(deleted_at set\) \| 1 \|/);
  assert.match(md, /\| active listing; its gallery no longer references the photo \| 4 \|/);
  assert.match(md, /\| record has no usable listing id \| 1 \|/);
  assert.match(md, /Active listings where the photo is absent \(4 objects, 2 listings\)/);
  assert.equal(rowOf(md, '| empty gallery |').split('|')[2].trim(), '1');
  assert.match(md, /\| 6 or more \| 0 \|/);
  assert.match(md, /\| 2 \| 2 \|/);
  assert.match(md, /\| 3-5 \| 1 \|/);
  assert.match(md, /Tied records name 2 objects with more than one different listing/);
});

test('summary and logs never contain an object name, listing id or record id; the detail file holds them (history rows only, fixed columns)', () => {
  const { md, detail, r } = summarize();
  assert.doesNotMatch(md + r.stderr + r.stdout, IDENT);
  const rows = parseCsv(detail);
  assert.equal(rows.length, 13);   // 8 assign (incl. the one with no usable listing id) + 2 unassign + 3 ambiguous
  assert.deepEqual(Object.keys(rows[0]), ['object_name', 'latest_op', 'outcome', 'listing_id', 'record_id', 'record_date', 'tied_records', 'tied_listings', 'listing_gallery_size', 'listing_changed_after_record', 'confidence', 'recorded_via', 'size_bytes']);
  assert.ok(rows.every((x) => /^SYN-OBJ-s\d+\.jpg$/.test(x.object_name)));
  assert.ok(rows.filter((x) => x.latest_op === 'ambiguous').every((x) => x.outcome === 'ambiguous_latest_record' && x.listing_id === '' && x.record_id === ''));
  assert.ok(!detail.includes('operator') && !detail.includes('@'));
});

for (const [label, build, msg] of [
  ['a count different from the stage-2 total', () => ({ expected: 999 }), /returned 16 objects but the stage-2 diagnostic counted 999/],
  ['an object still referenced by its listing gallery (photo_in_gallery = t)', () => ({ rows: [...ROWS, base({ photo_in_gallery: 't' })] }), /population definition is inconsistent/],
  ['an ambiguous row that still carries a pick', () => ({ rows: [...ROWS, { ...amb(), listing_id: L(1) }] }), /ambiguous row carries a pick/],
  ['an ambiguous row with fewer than two tied records', () => ({ rows: [...ROWS, amb(1, 1)] }), /ambiguous row carries a pick or too few/],
  ['a history row without a listing state', () => ({ rows: [...ROWS, base({ listing_state: '' })] }), /without a record or listing state/],
  ['a history flag that disagrees with the operation', () => ({ rows: [...ROWS, base({ has_history: 'f' })] }), /history flag and operation disagree/],
  ['a row without history that carries a record', () => ({ rows: [...ROWS, { ...none(), record_id: R(1) }] }), /without history carries a record/],
  ['a malformed listing id', () => ({ rows: [...ROWS, base({ listing_id: 'SYN-not-a-uuid PLANTED' })] }), /malformed listing id/],
  ['a value outside the vocabulary', () => ({ rows: [...ROWS, base({ recorded_via: 'PLANTED-vocab' })] }), /malformed value .*vocabulary/],
  ['a non-numeric size', () => ({ rows: [...ROWS, base({ size_bytes: 'PLANTED-size' })] }), /malformed value .*size_bytes/],
  ['a duplicate object', () => ({ rows: [...ROWS, { ...ROWS[0] }] }), /duplicate object at row/],
  ['a ragged row', () => ({ text: mkcsv(ROWS) + 'SYN-OBJ-short,1\n', expected: 18 }), /malformed row \(wrong number of fields\)/],
  ['the wrong columns', () => ({ text: 'object_name,owner_phone\nSYN-OBJ-x,+1\n', expected: 1 }), /expected columns/],
  ['an empty file', () => ({ text: '', expected: 0 }), /expected columns/],
]) {
  test(`summarize_gallery fails closed on ${label}: exit 1, generic message, no detail file, no identifier anywhere`, () => {
    const spec = build();
    const { r, md, detail } = summarize(spec.rows, spec);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, msg);
    assert.equal(detail, null, 'no per-object file for a failed reconciliation');
    assert.match(md, /RECONCILIATION FAILED/);
    assert.doesNotMatch(r.stderr + r.stdout + md, /SYN-OBJ|PLANTED|0000aaaa|0000bbbb|owner_phone|Traceback/);
  });
}

test('summarize_gallery: invalid UTF-8 / missing input -> exit 1 with the exception type only', () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-bad-'));
  fs.writeFileSync(path.join(w, 'in.csv'), Buffer.concat([Buffer.from(IN_COLS.join(',') + '\n'), Buffer.from([0xff, 0xfe, 0x0a])]));
  const a = spawnSync('python3', ['-I', '-B', SUM, '--objects', path.join(w, 'in.csv'), '--expected', '1'], { encoding: 'utf8', cwd: w });
  const b = spawnSync('python3', ['-I', '-B', SUM, '--objects', path.join(w, 'SYN-OBJ-dir', 'in.csv'), '--expected', '1'], { encoding: 'utf8', cwd: w });
  for (const x of [a, b]) { assert.equal(x.status, 1); assert.doesNotMatch(x.stderr, /Traceback|SYN-OBJ/); }
  assert.match(a.stderr, /UnicodeDecodeError/);
});

test('mutation guard: the group sums really are checked (a doctored input cannot add up silently)', () => {
  const src = fs.readFileSync(SUM, 'utf8');
  for (const m of ['do not add up to the population', 'do not add up to the group', 'gallery-size buckets do not add up', 'breakdown does not add up']) assert.ok(src.includes(m), m);
});

// ── run.sh gallery mode against a fake psql ──
function runFake({ preflight, diag = ' 1 TOTAL | 4000 bytes | 16\n', env = {}, failOn, stale = false, rows = ROWS, stubSummarizer } = {}) {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-'));
  const work = path.join(dir2, 'work'); fs.mkdirSync(work); fs.mkdirSync(path.join(dir2, 'bin'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  if (stubSummarizer) fs.writeFileSync(path.join(work, 'summarize_gallery.py'), stubSummarizer);
  if (stale) for (const f of ['gallery-listing-detail.csv', 'gallery-listing-summary.md', 'gallery-state.csv', 'diagnostic.txt']) fs.writeFileSync(path.join(work, f), 'STALE\n');
  fs.writeFileSync(path.join(dir2, 'pre.out'), preflight ?? 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\n');
  fs.writeFileSync(path.join(dir2, 'diag.out'), diag);
  fs.writeFileSync(path.join(dir2, 'g.out'), mkcsv(rows));
  const log = path.join(dir2, 'psql.log');
  fs.writeFileSync(path.join(dir2, 'bin', 'psql'), `#!/bin/bash
echo "CALL $*" >> "${log}"
case "$*" in
  *${failOn || 'NEVER-MATCHES'}*) echo "ERROR:  invalid input: \\"SYN-OBJ-leak.jpg\\" listing ${L(1)}" >&2; echo "ERROR:  22P02" >&2; echo "SYN-OBJ-stdout-leak.jpg"; exit 3;;
  *1-preflight.sql*) cat "${dir2}/pre.out";; *2-diagnostic.sql*) cat "${dir2}/diag.out";; *5-gallery-listing-state.sql*) cat "${dir2}/g.out";;
esac
`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(work, 'run.sh'), 'gallery'], { env: { PATH: `${path.join(dir2, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir2, PINTAG_PROD_DB_URL: SECRET_URL, ...env }, encoding: 'utf8', input: '' });
  const files = {};
  for (const f of fs.readdirSync(work)) if (/\.(txt|md|csv)$/.test(f)) files[f] = fs.readFileSync(path.join(work, f), 'utf8');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('CALL ').filter(Boolean) : [];
  return { r, out: r.stdout + r.stderr, files, calls };
}

test('gallery mode: lint, preflight, stage-2 cross-check, then stage 5 only (no stage 3/4); every call READ ONLY; raw state file removed; detail file kept', () => {
  const { r, out, files, calls } = runFake();
  assert.equal(r.status, 0, out);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /1-preflight\.sql/); assert.match(calls[1], /2-diagnostic\.sql/); assert.match(calls[2], /5-gallery-listing-state\.sql/);
  for (const c of calls) { assert.match(c, /BEGIN READ ONLY.*\.sql.*ROLLBACK/); assert.doesNotMatch(c, /3-reconcile|4-source-health/); }
  assert.match(out, /lint ok: 5-gallery-listing-state\.sql/);
  assert.match(out, /=== stage 5: Gallery Recovery records vs current listing galleries, for the 16 objects/);
  assert.ok(!('gallery-state.csv' in files), 'the raw all-objects file never outlives the run');
  assert.ok('gallery-listing-detail.csv' in files && 'gallery-listing-summary.md' in files);
  assert.doesNotMatch(out, IDENT);
  for (const [f, t] of Object.entries(files)) if (f !== 'gallery-listing-detail.csv') assert.doesNotMatch(t, IDENT, f);
  assert.doesNotMatch(out + Object.values(files).join(''), /S3cr3tPassw0rd/);
});

for (const [label, preflight, text] of [
  ['gallery-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | FAIL\n', /GALLERY-SCHEMA VERDICT DID NOT PASS/],
  ['gallery-schema missing', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\n', /GALLERY-SCHEMA VERDICT DID NOT PASS/],
  ['reconcile-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | FAIL\nVERDICT | gallery-schema | PASS\n', /RECONCILE-SCHEMA VERDICT DID NOT PASS/],
]) {
  test(`gallery mode stops before stage 5 on ${label}: job fails visibly, no detail file`, () => {
    const { r, out, files, calls } = runFake({ preflight, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, text);
    assert.ok(!calls.some((c) => /5-gallery-listing-state/.test(c)));
    for (const f of ['gallery-listing-detail.csv', 'gallery-listing-summary.md', 'gallery-state.csv']) assert.ok(!(f in files), `${f} must not survive`);
  });
}

for (const [label, preflight] of [
  ['a FAIL verdict', 'VERDICT | schema | PASS\nVERDICT | role+session | FAIL\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\n'],
  ['a WARN row', 'role | rolbypassrls | WARN false\nVERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\n'],
]) {
  test(`gallery mode keeps the preflight gates: ${label} stops everything before any data stage`, () => {
    const { r, calls, files } = runFake({ preflight, stale: true });
    assert.equal(r.status, 1);
    assert.equal(calls.length, 1);
    assert.ok(!('gallery-listing-detail.csv' in files));
  });
}

test('gallery mode: expected_objects must match the stage-2 total (or be numeric); stage 5 is not run otherwise', () => {
  const ok = runFake({ env: { EXPECTED_OBJECTS: '16' } });
  assert.equal(ok.r.status, 0, ok.out);
  const bad = runFake({ env: { EXPECTED_OBJECTS: '551' } });
  assert.equal(bad.r.status, 1);
  assert.match(bad.out, /Stage 2 counted 16 objects but expected_objects is 551/);
  assert.equal(bad.calls.length, 2);
  const nonnum = runFake({ env: { EXPECTED_OBJECTS: '5;DROP' } });
  assert.equal(nonnum.r.status, 1);
  assert.match(nonnum.out, /expected_objects must be a number/);
  assert.equal(nonnum.calls.length, 2);
});

test('gallery mode: a result that does not reconcile to the stage-2 total fails the job and writes no detail file', () => {
  const { r, out, files } = runFake({ diag: ' 1 TOTAL | 4000 bytes | 551\n' });
  assert.equal(r.status, 1);
  assert.match(out, /returned 16 objects but the stage-2 diagnostic counted 551/);
  assert.ok(!('gallery-listing-detail.csv' in files));
  assert.doesNotMatch(out, IDENT);
});

for (const failOn of ['2-diagnostic.sql', '5-gallery-listing-state.sql']) {
  test(`gallery mode: psql failure in ${failOn} withholds the error text (SQLSTATE only), prints no identifier, leaves no detail file`, () => {
    const { r, out, files } = runFake({ failOn, stale: true });
    assert.notEqual(r.status, 0);
    assert.match(out, /psql failed \(exit 3\); its error text is withheld/);
    assert.doesNotMatch(out, /SYN-OBJ|0000aaaa/);
    for (const [f, t] of Object.entries(files)) assert.doesNotMatch(t, /SYN-OBJ-(stdout-)?leak/, f);
    assert.ok(!('gallery-listing-detail.csv' in files) && !('gallery-state.csv' in files));
  });
}

test('the default run.sh mode is unchanged: stages 1-4, never stage 5', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-'));
  const work = path.join(dir2, 'work'); fs.mkdirSync(work); fs.mkdirSync(path.join(dir2, 'bin'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  const log = path.join(dir2, 'psql.log');
  fs.writeFileSync(path.join(dir2, 'bin', 'psql'), `#!/bin/bash\necho "CALL $*" >> "${log}"\ncase "$*" in *1-preflight*) printf 'VERDICT | schema | PASS\\nVERDICT | role+session | PASS\\n';; *2-diag*) echo ' 1 TOTAL | x | 3';; esac\n`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(work, 'run.sh')], { env: { PATH: `${path.join(dir2, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir2, PINTAG_PROD_DB_URL: SECRET_URL }, encoding: 'utf8', input: '' });
  assert.equal(r.status, 1);   // no reconcile-schema verdict in this canned preflight: the diagnostic mode stops there, exactly as before
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /5-gallery-listing-state/);
  assert.equal(spawnSync('bash', [path.join(work, 'run.sh'), 'bogus'], { encoding: 'utf8' }).status, 2);
});

// ── run.sh gallery mode, end to end on real Postgres with a read-only role ──
test('end to end (real Postgres, read-only role): the whole gallery run prints no identifier; the detail file has them; summary reconciles to the stage-2 total', opts, () => {
  const db = makeDb();
  const work = fs.mkdtempSync(path.join(dir, 'e2e-'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  const r = spawnSync('bash', [path.join(work, 'run.sh'), 'gallery'], { encoding: 'utf8', input: '',
    env: { PATH: `${PGBIN}${path.delimiter}${process.env.PATH}`, HOME: dir, EXPECTED_OBJECTS: '18', PINTAG_PROD_DB_URL: `postgresql://gl_ro@/${db}?host=${sock}&port=${port}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /VERDICT \| gallery-schema \| PASS/);
  assert.match(r.stdout, /\*\*18 objects\. Counts reconcile to the stage-2 total \(18\)\.\*\*/);
  assert.doesNotMatch(r.stdout + r.stderr, IDENT);
  for (const f of ['preflight.txt', 'diagnostic.txt', 'gallery-listing-summary.md']) assert.doesNotMatch(fs.readFileSync(path.join(work, f), 'utf8'), IDENT, f);
  const detail = parseCsv(fs.readFileSync(path.join(work, 'gallery-listing-detail.csv'), 'utf8'));
  assert.equal(detail.length, 17);
  assert.ok(detail.some((x) => x.listing_id === L(1)) && detail.some((x) => x.object_name === O(1)));
  assert.ok(!fs.existsSync(path.join(work, 'gallery-state.csv')));
});

// ── the workflow ──
const wf = fs.readFileSync(WORKFLOW, 'utf8');
const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const steps = code.split(/^ {6}- /m).slice(1);

test('workflow: manual only (workflow_dispatch with one optional input), read-only permissions, the protected environment, no secrets at job level', () => {
  const on = code.match(/^on:\n((?:[ \t]+.*\n|\n)+)/m)[1];
  assert.deepEqual([...on.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]), ['workflow_dispatch']);
  assert.deepEqual([...on.matchAll(/^ {6}([a-z_]+):\n {8}description/gm)].map((m) => m[1]), ['expected_objects']);
  assert.match(code, /^permissions:\n {2}contents: read\n/m);
  assert.ok(!/(contents|id-token|actions|packages|pull-requests|issues|checks|statuses|deployments): *write/.test(code));
  assert.match(code, /^ {4}environment: production-backup$/m);
  assert.ok(!/^env:/m.test(code));
  const job = code.split(/^jobs:/m)[1].split(/^ {4}steps:/m)[0];
  assert.ok(!/secrets\./.test(job));
});

test('workflow: only the presence check and the runner step see the DB secret; the runner is `run.sh gallery`; the input is passed via env, never interpolated into a script', () => {
  const withSecret = steps.filter((s) => /secrets\.PINTAG_PROD_DB_URL/.test(s));
  assert.equal(withSecret.length, 2);
  assert.ok(withSecret.some((s) => /bash scripts\/diagnostics\/orphan-originals\/run\.sh gallery\n/.test(s)));
  assert.ok(!steps.filter((s) => /Publish results|Upload private/.test(s)).some((s) => /secrets\./.test(s)));
  assert.ok(!/\$\{\{ *inputs\./.test(code.replace(/EXPECTED_OBJECTS: \$\{\{ inputs\.expected_objects \}\}/, '')), 'inputs only via the EXPECTED_OBJECTS env line');
  assert.equal((code.match(/run\.sh/g) || []).length, 1);
  assert.ok(!/\b(git (push|commit|tag)|gh (api|pr|release)|curl|wget|rclone)\b/.test(code));
  assert.ok(!/^\s*psql\b/m.test(code));
});

test('workflow: exactly one artifact -- pinned, no secret, private name, exactly the detail + summary files, 3-day retention, only after a validated detail file', () => {
  const ups = steps.filter((s) => /upload-artifact/.test(s));
  assert.equal(ups.length, 1);
  const u = ups[0];
  assert.match(u, /uses: actions\/upload-artifact@[0-9a-f]{40} # v4/);
  assert.ok(!/secrets\./.test(u));
  assert.match(u, /name: gallery-listing-state-private/);
  const paths = u.match(/path: \|\n((?: {12}.*\n?)+)/)[1].split('\n').map((l) => l.trim()).filter(Boolean).sort();
  assert.deepEqual(paths, ['scripts/diagnostics/orphan-originals/gallery-listing-detail.csv', 'scripts/diagnostics/orphan-originals/gallery-listing-summary.md']);
  assert.match(u, /if: always\(\) && steps\.reconcile\.outcome == 'success' && hashFiles\('scripts\/diagnostics\/orphan-originals\/gallery-listing-detail\.csv'\) != ''/);
  assert.match(u, /retention-days: 3\b/);
  assert.match(u, /if-no-files-found: ignore/);
});

test('workflow: the log and job summary come only from preflight.txt, diagnostic.txt and the aggregate summary (never the detail file or the raw state file)', () => {
  const pub = steps.find((s) => /Publish results/.test(s));
  assert.ok(!/gallery-listing-detail|gallery-state\.csv/.test(pub));
  assert.match(pub, /gallery-listing-summary\.md/);
});

test('repository hygiene: no detail / summary / raw state file is tracked and each is ignored wherever it is saved', () => {
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n');
  assert.deepEqual(tracked.filter((f) => /(^|\/)(gallery-listing-detail\.csv|gallery-listing-summary\.md|gallery-state\.csv)$/.test(f)), []);
  for (const f of ['some/dir/gallery-listing-detail.csv', 'scripts/diagnostics/orphan-originals/gallery-state.csv']) assert.equal(spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT }).status, 0, f);
});

// ── the reconciliation step must have SUCCEEDED for anything to be uploaded ──
const uploadStep = steps.find((s) => /upload-artifact/.test(s));
const uploadIf = uploadStep.match(/^ {8}if: (.*)$/m)[1];
// a minimal evaluator for exactly the three terms the condition may contain (an unknown term throws, so the condition cannot drift unnoticed)
function evalIf(cond, { outcome, detailExists }) {
  return cond.split(' && ').every((term) => {
    if (term === 'always()') return true;
    const o = term.match(/^steps\.reconcile\.outcome == '([a-z]+)'$/);
    if (o) return outcome === o[1];
    if (/^hashFiles\('scripts\/diagnostics\/orphan-originals\/gallery-listing-detail\.csv'\) != ''$/.test(term)) return detailExists;
    throw new Error(`unexpected term in the upload condition: ${term}`);
  });
}

test('workflow: the reconciliation step has the id the upload condition reads, and the condition needs BOTH success and a detail file', () => {
  const rec = steps.find((s) => /run\.sh gallery/.test(s) && /secrets\.PINTAG_PROD_DB_URL/.test(s));
  assert.match(rec, /^ {8}id: reconcile$/m);
  assert.equal(evalIf(uploadIf, { outcome: 'success', detailExists: true }), true);
  for (const outcome of ['failure', 'cancelled', 'skipped'])
    assert.equal(evalIf(uploadIf, { outcome, detailExists: true }), false, `a ${outcome} reconciliation step must not upload a (leftover or partial) detail file`);
  assert.equal(evalIf(uploadIf, { outcome: 'success', detailExists: false }), false);
  assert.equal(evalIf(uploadIf, { outcome: 'failure', detailExists: false }), false);
});

test('a failed reconciliation (summary crashes after a partial detail write, with a stale detail file already present) exits non-zero and leaves no detail file', () => {
  const stub = `import sys\nopen("gallery-listing-detail.csv", "w").write("object_name,listing_id\\nPARTIAL-ROW,")\nsys.exit(1)\n`;
  const { r, files } = runFake({ stubSummarizer: stub, stale: true });
  assert.notEqual(r.status, 0, 'the step fails, so steps.reconcile.outcome is not success and the upload is skipped');
  assert.ok(!('gallery-listing-detail.csv' in files), 'no leftover or partially written detail file survives');
  assert.ok(!('gallery-listing-detail.csv.tmp' in files));
});

test('a stale detail file from an earlier run is removed up front, and a run that stops at the preflight leaves none (step fails or no file: nothing to upload)', () => {
  const pre = runFake({ stale: true, preflight: 'VERDICT | schema | PASS\nVERDICT | role+session | FAIL\n' });
  assert.equal(pre.r.status, 1);
  assert.ok(!('gallery-listing-detail.csv' in pre.files));
});

test('summarize_gallery writes the detail file atomically: a crash while writing leaves nothing under the real name', () => {
  const src = fs.readFileSync(SUM, 'utf8');
  assert.match(src, /tmp = a\.out_detail \+ "\.tmp"/);
  assert.match(src, /os\.replace\(tmp, a\.out_detail\)/);
  assert.match(src, /finally:\n\s+if os\.path\.exists\(tmp\):\n\s+os\.remove\(tmp\)/);
});

// ── properties.deleted_at is required: an unknown deletion state must never read as "active" ──
for (const [label, sql] of [
  ['missing', 'ALTER TABLE properties DROP COLUMN deleted_at;'],
  ['of type text', 'ALTER TABLE properties ALTER COLUMN deleted_at TYPE text USING deleted_at::text;'],
  ['of type timestamp without time zone', 'ALTER TABLE properties ALTER COLUMN deleted_at TYPE timestamp;'],
]) {
  test(`run.sh gallery on real Postgres with properties.deleted_at ${label}: the preflight fails, stage 5 never runs, no detail file, exit 1`, opts, () => {
    const db = makeDb(sql + '\n');
    const work = fs.mkdtempSync(path.join(dir, 'nodel-'));
    for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
    const r = spawnSync('bash', [path.join(work, 'run.sh'), 'gallery'], { encoding: 'utf8', input: '',
      env: { PATH: `${PGBIN}${path.delimiter}${process.env.PATH}`, HOME: dir, PINTAG_PROD_DB_URL: `postgresql://gl_ro@/${db}?host=${sock}&port=${port}` } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /VERDICT \| gallery-schema \| FAIL/);
    assert.match(r.stdout, /gallery-schema \| public\.properties\.deleted_at \| (MISSING|WRONG_TYPE)/);
    assert.match(r.stdout + r.stderr, /GALLERY-SCHEMA VERDICT DID NOT PASS/);
    assert.doesNotMatch(r.stdout, /=== stage 5/);
    assert.ok(!fs.existsSync(path.join(work, 'gallery-listing-detail.csv')) && !fs.existsSync(path.join(work, 'gallery-state.csv')));
    assert.doesNotMatch(r.stdout + r.stderr, IDENT);
  });
}

test('the query reads properties.deleted_at directly (no to_jsonb fallback that could hide an unknown deletion state)', () => {
  const sql = fs.readFileSync(path.join(D, '5-gallery-listing-state.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.match(sql, /WHEN p\.deleted_at IS NOT NULL THEN 'listing_soft_deleted'/);
  assert.doesNotMatch(sql, /to_jsonb\(p\)->>'deleted_at'/);
});
