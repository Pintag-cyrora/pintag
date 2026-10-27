// scripts/diagnostics/orphan-originals/10-registry-activation-boundary.sql + `run.sh registry` + .github/workflows/gallery-registry-boundary.yml:
// the unregistered originals (the integrity check's "orphaned originals") against the registry activation instant 2026-08-18 13:32:37 UTC: which evidence puts an
// object in a gallery before / on-or-after it (Gallery Recovery records, editor events, linked snapshots; browser clocks only with a one-day margin; null,
// missing and malformed sides never read as presence or removal), September/October uploads, registry row history, trigger status, malformed galleries.
// SYNTHETIC data only. Run with: node --test gallery-registry-boundary.test.js   (CI=true: a missing PostgreSQL install is a FAILURE, not a skip)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D_ = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'gallery-registry-boundary.yml');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const SECRET_URL = 'postgres://backup_ro:S3cr3tPassw0rd@db.example.invalid:5432/postgres';
const IDENT = /SYN-OBJ|SYN-IMG|0000-8888|0000-9999|ops@example|other@example|ext\.example|S3cr3tPassw0rd/i;

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
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL: the registry-boundary tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pgpe-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  assert.equal(asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']).status, 0);
  assert.equal(asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']).status, 0);
  psqlRaw('postgres', [], 'CREATE ROLE rb_ro LOGIN BYPASSRLS;');
});
after(() => {
  if (!dir) return;
  asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

const L = (n) => `00000000-0000-0000-8888-${String(n).padStart(12, '0')}`;   // planted listing ids
const EV = (n) => `00000000-0000-0000-9999-${String(n).padStart(12, '0')}`;  // planted event ids
const U = (rel) => `https://x.supabase.co/storage/v1/object/public/property-images/${rel}`;
const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
const J = (v) => `${q(JSON.stringify(v))}::jsonb`;
const SCHEMA = `
CREATE SCHEMA storage;
CREATE TABLE storage.objects (bucket_id text, name text, created_at timestamptz, metadata jsonb);
CREATE TABLE public.properties (id uuid PRIMARY KEY, title text, images jsonb, deleted_at timestamptz);
CREATE TABLE public.unit_types (images text[]); CREATE TABLE public.parties (photo_url text);
CREATE TABLE public.property_images (id uuid DEFAULT gen_random_uuid(), property_id uuid, storage_path text, status text, sha256 text, created_at timestamptz DEFAULT now());
CREATE TABLE public.gallery_assignments (id uuid DEFAULT gen_random_uuid(), op text, listing_id uuid, cluster_id text, photo_paths jsonb, confidence text, operator text, created_at timestamptz);
CREATE TABLE public.listing_image_snapshots (id uuid DEFAULT gen_random_uuid(), listing_id uuid, provenance_event_id uuid, storage_url text, storage_path text, created_at timestamptz);
CREATE TABLE public.import_records (id uuid DEFAULT gen_random_uuid(), listing_id uuid, raw_payload jsonb, imported_at timestamptz);
CREATE TABLE public.import_images (id uuid DEFAULT gen_random_uuid(), import_id uuid, listing_id uuid, storage_url text, storage_path text, uploaded_at timestamptz);
CREATE TABLE public.properties_row_snapshots (id uuid, property_id uuid, op text, row_data jsonb, created_at timestamptz);
CREATE TABLE public.listing_provenance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_id uuid, event_type text NOT NULL, field_name text, old_value jsonb, new_value jsonb, source text, actor text, created_at timestamptz NOT NULL DEFAULT now());
`;
const obj = (name) => `INSERT INTO storage.objects VALUES ('property-images', ${q(name)}, now(), '{"size": 1000}');`;
const listing = (n) => `INSERT INTO properties VALUES ('${L(n)}', 'SYN-TITLE-${n}', '[]', NULL);`;
const assign = (n, names, ts = '2026-08-06 10:00', operator = 'ops@example.com') => `INSERT INTO gallery_assignments (op, listing_id, photo_paths, operator, created_at) VALUES ('assign', '${L(n)}', ${J(names)}, ${operator == null ? 'NULL' : q(operator)}, ${q(ts)});`;
// a snapshot state (what the editor saved): names -> rows, anchored to an event id (or to nothing)
const state = (n, ev, names, ts) => names.map((nm) => `INSERT INTO listing_image_snapshots (listing_id, provenance_event_id, storage_path, storage_url, created_at) VALUES ('${L(n)}', ${ev == null ? 'NULL' : q(EV(ev))}, ${q(nm.split('/').pop())}, ${q(U(nm))}, ${q(ts)});`).join('\n');
const event = (id, n, oldL, newL, ts, actor = 'ops@example.com', type = 'photos_changed') =>
  `INSERT INTO listing_provenance (id, listing_id, event_type, field_name, old_value, new_value, source, actor, created_at) VALUES ('${EV(id)}', '${L(n)}', ${q(type)}, 'images', ${oldL === undefined ? 'NULL' : J(oldL)}, ${newL === undefined ? 'NULL' : J(newL)}, 'manual', ${actor == null ? 'NULL' : q(actor)}, ${q(ts)});`;
const urls = (...rels) => rels.map(U);

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const BMS = Date.parse('2026-08-18T13:32:37Z');                  // the activation instant used by the query
const H = 3600000, D = 24 * H;
const T = (ms) => new Date(BMS + ms).toISOString();
const pad = (n) => String(n).padStart(2, '0');
const X = 'SYN-IMG-x.jpg';
const objc = (name, created) => `INSERT INTO storage.objects VALUES ('property-images', ${q(name)}, ${created == null ? 'NULL' : q(created)}, '{"size": 1000}');`;
const rec = (n, op, names, ts) => `INSERT INTO gallery_assignments (op, listing_id, photo_paths, operator, created_at) VALUES (${q(op)}, '${L(n)}', ${J(names)}, 'ops@example.com', ${q(ts)});`;
const regrow = (prop, path, status, ts) => `INSERT INTO property_images (property_id, storage_path, status, created_at) VALUES ('${prop}', ${q(path)}, ${q(status)}, ${q(ts)});`;
const REG = (n) => `00000000-0000-0000-7777-${String(n).padStart(12, '0')}`;   // registry-only property ids
const TRG_FN = `
CREATE FUNCTION public.pintag_sync_property_images(p_property uuid, p_images jsonb) RETURNS void LANGUAGE plpgsql AS $f$ BEGIN NULL; END $f$;
CREATE FUNCTION public.pintag_property_images_trg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $f$ BEGIN
  BEGIN PERFORM pintag_sync_property_images(NEW.id, NEW.images); EXCEPTION WHEN OTHERS THEN RAISE WARNING 'sync failed'; END; RETURN NEW; END $f$;`;
const TRG = 'CREATE TRIGGER trg_property_images_sync AFTER INSERT OR UPDATE OF images ON public.properties FOR EACH ROW EXECUTE FUNCTION public.pintag_property_images_trg();';

// n -> { name, created, sql (evidence only), bucket, src }. Every object has its own listing n. Bucket numbers are the query's section-3 buckets.
const S = {};
const add = (n, o) => { S[n] = { name: `SYN-OBJ-${pad(n)}.jpg`, created: '2026-08-10T00:00:00Z', ...o }; };
const nm = (n) => S[n].name;
// exact (server-time) evidence ON/AFTER the boundary: bucket 1, with the source of the latest evidence
add(1, { bucket: 1, src: 'Gallery Recovery assign record', sql: () => rec(1, 'assign', [nm(1)], T(0)) });                                      // exactly AT the boundary counts as on/after
add(2, { bucket: 6, sql: () => rec(2, 'assign', [nm(2)], T(-1000)) });                                                                        // one second BEFORE: no later state
add(3, { bucket: 1, src: 'Gallery Recovery assign record', sql: () => rec(3, 'assign', [nm(3)], T(1000)) });
add(4, { bucket: 1, src: 'recorded snapshot state not linked to a photos_changed event', sql: () => state(4, null, [nm(4), X], T(H)) });
add(5, { bucket: 1, src: 'before-list of a saved editor edit (save confirmed by a linked snapshot)', sql: () => `${event(51, 5, urls(nm(5), X), urls(X), T(2 * H))}\n${state(5, 51, [X], T(2 * H))}` });
add(6, { bucket: 1, src: 'recorded snapshot state of a saved editor edit (linked to a photos_changed event)', sql: () => `${event(61, 6, urls(X), urls(nm(6), X), T(3 * H))}\n${state(6, 61, [nm(6), X], T(3 * H))}` });
// before the boundary: removal bounded / undecidable
add(7, { bucket: 4, sql: () => `${rec(7, 'assign', [nm(7)], T(-10 * D))}\n${state(7, null, [X], T(-5 * D))}` });                               // first later recorded state (without it) is BEFORE the boundary
add(8, { bucket: 5, sql: () => `${rec(8, 'assign', [nm(8)], T(-10 * D))}\n${state(8, null, [X], T(D))}` });                                   // first later recorded state is AFTER the boundary
add(9, { bucket: 6, sql: () => rec(9, 'assign', [nm(9)], T(-10 * D)) });
// browser-clock evidence (editor before-list, no linked snapshot): one-day margin on each side
add(10, { bucket: 2, sql: () => event(101, 10, urls(nm(10), X), urls(X), T(3 * D)) });
add(11, { bucket: 3, sql: () => event(111, 11, urls(nm(11), X), urls(X), T(12 * H)) });
add(12, { bucket: 3, sql: () => event(121, 12, urls(nm(12), X), urls(X), T(-12 * H)) });
add(13, { bucket: 7, sql: () => event(131, 13, urls(nm(13), X), urls(X), T(-3 * D)) });
add(14, { bucket: 3, sql: () => event(141, 14, urls(nm(14), X), urls(X), T(D)) });                                                              // exactly +1 day: still inside the margin
add(15, { bucket: 2, sql: () => event(151, 15, urls(nm(15), X), urls(X), T(D + 1000)) });
add(16, { bucket: 3, sql: () => event(161, 16, urls(nm(16), X), urls(X), T(-D)) });                                                             // exactly -1 day
add(17, { bucket: 7, sql: () => event(171, 17, urls(nm(17), X), urls(X), T(-D - 1000)) });
// circumstantial only
add(18, { bucket: 8, sql: () => rec(18, 'unassign', [nm(18)], T(D)) });
add(19, { bucket: 8, sql: () => event(191, 19, undefined, urls(nm(19)), T(2 * D)) });                                                           // missing before side + unconfirmed after-list
add(20, { bucket: 8, sql: () => `INSERT INTO import_images (listing_id, storage_path, storage_url) VALUES ('${L(20)}', ${q(nm(20))}, ${q(U(nm(20)))});` });
add(21, { bucket: 9, sql: () => '' });
// missing / malformed sides never read as presence or removal
add(22, { bucket: 5, sql: () => `${rec(22, 'assign', [nm(22)], T(-10 * D))}\n${event(221, 22, undefined, urls(X), T(D))}\n${state(22, 221, [X], T(D))}` });   // old_value NULL + later state without it: undecidable, not "removed before"
add(23, { bucket: 9, sql: () => event(231, 23, `a string that mentions ${nm(23)}`, 'x', T(5 * D)) });                                          // a JSON string is not parsed
add(24, { bucket: 2, sql: () => `${rec(24, 'assign', [nm(24)], T(-10 * D))}\n${event(241, 24, urls(nm(24), X), urls(X), T(5 * D))}` });        // exact before + browser-clock evidence a few days after: the later one wins
// exact matching
add(25, { name: 'SYN-OBJ-dir/n 25.jpg', bucket: 1, src: 'Gallery Recovery assign record', sql: () => rec(25, 'assign', [U('SYN-OBJ-dir/n%2025.jpg?v=2')], T(D)) });   // nested + percent-encoded + query string
add(26, { bucket: 9, sql: () => rec(26, 'assign', ['other/SYN-OBJ-26.jpg', 'SYN-OBJ-26.jpg.bak', 'xSYN-OBJ-26.jpg'], T(D)) });                   // look-alikes are not this object
add(27, { name: 'SYN-OBJ-27 sp.jpg', bucket: 9, sql: () => regrow(L(27), 'SYN-OBJ-27%20sp.jpg', 'active', T(D)) });                            // registry row under another spelling
add(28, { bucket: 6, sql: () => `${rec(28, 'assign', [nm(28)], T(-10 * D))}\n${event(281, 28, [], urls(X), T(D))}` });                          // an EMPTY before-list is not a removal and not presence
// a saved edit BEFORE the boundary whose own recorded state (same instant) already lacks the object: removed before activation
add(39, { bucket: 4, sql: () => `${event(391, 39, urls(nm(39), X), urls(X), T(-5 * D))}\n${state(39, 391, [X], T(-5 * D))}` });
// September / October uploads, and uploads on/after the boundary
add(31, { created: '2026-09-15T08:00:00Z', bucket: 1, src: 'Gallery Recovery assign record', sql: () => rec(31, 'assign', [nm(31)], '2026-09-20T08:00:00Z') });
add(32, { created: '2026-10-02T08:00:00Z', bucket: 2, sql: () => event(321, 32, urls(nm(32), X), urls(X), '2026-10-05T08:00:00Z') });
add(33, { created: '2026-09-20T08:00:00Z', bucket: 8, sql: () => rec(33, 'unassign', [nm(33)], '2026-09-21T08:00:00Z') });
add(34, { created: '2026-10-10T08:00:00Z', bucket: 9, sql: () => '' });
add(35, { created: '2026-09-25T08:00:00Z', bucket: 1, src: 'Gallery Recovery assign record', sql: () => rec(35, 'assign', [nm(35)], '2026-09-01T08:00:00Z') });   // evidence dated BEFORE the object's own upload
add(36, { created: '2026-08-20T08:00:00Z', bucket: 9, sql: () => '' });
add(37, { created: '2026-08-10T08:00:00Z', bucket: 9, sql: () => '' });
add(38, { created: null, bucket: 9, sql: () => '' });
const POP = Object.keys(S).map(Number);                                // 36 objects in the population
const listingRow = (n, images = "'[]'", deleted = 'NULL') => `INSERT INTO properties VALUES ('${L(n)}', 'SYN-TITLE-${n}', ${images}, ${deleted});`;
const scenario = (n) => `${listingRow(n)}\n${objc(S[n].name, S[n].created)}\n${S[n].sql()}`;
const EXCLUDED = `
${listingRow(29, `${J(urls('SYN-OBJ-29.jpg'))}`)}
${objc('SYN-OBJ-29.jpg', '2026-08-10T00:00:00Z')}
${rec(29, 'assign', ['SYN-OBJ-29.jpg'], T(D))}
${listingRow(30)}
${objc('SYN-OBJ-30.jpg', '2026-08-10T00:00:00Z')}
${rec(30, 'assign', ['SYN-OBJ-30.jpg'], T(D))}
${regrow(L(30), 'SYN-OBJ-30.jpg', 'removed', T(D))}
`;
const REGISTRY = `
${regrow(REG(1), 'reg-a', 'active', T(-D))}
${regrow(REG(2), 'reg-b', 'active', T(200))}
${regrow(REG(2), 'reg-c', 'removed', T(200))}
${regrow(REG(3), 'reg-d', 'active', T(2 * D))}
${regrow(REG(3), 'reg-e', 'removed', T(3 * D))}
${regrow(REG(4), 'reg-f', 'active', T(0))}
`;   // reg-f is created EXACTLY at the boundary: on/after, not before
const GALLERIES = `
INSERT INTO properties VALUES ('${L(901)}', 't', NULL, NULL);
INSERT INTO properties VALUES ('${L(902)}', 't', 'null'::jsonb, NULL);
INSERT INTO properties VALUES ('${L(903)}', 't', '"just a string"'::jsonb, NULL);
INSERT INTO properties VALUES ('${L(904)}', 't', '{"a": 1}'::jsonb, NULL);
INSERT INTO properties VALUES ('${L(905)}', 't', '5'::jsonb, NULL);
INSERT INTO properties VALUES ('${L(906)}', 't', 'true'::jsonb, NULL);
INSERT INTO properties VALUES ('${L(907)}', 't', '[null]'::jsonb, NULL);
INSERT INTO properties VALUES ('${L(908)}', 't', '[""]'::jsonb, NULL);
INSERT INTO properties VALUES ('${L(909)}', 't', ${J(urls(X))}, '2026-09-01 00:00+00');
INSERT INTO properties VALUES ('${L(910)}', 't', NULL, '2026-09-01 00:00+00');
`;
const DATA9 = `${POP.map(scenario).join('\n')}\n${EXCLUDED}\n${REGISTRY}\n${GALLERIES}\n${TRG_FN}\n${TRG}`;
function makeDb(data = DATA9, extra = '') {
  const db = `p${++counter}`;
  assert.equal(psqlRaw('postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${db};`).status, 0);
  const s = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1'], SCHEMA + data + extra + 'GRANT USAGE ON SCHEMA public, storage TO rb_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public, storage TO rb_ro;');
  assert.equal(s.status, 0, s.stderr);
  return db;
}
function run(db, file, { readOnly = true } = {}) {
  const r = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-v', 'ON_ERROR_STOP=1', ...(readOnly ? ['-c', 'BEGIN READ ONLY'] : []), '-f', path.join(D_, file), ...(readOnly ? ['-c', 'ROLLBACK'] : [])]);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [section, label, n, listings] = l.split(' | '); return { section, label, n, listings }; });
  const get = (prefix) => Object.fromEntries(rows.filter((x) => x.section.startsWith(prefix)).map((x) => [x.label, `${x.n}/${x.listings}`]));
  return { rows, get, text: r.stdout };
}
const reg = (db, o) => run(db, '10-registry-activation-boundary.sql', o);
const BUCKETS = {
  1: '1 direct, server time: in a gallery ON/AFTER activation (a registry row is expected if the sync worked)',
  2: '2 direct, browser clock: in a gallery MORE THAN A DAY after activation (approximate; a row is expected if the sync worked)',
  3: '3 direct, browser clock: in a gallery within a day of activation (cannot be placed before or after)',
  4: '4 REMOVED BEFORE activation: a recorded gallery state before it already excludes the object (no row possible)',
  5: '5 last in a gallery before activation; first recorded state without it is on/after activation (removal date undecidable)',
  6: '6 last in a gallery before activation; no later recorded gallery state (removal date undecidable)',
  7: '7 direct, browser clock only: in a gallery more than a day before activation (removal date unknown)',
  8: '8 circumstantial evidence only (unassign record, unconfirmed after-list or import row): no proof it was ever in a gallery',
  9: '9 no evidence of any kind' };
const SRC = ['Gallery Recovery assign record', 'recorded snapshot state of a saved editor edit (linked to a photos_changed event)', 'recorded snapshot state not linked to a photos_changed event',
  'before-list of a saved editor edit (save confirmed by a linked snapshot)'];
const cnt = (arr) => arr.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m; }, {});

test('population and guard: the stage-2 population (37 here), nothing referenced, nothing with a registry row of the same spelling; boundary shown', opts, () => {
  const h = reg(makeDb());
  assert.deepEqual(h.get('0'), { 'transaction_read_only=on': '/' });
  assert.deepEqual(h.get('1 '), { '': '37/' });
  const d = psqlRaw(makeDb(), ['-A', '-t', '-F', ' | ', '-c', 'BEGIN READ ONLY', '-f', path.join(D_, '2-diagnostic.sql'), '-c', 'ROLLBACK']);
  assert.equal(Number(d.stdout.split('\n').find((l) => /TOTAL/.test(l)).split(' | ').pop()), 37, 'stage 2 counts the same set');
  assert.deepEqual(h.get('2 '), { '2026-08-18 13:32:37 UTC': '/' });
});

test('every object lands in exactly ONE bucket, the buckets add up to the population, and each bucket holds exactly the planted objects', opts, () => {
  const h = reg(makeDb());
  const got = h.get('3 ');
  const want = cnt(POP.map((n) => BUCKETS[S[n].bucket]));
  for (const [label, k] of Object.entries(want)) assert.equal(got[label].split('/')[0], String(k), label);
  assert.equal(got['total of the buckets (must equal section 1)'], '37/');
  assert.equal(Object.keys(got).length, Object.keys(want).length + 1, 'no bucket that was not planted');
});

// the aggregate could hide a swap between two scenarios: every scenario also runs ALONE and must land in its own bucket
for (const n of POP) {
  test(`ISOLATED object ${n}: bucket ${S[n].bucket}${S[n].src ? ' (' + S[n].src + ')' : ''}`, opts, () => {
    const h = reg(makeDb(scenario(n), ''));
    assert.deepEqual(h.get('1 '), { '': '1/' });
    const got = h.get('3 ');
    delete got['total of the buckets (must equal section 1)'];
    assert.deepEqual(Object.keys(got), [BUCKETS[S[n].bucket]]);
    const src = h.get('4 ');
    if (S[n].bucket === 1) assert.deepEqual(Object.keys(src), [S[n].src]); else assert.deepEqual(src, {});
  });
}

test('bucket 1 by source: Gallery Recovery records, snapshot states of saved edits, other snapshots and saved before-lists are kept apart', opts, () => {
  assert.deepEqual(reg(makeDb()).get('4 '), {
    'Gallery Recovery assign record': '5/5',                                                                   // objects 1, 3, 25, 31, 35
    'recorded snapshot state of a saved editor edit (linked to a photos_changed event)': '1/1',              // 6
    'recorded snapshot state not linked to a photos_changed event': '1/1',                                    // 4
    'before-list of a saved editor edit (save confirmed by a linked snapshot)': '1/1' });                    // 5
});

test('each source on its own: dated before / on-or-after the boundary (server time exact, browser clock with a one-day margin), circumstantial ones labelled', opts, () => {
  const g = reg(makeDb()).get('5 ');
  assert.equal(g['direct: Gallery Recovery assign record: latest on/after the boundary'].split('/')[0], '5');
  assert.equal(g['direct: Gallery Recovery assign record: latest before the boundary'].split('/')[0], '7');   // 2, 7, 8, 9, 22, 24, 28
  assert.equal(g['direct: other snapshot state: latest on/after the boundary'].split('/')[0], '1');
  assert.equal(g['direct: snapshot state of a saved editor edit: latest on/after the boundary'].split('/')[0], '1');
  assert.equal(g['direct: editor before-list, save confirmed: latest on/after the boundary'].split('/')[0], '1');
  assert.equal(g['direct, browser clock: editor before-list, save not confirmed: latest more than a day AFTER'].split('/')[0], '4');   // 10, 15, 24, 32
  assert.equal(g['direct, browser clock: editor before-list, save not confirmed: latest within a day of the boundary'].split('/')[0], '4');   // 11, 12, 14, 16
  assert.equal(g['direct, browser clock: editor before-list, save not confirmed: latest more than a day BEFORE'].split('/')[0], '2');   // 13, 17
  assert.equal(g['circumstantial: Gallery Recovery unassign record: latest on/after the boundary'].split('/')[0], '2');
  assert.equal(g['circumstantial, browser clock: editor after-list, save not confirmed: latest more than a day AFTER'].split('/')[0], '1');
  assert.equal(g['circumstantial: import_images row (not dated): no time used'].split('/')[0], '1');
  assert.ok(!Object.keys(g).some((k) => /registry/.test(k)), 'registry rows are not evidence of gallery membership');
});

test('September/October uploads (storage created_at, stage 2 month rule): direct and circumstantial evidence kept apart; evidence older than the upload flagged', opts, () => {
  const g = reg(makeDb()).get('6 ');
  assert.equal(g['all such objects (stage 2 reported 129 on 2026-10-24)'].split('/')[0], '5');                   // 31, 32, 33, 34, 35
  assert.equal(g['strongest evidence: direct, server time'].split('/')[0], '2');                                // 31, 35
  assert.equal(g['strongest evidence: direct, browser clock only'].split('/')[0], '1');                         // 32
  assert.equal(g['strongest evidence: circumstantial only'].split('/')[0], '1');                                // 33
  assert.equal(g['strongest evidence: none'].split('/')[0], '1');                                               // 34
  assert.equal(g['bucket ' + BUCKETS[1]].split('/')[0], '2');
  assert.equal(g['bucket ' + BUCKETS[2]].split('/')[0], '1');
  assert.equal(g['bucket ' + BUCKETS[8]].split('/')[0], '1');
  assert.equal(g['bucket ' + BUCKETS[9]].split('/')[0], '1');
  assert.equal(g["server-time evidence dated BEFORE the object's own upload time (inconsistent: clock or re-upload)"].split('/')[0], '1');   // 35
  const p = reg(makeDb()).get('7 ');
  assert.equal(p['all such objects'].split('/')[0], '6');                                                         // 31-36
  assert.equal(p['strongest evidence: none'].split('/')[0], '2');                                                 // 34, 36
  assert.equal(p['objects with no upload time recorded'].split('/')[0], '1');                                     // 38
});

test('registry history: first / last row time, rows by status, rows before the boundary, the backfill burst and the trigger period', opts, () => {
  const g = reg(makeDb()).get('8 ');
  assert.equal(g.rows, '8/6');
  assert.ok('earliest row created_at 2026-08-17 13:32:37 UTC' in g);
  assert.ok('latest row created_at 2026-08-21 13:32:37 UTC' in g);
  assert.equal(g['status active'].split('/')[0], '5'); assert.equal(g['status removed'].split('/')[0], '3');
  assert.equal(g['rows created BEFORE the activation instant (expected 0)'].split('/')[0], '1');
  assert.equal(g['rows created within 1 minute AFTER the activation instant (the one-time backfill)'].split('/')[0], '3');
  assert.equal(g['rows created more than 1 minute after the activation instant (the trigger)'].split('/')[0], '4');
});

test('registry history on an EMPTY registry: no rows, "none" for the dates, nothing fails', opts, () => {
  const db = makeDb(POP.slice(0, 3).map(scenario).join('\n'), '');
  const g = reg(db).get('8 ');
  assert.equal(g.rows, '0/0'); assert.ok('earliest row created_at none' in g && 'latest row created_at none' in g);
});

const FULL = { 'exists (any table)': 1, 'attached to public.properties': 1, 'enabled: fires in ordinary sessions (origin)': 1, disabled: 0, 'enabled for replica sessions only': 0, 'enabled always': 0,
  'AFTER ... FOR EACH ROW': 1, 'fires on INSERT': 1, 'fires on UPDATE': 1, 'fires on DELETE (not expected)': 0, 'fires on TRUNCATE (not expected)': 0, 'UPDATE restricted to the images column': 1,
  'runs function pintag_property_images_trg': 1, 'function is SECURITY DEFINER': 1, 'function source calls pintag_sync_property_images': 1, 'function source swallows errors (EXCEPTION WHEN OTHERS)': 1,
  'OTHER triggers that run pintag_property_images_trg (any name)': 0, 'function pintag_sync_property_images exists': 1 };
const trigger = (extra, data = DATA9.replace(TRG, '')) => Object.fromEntries(Object.entries(reg(makeDb(data, extra)).get('9 ')).map(([k, v]) => [k, Number(v.split('/')[0])]));
test('trigger status: the expected trigger is reported as present, enabled, AFTER INSERT OR UPDATE OF images ... FOR EACH ROW on public.properties, calling the sync with an error handler', opts, () => {
  assert.deepEqual(trigger(TRG), FULL);
});
const VARIANTS = [
  ['missing entirely (functions only)', '', { 'exists (any table)': 0, 'attached to public.properties': 0, 'enabled: fires in ordinary sessions (origin)': 0, 'AFTER ... FOR EACH ROW': 0, 'fires on INSERT': 0, 'fires on UPDATE': 0, 'UPDATE restricted to the images column': 0, 'runs function pintag_property_images_trg': 0, 'function is SECURITY DEFINER': 0, 'function source calls pintag_sync_property_images': 0, 'function source swallows errors (EXCEPTION WHEN OTHERS)': 0 }],
  ['disabled', `${TRG}\nALTER TABLE public.properties DISABLE TRIGGER trg_property_images_sync;`, { 'enabled: fires in ordinary sessions (origin)': 0, disabled: 1 }],
  ['enabled for replica sessions only', `${TRG}\nALTER TABLE public.properties ENABLE REPLICA TRIGGER trg_property_images_sync;`, { 'enabled: fires in ordinary sessions (origin)': 0, 'enabled for replica sessions only': 1 }],
  ['enabled always', `${TRG}\nALTER TABLE public.properties ENABLE ALWAYS TRIGGER trg_property_images_sync;`, { 'enabled: fires in ordinary sessions (origin)': 0, 'enabled always': 1 }],
  ['UPDATE of any column (not restricted to images)', 'CREATE TRIGGER trg_property_images_sync AFTER INSERT OR UPDATE ON public.properties FOR EACH ROW EXECUTE FUNCTION public.pintag_property_images_trg();', { 'UPDATE restricted to the images column': 0 }],
  ['BEFORE instead of AFTER', 'CREATE TRIGGER trg_property_images_sync BEFORE INSERT OR UPDATE OF images ON public.properties FOR EACH ROW EXECUTE FUNCTION public.pintag_property_images_trg();', { 'AFTER ... FOR EACH ROW': 0 }],
  ['INSERT only (no UPDATE)', 'CREATE TRIGGER trg_property_images_sync AFTER INSERT ON public.properties FOR EACH ROW EXECUTE FUNCTION public.pintag_property_images_trg();', { 'fires on UPDATE': 0, 'UPDATE restricted to the images column': 0 }],
  ['UPDATE of a different column', 'CREATE TRIGGER trg_property_images_sync AFTER INSERT OR UPDATE OF title ON public.properties FOR EACH ROW EXECUTE FUNCTION public.pintag_property_images_trg();', { 'UPDATE restricted to the images column': 0 }],
  ['also fires on DELETE and TRUNCATE', 'CREATE TRIGGER trg_property_images_sync AFTER INSERT OR UPDATE OF images OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION public.pintag_property_images_trg();', { 'fires on DELETE (not expected)': 1 }],
  ['attached to ANOTHER table', 'CREATE TABLE public.properties_copy (id uuid, images jsonb);\nCREATE TRIGGER trg_property_images_sync AFTER INSERT OR UPDATE OF images ON public.properties_copy FOR EACH ROW EXECUTE FUNCTION public.pintag_property_images_trg();', { 'attached to public.properties': 0, 'UPDATE restricted to the images column': 1 }],
  ['runs a DIFFERENT function', 'CREATE FUNCTION public.other_trg() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;\nCREATE TRIGGER trg_property_images_sync AFTER INSERT OR UPDATE OF images ON public.properties FOR EACH ROW EXECUTE FUNCTION public.other_trg();',
    { 'runs function pintag_property_images_trg': 0, 'function is SECURITY DEFINER': 0, 'function source calls pintag_sync_property_images': 0, 'function source swallows errors (EXCEPTION WHEN OTHERS)': 0 }],
  ['a second trigger under another name runs the same function', `${TRG}\nCREATE TRIGGER trg_other_name AFTER UPDATE OF images ON public.properties FOR EACH ROW EXECUTE FUNCTION public.pintag_property_images_trg();`, { 'OTHER triggers that run pintag_property_images_trg (any name)': 1 }],
];
for (const [label, extra, delta] of VARIANTS) {
  test(`trigger status: ${label}`, opts, () => {
    const got = trigger(extra);
    const want = { ...FULL, ...delta };
    // a trigger that is not there reports zeros for every attribute
    if (/missing entirely/.test(label)) for (const k of Object.keys(FULL)) if (k !== 'function pintag_sync_property_images exists') want[k] = 0;
    assert.deepEqual(got, want);
  });
}

test('malformed galleries: SQL NULL and JSON null counted separately from string / object / number / boolean; empty vs non-empty arrays; entries that are not non-empty strings; soft-deleted apart', opts, () => {
  const g = reg(makeDb()).get('10 ');
  const n = (k) => Number(g[k].split('/')[0]);
  assert.equal(n('SQL NULL; listing not soft-deleted'), 1);
  assert.equal(n('JSON null; listing not soft-deleted'), 1);
  assert.equal(n('string; listing not soft-deleted'), 1);
  assert.equal(n('object; listing not soft-deleted'), 1);
  assert.equal(n('number; listing not soft-deleted'), 1);
  assert.equal(n('boolean; listing not soft-deleted'), 1);
  assert.equal(n('array, empty; listing not soft-deleted'), 38);       // the 37 scenario listings plus L30; L29 holds a non-empty gallery
  assert.equal(n('array, non-empty; listing not soft-deleted'), 3);    // L29, [null], [""]
  assert.equal(n('array, non-empty; listing soft-deleted'), 1);
  assert.equal(n('SQL NULL; listing soft-deleted'), 1);
  assert.equal(n('array with an entry that is not a non-empty string'), 2);
});

test('spelling: an unreferenced object whose registry row exists only under another (percent-encoded) spelling is counted, and is not evidence of gallery membership', opts, () => {
  assert.equal(reg(makeDb()).rows.find((r) => /^11 /.test(r.section)).n.replace(/ \|$/, ''), '1');
  assert.equal(reg(makeDb(scenario(27), '')).get('3 ')[BUCKETS[9]].split('/')[0], '1');
});

test('READ ONLY guard: outside a READ ONLY transaction every count is zero and the guard row says so; nothing is changed', opts, () => {
  const db = makeDb();
  const off = reg(db, { readOnly: false });
  assert.deepEqual(off.get('0'), { 'transaction_read_only=off': '/' });
  assert.deepEqual(off.get('1 '), { '': '0/' });
  assert.equal(off.get('3 ')['total of the buckets (must equal section 1)'], '0/');
  assert.equal(off.get('8 ').rows, '0/0');
  assert.deepEqual(Object.values(off.get('9 ')).filter((v) => v !== '0/'), []);
  assert.deepEqual(off.get('10 '), { 'array with an entry that is not a non-empty string': '0/0' });
  const count = () => psqlRaw(db, ['-A', '-t'], 'SELECT (SELECT count(*) FROM listing_provenance)||(SELECT count(*) FROM listing_image_snapshots)||(SELECT count(*) FROM gallery_assignments)||(SELECT count(*) FROM properties)||(SELECT count(*) FROM property_images)||(SELECT count(*) FROM import_images);').stdout;
  const before = count(); reg(db);
  assert.equal(count(), before);
  assert.notEqual(psqlRaw(db, ['-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY', '-c', 'DELETE FROM property_images']).status, 0);
});

test('aggregates only: no object name, image list, listing id, event id, record id, actor or title is ever printed', opts, () => {
  const h = reg(makeDb());
  assert.doesNotMatch(h.text, IDENT);
  assert.doesNotMatch(h.text, /SYN-TITLE|reg-[a-f]|@/);
});

test('the query selects no title, payload, actor value or id (output columns are section / label / n / listings), reads no table outside the existing evidence sources, and parses no JSON string', () => {
  const sql = fs.readFileSync(path.join(D_, '10-registry-activation-boundary.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.match(sql, /SELECT section, label, n, listings FROM \(/);
  assert.doesNotMatch(sql, /raw_payload|title|phone|email|row_data|\bactor\b|::jsonb\s*\)?\s*FROM\s+\(?\s*SELECT.*#>>/);
  const tables = new Set([...sql.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.|storage\.)?([a-z_]+)/gi)].map((m) => m[1].toLowerCase()));
  const allowed = ['properties', 'unit_types', 'parties', 'property_images', 'gallery_assignments', 'listing_image_snapshots', 'listing_provenance', 'import_images', 'objects', 'pg_trigger', 'pg_class', 'pg_namespace', 'pg_proc', 'pg_attribute',
    'obj_all', 'live_raw', 'live_forms', 'orph', 'evt', 'lk', 'stt', 'ent0', 'ent', 'mt', 'mxa', 'apx', 'circ', 'regm', 'rem', 'ob', 'cb', 'grp', 'trg', 'trgc', 'gal', 'bnd', 'lateral', 'q', 'regexp_matches', 'trg', 'jsonb_array_elements_text', 'jsonb_path_query', 'jsonb_array_elements', 'unnest', 'listing_provenance', 'x', 'm', 'u', 'g', 't', 'p', 'e', 'c', 'n', 'o', 'a', 's', 'r', 'i', 'd', 'v', 'st', 'pi', 'so'];
  for (const t of tables) assert.ok(allowed.includes(t), `unexpected relation ${t}`);
  assert.ok(!/to_jsonb\([a-z_.]+\)\s*->>\s*'(old_value|new_value|images)'/.test(sql));
});

// ── run.sh registry against a fake psql ──
const ALIGNED = (n = 553, tot = n) => ` 0 session guard (must be on) | transaction_read_only=on |     | \n 1 unreferenced originals (must equal the stage-2 total) |  | ${String(n).padStart(3)} | \n 3 unregistered originals: strongest evidence ... (exclusive; the buckets add up to section 1) | total of the buckets (must equal section 1) | ${String(tot).padStart(3)} | \n`;
const PASS_ALL = 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\nVERDICT | provenance-schema | PASS\nVERDICT | registry-schema | PASS\n';
function runFake({ preflight, diag = ' 1 TOTAL | 189 MB | 553\n', out10, env = {}, failOn, stale = false, mode = 'registry' } = {}) {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pr10-'));
  const work = path.join(dir2, 'work'); fs.mkdirSync(work); fs.mkdirSync(path.join(dir2, 'bin'));
  for (const f of fs.readdirSync(D_)) if (fs.statSync(path.join(D_, f)).isFile()) fs.copyFileSync(path.join(D_, f), path.join(work, f));
  if (stale) for (const f of ['registry-boundary.txt', 'diagnostic.txt']) fs.writeFileSync(path.join(work, f), 'STALE\n');
  fs.writeFileSync(path.join(dir2, 'pre.out'), preflight ?? PASS_ALL);
  fs.writeFileSync(path.join(dir2, 'diag.out'), diag);
  fs.writeFileSync(path.join(dir2, 'o10.out'), out10 ?? ALIGNED());
  const log = path.join(dir2, 'psql.log');
  fs.writeFileSync(path.join(dir2, 'bin', 'psql'), `#!/bin/bash
echo "CALL $*" >> "${log}"
case "$*" in
  *${failOn || 'NEVER-MATCHES'}*) echo "ERROR:  invalid input: \\"SYN-OBJ-leak.jpg\\" listing ${L(1)} ops@example.com" >&2; echo "ERROR:  22P02" >&2; echo "SYN-IMG-stdout-leak"; exit 3;;
  *1-preflight.sql*) cat "${dir2}/pre.out";; *2-diagnostic.sql*) cat "${dir2}/diag.out";; *10-registry-activation-boundary.sql*|*8-gallery-provenance-photos-changed.sql*) cat "${dir2}/o10.out";;
esac
`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(work, 'run.sh'), mode], { env: { PATH: `${path.join(dir2, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir2, PINTAG_PROD_DB_URL: SECRET_URL, ...env }, encoding: 'utf8', input: '' });
  const files = {};
  for (const f of fs.readdirSync(work)) if (/\.(txt|md|csv)$/.test(f)) files[f] = fs.readFileSync(path.join(work, f), 'utf8');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('CALL ').filter(Boolean) : [];
  return { r, out: r.stdout + r.stderr, files, calls };
}

test('registry mode: lint, preflight, stage-2 cross-check, then ONLY stage 10; every call READ ONLY; population and bucket total must equal stage 2', () => {
  const { r, out, files, calls } = runFake();
  assert.equal(r.status, 0, out);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /1-preflight\.sql/); assert.match(calls[1], /2-diagnostic\.sql/); assert.match(calls[2], /10-registry-activation-boundary\.sql/);
  for (const c of calls) assert.match(c, /BEGIN READ ONLY.*\.sql.*ROLLBACK/);
  assert.match(calls[2], /VERBOSITY=sqlstate/);
  assert.match(out, /lint ok: 10-registry-activation-boundary\.sql/);
  assert.match(out, /=== stage 10: unregistered originals vs the registry activation instant, registry history and trigger status, for the 553 objects/);
  assert.match(files['registry-boundary.txt'], /unreferenced originals/);
  assert.doesNotMatch(out + Object.values(files).join(''), /S3cr3tPassw0rd/);
});

test('registry mode: a rebuilt population different from the stage-2 total is DISCARDED (job fails, no result file)', () => {
  for (const out10 of [ALIGNED(551), ALIGNED(554), ' 0 guard | transaction_read_only=off |  | \n 1 unreferenced originals (must equal the stage-2 total) |  |   0 | \n', ' no population row at all\n']) {
    const { r, out, files } = runFake({ out10, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, /Stage 10 rebuilt a population of '[0-9?]*' objects but stage 2 counted 553 - the result was discarded/);
    assert.ok(!('registry-boundary.txt' in files));
  }
});

test('registry mode: evidence buckets that do not add up to the population (or no total row) are DISCARDED', () => {
  for (const out10 of [ALIGNED(553, 552), ALIGNED(553, 554), ` 1 unreferenced originals (must equal the stage-2 total) |  | 553 | \n`]) {
    const { r, out, files } = runFake({ out10, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, /Stage 10 evidence buckets add up to '[0-9?]*' but the population is 553 - the result was discarded/);
    assert.ok(!('registry-boundary.txt' in files));
  }
});

for (const v of ['registry-schema', 'provenance-schema', 'history-schema', 'gallery-schema', 'reconcile-schema']) {
  test(`registry mode stops before stage 10 on ${v} FAIL or missing: job fails visibly, no result file`, () => {
    for (const preflight of [PASS_ALL.replace(`${v} | PASS`, `${v} | FAIL`), PASS_ALL.replace(`VERDICT | ${v} | PASS\n`, '')]) {
      const { r, out, files, calls } = runFake({ preflight, stale: true });
      assert.equal(r.status, 1, out);
      assert.match(out, new RegExp(`${v.toUpperCase()} VERDICT DID NOT PASS`));
      assert.ok(!calls.some((c) => /10-registry/.test(c)));
      assert.ok(!('registry-boundary.txt' in files));
    }
  });
}

for (const [label, preflight] of [['a role+session FAIL', PASS_ALL.replace('role+session | PASS', 'role+session | FAIL')], ['a WARN row', `role | rolbypassrls | WARN false\n${PASS_ALL}`], ['a schema FAIL', PASS_ALL.replace('schema | PASS', 'schema | FAIL')]]) {
  test(`registry mode keeps the preflight gates: ${label} stops everything before any data stage`, () => {
    const { r, calls } = runFake({ preflight });
    assert.equal(r.status, 1);
    assert.equal(calls.length, 1);
  });
}

test('registry mode: expected_objects must match the stage-2 total (or be numeric); a different count stops before stage 10', () => {
  assert.equal(runFake({ env: { EXPECTED_OBJECTS: '553' } }).r.status, 0);
  const bad = runFake({ env: { EXPECTED_OBJECTS: '551' } });
  assert.equal(bad.r.status, 1);
  assert.match(bad.out, /Stage 2 counted 553 objects but expected_objects is 551 - stage 10 NOT run/);
  assert.equal(bad.calls.length, 2);
  const nn = runFake({ env: { EXPECTED_OBJECTS: '1;DROP' } });
  assert.equal(nn.r.status, 1);
  assert.match(nn.out, /expected_objects must be a number/);
});

for (const failOn of ['2-diagnostic.sql', '10-registry-activation-boundary.sql']) {
  test(`registry mode: psql failure in ${failOn} withholds the error text (SQLSTATE only); no identifier, no partial result`, () => {
    const { r, out, files } = runFake({ failOn, stale: true });
    assert.notEqual(r.status, 0);
    assert.match(out, /psql failed \(exit 3\); its error text is withheld/);
    assert.doesNotMatch(out, /SYN-IMG|SYN-OBJ|0000-8888|ops@example/);
    assert.ok(!('registry-boundary.txt' in files));
    for (const t of Object.values(files)) assert.doesNotMatch(t, /SYN-IMG|SYN-OBJ|ops@example/);
  });
}

test('the other modes never run stage 10, and `registry` is a known mode', () => {
  for (const mode of ['diagnostic', 'gallery', 'probe', 'history', 'provenance']) assert.ok(!runFake({ mode }).calls.some((c) => /10-registry/.test(c)), mode);
  assert.equal(spawnSync('bash', [path.join(D_, 'run.sh'), 'bogus'], { encoding: 'utf8' }).status, 2);
});

// ── end to end on real Postgres with a read-only role ──
test('end to end (real Postgres, read-only role): `run.sh registry` passes every gate incl. registry-schema, rebuilds the stage-2 population, prints aggregates only', opts, () => {
  const db = makeDb(DATA9, 'ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS updated_at timestamptz;');
  const work = fs.mkdtempSync(path.join(dir, 'e2e-'));
  for (const f of fs.readdirSync(D_)) if (fs.statSync(path.join(D_, f)).isFile()) fs.copyFileSync(path.join(D_, f), path.join(work, f));
  const r = spawnSync('bash', [path.join(work, 'run.sh'), 'registry'], { encoding: 'utf8', input: '',
    env: { PATH: `${PGBIN}${path.delimiter}${process.env.PATH}`, HOME: dir, EXPECTED_OBJECTS: '37', PINTAG_PROD_DB_URL: `postgresql://rb_ro@/${db}?host=${sock}&port=${port}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const v of ['schema', 'role+session', 'reconcile-schema', 'gallery-schema', 'history-schema', 'provenance-schema', 'registry-schema']) assert.ok(r.stdout.includes(`VERDICT | ${v} | PASS`), v);
  assert.match(r.stdout, /transaction_read_only=on/);
  assert.match(r.stdout, /1 unreferenced originals[^\n]*\|\s+37 \|/);
  assert.match(r.stdout, /total of the buckets \(must equal section 1\)[^\n]*\|\s+37 \|/);
  assert.match(r.stdout, /earliest row created_at 2026-08-17 13:32:37 UTC/);
  assert.doesNotMatch(r.stdout + r.stderr, IDENT);
  assert.doesNotMatch(fs.readFileSync(path.join(work, 'registry-boundary.txt'), 'utf8'), IDENT);
});

test('registry-schema preflight: a missing registry column or wrong type fails ONLY the registry-schema verdict, and the other verdicts are unchanged', opts, () => {
  const pre = (extra) => {
    const db = makeDb(DATA9, extra);
    const r = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-c', 'BEGIN READ ONLY', '-f', path.join(D_, '1-preflight.sql'), '-c', 'ROLLBACK']);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const ok = pre('');
  assert.match(ok, /VERDICT \| registry-schema \| PASS/);
  const bad = pre('ALTER TABLE public.property_images ALTER COLUMN created_at TYPE timestamp without time zone;');
  assert.match(bad, /public\.property_images\.created_at \| WRONG_TYPE/);
  assert.match(bad, /VERDICT \| registry-schema \| FAIL/);
  for (const v of ['schema', 'reconcile-schema', 'gallery-schema', 'history-schema', 'provenance-schema']) assert.match(bad, new RegExp(`VERDICT \\| ${v} \\| PASS`), v);
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
  assert.ok(withSecret.some((s) => /bash scripts\/diagnostics\/orphan-originals\/run\.sh registry\n/.test(s)));
  assert.equal((code.match(/run\.sh/g) || []).length, 1);
  assert.ok(!/\$\{\{ *inputs\./.test(code.replace(/EXPECTED_OBJECTS: \$\{\{ inputs\.expected_objects \}\}/, '')), 'the input only reaches the runner through env');
  assert.ok(!/\b(git (push|commit|tag)|gh (api|pr|release)|curl|wget|rclone)\b/.test(code));
  assert.ok(!/^\s*psql\b/m.test(code));
});

test('workflow: the log and job summary come only from preflight.txt, diagnostic.txt and registry-boundary.txt; no other workflow is touched by this change', () => {
  const pub = steps.find((s) => /Publish results/.test(s));
  assert.match(pub, /registry-boundary\.txt/);
  assert.ok(!/provenance-events|gallery-listing|reconcile-objects|gallery-state|history-vs-gallery|\.csv/.test(pub));
});

test('repository hygiene: the result file is ignored and not tracked', () => {
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'scripts/diagnostics/orphan-originals/registry-boundary.txt'], { cwd: ROOT }).status, 0);
  assert.ok(!spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').some((f) => /registry-boundary\.txt$/.test(f)));
});
