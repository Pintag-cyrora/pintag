// scripts/diagnostics/orphan-originals/1-preflight.sql -- the write-privilege allowlist and the session checks, against a REAL
// throwaway Postgres cluster (initdb in a temp dir; nothing here touches any real database). Run with:
//   node --test diagnose-orphan-originals-preflight.test.js
//
// What is pinned:
//   * The ONLY tolerated write-type privileges are the four platform objects Supabase's pg_cron / pg_net grant to PUBLIC:
//     cron.job_run_details, net._http_response, net.http_request_queue, net.http_request_queue_id_seq -- exact schema.name AND
//     kind, and only while every privilege the role holds on them is itself granted to PUBLIC.
//   * Everything else still FAILS the preflight, with its name printed: a direct table / column / sequence grant, a PUBLIC grant
//     on any other object, look-alike names in other schemas, a wrong-kind object with an allowed name, an extra direct
//     privilege or ownership on an allowed object, an extra sequence grant.
//   * transaction_read_only=on stays mandatory; default_transaction_read_only is informational only (a pooler drops startup
//     options). The other gates (superuser, membership, RLS without bypass, missing schema) are unchanged.
// In CI (CI=true) a missing Postgres install is a test FAILURE, never a silent skip: this guard must really run.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PREFLIGHT = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals', '1-preflight.sql');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

function findPgBin() {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const base = '/usr/lib/postgresql';
  if (fs.existsSync(base)) {
    for (const v of fs.readdirSync(base).sort((a, b) => Number(b) - Number(a))) dirs.push(path.join(base, v, 'bin'));
  }
  for (const d of dirs) if (d && fs.existsSync(path.join(d, 'initdb')) && fs.existsSync(path.join(d, 'pg_ctl'))) return d;
  return null;
}
const PGBIN = findPgBin();
const PSQL = spawnSync('psql', ['--version']).status === 0 ? 'psql' : (PGBIN && fs.existsSync(path.join(PGBIN, 'psql')) ? path.join(PGBIN, 'psql') : null);

let dir, sock, port, counter = 0;
const asPg = (cmd, args, opts = {}) => IS_ROOT
  ? spawnSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { encoding: 'utf8', ...opts })
  : spawnSync(cmd, args, { encoding: 'utf8', ...opts });

function psql(db, user, args, input) {
  const r = spawnSync(PSQL, ['-h', sock, '-p', String(port), '-U', user, '-d', db, '-X', '-q', ...args],
    { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: dir } });
  return r;
}

const FIXTURE = `
CREATE SCHEMA storage; CREATE SCHEMA cron; CREATE SCHEMA net;
CREATE TABLE storage.objects (bucket_id text, name text, created_at timestamptz, metadata jsonb);
CREATE TABLE public.properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), images jsonb, deleted_at timestamptz);
CREATE TABLE public.unit_types (images text[]);
CREATE TABLE public.parties (photo_url text);
CREATE TABLE public.property_images (storage_path text, status text, sha256 text);
CREATE TABLE public.listing_image_snapshots (id uuid, listing_id uuid, storage_url text, storage_path text, created_at timestamptz);
CREATE TABLE public.import_images (id uuid, import_id uuid, listing_id uuid, storage_url text, storage_path text, uploaded_at timestamptz);
CREATE TABLE public.gallery_assignments (id uuid, op text, listing_id uuid, cluster_id text, photo_paths jsonb, confidence text, created_at timestamptz);
CREATE TABLE public.properties_row_snapshots (id uuid, property_id uuid, op text, row_data jsonb, created_at timestamptz);
CREATE TABLE public.import_records (id uuid, listing_id uuid, raw_payload jsonb, imported_at timestamptz);
-- the four platform objects, granted to PUBLIC the way pg_cron / pg_net do it
CREATE TABLE cron.job_run_details (runid bigserial PRIMARY KEY, command text);
CREATE TABLE net._http_response (id bigint, status int);
CREATE TABLE net.http_request_queue (id bigserial PRIMARY KEY, url text);
GRANT USAGE ON SCHEMA cron, net TO PUBLIC;
GRANT ALL ON cron.job_run_details, net._http_response, net.http_request_queue TO PUBLIC;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE net.http_request_queue_id_seq TO PUBLIC;
-- the read-only reader: SELECT on public + storage, nothing else
GRANT USAGE ON SCHEMA public, storage TO backup_ro, rls_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public, storage TO backup_ro, rls_ro;
`;

