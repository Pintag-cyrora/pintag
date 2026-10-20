// scripts/diagnostics/orphan-originals/3-reconcile.sql and 4-source-health.sql against a REAL throwaway Postgres cluster
// (initdb in a temp dir; nothing here touches any real database). Run with: node --test diagnose-orphan-originals-reconcile.test.js
// Pins: the object set is exactly 2-diagnostic.sql's; URL-encoded and raw names; JSON/array/nested/malformed shapes; several
// historical matches; eTag duplicate candidates (candidate only, size must match too); rendition presence; unparsable names;
// mutually exclusive categories; the READ ONLY guard (outside a READ ONLY transaction no object is returned).
// In CI (CI=true) a missing Postgres install is a test FAILURE, never a silent skip.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

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
const psqlRaw = (db, args, input) => spawnSync(PSQL, ['-h', sock, '-p', String(port), '-U', 'postgres', '-d', db, '-X', '-q', ...args],
  { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: dir } });

before(() => {
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL server binaries / psql: the reconcile tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pgrc-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  const init = asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']);
  assert.equal(init.status, 0, init.stderr);
  const start = asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']);
  assert.equal(start.status, 0, start.stderr);
});
after(() => {
  if (!dir) return;
  asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

const SCHEMA = `
CREATE SCHEMA storage;
CREATE TABLE storage.objects (bucket_id text, name text, created_at timestamptz, metadata jsonb);
CREATE TABLE public.properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), images jsonb);
CREATE TABLE public.unit_types (images text[]);
CREATE TABLE public.parties (photo_url text);
CREATE TABLE public.property_images (storage_path text, status text);
CREATE TABLE public.gallery_assignments (id uuid DEFAULT gen_random_uuid(), op text, listing_id uuid, cluster_id text, photo_paths jsonb, created_at timestamptz);
CREATE TABLE public.properties_row_snapshots (id uuid DEFAULT gen_random_uuid(), property_id uuid, op text, row_data jsonb, created_at timestamptz);
CREATE TABLE public.import_records (id uuid DEFAULT gen_random_uuid(), listing_id uuid, raw_payload jsonb, imported_at timestamptz);
CREATE TABLE public.listing_image_snapshots (id uuid DEFAULT gen_random_uuid(), listing_id uuid, storage_url text, storage_path text, created_at timestamptz);
CREATE TABLE public.import_images (id uuid DEFAULT gen_random_uuid(), import_id uuid, listing_id uuid, storage_url text, storage_path text, uploaded_at timestamptz);
`;
const B = 'https://x.supabase.co/storage/v1/object/public/property-images/';
const obj = (name, etag, size, created = '2026-07-01T00:00:00Z') =>
  `INSERT INTO storage.objects VALUES ('property-images', ${q(name)}, '${created}', ${q(JSON.stringify({ size, eTag: etag }))}::jsonb);`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const LID = '00000000-0000-0000-0000-0000000000a1';

const N = {
  gal: '1700000000000-aaaaaa.jpg', del: '1700000100000-bbbbbb.jpg', imp: '1700000200000-cccccc.jpg', lsn: 'file d.jpg', iim: '1700000300000-dddddd.jpg',
  multi: '1700000400000-eeeeee.jpg', dup: '1700000500000-ffffff.jpg', dupSize: '1700000600000-gggggg.jpg', noevOld: '1700000000000-oldold.jpg',
  noevNew: '1790000000000-newnew.jpg', noTs: 'plain-name.jpg', live: 'live-one.jpg', unitEnc: 'my unit.jpg', agent: 'agent.jpg', reg: 'reg.jpg', regOff: 'regoff.jpg',
};
const DATA = `
${obj(N.gal, 'e-gal', 10)} ${obj(N.del, 'e-del', 11)} ${obj(N.imp, 'e-imp', 12)} ${obj(N.lsn, 'e-lsn', 13)} ${obj(N.iim, 'e-iim', 14)}
${obj(N.multi, 'e-multi', 15)} ${obj(N.dup, 'e-live', 100)} ${obj(N.dupSize, 'e-live', 999)} ${obj(N.noevOld, 'e-old', 16)}
${obj(N.noevNew, 'e-new', 17)} ${obj(N.noTs, 'e-nots', 18)}
${obj(N.live, 'e-live', 100)} ${obj(N.unitEnc, 'e-unit', 19)} ${obj(N.agent, 'e-agent', 20)} ${obj(N.reg, 'e-reg', 21)} ${obj(N.regOff, 'e-regoff', 22)}
INSERT INTO storage.objects VALUES ('other-bucket', ${q(N.gal)}, now(), '{}');
INSERT INTO storage.objects VALUES ('property-images', 'renditions/1700000000000-aaaaaa/thumbnail.webp', now(), '{}');
INSERT INTO storage.objects VALUES ('property-images', 'renditions/1700000000000-aaaaaa/card.webp', now(), '{}');
INSERT INTO storage.objects VALUES ('property-images', 'renditions/1700000400000-eeeeee/hero.webp', now(), '{}');
INSERT INTO properties (id, images) VALUES ('${LID}', ${q(JSON.stringify([B + N.live + '?v=1']))}::jsonb);
INSERT INTO properties (images) VALUES ('{"not":"an array"}'::jsonb), (NULL);
INSERT INTO unit_types VALUES (ARRAY[${q(B + 'my%20unit.jpg')}]), (NULL);
INSERT INTO parties VALUES (${q(B + N.agent)}), (NULL), ('https://elsewhere.example/a.jpg');
INSERT INTO property_images VALUES (${q(N.reg)}, 'active'), (${q(N.regOff)}, 'removed');
-- gallery_assignments: two rows name the same object (multiple historical matches); URL-encoded form; malformed shapes
INSERT INTO gallery_assignments (op, listing_id, photo_paths, created_at) VALUES
  ('assign',   '${LID}', ${q(JSON.stringify([B + N.gal, B + N.multi]))}::jsonb, '2026-07-10T00:00:00Z'),
  ('unassign', '${LID}', ${q(JSON.stringify({ photos: [{ path: N.gal }, { path: 42 }, { path: null }] }))}::jsonb, '2026-07-12T00:00:00Z'),
  ('assign',   '${LID}', 'null'::jsonb, '2026-07-13T00:00:00Z'),
  ('assign',   '${LID}', '7'::jsonb, '2026-07-14T00:00:00Z'),
  ('assign',   '${LID}', NULL, '2026-07-15T00:00:00Z');
INSERT INTO properties_row_snapshots (property_id, op, row_data, created_at) VALUES
  ('${LID}', 'hard_delete', ${q(JSON.stringify({ images: [B + N.del, B + 'file%20d.jpg'], title: 'SECRET TITLE', phone: '+000' }))}::jsonb, '2026-08-03T00:00:00Z'),
  ('${LID}', 'soft_delete', ${q(JSON.stringify({ images: 'not-a-list' }))}::jsonb, '2026-08-04T00:00:00Z'),
  ('${LID}', 'hard_delete', '[1,2]'::jsonb, '2026-08-05T00:00:00Z');
INSERT INTO import_records (listing_id, raw_payload, imported_at) VALUES
  ('${LID}', ${q(JSON.stringify({ fetched: { urls: [B + N.imp, 'https://cdn.example/other.jpg'] }, aiResult: { note: 'x' } }))}::jsonb, '2026-07-20T00:00:00Z'),
  ('${LID}', ${q(JSON.stringify({ fetched: { urls: [B + N.multi] } }))}::jsonb, '2026-07-21T00:00:00Z'),
  ('${LID}', '"just a string"'::jsonb, '2026-07-22T00:00:00Z'),
  ('${LID}', NULL, '2026-07-23T00:00:00Z');
INSERT INTO listing_image_snapshots (listing_id, storage_url, storage_path, created_at) VALUES
  ('${LID}', NULL, 'file%20d.jpg', '2026-06-01T00:00:00Z'),
  ('${LID}', NULL, NULL, '2026-06-02T00:00:00Z');
INSERT INTO import_images (listing_id, storage_url, storage_path, uploaded_at) VALUES
  ('${LID}', ${q(B + N.iim)}, NULL, '2026-07-30T00:00:00Z'), ('${LID}', NULL, NULL, '2026-07-31T00:00:00Z');
`;

function parseCsv(text) {   // RFC 4180: quoted fields, doubled quotes, embedded newlines/commas
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
  const db = `r${++counter}`;
  assert.equal(psqlRaw('postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${db};`).status, 0);
  const s = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1'], SCHEMA + DATA + extra);
  assert.equal(s.status, 0, s.stderr);
  return db;
}
function run(db, file, { readOnly = true } = {}) {
  const r = psqlRaw(db, ['--csv', '-v', 'ON_ERROR_STOP=1', ...(readOnly ? ['-c', 'BEGIN READ ONLY'] : []), '-f', path.join(D, file), ...(readOnly ? ['-c', 'ROLLBACK'] : [])]);
  assert.equal(r.status, 0, r.stderr);
  return parseCsv(r.stdout);
}
const by = (rows) => Object.fromEntries(rows.map((r) => [r.object_name, r]));

test('the object set is exactly the one 2-diagnostic.sql counts (live, unit-encoded, agent and registry objects excluded)', opts, () => {
  const db = makeDb();
  const rows = run(db, '3-reconcile.sql');
  const names = rows.map((r) => r.object_name).sort();
  assert.deepEqual(names, [N.gal, N.del, N.imp, N.lsn, N.iim, N.multi, N.dup, N.dupSize, N.noevOld, N.noevNew, N.noTs].sort());
  const d = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-c', 'BEGIN READ ONLY', '-f', path.join(D, '2-diagnostic.sql'), '-c', 'ROLLBACK']);
  const total = d.stdout.split('\n').find((l) => /TOTAL/.test(l));
  assert.ok(total, d.stdout);
  assert.equal(Number(total.split(' | ').pop()), rows.length);
});

test('URL encoding: history stored as file%20d.jpg matches the object "file d.jpg" (listing snapshot + deleted-listing snapshot)', opts, () => {
  const r = by(run(makeDb(), '3-reconcile.sql'))[N.lsn];
  assert.equal(r.listing_snapshot_hits, '1');
  assert.equal(r.deleted_snapshot_hits, '1');
  assert.match(r.matched_sources, /deleted_listing_snapshot/);
  assert.equal(r.category, 'multiple_evidence');
});

test('JSON shapes: array of URLs, nested object, scalar, null and non-string values are all safe; one source -> its own category', opts, () => {
  const rows = by(run(makeDb(), '3-reconcile.sql'));
  assert.equal(rows[N.gal].category, 'history_gallery_assignment_only');
  assert.equal(rows[N.del].category, 'history_deleted_listing_snapshot_only');
  assert.equal(rows[N.imp].category, 'history_import_record_only');
  assert.equal(rows[N.iim].category, 'history_import_image_only');
  assert.equal(rows[N.imp].import_record_hits, '1');
});

test('multiple historical matches: counts, last date and last record are reported; several sources -> multiple_evidence (flagged)', opts, () => {
  const rows = by(run(makeDb(), '3-reconcile.sql'));
  assert.equal(rows[N.gal].gallery_assignment_hits, '2');
  assert.match(rows[N.gal].gallery_assignment_last_date, /^2026-07-12/);
  assert.equal(rows[N.gal].gallery_assignment_op, 'unassign');
  assert.equal(rows[N.multi].category, 'multiple_evidence');
  assert.equal(rows[N.multi].matched_sources, 'gallery_assignment,import_record');
  assert.equal(rows[N.multi].evidence_count, '2');
});

test('duplicate candidates: same eTag AND size as a live object; same eTag with a different size is NOT a candidate', opts, () => {
  const rows = by(run(makeDb(), '3-reconcile.sql'));
  assert.equal(rows[N.dup].category, 'duplicate_of_live_image_only');
  assert.equal(rows[N.dup].duplicate_of_live_object, N.live);
  assert.match(rows[N.dup].explanation, /CANDIDATE only/);
  assert.notEqual(rows[N.dupSize].category, 'duplicate_of_live_image_only');
  assert.equal(rows[N.dupSize].duplicate_candidate_count, '0');
  assert.equal(rows[N.dupSize].duplicate_of_live_object, '');
});

test('a duplicate of an object referenced only by an INACTIVE registry row is not a candidate', opts, () => {
  const db = makeDb(`${obj('1700000700000-hhhhhh.jpg', 'e-regoff', 22)}`);
  assert.equal(by(run(db, '3-reconcile.sql'))['1700000700000-hhhhhh.jpg'].duplicate_candidate_count, '0');
});

test('renditions: present profiles listed, missing -> empty, partial -> only those that exist', opts, () => {
  const rows = by(run(makeDb(), '3-reconcile.sql'));
  assert.equal(rows[N.gal].renditions_present, 'card,thumbnail');
  assert.equal(rows[N.multi].renditions_present, 'hero');
  assert.equal(rows[N.noevOld].renditions_present, '');
});

test('no history: before / after the first gallery snapshot, or inconclusive when the name has no upload time', opts, () => {
  const rows = by(run(makeDb(), '3-reconcile.sql'));
  assert.equal(rows[N.noevOld].category, 'no_evidence_uploaded_before_provenance');
  assert.equal(rows[N.noevNew].category, 'no_evidence_uploaded_after_provenance');
  assert.match(rows[N.noevNew].explanation, /inferred, not proven/);
  assert.match(rows[N.noevOld].explanation, /INFERRED/);
  assert.equal(rows[N.noTs].category, 'unclassifiable_no_evidence');
  assert.match(rows[N.noTs].explanation, /^inconclusive/);
  assert.equal(rows[N.noTs].name_upload_ts, '');
  assert.match(rows[N.noevOld].name_upload_ts, /^2023-/);
});

test('no gallery snapshot exists at all -> the dated no-evidence objects are inconclusive, not guessed', opts, () => {
  const db = makeDb('DELETE FROM listing_image_snapshots;');
  const r = by(run(db, '3-reconcile.sql'));
  assert.equal(r[N.noevOld].category, 'unclassifiable_no_evidence');
  assert.match(r[N.noevOld].explanation, /no gallery snapshot exists/);
});

test('categories are mutually exclusive, every object has exactly one, and none of the current-reference columns is true', opts, () => {
  const rows = run(makeDb(), '3-reconcile.sql');
  const known = new Set(['multiple_evidence', 'history_gallery_assignment_only', 'history_deleted_listing_snapshot_only', 'history_import_record_only',
    'history_listing_snapshot_only', 'history_import_image_only', 'duplicate_of_live_image_only', 'unclassifiable_no_evidence',
    'no_evidence_uploaded_before_provenance', 'no_evidence_uploaded_after_provenance']);
  for (const r of rows) {
    assert.ok(known.has(r.category), r.category);
    assert.ok(r.explanation);
    assert.deepEqual([r.ref_listing, r.ref_unit, r.ref_agent, r.ref_registry], ['f', 'f', 'f', 'f']);
  }
  assert.equal(new Set(rows.map((r) => r.object_name)).size, rows.length);
});

test('privacy: the report holds names, sizes, dates and ids only -- no titles, phones or payload text', opts, () => {
  const r = psqlRaw(makeDb(), ['--csv', '-c', 'BEGIN READ ONLY', '-f', path.join(D, '3-reconcile.sql'), '-c', 'ROLLBACK']);
  assert.doesNotMatch(r.stdout, /SECRET TITLE|\+000|aiResult|elsewhere\.example|cdn\.example/);
});

test('READ ONLY guard: outside a READ ONLY transaction the reconciliation returns no objects at all', opts, () => {
  const db = makeDb();
  assert.equal(run(db, '3-reconcile.sql', { readOnly: false }).length, 0);
  assert.ok(run(db, '3-reconcile.sql').length > 0);
});

test('the reconciliation leaves every table unchanged (before/after row counts and a write attempt inside READ ONLY fails)', opts, () => {
  const db = makeDb();
  const count = () => psqlRaw(db, ['-A', '-t'], `SELECT (SELECT count(*) FROM storage.objects)||','||(SELECT count(*) FROM gallery_assignments)||','||(SELECT count(*) FROM import_records);`).stdout.trim();
  const before = count(); run(db, '3-reconcile.sql'); run(db, '4-source-health.sql');
  assert.equal(count(), before);
  const w = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY', '-c', "DELETE FROM storage.objects"]);
  assert.notEqual(w.status, 0); assert.match(w.stderr, /read-only transaction/);
});

test('4-source-health: an EMPTY history table still yields its row (rows_total 0), so a missing source can only mean a failure', opts, () => {
  const h = run(makeDb('DELETE FROM import_images; DELETE FROM import_records;'), '4-source-health.sql');
  assert.equal(h.length, 5);
  assert.equal(h.find((r) => r.source === 'import_images').rows_total, '0');
});

test('4-source-health: usable vs unusable rows per history source', opts, () => {
  const h = Object.fromEntries(run(makeDb(), '4-source-health.sql').map((r) => [r.source, r]));
  assert.equal(h['gallery_assignments.photo_paths'].rows_total, '5');
  assert.equal(h['gallery_assignments.photo_paths'].rows_usable, '2');
  assert.equal(h['gallery_assignments.photo_paths'].rows_unusable, '3');
  assert.equal(h['properties_row_snapshots.row_data->images'].rows_usable, '2');   // a bare string counts as readable (it simply matches nothing)
  assert.equal(h['import_records.raw_payload'].rows_usable, '2');
  assert.equal(h['listing_image_snapshots'].rows_usable, '1');
  assert.equal(h['import_images'].rows_usable, '1');
});

// ── run.sh end to end against the real cluster (read-only role, real preflight, real stage 3, real summarize.py) ──
test('end to end: the real runner, a read-only role and the fixture -> validated report reconciles to the stage-2 total', opts, () => {
  psqlRaw('postgres', [], 'DROP ROLE IF EXISTS recon_ro; CREATE ROLE recon_ro LOGIN BYPASSRLS;');
  const db = makeDb('GRANT USAGE ON SCHEMA public, storage TO recon_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public, storage TO recon_ro;');
  const work = fs.mkdtempSync(path.join(dir, 'e2e-'));
  for (const f of fs.readdirSync(D)) fs.copyFileSync(path.join(D, f), path.join(work, f));
  const pathEnv = `${path.dirname(PSQL.includes('/') ? PSQL : path.join(PGBIN, 'psql'))}${path.delimiter}${PGBIN}${path.delimiter}${process.env.PATH}`;
  const r = spawnSync('bash', [path.join(work, 'run.sh')], { encoding: 'utf8', input: '',
    env: { PATH: pathEnv, HOME: dir, PINTAG_PROD_DB_URL: `postgresql://recon_ro@/${db}?host=${sock}&port=${port}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /VERDICT \| reconcile-schema \| PASS/);
  assert.match(r.stdout, /11 objects\. Counts reconcile to the stage-2 total \(11\)/);
  const rows = parseCsv(fs.readFileSync(path.join(work, 'reconcile-objects.csv'), 'utf8'));
  assert.equal(rows.length, 11);
  assert.ok(fs.readFileSync(path.join(work, 'reconcile-summary.md'), 'utf8').includes('multiple_evidence'));
});

// ── summarize.py ──
const SUM = path.join(D, 'summarize.py');
const COLS = fs.readFileSync(SUM, 'utf8').match(/COLUMNS = \[([\s\S]*?)\n\]/)[1].match(/"([a-z_]+)"/g).map((c) => c.slice(1, -1));
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const mk = (o = {}) => ({ object_name: 'a.jpg', size_bytes: '1000', ref_listing: 'f', ref_unit: 'f', ref_agent: 'f', ref_registry: 'f', evidence_count: '0',
  gallery_assignment_hits: '0', deleted_snapshot_hits: '0', import_record_hits: '0', listing_snapshot_hits: '0', import_image_hits: '0',
  duplicate_candidate_count: '0', matched_sources: '', renditions_present: '', category: 'unclassifiable_no_evidence', explanation: 'x', ...o });
const SRC = ['gallery_assignments.photo_paths', 'properties_row_snapshots.row_data->images', 'import_records.raw_payload', 'listing_image_snapshots', 'import_images'];
function summarize(rowObjs, { expected, header = COLS, health = true, healthRows } = {}) {
  const w = fs.mkdtempSync(path.join(dir, 'sum-'));
  fs.writeFileSync(path.join(w, 'in.csv'), [header.join(','), ...rowObjs.map((o) => header.map((c) => esc(o[c] ?? '')).join(','))].join('\n') + '\n');
  const hs = healthRows ?? SRC.map((x) => [x, 3, 3, 0]);
  fs.writeFileSync(path.join(w, 'h.csv'), 'source,rows_total,rows_usable,rows_unusable,first_date,last_date\n' + hs.map(([x, t, u, n]) => `${x},${t},${u},${n},2026-01-01 00:00:00+00,2026-02-01 00:00:00+00`).join('\n') + '\n');
  const r = spawnSync('python3', ['-I', SUM, '--objects', path.join(w, 'in.csv'), ...(health ? ['--health', path.join(w, 'h.csv')] : []),
    ...(expected != null ? ['--expected', String(expected)] : []), '--out-objects', path.join(w, 'o.csv'), '--out-summary', path.join(w, 's.md')], { encoding: 'utf8' });
  return { r, out: fs.existsSync(path.join(w, 'o.csv')) ? fs.readFileSync(path.join(w, 'o.csv'), 'utf8') : '', md: fs.readFileSync(path.join(w, 's.md'), 'utf8') };
}

test('summarize.py: provenance cutoff is labelled as an inference', () => {
  const { md } = summarize([mk()], { expected: 1 });
  assert.match(md, /Provenance start is an INFERENCE/);
  assert.match(md, /INFERRED/);
});

test('summarize.py: counts and bytes per category, flagged categories, reconciles to the expected total', () => {
  const { r, md } = summarize([mk({ object_name: 'a' }), mk({ object_name: 'b', size_bytes: '' }),
    mk({ object_name: 'c', category: 'multiple_evidence', evidence_count: '2', gallery_assignment_hits: '1', import_image_hits: '1', matched_sources: 'gallery_assignment,import_image' })], { expected: 3 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(md, /\| `unclassifiable_no_evidence` \| 2 \| 1000 bytes \(\+1 unknown size\) \| FLAGGED \|/);
  assert.match(md, /\| `multiple_evidence` \| 1 \| 1000 bytes \| FLAGGED \|/);
  assert.match(md, /\| \*\*total\*\* \| \*\*3\*\*/);
  assert.match(md, /Counts reconcile to the stage-2 total \(3\)/);
  assert.doesNotMatch(md, /a\.jpg/);   // the job summary never lists object names
});

test('summarize.py: names with commas, quotes and newlines survive the round trip', () => {
  const name = 'we,ird "name"\nx.jpg';
  const { r, out } = summarize([mk({ object_name: name })], { expected: 1 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parseCsv(out)[0].object_name, name);
});

for (const [label, rowsFn, extra, msg] of [
  ['a count different from the stage-2 total', () => [mk()], { expected: 551 }, /lists 1 objects but the stage-2 diagnostic counted 551/],
  ['an unknown category', () => [mk({ category: 'safe_to_delete' })], {}, /unknown category 'safe_to_delete'/],
  ['a duplicate object row', () => [mk(), mk()], {}, /duplicate object row/],
  ['an object marked as currently referenced', () => [mk({ ref_unit: 't' })], {}, /marked as currently referenced/],
  ['multiple_evidence with fewer than two sources', () => [mk({ category: 'multiple_evidence' })], {}, /contradicts evidence_count/],
  ['evidence_count that does not match the matched sources', () => [mk({ evidence_count: '1', category: 'history_import_image_only' })], {}, /evidence_count does not match/],
  ['a column outside the whitelist (would leak data)', () => [mk({ owner_phone: '+1' })], { header: [...COLS, 'owner_phone'] }, /differ from the expected whitelist: owner_phone/],
]) {
  test(`summarize.py fails (exit 1, explained, not published as OK) on ${label}`, () => {
    const { r, md, out } = summarize(rowsFn(), extra);
    assert.equal(r.status, 1);
    assert.match(r.stderr, msg);
    assert.match(md, /RECONCILIATION FAILED/);
    assert.equal(out, '', 'no per-object report is written for a reconciliation that failed');
  });
}

test('summarize.py fails closed on history coverage: no health file, a missing source, or a wholly unreadable source -> no per-object report', () => {
  for (const [label, o, msg] of [
    ['no health file', { health: false }, /no source-health file/],
    ['a missing source', { healthRows: SRC.slice(1).map((x) => [x, 3, 3, 0]) }, /exactly the five history sources/],
    ['a source whose rows are all unreadable', { healthRows: SRC.map((x, i) => [x, 4, i === 2 ? 0 : 4, i === 2 ? 4 : 0]) }, /none is readable/],
  ]) {
    const { r, md, out } = summarize([mk()], { expected: 1, ...o });
    assert.equal(r.status, 1, label);
    assert.match(r.stderr, msg);
    assert.match(md, /RECONCILIATION FAILED/);
    assert.equal(out, '', `${label}: no per-object report`);
  }
});

test('summarize.py: partly unreadable history is a visible WARNING in the summary, not a silent success', () => {
  const { r, md } = summarize([mk()], { expected: 1, healthRows: SRC.map((x, i) => [x, 5, i === 0 ? 3 : 5, i === 0 ? 2 : 0]) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(md, /WARNING: 2 of 5 `gallery_assignments\.photo_paths` rows hold no readable path/);
});

test('privacy: the report columns are exactly the approved whitelist (no title/contact/payload/url/operator column)', () => {
  assert.ok(!COLS.some((c) => /title|phone|email|contact|payload|operator|actor|url|row_data|raw/.test(c)), COLS.join());
  assert.equal(COLS.length, 37);
});
