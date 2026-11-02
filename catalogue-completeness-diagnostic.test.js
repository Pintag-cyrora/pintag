// scripts/diagnostics/catalogue-completeness/ + .github/workflows/catalogue-completeness.yml: a manual, READ-ONLY, aggregate-only report on what the
// catalogue contains (published, photos, prices, availability, contacts, map-link precision). SYNTHETIC data only. Real-Postgres tests need a local
// PostgreSQL (CI=true: missing = FAILURE). Run with: node --test catalogue-completeness-diagnostic.test.js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(ROOT, 'scripts', 'diagnostics', 'catalogue-completeness');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'catalogue-completeness.yml');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const SECRET_URL = 'postgres://backup_ro:S3cr3tPassw0rd@db.example.invalid:5432/postgres';
// strings planted in the synthetic data that must never reach the output
const IDENT = /SYN-TITLE|SYN-DESC|SYN-MAP|SYN-VILLAGE|0000eeee|S3cr3tPassw0rd|18\.1234567|102\.1234567/;

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
const psqlRaw = (db, args, input, user = 'postgres') => spawnSync(PSQL, ['-h', sock, '-p', String(port), '-U', user, '-d', db, '-X', '-q', ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: dir } });

before(() => {
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL: the catalogue-completeness tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pgcat-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  assert.equal(asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']).status, 0);
  assert.equal(asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']).status, 0);
  psqlRaw('postgres', [], 'CREATE ROLE cat_ro LOGIN BYPASSRLS; CREATE ROLE cat_plain LOGIN; CREATE ROLE cat_owner LOGIN;');
});
after(() => {
  if (!dir) return;
  asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

const PUB = 'PUBLISHED (what the public read policy shows: not soft-deleted and status active/available)';
const WFA = 'published by the editorial rule (not soft-deleted and workflow_status = active)';
const DIS = 'listings on which the two rules DISAGREE (should be 0)';
const E = (n) => `00000000-0000-0000-eeee-${String(n).padStart(12, '0')}`;   // planted listing ids
const SCHEMA = `
CREATE TABLE public.properties (id uuid PRIMARY KEY, deleted_at timestamptz, status text, workflow_status text NOT NULL, market_status text NOT NULL, transaction_type text,
  images jsonb, created_at timestamptz NOT NULL DEFAULT now(), property_type text, price_amount numeric, price_currency text, price_frequency text,
  rent_price_amount numeric, rent_price_currency text, price_display text, title_lo text, title_en text, title_zh text, description_en text,
  managed_by_party_id uuid, contact_id uuid, owner_id uuid, district_en text, village_en text, province text, map_embed_url text, available_from date);
CREATE TABLE public.unit_types (id uuid PRIMARY KEY, property_id uuid, price_amount numeric, price_currency text, price_frequency text,
  rent_price_amount numeric, rent_price_currency text, rent_price_frequency text, is_available boolean);
CREATE TABLE public.leads (id uuid PRIMARY KEY, property_id uuid);
CREATE TABLE public.property_images (id uuid PRIMARY KEY, property_id uuid);
CREATE TABLE public.property_contacts (id uuid PRIMARY KEY, property_id uuid, contact_id uuid);
`;
// L1 published, 3 images + registry, exact $350, short map link, lo+en title, a party + contact
// L2 published, no images, 3 units (350, 500, 500 USD monthly: differ), coordinates with 7 decimals, a lead, owner
// L3 published, 2 units USD monthly + LAK monthly (mixed), market available but no unit available
// L4 draft (not published)         L5 soft-deleted active
// L6 published, price_amount 0 (not a positive number), registry rows but empty gallery, link with 3-decimal coordinates
// L7 published, no price at all, Available From in the past, same English title as L1
// L8 published, legacy text price only, a coordinate-less link, images that are not an array
const DATA = `
INSERT INTO properties (id, deleted_at, status, workflow_status, market_status, transaction_type, images, created_at, property_type, price_amount, price_currency, price_frequency, price_display,
   title_lo, title_en, title_zh, description_en, managed_by_party_id, contact_id, owner_id, district_en, village_en, province, map_embed_url, available_from) VALUES
 ('${E(1)}', NULL, 'active', 'active', 'available', 'for_rent', '["a.jpg","b.jpg","c.jpg"]', '2026-09-10', 'condo', 350, 'USD', 'month', NULL, 'SYN-TITLE-lo', 'SYN-TITLE-dup', NULL, 'SYN-DESC', '${E(90)}', '${E(91)}', NULL, 'Chanthabury', 'SYN-VILLAGE', 'Vientiane Capital', 'https://maps.app.goo.gl/SYN-MAP', NULL),
 ('${E(2)}', NULL, 'active', 'active', 'available', 'for_rent', '[]', '2026-09-20', 'apartment', NULL, NULL, NULL, NULL, NULL, 'SYN-TITLE-two', NULL, NULL, NULL, NULL, '${E(92)}', 'Sikhottabong', NULL, NULL, 'https://www.google.com/maps/place/SYN-MAP/@18.1234567,102.1234567,17z', NULL),
 ('${E(3)}', NULL, 'active', 'active', 'available', 'for_rent', '["x.jpg"]', '2026-10-01', 'apartment', NULL, NULL, NULL, NULL, 'SYN-TITLE-lo3', 'SYN-TITLE-three', 'SYN-TITLE-zh3', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 ('${E(4)}', NULL, 'draft', 'draft', 'available', 'for_rent', '["d.jpg"]', '2026-10-02', 'house', 100, 'USD', 'month', NULL, NULL, 'SYN-TITLE-four', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 ('${E(5)}', '2026-10-03', 'active', 'active', 'available', 'for_rent', '["e.jpg"]', '2026-10-03', 'house', 100, 'USD', 'month', NULL, NULL, 'SYN-TITLE-five', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 ('${E(6)}', NULL, 'active', 'active', 'reserved', 'for_sale', '[]', '2026-10-04', 'land', 0, 'USD', NULL, NULL, NULL, 'SYN-TITLE-six', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'https://www.google.com/maps?q=18.123,102.123', NULL),
 ('${E(7)}', NULL, 'active', 'active', 'available', 'for_rent', '["g.jpg"]', '2026-10-05', 'house', NULL, NULL, NULL, NULL, NULL, 'SYN-TITLE-DUP', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2020-01-01'),
 ('${E(8)}', NULL, 'active', 'active', 'available', 'for_rent', '"not-an-array"', '2026-10-06', 'house', NULL, NULL, NULL, '$200 / month', NULL, 'SYN-TITLE-eight', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'https://example.com/SYN-MAP', NULL);
INSERT INTO unit_types VALUES
 ('${E(21)}', '${E(2)}', 350, 'USD', 'month', NULL, NULL, NULL, true), ('${E(22)}', '${E(2)}', 500, 'USD', 'month', NULL, NULL, NULL, true), ('${E(23)}', '${E(2)}', 500, 'USD', 'month', NULL, NULL, NULL, false),
 ('${E(24)}', '${E(3)}', 300, 'USD', 'month', NULL, NULL, NULL, false), ('${E(25)}', '${E(3)}', NULL, NULL, NULL, 2000000, 'LAK', 'month', false);
INSERT INTO leads VALUES ('${E(31)}', '${E(2)}'), ('${E(32)}', '${E(2)}');
INSERT INTO property_images VALUES ('${E(41)}', '${E(1)}'), ('${E(42)}', '${E(6)}');
INSERT INTO property_contacts VALUES ('${E(51)}', '${E(3)}', '${E(93)}');
`;
function makeDb({ extra = '', grant = 'cat_ro' } = {}) {
  const db = `c${++counter}`;
  assert.equal(psqlRaw('postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${db};`).status, 0);
  const s = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1'], SCHEMA + DATA + extra + `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${grant}; GRANT USAGE ON SCHEMA public TO ${grant};`);
  assert.equal(s.status, 0, s.stderr);
  return db;
}
function sql(db, file, { readOnly = true, user = 'postgres' } = {}) {
  const r = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-v', 'ON_ERROR_STOP=1', ...(readOnly ? ['-c', 'BEGIN READ ONLY'] : []), '-f', path.join(D, file), ...(readOnly ? ['-c', 'ROLLBACK'] : [])], undefined, user);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function report(db, o) {
  const text = sql(db, '2-catalogue.sql', o);
  const rows = text.trim().split('\n').filter(Boolean).map((l) => { const [section, label, n] = l.split(' | '); return { section, label, n }; });
  const get = (prefix) => Object.fromEntries(rows.filter((x) => x.section.startsWith(prefix + ' ')).map((x) => [x.label, x.n]));
  return { rows, get, text };
}
function preflight(db, o) {
  const text = sql(db, '1-preflight.sql', o);
  const rows = text.trim().split('\n').filter(Boolean).map((l) => { const [area, item, status] = l.split(' | '); return { area, item, status }; });
  const verdict = (v) => (rows.find((r) => r.area === 'VERDICT' && r.item === v) || {}).status;
  return { rows, verdict, text };
}

test('catalogue counts: published scope, galleries, registry, prices, units, availability, content, links, leads', opts, () => {
  const r = report(makeDb());
  assert.ok(r.rows.some((x) => x.section.startsWith('0 ') && x.label === 'transaction_read_only=on'));
  assert.deepEqual(r.get('1'), { 'all rows': '8', 'soft-deleted': '1', 'not soft-deleted': '7', [PUB]: '6', [WFA]: '6', [DIS]: '0' });
  assert.deepEqual(r.get('2'), { active: '6', draft: '1' });
  assert.deepEqual(r.get('3'), { available: '5', reserved: '1' });
  assert.deepEqual(r.get('4'), { for_rent: '5', for_sale: '1' });
  // published = L1,L2,L3,L6,L7,L8 ; images: L1=3, L2=0, L3=1, L6=0, L7=1, L8=0 (a non-array gallery counts as empty)
  assert.deepEqual(r.get('6'), { 'a: no images': '3', 'b: 1-2': '2', 'c: 3-5': '1' });
  assert.deepEqual(r.get('7'), { 'gallery and registry rows': '1', 'gallery, NO registry rows': '2', 'registry rows, EMPTY gallery': '1', neither: '2' });
  assert.deepEqual(r.get('8'), {
    'listing-level structured price': '1',
    'unit-level structured prices only': '2',
    'amount present but not a positive number (falls back to Price on request)': '1',
    'legacy text price only': '1',
    'no price (shows Price on request)': '1' });
  assert.deepEqual(r.get('9'), { USD: '2', none: '4' });
  assert.deepEqual(r.get('10'), {
    'fewer than 2 unit types': '4',
    '2+ priced units, prices differ (From)': '1',
    '2+ priced units, mixed currency or frequency (Prices vary)': '1' });
  assert.deepEqual(r.get('11'), { '0': '4', '2-3': '2' });
  assert.deepEqual(r.get('12'), {
    'market_status available but no unit type is available': '1',
    'market_status available with an Available From date in the past': '1',
    'no inconsistency detected': '4' });
  assert.deepEqual(r.get('13'), { en: '4', 'lo en': '1', 'lo en zh': '1' });
  assert.deepEqual(r.get('14'), { none: '5', en: '1' });
  assert.deepEqual(r.get('15'), { 'party contact': '1', owner: '1', contact: '1', none: '3' });
  assert.deepEqual(r.get('16'), { 'province district village': '1', district: '1', none: '4' });
  assert.deepEqual(r.get('17'), {
    'short link (no coordinates until resolved)': '1',
    'carries coordinates with 5+ decimals (about 1 m)': '1',
    'carries coordinates with 1-4 decimals': '1',
    'link without parseable coordinates': '1',
    'no map link': '2' });
  assert.deepEqual(r.get('18'), { 'shares its English title': '2', unique: '4' });
  assert.deepEqual(r.get('19'), { 'has at least one lead': '1', 'no lead ever': '5' });
  assert.deepEqual(r.get('20'), { '2026-09': '2', '2026-10': '4' });
});

test('READ ONLY guard: outside a READ ONLY transaction every count is zero and the guard row says so', opts, () => {
  const r = report(makeDb(), { readOnly: false });
  assert.ok(r.rows.some((x) => x.section.startsWith('0 ') && x.label === 'transaction_read_only=off'));
  assert.deepEqual(r.get('1'), { 'all rows': '0', 'soft-deleted': '0', 'not soft-deleted': '0', [PUB]: '0', [WFA]: '0', [DIS]: '0' });
});

test('aggregates only: no title, description, village, map link, coordinate, id or secret is printed; the database is unchanged', opts, () => {
  const db = makeDb();
  const snap = () => psqlRaw(db, ['-A', '-t'], 'SELECT (SELECT count(*) FROM properties)||(SELECT count(*) FROM unit_types)||(SELECT count(*) FROM leads)||(SELECT string_agg(map_embed_url, \',\' ORDER BY id) FROM properties);').stdout;
  const before = snap();
  const r = report(db);
  assert.doesNotMatch(r.text, IDENT);
  assert.doesNotMatch(r.text, /https?:\/\//);
  assert.equal(snap(), before);
  const w = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY', '-c', 'UPDATE properties SET images = NULL']);
  assert.notEqual(w.status, 0); assert.match(w.stderr, /read-only transaction/);
});

test('optional columns missing: the report still runs (they are read through to_jsonb), only the required ones gate the preflight', opts, () => {
  const db = makeDb({ extra: 'ALTER TABLE properties DROP COLUMN province; ALTER TABLE properties DROP COLUMN description_en; ALTER TABLE unit_types DROP COLUMN is_available;' });
  const r = report(db);
  assert.equal(r.get('1')[PUB], '6');
  assert.equal(preflight(db).verdict('catalogue-schema'), 'PASS');
});

// ── preflight ──
test('preflight: baseline PASS for a read-only role that bypasses RLS', opts, () => {
  const p = preflight(makeDb(), { user: 'cat_ro' });
  assert.equal(p.verdict('catalogue-schema'), 'PASS');
  assert.equal(p.verdict('role+session'), 'PASS');
  assert.ok(!p.rows.some((x) => /WARN/.test(x.status)));
  assert.doesNotMatch(p.text, IDENT);
});
for (const [name, extra, want] of [
  ['a missing required column', 'ALTER TABLE properties DROP COLUMN workflow_status;', /MISSING/],
  ['a wrong-typed required column', 'ALTER TABLE properties ALTER COLUMN images TYPE text USING images::text;', /WRONG_TYPE/],
  ['a missing table', 'DROP TABLE leads;', /MISSING/],
]) {
  test(`preflight: catalogue-schema FAILS on ${name}`, opts, () => {
    const p = preflight(makeDb({ extra }));
    assert.equal(p.verdict('catalogue-schema'), 'FAIL');
    assert.ok(p.rows.some((r) => r.area === 'catalogue-schema' && want.test(r.status)));
  });
}
test('preflight: a role that can write FAILS role+session', opts, () => {
  const p = preflight(makeDb({ extra: 'GRANT UPDATE ON properties TO cat_ro;' }), { user: 'cat_ro' });
  assert.equal(p.verdict('role+session'), 'FAIL');
  assert.ok(p.rows.some((r) => r.area === 'role' && /can write/.test(r.status)));
});
test('preflight: a role that RLS applies to produces a WARN (counts could be hidden)', opts, () => {
  const db = makeDb({ extra: 'ALTER TABLE properties ENABLE ROW LEVEL SECURITY;', grant: 'cat_plain' });
  const p = preflight(db, { user: 'cat_plain' });
  assert.ok(p.rows.some((r) => /^WARN/.test(r.status) && /properties/.test(r.item)));
});
test('preflight: outside a READ ONLY transaction FAILS role+session', opts, () => {
  const p = preflight(makeDb(), { readOnly: false });
  assert.equal(p.verdict('role+session'), 'FAIL');
});


// ── adversarial review of the visibility gate: can the preflight certify a connection that cannot see every row? ──
test('preflight: FORCE ROW LEVEL SECURITY applies to the table OWNER too -> WARN (an owner is not exempt), and the verdict FAILS', opts, () => {
  const db = makeDb({ extra: 'ALTER TABLE properties OWNER TO cat_owner; ALTER TABLE properties ENABLE ROW LEVEL SECURITY; ALTER TABLE properties FORCE ROW LEVEL SECURITY; CREATE POLICY hide ON properties USING (false);', grant: 'cat_owner' });
  const p = preflight(db, { user: 'cat_owner' });
  assert.ok(p.rows.some((r) => r.area === 'role' && /properties/.test(r.item) && /rows of/.test(r.item) && /^WARN/.test(r.status)), p.text);
  assert.equal(p.verdict('role+session'), 'FAIL');
});
test('preflight: an owner WITHOUT force-RLS is not hidden by RLS (it bypasses it), so no RLS warning for that table', opts, () => {
  const db = makeDb({ extra: 'ALTER TABLE properties OWNER TO cat_owner; ALTER TABLE properties ENABLE ROW LEVEL SECURITY;', grant: 'cat_owner' });
  const p = preflight(db, { user: 'cat_owner' });
  assert.ok(!p.rows.some((r) => r.area === 'role' && /rows of properties/.test(r.item) && /^WARN/.test(r.status)));
});
test('preflight: any WARN also makes the role+session VERDICT FAIL, so a PASS verdict can never be read as "all rows visible"', opts, () => {
  const db = makeDb({ extra: 'ALTER TABLE properties ENABLE ROW LEVEL SECURITY;', grant: 'cat_plain' });
  const p = preflight(db, { user: 'cat_plain' });
  assert.ok(p.rows.some((r) => /^WARN/.test(r.status)));
  assert.equal(p.verdict('role+session'), 'FAIL');
});
test('"published" is the rule of the public read policy; a listing whose status is available but workflow_status is draft is published and the disagreement is counted', opts, () => {
  const db = makeDb({ extra: `INSERT INTO properties (id, status, workflow_status, market_status, transaction_type, images) VALUES ('${E(9)}', 'available', 'draft', 'available', 'for_rent', '[]');` });
  const r = report(db);
  assert.equal(r.get('1')[PUB], '7');
  assert.equal(r.get('1')[WFA], '6');
  assert.equal(r.get('1')[DIS], '1');
});
test('a status the public policy does not show (archived) is not published even if workflow_status says active', opts, () => {
  const db = makeDb({ extra: `INSERT INTO properties (id, status, workflow_status, market_status, transaction_type, images) VALUES ('${E(9)}', 'archived', 'active', 'available', 'for_rent', '[]');` });
  const r = report(db);
  assert.equal(r.get('1')[PUB], '6');
  assert.equal(r.get('1')[DIS], '1');
});
test('labels built from data are sanitized: free text in a category column prints as "other", never as the text', opts, () => {
  const db = makeDb({ extra: `UPDATE properties SET property_type = 'SYN-TITLE leak, a name', transaction_type = 'SYN-DESC for_rent', price_currency = 'SYN-MAP' WHERE id = '${E(7)}'; UPDATE properties SET market_status = 'SYN-TITLE market' WHERE id = '${E(8)}';` });
  const r = report(db);
  assert.doesNotMatch(r.text, IDENT);
  assert.ok(r.text.includes('other (not a plain code)'));
  assert.ok(r.text.includes('other (not a 3-letter code)'));
});
test('visibility cross-check: a connection that sees fewer rows than the catalogue estimate says so (advisory), and an unrestricted one is consistent', opts, () => {
  const ok = report(makeDb({ extra: 'ANALYZE;' }));
  const row = (rr) => Object.keys(rr.get('21')).find((k) => k.startsWith('properties'));
  assert.match(row(ok), /consistent with the estimate/);
  const db = makeDb({ extra: 'ANALYZE; ALTER TABLE properties ENABLE ROW LEVEL SECURITY; CREATE POLICY hide ON properties FOR SELECT TO cat_plain USING (false);', grant: 'cat_plain' });
  const hidden = report(db, { user: 'cat_plain' });
  assert.match(row(hidden), /FEWER rows seen than the estimate/);
});
test('visibility cross-check: a table that was never analyzed says so instead of pretending', opts, () => {
  const r = report(makeDb());
  assert.ok(Object.keys(r.get('21')).some((k) => /no estimate yet|consistent with the estimate/.test(k)));
});

// ── run.sh against a fake psql ──
function runFake({ preflightOut, catalogueOut, failOn, stale = false } = {}) {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  const work = path.join(dir2, 'work'); fs.mkdirSync(work); fs.mkdirSync(path.join(dir2, 'bin'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  if (stale) { fs.writeFileSync(path.join(work, 'catalogue.txt'), 'STALE\n'); fs.writeFileSync(path.join(work, 'preflight.txt'), 'STALE\n'); }
  fs.writeFileSync(path.join(dir2, 'pre.out'), preflightOut ?? 'VERDICT | catalogue-schema | PASS\nVERDICT | role+session | PASS\n');
  fs.writeFileSync(path.join(dir2, 'cat.out'), catalogueOut ?? '0 session guard | transaction_read_only=on | \n1 properties rows | all rows | 8\n');
  const log = path.join(dir2, 'psql.log');
  fs.writeFileSync(path.join(dir2, 'bin', 'psql'), `#!/bin/bash
echo "CALL $*" >> "${log}"
case "$*" in
  *${failOn || 'NEVER-MATCHES'}*) echo "ERROR:  invalid input: \\"SYN-TITLE-leak\\" listing ${E(1)}" >&2; echo "ERROR:  22P02" >&2; echo "SYN-TITLE-stdout-leak"; exit 3;;
  *1-preflight.sql*) cat "${dir2}/pre.out";; *2-catalogue.sql*) cat "${dir2}/cat.out";;
esac
`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(work, 'run.sh')], { env: { PATH: `${path.join(dir2, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir2, PINTAG_PROD_DB_URL: SECRET_URL }, encoding: 'utf8', input: '' });
  const files = {};
  for (const f of fs.readdirSync(work)) if (/\.(txt|csv)$/.test(f)) files[f] = fs.readFileSync(path.join(work, f), 'utf8');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('CALL ').filter(Boolean) : [];
  return { r, out: r.stdout + r.stderr, files, calls };
}

test('run.sh: lints both files, then preflight, then ONLY the catalogue query; every call READ ONLY with SQLSTATE-only errors; the URL is never printed', () => {
  const { r, out, files, calls } = runFake();
  assert.equal(r.status, 0, out);
  assert.match(out, /lint ok: 1-preflight\.sql/); assert.match(out, /lint ok: 2-catalogue\.sql/);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /1-preflight\.sql/); assert.match(calls[1], /2-catalogue\.sql/);
  for (const c of calls) { assert.match(c, /BEGIN READ ONLY.*\.sql.*ROLLBACK/); assert.match(c, /VERBOSITY=sqlstate/); }
  assert.match(files['catalogue.txt'], /1 properties rows/);
  assert.deepEqual(Object.keys(files).sort(), ['catalogue.txt', 'preflight.txt']);
  assert.doesNotMatch(out + Object.values(files).join(''), /S3cr3tPassw0rd/);
});
for (const [label, pre, text] of [
  ['catalogue-schema FAIL', 'VERDICT | catalogue-schema | FAIL\nVERDICT | role+session | PASS\n', /PREFLIGHT DID NOT PASS/],
  ['role+session FAIL', 'VERDICT | catalogue-schema | PASS\nVERDICT | role+session | FAIL\n', /PREFLIGHT DID NOT PASS/],
  ['a verdict missing', 'VERDICT | catalogue-schema | PASS\n', /PREFLIGHT DID NOT PASS/],
  ['a WARN row', 'role | row-level security cannot hide rows of properties | WARN (RLS applies to this role)\nVERDICT | catalogue-schema | PASS\nVERDICT | role+session | PASS\n', /PREFLIGHT HAD WARNINGS/],
]) {
  test(`run.sh keeps the gates: ${label} stops before the catalogue query, job fails, stale results removed`, () => {
    const { r, out, files, calls } = runFake({ preflightOut: pre, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, text);
    assert.equal(calls.length, 1);
    assert.ok(!('catalogue.txt' in files));
  });
}
test('run.sh: a psql failure withholds the error text (SQLSTATE only) and leaves no result file', () => {
  const { r, out, files } = runFake({ failOn: '2-catalogue.sql', stale: true });
  assert.notEqual(r.status, 0);
  assert.match(out, /psql failed \(exit 3\); its error text is withheld/);
  assert.doesNotMatch(out, /SYN-TITLE|0000eeee/);
  assert.ok(!('catalogue.txt' in files));
});
test('run.sh: no URL supplied -> nothing is run', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  const work = path.join(dir2, 'work'); fs.mkdirSync(work);
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  const r = spawnSync('bash', [path.join(work, 'run.sh')], { env: { PATH: process.env.PATH, HOME: dir2 }, encoding: 'utf8', input: '\n' });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /No database URL supplied - nothing was run/);
});

// ── lint fixtures: a forbidden statement in either file must be refused ──
test('the lint refuses a modified SQL file (a write keyword, a second statement)', () => {
  for (const bad of ['\nDELETE FROM properties;', '\n;SELECT 1;']) {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const work = path.join(dir2, 'work'); fs.mkdirSync(work);
    for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
    fs.appendFileSync(path.join(work, '2-catalogue.sql'), bad);
    const r = spawnSync('bash', [path.join(work, 'run.sh')], { env: { PATH: process.env.PATH, HOME: dir2, PINTAG_PROD_DB_URL: SECRET_URL }, encoding: 'utf8', input: '' });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /LINT FAIL 2-catalogue\.sql/);
  }
});

// ── workflow: static safety checks ──
const WF = fs.readFileSync(WORKFLOW, 'utf8');
test('workflow: manual only, contents: read, the protected environment, one secret, no artifact, no write path', () => {
  const on = WF.split('\n').filter((l) => /^on:|^  (workflow_dispatch|push|pull_request|schedule|workflow_run|repository_dispatch)/.test(l)).map((l) => l.trim());
  assert.deepEqual(on, ['on:', 'workflow_dispatch:']);
  assert.match(WF, /permissions:\n  contents: read\n/);
  assert.match(WF, /environment: production-backup/);
  assert.deepEqual([...new Set(WF.match(/secrets\.[A-Z0-9_]+/g))], ['secrets.PINTAG_PROD_DB_URL']);
  assert.doesNotMatch(WF, /upload-artifact|actions\/cache|gh release|git push|curl |wget /);
  assert.match(WF, /bash scripts\/diagnostics\/catalogue-completeness\/run\.sh/);
  assert.doesNotMatch(WF, /orphan-originals/);
  assert.match(WF, /\n    if: github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-latest/);   // a dispatch of another branch must not reach the production secret
});
test('the SQL files hold no write keyword, no transaction control and no identifier-bearing column in the output', () => {
  for (const f of ['1-preflight.sql', '2-catalogue.sql']) {
    const s = fs.readFileSync(path.join(D, f), 'utf8').replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
    assert.doesNotMatch(s, /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|copy|begin|commit|rollback|set|do)\b/i);
  }
  const out = fs.readFileSync(path.join(D, '2-catalogue.sql'), 'utf8');
  // the final projection is exactly (section, label, n)
  assert.match(out, /SELECT section, label, n FROM \(/);
});