before(() => {
  if (!PGBIN || !PSQL) {
    if (process.env.CI) assert.fail('CI runner has no PostgreSQL server binaries / psql: the preflight allowlist tests must run in CI');
    return;
  }
  dir = fs.mkdtempSync('/tmp/pgpf-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  const init = asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']);
  assert.equal(init.status, 0, init.stderr);
  const start = asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'),
    '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']);
  assert.equal(start.status, 0, start.stderr + fs.readFileSync(path.join(dir, 'log'), 'utf8'));
  const roles = psql('postgres', 'postgres', ['-v', 'ON_ERROR_STOP=1'],
    'CREATE ROLE backup_ro LOGIN BYPASSRLS; CREATE ROLE rls_ro LOGIN NOBYPASSRLS;');
  assert.equal(roles.status, 0, roles.stderr);
});

after(() => {
  if (!dir) return;
  asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Fresh database per scenario: fixture, then the scenario's extra SQL (as superuser), then the preflight as `user`.
function scenario(extraSql = '', { user = 'backup_ro', readOnlyTxn = true, pgoptions } = {}) {
  const db = `s${++counter}`;
  assert.equal(psql('postgres', 'postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${db};`).status, 0);
  const setup = psql(db, 'postgres', ['-v', 'ON_ERROR_STOP=1'], FIXTURE + '\n' + extraSql);
  assert.equal(setup.status, 0, setup.stderr);
  const args = ['-A', '-t', '-F', ' | ', '-v', 'ON_ERROR_STOP=1', ...(readOnlyTxn ? ['-c', 'BEGIN READ ONLY'] : []), '-f', PREFLIGHT, ...(readOnlyTxn ? ['-c', 'ROLLBACK'] : [])];
  const r = spawnSync(PSQL, ['-h', sock, '-p', String(port), '-U', user, '-d', db, '-X', '-q', ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, ...(pgoptions ? { PGOPTIONS: pgoptions } : {}) } });
  assert.equal(r.status, 0, r.stderr + r.stdout.slice(0, 500));
  const rows = r.stdout.trim().split('\n').map((l) => { const [area, item, ...st] = l.split(' | '); return { area, item, status: st.join(' | ') }; });
  const get = (prefix) => { const row = rows.find((x) => x.item.startsWith(prefix)); assert.ok(row, `row "${prefix}" missing:\n${r.stdout}`); return row.status; };
  return {
    rows, get,
    verdict: (name) => rows.find((x) => x.area === 'VERDICT' && x.item === name).status,
    tables: () => get('tables with table-level'), columns: () => get('relations with column-level'), seqs: () => get('sequences with USAGE'),
    allowed: () => get('allowed PUBLIC-granted'), txn: () => get('transaction_read_only'), dflt: () => get('default_transaction_read_only'),
  };
}
const skip = !PGBIN || !PSQL;
const opts = { skip: skip ? 'no local PostgreSQL install (CI requires one)' : false };

test('the allowlist is exactly the four confirmed platform objects (no silent additions)', () => {
  const sql = fs.readFileSync(PREFLIGHT, 'utf8');
  const block = sql.match(/allowed\(sch, name, kind\) AS \(VALUES([\s\S]*?)\nwr AS \(/);
  assert.ok(block, 'allowed(...) block found');
  const entries = [...block[1].matchAll(/\('([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g)].map((m) => `${m[1]}.${m[2]}:${m[3]}`).sort();
  assert.deepEqual(entries, ['cron.job_run_details:r', 'net._http_response:r', 'net.http_request_queue:r', 'net.http_request_queue_id_seq:S']);
});

test('baseline: only the four PUBLIC-granted platform privileges -> PASS, and they are listed', opts, () => {
  const s = scenario();
  assert.equal(s.verdict('schema'), 'PASS');
  assert.equal(s.verdict('role+session'), 'PASS');
  assert.equal(s.tables(), 'ok'); assert.equal(s.columns(), 'ok'); assert.equal(s.seqs(), 'ok');
  assert.match(s.allowed(), /^info 4 of 4: cron\.job_run_details, net\._http_response, net\.http_request_queue, net\.http_request_queue_id_seq$/);
  assert.equal(s.txn(), 'ok');
});

test('default_transaction_read_only is informational: off passes, on passes', opts, () => {
  for (const pgoptions of [undefined, '-c default_transaction_read_only=on']) {
    const s = scenario('', { pgoptions });
    assert.match(s.dflt(), /^info (on|off)$/);
    assert.equal(s.verdict('role+session'), 'PASS');
  }
  assert.equal(scenario('', { pgoptions: '-c default_transaction_read_only=on' }).dflt(), 'info on');
  assert.equal(scenario('').dflt(), 'info off');
});

test('transaction_read_only stays mandatory: no READ ONLY transaction -> FAIL', opts, () => {
  const s = scenario('', { readOnlyTxn: false });
  assert.match(s.txn(), /^FAIL \(off\)$/);
  assert.equal(s.verdict('role+session'), 'FAIL');
});

for (const [name, sql, check] of [
  ['a direct INSERT grant on a public table', 'GRANT INSERT ON public.property_images TO backup_ro;',
    (s) => { assert.match(s.tables(), /^FAIL \(1: public\.property_images\)$/); assert.match(s.columns(), /public\.property_images/); }],
  ['a direct UPDATE grant on a public table (the hash backfill shape)', 'GRANT UPDATE ON public.property_images TO backup_ro;',
    (s) => assert.match(s.tables(), /public\.property_images/)],
  ['only a DELETE grant', 'GRANT DELETE ON public.import_images TO backup_ro;',
    (s) => { assert.match(s.tables(), /^FAIL \(1: public\.import_images\)$/); assert.equal(s.columns(), 'ok'); }],
  ['a column-level UPDATE grant only', 'GRANT UPDATE (sha256) ON public.property_images TO backup_ro;',
    (s) => { assert.equal(s.tables(), 'ok'); assert.match(s.columns(), /^FAIL \(1: public\.property_images\)$/); }],
  ['a sequence USAGE grant', 'CREATE SEQUENCE public.other_seq; GRANT USAGE ON SEQUENCE public.other_seq TO backup_ro;',
    (s) => assert.match(s.seqs(), /^FAIL \(1: public\.other_seq\)$/)],
  ['a PUBLIC write grant on a NON-allowlisted object', 'GRANT INSERT ON public.import_images TO PUBLIC;',
    (s) => assert.match(s.tables(), /^FAIL \(1: public\.import_images\)$/)],
  ['look-alike names in other schemas', 'CREATE SCHEMA app; GRANT USAGE ON SCHEMA app TO PUBLIC; CREATE TABLE app.http_request_queue (id int); CREATE TABLE public.job_run_details (id int); GRANT INSERT ON app.http_request_queue, public.job_run_details TO PUBLIC;',
    (s) => { assert.match(s.tables(), /app\.http_request_queue/); assert.match(s.tables(), /public\.job_run_details/); assert.match(s.tables(), /^FAIL \(2:/); }],
  ['an extra PUBLIC grant on the other cron sequence', 'GRANT USAGE ON SEQUENCE cron.job_run_details_runid_seq TO PUBLIC;',
    (s) => assert.match(s.seqs(), /^FAIL \(1: cron\.job_run_details_runid_seq\)$/)],
  ['an allowed object that gained a DIRECT privilege PUBLIC lacks', 'REVOKE TRUNCATE ON net._http_response FROM PUBLIC; GRANT TRUNCATE ON net._http_response TO backup_ro;',
    (s) => { assert.match(s.tables(), /^FAIL \(1: net\._http_response\)$/); assert.match(s.allowed(), /^info 3 of 4/); }],
  ['an allowed object that gained a DIRECT column privilege PUBLIC lacks', 'REVOKE UPDATE ON net._http_response FROM PUBLIC; GRANT UPDATE (status) ON net._http_response TO backup_ro;',
    (s) => assert.match(s.columns(), /net\._http_response/)],
  ['the role OWNING an allowed object', 'ALTER TABLE cron.job_run_details OWNER TO backup_ro;',
    (s) => assert.match(s.tables(), /cron\.job_run_details/)],
  ['an allowed NAME of the wrong kind (a view)', 'DROP TABLE net._http_response; CREATE TABLE public.vsrc (id int, status int); CREATE VIEW net._http_response AS SELECT id, status FROM public.vsrc; GRANT UPDATE ON net._http_response TO PUBLIC;',
    (s) => assert.match(s.columns(), /net\._http_response/)],
]) {
  test(`unexpected write privilege still FAILS: ${name}`, opts, () => {
    const s = scenario(sql);
    check(s);
    assert.equal(s.verdict('role+session'), 'FAIL');
    assert.equal(s.verdict('schema'), 'PASS');
  });
}

test('the other gates are unchanged: superuser, membership, RLS without bypass, missing schema', opts, () => {
  const su = scenario('', { user: 'postgres' });
  assert.equal(su.verdict('role+session'), 'FAIL');
  assert.match(su.get('rolsuper'), /^FAIL/);

  psql('postgres', 'postgres', [], 'GRANT pg_monitor TO backup_ro;');
  try {
    const m = scenario();
    assert.match(m.get('membership in ANY other role'), /^FAIL/);
    assert.equal(m.verdict('role+session'), 'FAIL');
  } finally { psql('postgres', 'postgres', [], 'REVOKE pg_monitor FROM backup_ro;'); }

  const rls = scenario('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;', { user: 'rls_ro' });
  assert.match(rls.get('tables read by the diagnostic with row-level security'), /^FAIL \(1: storage\.objects\)$/);
  assert.match(rls.get('rolbypassrls'), /^WARN/);
  assert.equal(rls.verdict('role+session'), 'FAIL');
  assert.equal(scenario('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;').verdict('role+session'), 'PASS');   // BYPASSRLS role

  const schema = scenario('ALTER TABLE public.import_images DROP COLUMN storage_path;');
  assert.equal(schema.verdict('schema'), 'FAIL');
});

// ── Part C: the reconcile-schema verdict (stage 3 only). Its own verdict; it never changes the other two. ──
test('reconcile-schema: baseline PASS; the existing two verdicts are unchanged', opts, () => {
  const s = scenario();
  assert.equal(s.verdict('reconcile-schema'), 'PASS');
  assert.equal(s.verdict('schema'), 'PASS');
  assert.equal(s.verdict('role+session'), 'PASS');
});

for (const [name, sql, want] of [
  ['a missing history table', 'DROP TABLE public.import_records;', /MISSING/],
  ['a missing history column', 'ALTER TABLE public.gallery_assignments DROP COLUMN photo_paths;', /MISSING/],
  ['a history column of the wrong type (photo_paths text)', 'ALTER TABLE public.gallery_assignments ALTER COLUMN photo_paths TYPE text;', /WRONG_TYPE/],
  ['a history table the role cannot read', 'REVOKE SELECT ON public.properties_row_snapshots FROM backup_ro;', /NO_SELECT/],
]) {
  test(`reconcile-schema FAILS on ${name} -- and only that verdict (stage 2 stays runnable)`, opts, () => {
    const s = scenario(sql);
    assert.equal(s.verdict('reconcile-schema'), 'FAIL');
    assert.equal(s.verdict('schema'), 'PASS');
    assert.equal(s.verdict('role+session'), 'PASS');
    assert.ok(s.rows.some((r) => r.area === 'reconcile-schema' && want.test(r.status)));
  });
}

test('reconcile-schema: row-level security hiding a history table from the role FAILS that verdict only', opts, () => {
  const s = scenario('ALTER TABLE public.import_records ENABLE ROW LEVEL SECURITY;', { user: 'rls_ro' });
  assert.match(s.get('tables read only by the reconciliation with row-level security'), /^FAIL \(1: public\.import_records\)$/);
  assert.equal(s.verdict('reconcile-schema'), 'FAIL');
  assert.equal(s.verdict('schema'), 'PASS');
});

// ── Part D: the gallery-schema verdict (gallery listing-state stage only). Its own verdict; it never changes the others. ──
test('gallery-schema: baseline PASS; the other three verdicts are unchanged', opts, () => {
  const s = scenario();
  assert.equal(s.verdict('gallery-schema'), 'PASS');
  for (const v of ['schema', 'role+session', 'reconcile-schema']) assert.equal(s.verdict(v), 'PASS', v);
});

for (const [name, sql, want] of [
  ['a missing gallery_assignments.cluster_id', 'ALTER TABLE public.gallery_assignments DROP COLUMN cluster_id;', /MISSING/],
  ['a missing gallery_assignments.confidence', 'ALTER TABLE public.gallery_assignments DROP COLUMN confidence;', /MISSING/],
  ['gallery_assignments unreadable by the role', 'REVOKE SELECT ON public.gallery_assignments FROM backup_ro;', /NO_SELECT/],
  ['properties.images of the wrong type', 'ALTER TABLE public.properties ALTER COLUMN images TYPE text USING images::text;', /WRONG_TYPE/],
  ['a missing properties.deleted_at (deletion state unknown)', 'ALTER TABLE public.properties DROP COLUMN deleted_at;', /^MISSING$/],
  ['properties.deleted_at of type text', 'ALTER TABLE public.properties ALTER COLUMN deleted_at TYPE text USING deleted_at::text;', /WRONG_TYPE \(is text, expected timestamp with time zone\)/],
  ['properties.deleted_at of type timestamp WITHOUT time zone', 'ALTER TABLE public.properties ALTER COLUMN deleted_at TYPE timestamp;', /WRONG_TYPE \(is timestamp without time zone, expected timestamp with time zone\)/],
  ['properties.deleted_at of type boolean', 'ALTER TABLE public.properties DROP COLUMN deleted_at; ALTER TABLE public.properties ADD COLUMN deleted_at boolean;', /WRONG_TYPE/],
]) {
  test(`gallery-schema FAILS on ${name}`, opts, () => {
    const s = scenario(sql);
    assert.equal(s.verdict('gallery-schema'), 'FAIL');
    assert.ok(s.rows.some((r) => r.area === 'gallery-schema' && want.test(r.status)));
    assert.equal(s.verdict('role+session'), 'PASS', 'the role + session verdict is unaffected');
  });
}

test('gallery-schema lists properties.deleted_at as a required timestamptz column (and ok when present)', opts, () => {
  const s = scenario();
  assert.equal(s.rows.find((r) => r.area === 'gallery-schema' && r.item === 'public.properties.deleted_at').status, 'ok');
  const sql = fs.readFileSync(PREFLIGHT, 'utf8');
  assert.match(sql, /\('public',\s+'properties',\s+'deleted_at',\s+'timestamp with time zone'\)/);
});
