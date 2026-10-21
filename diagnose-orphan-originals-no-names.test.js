// The orphan-originals diagnostic must never print an object path or an original filename into the job log, the job summary,
// annotations, the result files that get published, or an exception message -- on success OR failure. The per-object names exist
// only in the validated artifact file reconcile-objects.csv. Recognizable planted filenames are used throughout.
// Run with: node --test diagnose-orphan-originals-no-names.test.js (real-Postgres tests need a local PostgreSQL; CI has one).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const PLANTED = ['PLANTED-SECRET-alpha.jpg', 'Villa Sunset Small.jpeg', '1700000000000-plantd.jpg', 'caf0a53c-159b-46b9-acf7-planted 2.jpeg', 'pla%20nted-enc.jpg'];
const TOKENS = /PLANTED|Villa Sunset|plantd|pla%20nted|pla nted|caf0a53c|Small\.jpeg/i;   // (the generic pattern label "<ms>-<rand6>.jpg" is not a name)
const URL_SECRET = 'postgres://backup_ro:S3cr3tPassw0rd@db.example.invalid:5432/postgres';

// ── 1. the SQL: stage 2 selects no name at all ──
const sql2 = fs.readFileSync(path.join(SRC, '2-diagnostic.sql'), 'utf8');
test('2-diagnostic.sql has no sample-name section any more and says so', () => {
  assert.ok(!/sample object names|UNION ALL SELECT 7\b/.test(sql2));
  assert.match(sql2, /no object name, path or original filename is ever selected/);
  const sections = [...sql2.matchAll(/SELECT (\d+), '/g)].map((m) => Number(m[1]));
  assert.deepEqual(sections.filter((n) => n > 6), []);
});

// ── 2. fake-psql runner: failure paths ──
function runFake({ failOn, recon, diag = ' 1 TOTAL | 4000 bytes | 2\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonames-'));
  const work = path.join(dir, 'work'); fs.mkdirSync(work); fs.mkdirSync(path.join(dir, 'bin'));
  for (const f of fs.readdirSync(SRC)) if (fs.statSync(path.join(SRC, f)).isFile()) fs.copyFileSync(path.join(SRC, f), path.join(work, f));
  const COLS = fs.readFileSync(path.join(SRC, 'summarize.py'), 'utf8').match(/COLUMNS = \[([\s\S]*?)\n\]/)[1].match(/"([a-z_]+)"/g).map((c) => c.slice(1, -1));
  const row = (name) => COLS.map((c) => ({ object_name: name, size_bytes: '10', ref_listing: 'f', ref_unit: 'f', ref_agent: 'f', ref_registry: 'f', evidence_count: '0', gallery_assignment_hits: '0',
    deleted_snapshot_hits: '0', import_record_hits: '0', listing_snapshot_hits: '0', import_image_hits: '0', duplicate_candidate_count: '0', name_upload_ts: '2026-09-01 00:00:00+00',
    category: 'no_evidence_uploaded_after_provenance', explanation: 'x' }[c] ?? '')).join(',');
  fs.writeFileSync(path.join(dir, 'recon.out'), recon ?? (COLS.join(',') + '\n' + row(PLANTED[0]) + '\n' + row(PLANTED[1]) + '\n'));
  const SRCS = ['gallery_assignments.photo_paths', 'properties_row_snapshots.row_data->images', 'import_records.raw_payload', 'listing_image_snapshots', 'import_images'];
  fs.writeFileSync(path.join(dir, 'health.out'), 'source,rows_total,rows_usable,rows_unusable,first_date,last_date\n' + SRCS.map((x) => `${x},3,3,0,2026-01-01,2026-02-01`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'pre.out'), 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\n');
  fs.writeFileSync(path.join(dir, 'diag.out'), diag);
  const log = path.join(dir, 'psql.log');
  fs.writeFileSync(path.join(dir, 'bin', 'psql'), `#!/bin/bash
echo "CALL $*" >> "${log}"
case "$*" in
  *${failOn || 'NEVER-MATCHES'}*) echo "ERROR:  invalid input syntax: \\"${PLANTED[0]}\\" in ${PLANTED[1]}" >&2; echo "DETAIL:  Key (name)=(${PLANTED[2]})" >&2; echo "ERROR:  22P02" >&2; echo "${PLANTED[3]}"; exit 3;;
  *1-preflight.sql*) cat "${dir}/pre.out";; *2-diagnostic.sql*) cat "${dir}/diag.out";;
  *3-reconcile.sql*) cat "${dir}/recon.out";; *4-source-health.sql*) cat "${dir}/health.out";;
esac
`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(work, 'run.sh')], { env: { PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir, PINTAG_PROD_DB_URL: URL_SECRET }, encoding: 'utf8', input: '' });
  const files = {};
  for (const f of fs.readdirSync(work)) if (/\.(txt|md|csv)$/.test(f)) files[f] = fs.readFileSync(path.join(work, f), 'utf8');
  return { r, out: r.stdout + r.stderr, files, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('success path (fake psql, planted names in the per-object CSV): log, summary and result files contain no name; only the artifact CSV does', () => {
  const { r, out, files } = runFake();
  assert.equal(r.status, 0, out);
  assert.doesNotMatch(out, TOKENS);
  for (const [f, text] of Object.entries(files)) {
    if (f === 'reconcile-objects.csv') assert.match(text, /PLANTED-SECRET-alpha/, 'the artifact CSV is the one place names live');
    else assert.doesNotMatch(text, TOKENS, `${f} must not contain a name`);
  }
  assert.ok(!('reconcile.csv' in files) && !('source-health.csv' in files), 'raw stage-3 files are removed when the run ends');
});

for (const failOn of ['2-diagnostic.sql', '3-reconcile.sql', '4-source-health.sql']) {
  test(`failure path: psql error text from ${failOn} (quoting planted names) is withheld; only the SQLSTATE is shown`, () => {
    const { r, out, files, log } = runFake({ failOn });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(out, TOKENS);
    assert.match(out, /psql failed \(exit 3\); its error text is withheld/);
    assert.match(out, /SQLSTATE: ERROR: 22P02/);
    for (const [f, text] of Object.entries(files)) assert.doesNotMatch(text, TOKENS, f);
    assert.ok(!('reconcile-objects.csv' in files), 'no artifact report after a failed stage');
    if (failOn === '2-diagnostic.sql') assert.ok(!('diagnostic.txt' in files), 'partial stage-2 output is not kept or published');
    assert.match(log, /VERBOSITY=sqlstate/);
    assert.match(log, /SHOW_CONTEXT=never/);
  });
}

test('failure path: a report that does not reconcile (planted names in the CSV) prints counts and row numbers only, no artifact CSV', () => {
  const { r, out, files } = runFake({ diag: ' 1 TOTAL | 4000 bytes | 551\n' });
  assert.equal(r.status, 1);
  assert.match(out, /lists 2 objects but the stage-2 diagnostic counted 551/);
  assert.doesNotMatch(out, TOKENS);
  assert.ok(!('reconcile-objects.csv' in files));
  assert.doesNotMatch(files['reconcile-summary.md'], TOKENS);
});

test('failure path: a malformed per-object report (planted name in a numeric column) fails with no traceback and no name', () => {
  const COLS_LINE = fs.readFileSync(path.join(SRC, 'summarize.py'), 'utf8').match(/COLUMNS = \[([\s\S]*?)\n\]/)[1].match(/"([a-z_]+)"/g).map((c) => c.slice(1, -1)).join(',');
  const bad = COLS_LINE + '\n' + COLS_LINE.split(',').map((c) => (c === 'size_bytes' || c === 'evidence_count' ? PLANTED[0] : c === 'category' ? 'unclassifiable_no_evidence' : PLANTED[1])).join(',') + '\n';
  const { r, out, files } = runFake({ recon: bad });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(out, TOKENS);
  assert.doesNotMatch(out, /Traceback/);
  assert.ok(!('reconcile-objects.csv' in files));
  for (const text of Object.values(files)) assert.doesNotMatch(text, TOKENS);
});

// ── 3. real Postgres: planted object names through the REAL stage-2 SQL and the whole runner ──
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
let dir, sock, port;
const asPg = (cmd, args) => IS_ROOT ? spawnSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { encoding: 'utf8' }) : spawnSync(cmd, args, { encoding: 'utf8' });
const psql = (db, args, input) => spawnSync(PSQL, ['-h', sock, '-p', String(port), '-U', 'postgres', '-d', db, '-X', '-q', ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: dir } });

before(() => {
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL: the no-names tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pgnn-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  assert.equal(asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']).status, 0);
  assert.equal(asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']).status, 0);
});
after(() => {
  if (!dir) return;
  asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

const q = (x) => `'${x.replace(/'/g, "''")}'`;
const FIXTURE = `
CREATE ROLE nn_ro LOGIN BYPASSRLS;
CREATE SCHEMA storage;
CREATE TABLE storage.objects (bucket_id text, name text, created_at timestamptz, metadata jsonb);
CREATE TABLE public.properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), images jsonb);
CREATE TABLE public.unit_types (images text[]);
CREATE TABLE public.parties (photo_url text);
CREATE TABLE public.property_images (storage_path text, status text);
CREATE TABLE public.gallery_assignments (id uuid DEFAULT gen_random_uuid(), op text, listing_id uuid, photo_paths jsonb, created_at timestamptz);
CREATE TABLE public.properties_row_snapshots (id uuid DEFAULT gen_random_uuid(), property_id uuid, op text, row_data jsonb, created_at timestamptz);
CREATE TABLE public.import_records (id uuid DEFAULT gen_random_uuid(), listing_id uuid, raw_payload jsonb, imported_at timestamptz);
CREATE TABLE public.listing_image_snapshots (id uuid DEFAULT gen_random_uuid(), listing_id uuid, storage_url text, storage_path text, created_at timestamptz);
CREATE TABLE public.import_images (id uuid DEFAULT gen_random_uuid(), import_id uuid, listing_id uuid, storage_url text, storage_path text, uploaded_at timestamptz);
${PLANTED.map((n, i) => `INSERT INTO storage.objects VALUES ('property-images', ${q(n)}, '2026-0${5 + (i % 3)}-1${i}T00:00:00Z', '{"size": ${1000 * (i + 1)}, "eTag": "e${i}"}');`).join('\n')}
INSERT INTO gallery_assignments (op, photo_paths, created_at) VALUES ('assign', ${q(JSON.stringify([PLANTED[0], PLANTED[1]]))}::jsonb, '2026-08-10T00:00:00Z');
INSERT INTO listing_image_snapshots (storage_path, created_at) VALUES ('x.png', '2026-08-07T00:00:00Z');
GRANT USAGE ON SCHEMA public, storage TO nn_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public, storage TO nn_ro;`;

test('real Postgres: the real stage-2 SQL with planted object names prints no name (aggregates only)', opts, () => {
  psql('postgres', [], 'CREATE DATABASE nn1;');
  assert.equal(psql('nn1', ['-v', 'ON_ERROR_STOP=1'], FIXTURE).status, 0);
  const r = psql('nn1', ['-A', '-t', '-F', ' | ', '-c', 'BEGIN READ ONLY', '-f', path.join(SRC, '2-diagnostic.sql'), '-c', 'ROLLBACK']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 TOTAL/);
  assert.match(r.stdout, /\| 5$/m);   // the 5 planted objects are all counted ...
  assert.doesNotMatch(r.stdout, TOKENS);   // ... and none is named
  assert.doesNotMatch(r.stdout, /sample object names/);
});

test('real Postgres, whole runner: planted names appear only in reconcile-objects.csv (the artifact), never in log, summary or result files', opts, () => {
  psql('postgres', [], 'CREATE DATABASE nn2;');
  assert.equal(psql('nn2', ['-v', 'ON_ERROR_STOP=1'], FIXTURE.replace('CREATE ROLE nn_ro LOGIN BYPASSRLS;', 'SELECT 1;')).status, 0);
  const work = fs.mkdtempSync(path.join(dir, 'e2e-'));
  for (const f of fs.readdirSync(SRC)) if (fs.statSync(path.join(SRC, f)).isFile()) fs.copyFileSync(path.join(SRC, f), path.join(work, f));
  const pathEnv = `${PGBIN}${path.delimiter}${process.env.PATH}`;
  const r = spawnSync('bash', [path.join(work, 'run.sh')], { encoding: 'utf8', input: '', env: { PATH: pathEnv, HOME: dir, PINTAG_PROD_DB_URL: `postgresql://nn_ro@/nn2?host=${sock}&port=${port}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, TOKENS);
  for (const f of ['preflight.txt', 'diagnostic.txt', 'reconcile-summary.md']) assert.doesNotMatch(fs.readFileSync(path.join(work, f), 'utf8'), TOKENS, f);
  const csv = fs.readFileSync(path.join(work, 'reconcile-objects.csv'), 'utf8');
  for (const n of PLANTED) assert.ok(csv.includes(n.includes(',') ? `"${n}"` : n), `artifact CSV holds ${n}`);
  assert.ok(!fs.existsSync(path.join(work, 'reconcile.csv')));
});
