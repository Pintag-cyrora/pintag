// scripts/seed-dev-lib.sh + scripts/seed-dev-from-prod.sh: the development database must never receive exact locations, accounts, real phone numbers, third-party post links,
// unpublished rows or internal fields from production. Runs the REAL export/import code against two throwaway local databases ("production" with sensitive, synthetic data;
// "dev" with the dev schema). SYNTHETIC data only. Needs a local PostgreSQL (CI=true: missing = FAILURE). Run with: node --test seed-dev-redaction.test.js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(ROOT, 'scripts', 'seed-dev-lib.sh');
const MAIN = fs.readFileSync(path.join(ROOT, 'scripts', 'seed-dev-from-prod.sh'), 'utf8');
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
let dir, sock, port, n = 0;
const asPg = (cmd, args) => IS_ROOT ? spawnSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { encoding: 'utf8' }) : spawnSync(cmd, args, { encoding: 'utf8' });
const psql = (db, args, input) => spawnSync(PSQL, ['-h', sock, '-p', String(port), '-U', 'postgres', '-d', db, '-X', '-q', ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: dir } });

before(() => {
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL: the seed redaction tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pgseed-');
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

// synthetic values that must NEVER appear in the development database
const SECRETS = ['SYN-MAPLINK', 'SYN-LAT', 'SYN-LNG', 'SYN-PHONE', 'SYN-EMAIL', 'SYN-OWNER', 'SYN-NOTE', 'SYN-DOWNLOAD', 'SYN-VIDEO', 'SYN-FBPOST', 'SYN-NEARBY', 'SYN-NEIGH',
  'SYN-DRAFT', 'SYN-DELETED', 'SYN-CONTACTNAME', 'SYN-CONTACTPHONE', 'SYN-AUTH', 'SYN-CREATEDBY', 'SYN-EXTRA', 'maps.app.goo.gl', 'google.com/maps', '18.1234567', '102.1234567'];
const U = (k) => `00000000-0000-0000-eeee-${String(k).padStart(12, '0')}`;
const PROD_SCHEMA = `
CREATE TABLE parties (id uuid PRIMARY KEY, type text, auth_user_id uuid, slug text, name_en text, name_lo text, photo_url text, agency_name text, bio_en text, bio_lo text,
  is_verified boolean, is_active boolean, languages text[], phone text, whatsapp text, email text, created_by uuid, created_at timestamptz DEFAULT now(), internal_flag text);
CREATE TABLE contacts (id uuid PRIMARY KEY, role text NOT NULL, name text, phone text NOT NULL, whatsapp text, party_id uuid, is_verified boolean DEFAULT false, created_by uuid, created_at timestamptz DEFAULT now(), secret_col text);
CREATE TABLE properties (id uuid PRIMARY KEY, slug text, title_en text, title_lo text, description_en text, property_type text, transaction_type text, status text, workflow_status text, market_status text,
  deleted_at timestamptz, price_amount numeric, price_currency text, price_frequency text, district_en text, village_en text, bedrooms int, images jsonb,
  map_embed_url text, latitude numeric, longitude numeric, owner_id uuid, notes text, download_url text, video_url text, video_embed_url text, facebook_video_url text,
  nearby_places jsonb, neighborhood_description text, neighborhood_insight_en text, view_count int, views_week int, price_previous numeric,
  managed_by_party_id uuid, contact_id uuid, is_featured boolean, created_at timestamptz DEFAULT now(), brand_new_internal_column text);
INSERT INTO parties (id, type, auth_user_id, slug, name_en, name_lo, photo_url, is_verified, is_active, languages, phone, whatsapp, email, created_by, internal_flag) VALUES
 ('${U(1)}', 'agent', '${U(90)}', 'agent-a', 'Agent A', 'ຕົວແທນ', 'https://x.invalid/a.jpg', true, true, ARRAY['lo'], 'SYN-PHONE-1', 'SYN-PHONE-W1', 'SYN-EMAIL-1@example.invalid', '${U(91)}', 'SYN-EXTRA-1'),
 ('${U(2)}', 'staff', '${U(92)}', 'staff', 'Pintag Staff', NULL, NULL, NULL, true, NULL, 'SYN-PHONE-2', NULL, 'SYN-EMAIL-2@example.invalid', NULL, NULL);
INSERT INTO contacts (id, role, name, phone, whatsapp, party_id, created_by, secret_col) VALUES
 ('${U(11)}', 'owner', 'SYN-CONTACTNAME-1', 'SYN-CONTACTPHONE-1', 'SYN-CONTACTPHONE-W1', '${U(1)}', '${U(93)}', 'SYN-EXTRA-2'),
 ('${U(12)}', 'agent', 'SYN-CONTACTNAME-2', 'SYN-CONTACTPHONE-2', NULL, NULL, NULL, NULL),
 ('${U(13)}', 'owner', 'SYN-CONTACTNAME-3 (belongs to a draft)', 'SYN-CONTACTPHONE-3', NULL, NULL, NULL, NULL);
INSERT INTO properties (id, slug, title_en, title_lo, description_en, property_type, transaction_type, status, workflow_status, market_status, deleted_at, price_amount, price_currency, price_frequency, district_en, village_en, bedrooms, images,
  map_embed_url, latitude, longitude, owner_id, notes, download_url, video_url, video_embed_url, facebook_video_url, nearby_places, neighborhood_description, neighborhood_insight_en, view_count, views_week, price_previous, managed_by_party_id, contact_id, is_featured, brand_new_internal_column) VALUES
 ('${U(21)}', 'published-one', 'Published one', 'ລາຍການ', 'Nice flat. Map: https://maps.app.goo.gl/SYN-MAPLINK-1 and https://www.google.com/maps/place/SYN-MAPLINK-2/@18.1234567,102.1234567,17z too', 'condo', 'for_rent', 'active', 'active', 'available', NULL, 350, 'USD', 'month', 'Chanthabury', 'Village One', 2, '["https://img.invalid/1.jpg"]',
  'https://www.google.com/maps/place/SYN-MAPLINK-3/@18.1234567,102.1234567,17z', 18.1234567, 102.1234567, '${U(94)}', 'SYN-NOTE-1', 'SYN-DOWNLOAD-1', 'https://v.invalid/SYN-VIDEO-1', 'https://v.invalid/SYN-VIDEO-2', 'https://facebook.invalid/SYN-FBPOST-1', '[{"name":"SYN-NEARBY-1"}]', 'SYN-NEIGH-1', 'SYN-NEIGH-2', 99, 55, 300, '${U(1)}', '${U(11)}', true, 'SYN-EXTRA-3'),
 ('${U(22)}', 'published-two', 'Published two', NULL, 'Plain text', 'house', 'for_sale', 'available', 'active', 'available', NULL, 90000, 'USD', NULL, 'Sikhottabong', 'Village Two', 4, '[]',
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 5, 2, NULL, NULL, '${U(12)}', false, NULL),
 ('${U(23)}', 'draft-one', 'SYN-DRAFT-TITLE', NULL, 'SYN-DRAFT', 'house', 'for_rent', 'draft', 'draft', 'available', NULL, 1, 'USD', 'month', 'X', 'Y', 1, '[]', 'https://maps.app.goo.gl/SYN-MAPLINK-4', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, '${U(13)}', false, NULL),
 ('${U(24)}', 'deleted-one', 'SYN-DELETED-TITLE', NULL, 'SYN-DELETED', 'house', 'for_rent', 'active', 'active', 'available', now(), 1, 'USD', 'month', 'X', 'Y', 1, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, false, NULL);
`;
// the dev schema: same tables (as bootstrap-dev-db.sh builds them), including the location columns (they exist in dev, they must stay empty), minus the brand-new production-only columns
const DEV_SCHEMA = PROD_SCHEMA.split('INSERT INTO')[0].replace(', internal_flag text', '').replace(', secret_col text', '').replace(', brand_new_internal_column text', '');
const run = (prod, dev, W, extra = '') => spawnSync('bash', ['-c', `set -euo pipefail
source "${LIB}"
psql_prod() { ${PSQL} -h "${sock}" -p ${port} -U postgres -d ${prod} -X -v ON_ERROR_STOP=1 "$@"; }
psql_dev()  { ${PSQL} -h "${sock}" -p ${port} -U postgres -d ${dev} -X -v ON_ERROR_STOP=1 "$@"; }
${extra}
seed_copy_data "${W}"`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
function makeDbs() {
  const k = ++n, prod = `prod${k}`, dev = `dev${k}`;
  for (const d of [prod, dev]) assert.equal(psql('postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${d};`).status, 0);
  assert.equal(psql(prod, ['-v', 'ON_ERROR_STOP=1'], PROD_SCHEMA).status, 0);
  assert.equal(psql(dev, ['-v', 'ON_ERROR_STOP=1'], DEV_SCHEMA + `INSERT INTO properties (id, slug, title_en, status, workflow_status, market_status, map_embed_url) VALUES ('${U(99)}', 'old-dev-row', 'old', 'active', 'active', 'available', 'https://old.invalid/preexisting');`).status, 0);
  return { prod, dev };
}
const q = (db, sql) => psql(db, ['-At', '-F', '|', '-c', sql]).stdout.trim();
const dump = (db) => ['parties', 'contacts', 'properties'].map((t) => psql(db, ['-At', '-c', `SELECT to_jsonb(t)::text FROM ${t} t`]).stdout).join('\n');

test('a seeded dev database contains no secret, location, account, phone, post link, unpublished row or internal field from production', opts, () => {
  const { prod, dev } = makeDbs(); const W = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
  const r = run(prod, dev, W);
  assert.equal(r.status, 0, r.stderr);
  const all = dump(dev);
  for (const s of SECRETS) assert.ok(!all.includes(s), `leaked into dev: ${s}`);
  for (const f of ['parties.csv', 'contacts.csv', 'properties.csv']) { const t = fs.readFileSync(path.join(W, f), 'utf8'); for (const s of SECRETS) assert.ok(!t.includes(s), `${f} contains ${s}`); }
});

test('location, account and third-party link columns exist in dev but are empty for every copied row; the old dev row is gone', opts, () => {
  const { prod, dev } = makeDbs(); const W = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
  assert.equal(run(prod, dev, W).status, 0);
  assert.equal(q(dev, `SELECT count(*) FROM properties WHERE map_embed_url IS NOT NULL OR latitude IS NOT NULL OR longitude IS NOT NULL OR owner_id IS NOT NULL OR notes IS NOT NULL OR download_url IS NOT NULL OR video_url IS NOT NULL OR video_embed_url IS NOT NULL OR facebook_video_url IS NOT NULL OR nearby_places IS NOT NULL OR neighborhood_description IS NOT NULL OR neighborhood_insight_en IS NOT NULL OR price_previous IS NOT NULL`), '0');
  assert.equal(q(dev, `SELECT count(*) FROM properties WHERE view_count <> 0 OR views_week <> 0`), '0'.length ? '0' : '0');
  assert.equal(q(dev, `SELECT count(*) FROM parties WHERE auth_user_id IS NOT NULL OR email IS NOT NULL OR created_by IS NOT NULL`), '0');
  assert.equal(q(dev, `SELECT count(*) FROM contacts WHERE created_by IS NOT NULL`), '0');
  assert.equal(q(dev, `SELECT count(*) FROM properties WHERE slug = 'old-dev-row'`), '0');
});

test('only published listings are copied (no draft, no soft-deleted), with the data the UI needs', opts, () => {
  const { prod, dev } = makeDbs(); const W = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
  assert.equal(run(prod, dev, W).status, 0);
  assert.equal(q(dev, `SELECT string_agg(slug, ',' ORDER BY slug) FROM properties`), 'published-one,published-two');
  assert.equal(q(dev, `SELECT price_amount || price_currency || price_frequency FROM properties WHERE slug='published-one'`), '350USDmonth');
  assert.equal(q(dev, `SELECT district_en || '/' || village_en || '/' || bedrooms FROM properties WHERE slug='published-one'`), 'Chanthabury/Village One/2');
  assert.equal(q(dev, `SELECT images::text FROM properties WHERE slug='published-one'`), '["https://img.invalid/1.jpg"]');
  assert.equal(q(dev, `SELECT count(*) FROM parties`), '2');
});

test('map links typed inside free text are replaced, the rest of the text survives', opts, () => {
  const { prod, dev } = makeDbs(); const W = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
  assert.equal(run(prod, dev, W).status, 0);
  const d = q(dev, `SELECT description_en FROM properties WHERE slug='published-one'`);
  assert.match(d, /^Nice flat\. Map: \[map link removed\] and \[map link removed\] too$/);
  assert.equal(q(dev, `SELECT description_en FROM properties WHERE slug='published-two'`), 'Plain text');
});

test('phone numbers and names are placeholders; only contacts used by a published listing are copied', opts, () => {
  const { prod, dev } = makeDbs(); const W = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
  assert.equal(run(prod, dev, W).status, 0);
  assert.equal(q(dev, `SELECT string_agg(DISTINCT phone || '/' || coalesce(whatsapp,''), ',') FROM contacts`), '0000000000/0000000000');
  assert.equal(q(dev, `SELECT string_agg(name, ',' ORDER BY name) FROM contacts`), 'Agent (dev),Owner (dev)');
  assert.equal(q(dev, `SELECT string_agg(DISTINCT phone || '/' || whatsapp, ',') FROM parties`), '0000000000/0000000000');
  assert.equal(q(dev, `SELECT count(*) FROM contacts`), '2');
});

test('columns outside the allowlist are reported by NAME only, never copied and never printed with data', opts, () => {
  const { prod, dev } = makeDbs(); const W = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
  const r = run(prod, dev, W);
  assert.match(r.stderr, /properties: copying \d+ columns; NOT copied[^\n]*map_embed_url/);
  assert.match(r.stderr, /brand_new_internal_column/);
  assert.match(r.stderr, /parties: copying[^\n]*auth_user_id/);
  for (const s of SECRETS) assert.ok(!(r.stdout + r.stderr).includes(s), `printed: ${s}`);
});

test('the leak guard aborts, before touching dev, if a forbidden column is added to an allowlist', opts, () => {
  const { prod, dev } = makeDbs(); const W = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
  const r = run(prod, dev, W, 'SEED_PROPERTIES_COPY="$SEED_PROPERTIES_COPY map_embed_url"');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REFUSING: 'map_embed_url' is on the never-copy list/);
  assert.equal(q(dev, `SELECT count(*) FROM properties WHERE slug='old-dev-row'`), '1');   // nothing was truncated
  for (const col of ['auth_user_id', 'email', 'owner_id', 'latitude']) {
    const rr = run(prod, dev, fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-')), `SEED_PARTIES_COPY="$SEED_PARTIES_COPY ${col}"; SEED_PROPERTIES_COPY="$SEED_PROPERTIES_COPY ${col}"`);
    assert.notEqual(rr.status, 0, col);
  }
});

test('the file guard aborts, before touching dev, if a map link or coordinate pair survives into an export', opts, () => {
  const { prod, dev } = makeDbs(); const W = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
  psql(prod, [], `UPDATE properties SET district_en = 'see https://maps.app.goo.gl/SYN-MAPLINK-9' WHERE slug = 'published-two';`);   // a column the redaction does not cover
  const r = run(prod, dev, W);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REFUSING: properties\.csv still contains 1 line\(s\) with a map link/);
  assert.ok(!r.stderr.includes('SYN-MAPLINK-9'), 'the match itself is never printed');
  assert.equal(q(dev, `SELECT count(*) FROM properties WHERE slug='old-dev-row'`), '1');
  psql(prod, [], `UPDATE properties SET district_en = 'at 18.12345, 102.12345 roughly' WHERE slug = 'published-two';`);
  const r2 = run(prod, dev, fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-')));
  assert.notEqual(r2.status, 0); assert.match(r2.stderr, /look like a coordinate pair/);
});

test('the main script keeps its project-ref safety gate, delegates the copy to the tested library and no longer copies SELECT *', () => {
  assert.match(MAIN, /source "\$\(dirname "\$0"\)\/seed-dev-lib\.sh"/);
  assert.match(MAIN, /seed_copy_data "\$WORKDIR"/);
  assert.match(MAIN, /REFUSING: PINTAG_DEV_DB_URL contains the PRODUCTION project ref/);
  assert.match(MAIN, /REFUSING: PINTAG_DEV_DB_URL does not contain the known pintag-dev project ref/);
  assert.doesNotMatch(MAIN.replace(/^\s*#.*$/gm, ''), /SELECT \* FROM (parties|contacts|properties)|CREATE TEMP TABLE _seed/);
  const lib = fs.readFileSync(LIB, 'utf8').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(lib, /SELECT \*/);
  assert.doesNotMatch(lib, /\b(UPDATE|DELETE|INSERT)\b[^\n]*\bFROM\s+(parties|contacts|properties)\b[^\n]*psql_prod/);
});
