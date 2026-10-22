// scripts/diagnostics/orphan-originals/7-gallery-history-vs-snapshots.sql + `run.sh history` + .github/workflows/gallery-history-vs-snapshots.yml:
// can listing_image_snapshots / import_records bracket WHEN Gallery Recovery 'assign' / 'unassign' images left their listing galleries?
// SYNTHETIC data only. Pins: the numbers for each scenario (state after the record / only before / none / import after / latest snapshot vs current
// gallery), that a snapshot is reported as a gallery STATE and the window as an UPPER bound, the stage-2 population cross-check, READ ONLY guard,
// aggregates-only privacy (stdout, log, summary), failure handling, and the workflow invariants (manual, read-only, NO artifact).
// Run with: node --test gallery-history-vs-snapshots.test.js   (CI=true: a missing PostgreSQL install is a FAILURE, not a skip)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'gallery-history-vs-snapshots.yml');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const SECRET_URL = 'postgres://backup_ro:S3cr3tPassw0rd@db.example.invalid:5432/postgres';
const IDENT = /SYN-OBJ|SYN-IMG|0000eeee|0000ffff|SYN-TITLE|S3cr3tPassw0rd/;

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
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL: the gallery history tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pghv-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  assert.equal(asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']).status, 0);
  assert.equal(asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']).status, 0);
  psqlRaw('postgres', [], 'CREATE ROLE hv_ro LOGIN BYPASSRLS;');
});
after(() => {
  if (!dir) return;
  asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

const L = (n) => `00000000-0000-0000-eeee-${String(n).padStart(12, '0')}`;   // planted listing ids
const E = (n) => `00000000-0000-0000-ffff-${String(n).padStart(12, '0')}`;   // planted provenance event ids
const IMG = (n) => `https://x.supabase.co/storage/v1/object/public/property-images/SYN-IMG-${n}.jpg`;
const SCHEMA = `
CREATE SCHEMA storage;
CREATE TABLE storage.objects (bucket_id text, name text, created_at timestamptz, metadata jsonb);
CREATE TABLE public.properties (id uuid PRIMARY KEY, title text, images jsonb, deleted_at timestamptz);
CREATE TABLE public.unit_types (images text[]); CREATE TABLE public.parties (photo_url text);
CREATE TABLE public.property_images (storage_path text, status text, sha256 text);
CREATE TABLE public.gallery_assignments (id uuid DEFAULT gen_random_uuid(), op text, listing_id uuid, cluster_id text, photo_paths jsonb, confidence text, created_at timestamptz);
CREATE TABLE public.listing_image_snapshots (id uuid DEFAULT gen_random_uuid(), listing_id uuid, provenance_event_id uuid, storage_url text, storage_path text, created_at timestamptz);
CREATE TABLE public.import_records (id uuid DEFAULT gen_random_uuid(), listing_id uuid, raw_payload jsonb, imported_at timestamptz);
CREATE TABLE public.import_images (id uuid DEFAULT gen_random_uuid(), import_id uuid, listing_id uuid, storage_url text, storage_path text, uploaded_at timestamptz);
CREATE TABLE public.properties_row_snapshots (id uuid, property_id uuid, op text, row_data jsonb, created_at timestamptz);
`;
const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
const snap = (listing, ev, names, ts) => names.map((n) => `INSERT INTO listing_image_snapshots (listing_id, provenance_event_id, storage_path, created_at) VALUES ('${L(listing)}', '${E(ev)}', ${q(`SYN-IMG-${n}.jpg`)}, ${q(ts)});`).join('\n');
const ga = (op, listing, names, ts) => `INSERT INTO gallery_assignments (op, listing_id, photo_paths, created_at) VALUES (${q(op)}, '${L(listing)}', ${q(JSON.stringify(names))}::jsonb, ${q(ts)});`;
const obj = (n) => `INSERT INTO storage.objects VALUES ('property-images', 'SYN-OBJ-${n}.jpg', now(), '{"size": 1000}');`;
// Listing 1: assign O1,O2 at 08-06 10:00; state before (08-05: x,y,z) and AFTER (08-12: x,y); current gallery x,y (= latest state)
// Listing 2: assign O3 08-07; only a state BEFORE (08-01: k); current k (= latest state)
// Listing 3: assign O4 08-07; NO state at all; a Smart Import record AFTER (08-20); current gallery EMPTY
// Listing 4: assign O5 08-07; state AFTER at 10-01 (q,r,s: 55 days) while the current gallery has only q
// Listing 5: unassign O6 08-08 10:00; state AFTER 6 hours later (a,b); current gallery EMPTY
// Listing 9 (no properties row): unassign O7; O8: ambiguous (assign on 1 vs unassign on 2 at one instant) -> out of scope; O9 no history
const DATA = `
${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(obj).join('\n')}
INSERT INTO properties VALUES ('${L(1)}', 'SYN-TITLE-1', ${q(JSON.stringify([IMG('x'), IMG('y')]))}::jsonb, NULL),
  ('${L(2)}', 'SYN-TITLE-2', ${q(JSON.stringify([IMG('k')]))}::jsonb, NULL), ('${L(3)}', 'SYN-TITLE-3', '[]', NULL),
  ('${L(4)}', 'SYN-TITLE-4', ${q(JSON.stringify([IMG('q')]))}::jsonb, NULL), ('${L(5)}', 'SYN-TITLE-5', '[]', NULL);
${ga('assign', 1, ['SYN-OBJ-1.jpg', 'SYN-OBJ-2.jpg'], '2026-08-06 10:00')}
${ga('assign', 2, ['SYN-OBJ-3.jpg'], '2026-08-07')} ${ga('assign', 3, ['SYN-OBJ-4.jpg'], '2026-08-07')} ${ga('assign', 4, ['SYN-OBJ-5.jpg'], '2026-08-07')}
${ga('unassign', 5, ['SYN-OBJ-6.jpg'], '2026-08-08 10:00')} ${ga('unassign', 9, ['SYN-OBJ-7.jpg'], '2026-08-08')}
${ga('assign', 1, ['SYN-OBJ-8.jpg'], '2026-08-11')} ${ga('unassign', 2, ['SYN-OBJ-8.jpg'], '2026-08-11')}
${snap(1, 1, ['x', 'y', 'z'], '2026-08-05')}
${snap(1, 2, ['x', 'y'], '2026-08-12')}
${snap(2, 3, ['k'], '2026-08-01')}
${snap(4, 4, ['q', 'r', 's'], '2026-10-01')}
${snap(5, 5, ['a', 'b'], '2026-08-08 16:00')}
INSERT INTO import_records (listing_id, raw_payload, imported_at) VALUES ('${L(3)}', '{"fetched": {"urls": ["SYN-IMG-payload.jpg"]}}', '2026-08-20'), ('${L(1)}', NULL, '2026-08-01');
`;
function makeDb(extra = '') {
  const db = `h${++counter}`;
  assert.equal(psqlRaw('postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${db};`).status, 0);
  const s = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1'], SCHEMA + DATA + extra + 'GRANT USAGE ON SCHEMA public, storage TO hv_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public, storage TO hv_ro;');
  assert.equal(s.status, 0, s.stderr);
  return db;
}
function history(db, { readOnly = true } = {}) {
  const r = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-v', 'ON_ERROR_STOP=1', ...(readOnly ? ['-c', 'BEGIN READ ONLY'] : []), '-f', path.join(D, '7-gallery-history-vs-snapshots.sql'), ...(readOnly ? ['-c', 'ROLLBACK'] : [])]);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [section, label, n, listings] = l.split(' | '); return { section, label, n, listings }; });
  const get = (prefix) => Object.fromEntries(rows.filter((x) => x.section.startsWith(prefix)).map((x) => [x.label, `${x.n}/${x.listings}`]));
  return { rows, get, text: r.stdout };
}

test('population and scope: 9 unreferenced originals (= the stage-2 total); the ambiguous object and the object without history are out of scope', opts, () => {
  const db = makeDb();
  const h = history(db);
  assert.deepEqual(h.get('0'), { 'transaction_read_only=on': '/' });
  assert.deepEqual(h.get('1 '), { '': '9/' });
  const d = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-c', 'BEGIN READ ONLY', '-f', path.join(D, '2-diagnostic.sql'), '-c', 'ROLLBACK']);
  assert.equal(Number(d.stdout.split('\n').find((l) => /TOTAL/.test(l)).split(' | ').pop()), 9);
  assert.deepEqual(h.get('2 '), { assign: '5/4', unassign: '2/2' });   // O1..O5 on 4 listings; O6, O7 (O8 ambiguous, O9 no history excluded)
});

test('history available: global row counts, listings and date ranges of the two tables', opts, () => {
  const h = history(makeDb());
  assert.deepEqual(h.get('3 '), { '2026-08-01 to 2026-10-01': '11/4' });
  assert.deepEqual(h.get('4 '), { '2026-08-01 to 2026-08-20': '2/2' });
});

test('gallery states vs the latest record: states AFTER it (a window exists), only BEFORE it (cannot be bracketed), none at all', opts, () => {
  const h = history(makeDb());
  assert.deepEqual(h.get('5 assign'), {
    'at least one state AFTER the latest record (removal window exists)': '3/2',
    'states exist, none AFTER the latest record (removal cannot be bracketed)': '1/1',
    'no gallery state recorded at all': '1/1' });
  assert.deepEqual(h.get('5 unassign'), { 'at least one state AFTER the latest record (removal window exists)': '1/1', 'no gallery state recorded at all': '1/1' });
});

test('removal window = latest record to the FIRST later state (an upper bound), with its buckets and date range', opts, () => {
  const h = history(makeDb());
  assert.deepEqual(h.get('6 assign'), { '2-7 days': '2/1', 'over 30 days': '1/1' });   // listing 1: 5.6 days (2 objects); listing 4: 55 days
  assert.deepEqual(h.get('6 unassign'), { 'within 1 day': '1/1' });                  // listing 5: 6 hours
  assert.deepEqual(h.get('7 assign'), { '2026-08-12 to 2026-10-01': '3/2' });
  assert.deepEqual(h.get('7 unassign'), { '2026-08-08 to 2026-08-08': '1/1' });
  assert.ok(h.rows.some((r) => /UPPER bound/.test(r.section)), 'the output says the window is an upper bound');
});

test('first later state vs current gallery image counts, and the listing-level latest snapshot vs current gallery set', opts, () => {
  const h = history(makeDb());
  assert.deepEqual(h.get('8 assign'), { 'same count': '2/1', 'state larger than the current gallery': '1/1' });
  assert.deepEqual(h.get('8 unassign'), { 'state larger than the current gallery': '1/1' });
  assert.deepEqual(h.get('9 assign'), { 'no snapshot': '1/1', 'same image set': '2/2', 'snapshot has images the gallery lacks': '1/1' });
  assert.deepEqual(h.get('9 unassign'), { 'no snapshot': '1/1', 'snapshot has images the gallery lacks': '1/1' });
});

test('Smart Import after the record, and the empty-gallery / missing-listing blind spots are reported plainly', opts, () => {
  const h = history(makeDb());
  assert.deepEqual(h.get('10 assign'), { 'at least one (first: 2026-08)': '1/1', none: '4/3' });
  assert.deepEqual(h.get('10 unassign'), { none: '2/2' });
  assert.deepEqual(h.get('11 assign'), { 'current gallery has images': '4/3', 'current gallery has no property-images entries': '1/1' });
  assert.deepEqual(h.get('11 unassign'), { 'current gallery has no property-images entries': '1/1', 'no listing row': '1/1' });
  assert.ok(h.rows.some((r) => /no snapshot is written when a save empties the gallery/.test(r.section)));
});

test('percent-encoded names match across history and the current gallery (canonical bytes)', opts, () => {
  const db = makeDb(`
    INSERT INTO storage.objects VALUES ('property-images', 'SYN-OBJ-enc d.jpg', now(), '{}');
    INSERT INTO properties VALUES ('${L(6)}', 'SYN-TITLE-6', ${q(JSON.stringify(['https://x/object/public/property-images/SYN-IMG-enc%20e.jpg']))}::jsonb, NULL);
    INSERT INTO gallery_assignments (op, listing_id, photo_paths, created_at) VALUES ('assign', '${L(6)}', '["SYN-OBJ-enc%20d.jpg"]', '2026-08-09');
    INSERT INTO listing_image_snapshots (listing_id, provenance_event_id, storage_path, created_at) VALUES ('${L(6)}', '${E(6)}', 'SYN-IMG-enc%20e.jpg', '2026-08-10');`);
  const h = history(db);
  assert.deepEqual(h.get('2 '), { assign: '6/5', unassign: '2/2' });
  assert.equal(h.get('9 assign')['same image set'], '3/3');   // listing 6: the snapshot's encoded name equals the gallery's encoded name
});

test('READ ONLY guard: outside a READ ONLY transaction every count is zero and the guard row says so; nothing is changed', opts, () => {
  const db = makeDb();
  const off = history(db, { readOnly: false });
  assert.deepEqual(off.get('0'), { 'transaction_read_only=off': '/' });
  assert.deepEqual(off.get('1 '), { '': '0/' });
  assert.equal(off.get('2 ')['assign'], undefined);
  const count = () => psqlRaw(db, ['-A', '-t'], 'SELECT (SELECT count(*) FROM listing_image_snapshots)||(SELECT count(*) FROM import_records)||(SELECT count(*) FROM gallery_assignments)||(SELECT count(*) FROM properties);').stdout;
  const before = count(); history(db);
  assert.equal(count(), before);
  const w = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY', '-c', 'DELETE FROM listing_image_snapshots']);
  assert.notEqual(w.status, 0); assert.match(w.stderr, /read-only transaction/);
});

test('aggregates only: no object name, image name, listing id, event id, title or payload text is ever printed', opts, () => {
  const h = history(makeDb());
  assert.doesNotMatch(h.text, IDENT);
  assert.doesNotMatch(h.text, /payload/);
});

test('the query selects no title, payload or id column (output columns are section / label / n / listings)', () => {
  const sql = fs.readFileSync(path.join(D, '7-gallery-history-vs-snapshots.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.match(sql, /SELECT section, label, n, listings FROM \(/);
  assert.doesNotMatch(sql, /raw_payload|title|operator|phone|email|row_data/i);
});

// ── run.sh history against a fake psql (aligned output, as the real data stages print) ──
const ALIGNED = (n = 551) => ` 0 session guard (must be on) | transaction_read_only=on |     | \n 1 unreferenced originals (must equal the stage-2 total) |  | ${String(n).padStart(3)} | \n 2 scope: latest Gallery Recovery record | assign | 107 | 13\n`;
function runFake({ preflight, diag = ' 1 TOTAL | 188 MB | 551\n', hist, env = {}, failOn, stale = false, mode = 'history' } = {}) {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'));
  const work = path.join(dir2, 'work'); fs.mkdirSync(work); fs.mkdirSync(path.join(dir2, 'bin'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  if (stale) for (const f of ['history-vs-gallery.txt', 'diagnostic.txt']) fs.writeFileSync(path.join(work, f), 'STALE\n');
  fs.writeFileSync(path.join(dir2, 'pre.out'), preflight ?? 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\n');
  fs.writeFileSync(path.join(dir2, 'diag.out'), diag);
  fs.writeFileSync(path.join(dir2, 'hist.out'), hist ?? ALIGNED());
  const log = path.join(dir2, 'psql.log');
  fs.writeFileSync(path.join(dir2, 'bin', 'psql'), `#!/bin/bash
echo "CALL $*" >> "${log}"
case "$*" in
  *${failOn || 'NEVER-MATCHES'}*) echo "ERROR:  invalid input: \\"SYN-IMG-leak.jpg\\" listing ${L(1)}" >&2; echo "ERROR:  22P02" >&2; echo "SYN-OBJ-stdout-leak"; exit 3;;
  *1-preflight.sql*) cat "${dir2}/pre.out";; *2-diagnostic.sql*) cat "${dir2}/diag.out";; *7-gallery-history-vs-snapshots.sql*) cat "${dir2}/hist.out";;
esac
`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(work, 'run.sh'), mode], { env: { PATH: `${path.join(dir2, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir2, PINTAG_PROD_DB_URL: SECRET_URL, ...env }, encoding: 'utf8', input: '' });
  const files = {};
  for (const f of fs.readdirSync(work)) if (/\.(txt|md|csv)$/.test(f)) files[f] = fs.readFileSync(path.join(work, f), 'utf8');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('CALL ').filter(Boolean) : [];
  return { r, out: r.stdout + r.stderr, files, calls };
}

test('history mode: lint, preflight, stage-2 cross-check, then ONLY stage 7 (no 3/4/5/6); every call READ ONLY; population must equal stage 2', () => {
  const { r, out, files, calls } = runFake();
  assert.equal(r.status, 0, out);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /1-preflight\.sql/); assert.match(calls[1], /2-diagnostic\.sql/); assert.match(calls[2], /7-gallery-history-vs-snapshots\.sql/);
  for (const c of calls) assert.match(c, /BEGIN READ ONLY.*\.sql.*ROLLBACK/);
  assert.match(calls[2], /VERBOSITY=sqlstate/);
  assert.match(out, /lint ok: 7-gallery-history-vs-snapshots\.sql/);
  assert.match(out, /=== stage 7: gallery history vs listing_image_snapshots \/ import_records, for the 551 objects/);
  assert.match(files['history-vs-gallery.txt'], /unreferenced originals/);
  assert.ok(!('gallery-listing-detail.csv' in files) && !('reconcile-objects.csv' in files));
  assert.doesNotMatch(out + Object.values(files).join(''), /S3cr3tPassw0rd/);
});

test('history mode: a rebuilt population different from the stage-2 total is DISCARDED (job fails, no result file)', () => {
  for (const hist of [ALIGNED(550), ALIGNED(552), ' 0 guard | transaction_read_only=off |  | \n 1 unreferenced originals (must equal the stage-2 total) |  |   0 | \n', ' no population row at all\n']) {
    const { r, out, files } = runFake({ hist, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, /Stage 7 rebuilt a population of '[0-9?]*' objects but stage 2 counted 551 - the result was discarded/);
    assert.ok(!('history-vs-gallery.txt' in files));
  }
});

for (const [label, preflight, text] of [
  ['history-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | FAIL\n', /HISTORY-SCHEMA VERDICT DID NOT PASS/],
  ['history-schema missing', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\n', /HISTORY-SCHEMA VERDICT DID NOT PASS/],
  ['gallery-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | FAIL\nVERDICT | history-schema | PASS\n', /GALLERY-SCHEMA VERDICT DID NOT PASS/],
  ['reconcile-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | FAIL\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\n', /RECONCILE-SCHEMA VERDICT DID NOT PASS/],
]) {
  test(`history mode stops before stage 7 on ${label}: job fails visibly, no result file`, () => {
    const { r, out, files, calls } = runFake({ preflight, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, text);
    assert.ok(!calls.some((c) => /7-gallery-history/.test(c)));
    assert.ok(!('history-vs-gallery.txt' in files));
  });
}

for (const [label, preflight] of [
  ['a role+session FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | FAIL\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\n'],
  ['a WARN row', 'role | rolbypassrls | WARN false\nVERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\n'],
]) {
  test(`history mode keeps the preflight gates: ${label} stops everything before any data stage`, () => {
    const { r, calls } = runFake({ preflight });
    assert.equal(r.status, 1);
    assert.equal(calls.length, 1);
  });
}

test('history mode: expected_objects must match the stage-2 total (or be numeric)', () => {
  assert.equal(runFake({ env: { EXPECTED_OBJECTS: '551' } }).r.status, 0);
  const bad = runFake({ env: { EXPECTED_OBJECTS: '550' } });
  assert.equal(bad.r.status, 1);
  assert.match(bad.out, /Stage 2 counted 551 objects but expected_objects is 550/);
  assert.equal(bad.calls.length, 2);
  const nn = runFake({ env: { EXPECTED_OBJECTS: '1;DROP' } });
  assert.equal(nn.r.status, 1);
  assert.match(nn.out, /expected_objects must be a number/);
});

for (const failOn of ['2-diagnostic.sql', '7-gallery-history-vs-snapshots.sql']) {
  test(`history mode: psql failure in ${failOn} withholds the error text (SQLSTATE only); no identifier, no partial result`, () => {
    const { r, out, files } = runFake({ failOn, stale: true });
    assert.notEqual(r.status, 0);
    assert.match(out, /psql failed \(exit 3\); its error text is withheld/);
    assert.doesNotMatch(out, /SYN-IMG|SYN-OBJ|0000eeee/);
    assert.ok(!('history-vs-gallery.txt' in files));
    for (const t of Object.values(files)) assert.doesNotMatch(t, /SYN-IMG|SYN-OBJ/);
  });
}

test('the other modes never run stage 7, and `history` is a known mode', () => {
  for (const mode of ['diagnostic', 'gallery', 'probe']) assert.ok(!runFake({ mode }).calls.some((c) => /7-gallery-history/.test(c)), mode);
  assert.equal(spawnSync('bash', [path.join(D, 'run.sh'), 'bogus'], { encoding: 'utf8' }).status, 2);
});

// ── end to end on real Postgres with a read-only role ──
test('end to end (real Postgres, read-only role): `run.sh history` passes every gate, rebuilds the stage-2 population, prints aggregates only', opts, () => {
  const db = makeDb(`ALTER TABLE public.property_images ADD COLUMN IF NOT EXISTS status text; ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS updated_at timestamptz;`);
  const work = fs.mkdtempSync(path.join(dir, 'e2e-'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  const r = spawnSync('bash', [path.join(work, 'run.sh'), 'history'], { encoding: 'utf8', input: '',
    env: { PATH: `${PGBIN}${path.delimiter}${process.env.PATH}`, HOME: dir, EXPECTED_OBJECTS: '9', PINTAG_PROD_DB_URL: `postgresql://hv_ro@/${db}?host=${sock}&port=${port}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const v of ['schema', 'role+session', 'reconcile-schema', 'gallery-schema', 'history-schema']) assert.ok(r.stdout.includes(`VERDICT | ${v} | PASS`), v);
  assert.match(r.stdout, /transaction_read_only=on/);
  assert.match(r.stdout, /1 unreferenced originals[^\n]*\|\s+9 \|/);
  assert.doesNotMatch(r.stdout + r.stderr, IDENT);
  assert.doesNotMatch(fs.readFileSync(path.join(work, 'history-vs-gallery.txt'), 'utf8'), IDENT);
});

// ── the workflow ──
const code = fs.readFileSync(WORKFLOW, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const steps = code.split(/^ {6}- /m).slice(1);

test('workflow: manual only (one optional input), read-only permissions, protected environment, NO artifact, secret only in the presence check and the runner', () => {
  const on = code.match(/^on:\n((?:[ \t]+.*\n|\n)+)/m)[1];
  assert.deepEqual([...on.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]), ['workflow_dispatch']);
  assert.deepEqual([...on.matchAll(/^ {6}([a-z_]+):\n {8}description/gm)].map((m) => m[1]), ['expected_objects']);
  assert.match(code, /^permissions:\n {2}contents: read\n/m);
  assert.ok(!/(contents|id-token|actions|packages|pull-requests|issues|checks|statuses|deployments): *write/.test(code));
  assert.match(code, /^ {4}environment: production-backup$/m);
  assert.ok(!/^env:/m.test(code));
  assert.ok(!/secrets\./.test(code.split(/^jobs:/m)[1].split(/^ {4}steps:/m)[0]));
  assert.ok(!/upload-artifact|download-artifact/.test(code), 'aggregates go to the log / job summary only: no artifact');
  const withSecret = steps.filter((s) => /secrets\.PINTAG_PROD_DB_URL/.test(s));
  assert.equal(withSecret.length, 2);
  assert.ok(withSecret.some((s) => /bash scripts\/diagnostics\/orphan-originals\/run\.sh history\n/.test(s)));
  assert.equal((code.match(/run\.sh/g) || []).length, 1);
  assert.ok(!/\$\{\{ *inputs\./.test(code.replace(/EXPECTED_OBJECTS: \$\{\{ inputs\.expected_objects \}\}/, '')), 'the input only reaches the runner through env');
  assert.ok(!/\b(git (push|commit|tag)|gh (api|pr|release)|curl|wget|rclone)\b/.test(code));
  assert.ok(!/^\s*psql\b/m.test(code));
});

test('workflow: the log and job summary come only from preflight.txt, diagnostic.txt and history-vs-gallery.txt', () => {
  const pub = steps.find((s) => /Publish results/.test(s));
  assert.match(pub, /history-vs-gallery\.txt/);
  assert.ok(!/gallery-listing|reconcile-objects|gallery-state|\.csv/.test(pub));
});

test('repository hygiene: the result file is ignored and not tracked', () => {
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'scripts/diagnostics/orphan-originals/history-vs-gallery.txt'], { cwd: ROOT }).status, 0);
  assert.ok(!spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').some((f) => /history-vs-gallery\.txt$/.test(f)));
});
