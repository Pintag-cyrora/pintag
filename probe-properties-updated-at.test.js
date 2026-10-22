// scripts/diagnostics/orphan-originals/6-properties-updated-at-probe.sql + `run.sh probe` + .github/workflows/probe-properties-updated-at.yml:
// a manual, READ-ONLY, aggregate-only probe of properties.updated_at (does the column exist / have values / have its trigger, and can "changed after
// the latest Gallery Recovery record" be computed?). SYNTHETIC data only. Real-Postgres tests need a local PostgreSQL (CI=true: missing = FAILURE).
// Run with: node --test probe-properties-updated-at.test.js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'probe-properties-updated-at.yml');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const SECRET_URL = 'postgres://backup_ro:S3cr3tPassw0rd@db.example.invalid:5432/postgres';
const IDENT = /SYN-LISTING|SYN-TITLE|0000cccc|0000dddd|SYN-OBJ|S3cr3tPassw0rd/;

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
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL: the updated_at probe tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pgup-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  assert.equal(asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']).status, 0);
  assert.equal(asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']).status, 0);
  psqlRaw('postgres', [], 'CREATE ROLE up_ro LOGIN BYPASSRLS;');
});
after(() => {
  if (!dir) return;
  asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

const L = (n) => `00000000-0000-0000-cccc-${String(n).padStart(12, '0')}`;   // planted listing ids
const R = (n) => `00000000-0000-0000-dddd-${String(n).padStart(12, '0')}`;   // planted record ids
const SCHEMA = (withCol) => `
CREATE TABLE public.properties (id uuid PRIMARY KEY, title text, images jsonb${withCol ? ', updated_at timestamptz DEFAULT now()' : ''});
${withCol ? `CREATE FUNCTION update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;` : ''}
CREATE TABLE public.gallery_assignments (id uuid PRIMARY KEY, op text, listing_id uuid, photo_paths jsonb, created_at timestamptz);
`;
const TRIGGER = 'CREATE TRIGGER trg_properties_updated_at BEFORE UPDATE ON public.properties FOR EACH ROW EXECUTE FUNCTION update_updated_at();';
// listings 1,2: updated AFTER their latest record; 3: updated BEFORE it; 4: NULL updated_at; 5: no record at all; record for a listing that has no properties row (9)
const DATA = (withCol) => `
INSERT INTO properties (id, title, images) VALUES ${[1, 2, 3, 4, 5].map((n) => `('${L(n)}', 'SYN-TITLE-${n}', '[]')`).join(', ')};
${withCol ? `UPDATE properties SET updated_at = '2026-09-01' WHERE id IN ('${L(1)}', '${L(2)}');
UPDATE properties SET updated_at = '2026-07-01' WHERE id = '${L(3)}';
UPDATE properties SET updated_at = NULL WHERE id = '${L(4)}';
UPDATE properties SET updated_at = '2026-10-05' WHERE id = '${L(5)}';` : ''}
INSERT INTO gallery_assignments VALUES ('${R(1)}', 'assign', '${L(1)}', '["SYN-OBJ-1.jpg"]', '2026-08-06'), ('${R(2)}', 'assign', '${L(1)}', '["SYN-OBJ-2.jpg"]', '2026-08-07'),
  ('${R(3)}', 'assign', '${L(2)}', '["SYN-OBJ-3.jpg"]', '2026-08-08'), ('${R(4)}', 'unassign', '${L(3)}', '["SYN-OBJ-4.jpg"]', '2026-08-08'),
  ('${R(5)}', 'assign', '${L(4)}', '["SYN-OBJ-5.jpg"]', '2026-08-08'), ('${R(6)}', 'assign', '${L(9)}', '["SYN-OBJ-6.jpg"]', '2026-08-08'),
  ('${R(7)}', 'assign', NULL, '["SYN-OBJ-7.jpg"]', '2026-08-08');
`;
function makeDb({ withCol = true, trigger = true, extra = '' } = {}) {
  const db = `u${++counter}`;
  assert.equal(psqlRaw('postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${db};`).status, 0);
  // the trigger is created AFTER the data so the synthetic updated_at values stay as written
  const s = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1'], SCHEMA(withCol) + DATA(withCol) + (withCol && trigger ? TRIGGER : '') + extra + 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO up_ro; GRANT USAGE ON SCHEMA public TO up_ro;');
  assert.equal(s.status, 0, s.stderr);
  return db;
}
function probe(db, { readOnly = true } = {}) {
  const r = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-v', 'ON_ERROR_STOP=1', ...(readOnly ? ['-c', 'BEGIN READ ONLY'] : []), '-f', path.join(D, '6-properties-updated-at-probe.sql'), ...(readOnly ? ['-c', 'ROLLBACK'] : [])]);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [section, label, n] = l.split(' | '); return { section, label, n }; });
  const get = (prefix) => rows.filter((x) => x.section.startsWith(prefix));
  return { rows, get, text: r.stdout };
}

test('column present with values and its trigger: catalog facts, counts, dates and the comparison with the LATEST Gallery Recovery record', opts, () => {
  const p = probe(makeDb());
  assert.equal(p.get('0')[0].label, 'transaction_read_only=on');
  assert.equal(p.get('1')[0].n, '5');
  assert.match(p.get('2')[0].label, /^present, type timestamp with time zone, default yes$/);
  assert.equal(p.get('3')[0].label, 'present, enabled=O');
  const states = Object.fromEntries(p.get('4').map((x) => [x.label, x.n]));
  assert.deepEqual(states, { 'has a value': '4', 'NULL or unreadable': '1' });
  assert.equal(p.get('5')[0].label, '2026-07-01 / 2026-10-05');
  assert.equal(p.get('5')[0].n, '4');
  assert.deepEqual(Object.fromEntries(p.get('6').map((x) => [x.label, x.n])), { '2026-07': '1', '2026-09': '2', '2026-10': '1' });
  const cmp = Object.fromEntries(p.get('7').map((x) => [x.label, x.n]));
  assert.deepEqual(cmp, { 'changed after the latest record': '2', 'not changed since the latest record': '1', 'updated_at NULL or unreadable': '1' });
  assert.equal(p.get('8')[0].n, '5');   // listings 1,2,3,4 and the one without a properties row (9); the NULL listing_id record is excluded
});

test('column present but every value NULL (the production symptom): reported plainly, comparison unavailable', opts, () => {
  const p = probe(makeDb({ extra: 'ALTER TABLE properties DISABLE TRIGGER trg_properties_updated_at; UPDATE properties SET updated_at = NULL;' }));
  assert.deepEqual(Object.fromEntries(p.get('4').map((x) => [x.label, x.n])), { 'NULL or unreadable': '5' });
  assert.equal(p.get('5')[0].label, 'no values');
  assert.equal(p.get('6').length, 0);
  assert.deepEqual(Object.fromEntries(p.get('7').map((x) => [x.label, x.n])), { 'updated_at NULL or unreadable': '4' });
});

test('column ABSENT: stated as ABSENT, rows reported as "column not visible", no error', opts, () => {
  const p = probe(makeDb({ withCol: false }));
  assert.equal(p.get('2')[0].label, 'ABSENT');
  assert.equal(p.get('3')[0].label, 'ABSENT');
  assert.deepEqual(Object.fromEntries(p.get('4').map((x) => [x.label, x.n])), { 'column not visible in the row': '5' });
  assert.deepEqual(Object.fromEntries(p.get('7').map((x) => [x.label, x.n])), { 'updated_at NULL or unreadable': '4' });
});

test('column without a default / trigger missing or disabled are reported (catalog facts)', opts, () => {
  assert.equal(probe(makeDb({ trigger: false })).get('3')[0].label, 'ABSENT');
  assert.equal(probe(makeDb({ extra: 'ALTER TABLE properties DISABLE TRIGGER trg_properties_updated_at;' })).get('3')[0].label, 'present, enabled=D');
  assert.match(probe(makeDb({ extra: 'ALTER TABLE properties ALTER COLUMN updated_at DROP DEFAULT;' })).get('2')[0].label, /default NO$/);
});

test('READ ONLY guard: outside a READ ONLY transaction every count is zero and the guard row says so', opts, () => {
  const p = probe(makeDb(), { readOnly: false });
  assert.equal(p.get('0')[0].label, 'transaction_read_only=off');
  assert.equal(p.get('1')[0].n, '0');
  assert.equal(p.get('7').length, 0);
  assert.equal(p.get('8')[0].n, '0');
});

test('aggregates only: no title, listing id, record id or object name is ever printed; nothing is changed', opts, () => {
  const db = makeDb();
  const count = () => psqlRaw(db, ['-A', '-t'], 'SELECT (SELECT count(*) FROM properties)||(SELECT count(*) FROM gallery_assignments)||(SELECT string_agg(updated_at::text, \',\' ORDER BY id) FROM properties);').stdout;
  const before = count();
  const p = probe(db);
  assert.doesNotMatch(p.text, IDENT);
  assert.equal(count(), before);
  const w = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY', '-c', 'UPDATE properties SET updated_at = NULL']);
  assert.notEqual(w.status, 0); assert.match(w.stderr, /read-only transaction/);
});

// ── run.sh probe mode against a fake psql ──
function runFake({ preflight, probeOut, failOn, stale = false, mode = 'probe' } = {}) {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  const work = path.join(dir2, 'work'); fs.mkdirSync(work); fs.mkdirSync(path.join(dir2, 'bin'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  if (stale) fs.writeFileSync(path.join(work, 'updated-at-probe.txt'), 'STALE\n');
  fs.writeFileSync(path.join(dir2, 'pre.out'), preflight ?? 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\n');
  fs.writeFileSync(path.join(dir2, 'probe.out'), probeOut ?? '0 session guard | transaction_read_only=on | \n1 properties rows |  | 7\n');
  const log = path.join(dir2, 'psql.log');
  fs.writeFileSync(path.join(dir2, 'bin', 'psql'), `#!/bin/bash
echo "CALL $*" >> "${log}"
case "$*" in
  *${failOn || 'NEVER-MATCHES'}*) echo "ERROR:  invalid input: \\"SYN-TITLE-leak\\" listing ${L(1)}" >&2; echo "ERROR:  22P02" >&2; echo "SYN-TITLE-stdout-leak"; exit 3;;
  *1-preflight.sql*) cat "${dir2}/pre.out";; *6-properties-updated-at-probe.sql*) cat "${dir2}/probe.out";;
esac
`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(work, 'run.sh'), mode], { env: { PATH: `${path.join(dir2, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir2, PINTAG_PROD_DB_URL: SECRET_URL }, encoding: 'utf8', input: '' });
  const files = {};
  for (const f of fs.readdirSync(work)) if (/\.(txt|md|csv)$/.test(f)) files[f] = fs.readFileSync(path.join(work, f), 'utf8');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('CALL ').filter(Boolean) : [];
  return { r, out: r.stdout + r.stderr, files, calls };
}

test('probe mode: lint, preflight, then ONLY the probe (no stage 2/3/4/5); every call READ ONLY; result file kept; nothing else written', () => {
  const { r, out, files, calls } = runFake();
  assert.equal(r.status, 0, out);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /1-preflight\.sql/); assert.match(calls[1], /6-properties-updated-at-probe\.sql/);
  for (const c of calls) assert.match(c, /BEGIN READ ONLY.*\.sql.*ROLLBACK/);
  assert.match(calls[1], /VERBOSITY=sqlstate/);   // the data stage withholds psql error text
  assert.match(out, /lint ok: 6-properties-updated-at-probe\.sql/);
  assert.match(out, /=== stage 6: properties\.updated_at probe/);
  assert.match(files['updated-at-probe.txt'], /1 properties rows/);
  assert.ok(!('gallery-listing-detail.csv' in files) && !('reconcile-objects.csv' in files) && !('diagnostic.txt' in files));
  assert.doesNotMatch(out + Object.values(files).join(''), /S3cr3tPassw0rd/);
});

for (const [label, preflight, text] of [
  ['reconcile-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | FAIL\n', /RECONCILE-SCHEMA VERDICT DID NOT PASS/],
  ['reconcile-schema missing', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\n', /RECONCILE-SCHEMA VERDICT DID NOT PASS/],
  ['a role+session FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | FAIL\nVERDICT | reconcile-schema | PASS\n', /PREFLIGHT DID NOT PASS/],
  ['a WARN row', 'role | rolbypassrls | WARN false\nVERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\n', /PREFLIGHT HAD WARNINGS/],
]) {
  test(`probe mode keeps the gates: ${label} stops before the probe, job fails, stale result removed`, () => {
    const { r, out, files, calls } = runFake({ preflight, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, text);
    assert.equal(calls.length, 1);
    assert.ok(!('updated-at-probe.txt' in files));
  });
}

test('probe mode: a psql failure withholds the error text (SQLSTATE only) and leaves no result file', () => {
  const { r, out, files } = runFake({ failOn: '6-properties-updated-at-probe.sql', stale: true });
  assert.notEqual(r.status, 0);
  assert.match(out, /psql failed \(exit 3\); its error text is withheld/);
  assert.doesNotMatch(out, /SYN-TITLE|0000cccc/);
  assert.ok(!('updated-at-probe.txt' in files));
});

test('the other modes never run the probe, and an unknown mode is refused', () => {
  const g = runFake({ mode: 'gallery' });
  assert.ok(!g.calls.some((c) => /6-properties-updated-at-probe/.test(c)));
  const d = runFake({ mode: 'diagnostic' });
  assert.ok(!d.calls.some((c) => /6-properties-updated-at-probe/.test(c)));
  assert.equal(spawnSync('bash', [path.join(D, 'run.sh'), 'bogus'], { encoding: 'utf8' }).status, 2);
});

test('end to end (real Postgres, read-only role): `run.sh probe` prints the aggregate probe, no identifier, exit 0', opts, () => {
  const db = makeDb();
  psqlRaw(db, [], 'CREATE SCHEMA storage; CREATE TABLE storage.objects (bucket_id text, name text, created_at timestamptz, metadata jsonb); CREATE TABLE public.unit_types (images text[]); CREATE TABLE public.parties (photo_url text); CREATE TABLE public.property_images (storage_path text, status text, sha256 text); CREATE TABLE public.properties_row_snapshots (id uuid, property_id uuid, op text, row_data jsonb, created_at timestamptz); CREATE TABLE public.import_records (id uuid, listing_id uuid, raw_payload jsonb, imported_at timestamptz); CREATE TABLE public.listing_image_snapshots (id uuid, listing_id uuid, storage_url text, storage_path text, created_at timestamptz); CREATE TABLE public.import_images (id uuid, import_id uuid, listing_id uuid, storage_url text, storage_path text, uploaded_at timestamptz); ALTER TABLE public.gallery_assignments ADD COLUMN cluster_id text, ADD COLUMN confidence text; ALTER TABLE public.properties ADD COLUMN deleted_at timestamptz; GRANT USAGE ON SCHEMA storage TO up_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public, storage TO up_ro;');
  const work = fs.mkdtempSync(path.join(dir, 'e2e-'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  const r = spawnSync('bash', [path.join(work, 'run.sh'), 'probe'], { encoding: 'utf8', input: '',
    env: { PATH: `${PGBIN}${path.delimiter}${process.env.PATH}`, HOME: dir, PINTAG_PROD_DB_URL: `postgresql://up_ro@/${db}?host=${sock}&port=${port}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /VERDICT \| reconcile-schema \| PASS/);
  assert.match(r.stdout, /2 updated_at column definition \(catalog\)\s+\| present, type timestamp with time zone, default yes/);
  assert.doesNotMatch(r.stdout + r.stderr, IDENT);
  assert.doesNotMatch(fs.readFileSync(path.join(work, 'updated-at-probe.txt'), 'utf8'), IDENT);
});

// ── the workflow ──
const code = fs.readFileSync(WORKFLOW, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const steps = code.split(/^ {6}- /m).slice(1);

test('workflow: manual only, read-only permissions, the protected environment, NO artifact, secret only in the presence check and the runner', () => {
  const on = code.match(/^on:\n((?:[ \t]+.*\n|\n)+)/m)[1];
  assert.deepEqual([...on.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]), ['workflow_dispatch']);
  assert.doesNotMatch(on, /inputs:/);
  assert.match(code, /^permissions:\n {2}contents: read\n/m);
  assert.ok(!/(contents|id-token|actions|packages|pull-requests|issues|checks|statuses|deployments): *write/.test(code));
  assert.match(code, /^ {4}environment: production-backup$/m);
  assert.ok(!/^env:/m.test(code));
  assert.ok(!/secrets\./.test(code.split(/^jobs:/m)[1].split(/^ {4}steps:/m)[0]));
  assert.ok(!/upload-artifact|actions\/upload|download-artifact/.test(code), 'the probe publishes aggregate text only: no artifact');
  const withSecret = steps.filter((s) => /secrets\.PINTAG_PROD_DB_URL/.test(s));
  assert.equal(withSecret.length, 2);
  assert.ok(withSecret.some((s) => /bash scripts\/diagnostics\/orphan-originals\/run\.sh probe\n/.test(s)));
  assert.equal((code.match(/run\.sh/g) || []).length, 1);
  assert.ok(!/\b(git (push|commit|tag)|gh (api|pr|release)|curl|wget|rclone)\b/.test(code));
  assert.ok(!/^\s*psql\b/m.test(code));
});

test('workflow: the log and job summary come only from preflight.txt and updated-at-probe.txt', () => {
  const pub = steps.find((s) => /Publish results/.test(s));
  assert.match(pub, /updated-at-probe\.txt/);
  assert.ok(!/reconcile|gallery-listing|object/i.test(pub.replace(/probe \(stage 6\)/gi, '')));
});

test('repository hygiene: the probe result file is ignored and not tracked', () => {
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'scripts/diagnostics/orphan-originals/updated-at-probe.txt'], { cwd: ROOT }).status, 0);
  assert.ok(!spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').some((f) => /updated-at-probe\.txt$/.test(f)));
});
