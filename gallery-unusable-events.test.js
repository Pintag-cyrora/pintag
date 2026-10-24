// scripts/diagnostics/orphan-originals/9-unusable-provenance-events.sql + `run.sh unusable` + .github/workflows/gallery-provenance-unusable.yml:
// why did stage 8 call some Gallery Recovery 'assign' objects "unusable" (events in the window, none with a before AND an after list), and do the other
// existing records (linked snapshot, delete snapshots, Gallery Recovery / import records, other change-log events, the current gallery) say anything about
// THOSE objects only? SYNTHETIC data only. Pins: the jsonb type of each stored side, what each existing side says about the image (exact matching),
// direct vs circumstantial evidence kept apart, scope = exactly stage 8's unusable set, READ ONLY guard, aggregates-only privacy, runner gates, workflow.
// Run with: node --test gallery-unusable-events.test.js   (CI=true: a missing PostgreSQL install is a FAILURE, not a skip)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'gallery-provenance-unusable.yml');
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
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL: the unusable-events tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pgpe-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  assert.equal(asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']).status, 0);
  assert.equal(asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']).status, 0);
  psqlRaw('postgres', [], 'CREATE ROLE ue_ro LOGIN BYPASSRLS;');
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
CREATE TABLE public.property_images (storage_path text, status text, sha256 text);
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

// A scenario = one listing n with ONE assign record (2026-08-06 10:00) for ONE object, the object's events, and a first later state that EXCLUDES the image.
const S0 = '2026-08-06 10:00';
const NOT_LINKED = 'event has no linked snapshot (save not confirmed, or the saved gallery was empty)';
const X = 'SYN-IMG-x.jpg';
const later = (n) => state(n, null, [X], '2026-08-12 09:00');
const base = (n, name = `SYN-OBJ-${n}.jpg`) => `${listing(n)}\n${obj(name)}\n${assign(n, [name])}`;
const SCEN = {
  // S1 SQL NULL before, a list WITHOUT the image after, the event's own saved snapshot is the first later state
  1: { sql: `${base(1)}\n${event(1, 1, undefined, urls(X), '2026-08-10 11:00')}\n${state(1, 1, [X], '2026-08-10 11:00:05')}`,
       shapes: { 'before=SQL NULL, after=list': '1/1' }, cls: { 'after-list LACKS the image, before-list is not a list: whether it was there before is unknown': '1/1' },
       linked: { 'linked snapshot LACKS the image; it IS the first later gallery state': '1/1' } },
  // S2 JSON null before, a list that HAS the image after (the edit left it in the gallery), no linked snapshot
  2: { sql: `${base(2)}\n${event(2, 2, null, urls('SYN-OBJ-2.jpg', X), '2026-08-08 10:00')}\n${later(2)}`,
       shapes: { 'before=JSON null, after=list': '1/1' }, cls: { 'after-list HAS the image, before-list is not a list: this edit left the image in the gallery': '1/1' }, linked: { [NOT_LINKED]: '1/1' } },
  // S3 before-list HAS the image, after is a JSON string
  3: { sql: `${base(3)}\n${event(3, 3, urls('SYN-OBJ-3.jpg', X), 'a string', '2026-08-08 10:00')}\n${later(3)}`,
       shapes: { 'before=list, after=string': '1/1' }, cls: { 'before-list HAS the image, after-list is not a list: a removal cannot be shown (the after-list is missing)': '1/1' }, linked: { [NOT_LINKED]: '1/1' } },
  // S4 before-list LACKS the image, after is an object
  4: { sql: `${base(4)}\n${event(4, 4, urls(X), { k: 1 }, '2026-08-08 10:00')}\n${later(4)}`,
       shapes: { 'before=list, after=object': '1/1' }, cls: { 'before-list LACKS the image, after-list is not a list: this edit did not remove it': '1/1' }, linked: { [NOT_LINKED]: '1/1' } },
  // S5 neither side is a list
  5: { sql: `${base(5)}\n${event(5, 5, 'x', 'y', '2026-08-08 10:00')}\n${later(5)}`,
       shapes: { 'before=string, after=string': '1/1' }, cls: { 'neither side is a list: no membership evidence from this edit': '1/1' }, linked: { [NOT_LINKED]: '1/1' } },
  // S7 string before, EMPTY list after: the after-list exists and lacks the image
  7: { sql: `${base(7)}\n${event(7, 7, 'old', [], '2026-08-08 10:00')}\n${later(7)}`,
       shapes: { 'before=string, after=empty list': '1/1' }, cls: { 'after-list LACKS the image, before-list is not a list: whether it was there before is unknown': '1/1' }, linked: { [NOT_LINKED]: '1/1' } },
  // S8 exact match through a nested, percent-encoded URL with a query string
  8: { sql: `${base(8, 'SYN-OBJ-dir/my file.jpg')}\n${event(8, 8, [U('SYN-OBJ-dir/my%20file.jpg?v=2'), X], 'str', '2026-08-08 10:00')}\n${later(8)}`,
       shapes: { 'before=list, after=string': '1/1' }, cls: { 'before-list HAS the image, after-list is not a list: a removal cannot be shown (the after-list is missing)': '1/1' }, linked: { [NOT_LINKED]: '1/1' } },
  // S9 look-alikes only (longer name, prefixed name, same basename in another directory): NOT this image
  9: { sql: `${base(9)}\n${event(9, 9, urls('SYN-OBJ-9.jpg.bak', 'xSYN-OBJ-9.jpg', 'other/SYN-OBJ-9.jpg'), 'str', '2026-08-08 10:00')}\n${later(9)}`,
       shapes: { 'before=list, after=string': '1/1' }, cls: { 'before-list LACKS the image, after-list is not a list: this edit did not remove it': '1/1' }, linked: { [NOT_LINKED]: '1/1' } },
};
// S6 two events pointing opposite ways (one removal-leaning, one "left it in the gallery")
const S6 = `${base(6)}\n${event(61, 6, urls('SYN-OBJ-6.jpg', X), 'str', '2026-08-08 10:00')}\n${event(62, 6, null, urls('SYN-OBJ-6.jpg', X), '2026-08-09 10:00')}\n${later(6)}`;
// controls that stage 8 does NOT call unusable: they must never show up in stage 9
const CONTROLS = `${base(10)}\n${event(101, 10, urls('SYN-OBJ-10.jpg', X), urls(X), '2026-08-10 11:00')}\n${state(10, 101, [X], '2026-08-10 11:00:05')}
${base(11)}\n${later(11)}`;
// context records on the unusable listings (circumstantial / state evidence)
const CONTEXT = `
INSERT INTO gallery_assignments (op, listing_id, photo_paths, operator, created_at) VALUES ('assign', '${L(1)}', ${J(['SYN-IMG-q.jpg'])}, 'ops@example.com', '2026-08-01 10:00');
INSERT INTO gallery_assignments (op, listing_id, photo_paths, operator, created_at) VALUES ('unassign', '${L(1)}', ${J(['SYN-IMG-q.jpg'])}, 'ops@example.com', '2026-08-07 10:00');
INSERT INTO gallery_assignments (op, listing_id, photo_paths, operator, created_at) VALUES ('assign', '${L(1)}', ${J(['SYN-IMG-q.jpg'])}, 'ops@example.com', '2026-08-20 10:00');
INSERT INTO import_records (listing_id, raw_payload, imported_at) VALUES ('${L(1)}', '{"secret": "SYN-PAYLOAD"}', '2026-08-01 09:00');
INSERT INTO import_records (listing_id, raw_payload, imported_at) VALUES ('${L(1)}', '{"secret": "SYN-PAYLOAD"}', '2026-08-08 09:00');
INSERT INTO import_records (listing_id, raw_payload, imported_at) VALUES ('${L(1)}', '{"secret": "SYN-PAYLOAD"}', '2026-09-01 09:00');
${event(121, 1, urls(X), urls(X), '2026-08-07 09:00', 'ops@example.com', 'field_changed')}
${event(122, 1, undefined, undefined, '2026-09-02 09:00', 'ops@example.com', 'listing_deleted')}
${event(123, 1, undefined, undefined, '2026-08-01 08:00', 'ops@example.com', 'zzz_custom_SYN-OBJ-secret')}
INSERT INTO properties_row_snapshots VALUES (gen_random_uuid(), '${L(2)}', 'soft_delete', ${J({ images: urls('SYN-OBJ-2.jpg', X) })}, '2026-08-09 10:00');
INSERT INTO properties_row_snapshots VALUES (gen_random_uuid(), '${L(3)}', 'soft_delete', ${J({ images: urls(X) })}, '2026-09-01 10:00');
INSERT INTO properties_row_snapshots VALUES (gen_random_uuid(), '${L(5)}', 'hard_delete', ${J({ images: 'not a list' })}, '2026-08-09 10:00');
UPDATE properties SET deleted_at = '2026-09-01 10:00' WHERE id = '${L(3)}';
UPDATE properties SET images = ${J(urls(X, 'SYN-IMG-y.jpg', 'SYN-IMG-z.jpg'))} WHERE id = '${L(4)}';
`;
const DATA9 = `${[1, 2, 3, 4, 5, 7, 8, 9].map((n) => SCEN[n].sql).join('\n')}\n${S6}\n${CONTROLS}\n${CONTEXT}`;
function makeDb9(data = DATA9, extra = '') {
  const db = `p${++counter}`;
  assert.equal(psqlRaw('postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${db};`).status, 0);
  const s = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1'], SCHEMA + data + extra + 'GRANT USAGE ON SCHEMA public, storage TO ue_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public, storage TO ue_ro;');
  assert.equal(s.status, 0, s.stderr);
  return db;
}
function run(db, file, { readOnly = true } = {}) {
  const r = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-v', 'ON_ERROR_STOP=1', ...(readOnly ? ['-c', 'BEGIN READ ONLY'] : []), '-f', path.join(D, file), ...(readOnly ? ['-c', 'ROLLBACK'] : [])]);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [section, label, n, listings] = l.split(' | '); return { section, label, n, listings }; });
  const get = (prefix) => Object.fromEntries(rows.filter((x) => x.section.startsWith(prefix)).map((x) => [x.label, `${x.n}/${x.listings}`]));
  return { rows, get, text: r.stdout };
}
const un = (db, o) => run(db, '9-unusable-provenance-events.sql', o);
const prov = (db, o) => run(db, '8-gallery-provenance-photos-changed.sql', o);

test('scope: exactly the objects stage 8 calls unusable, nothing else is counted or described', opts, () => {
  const db = makeDb9();
  const h = un(db);
  assert.deepEqual(h.get('0'), { 'transaction_read_only=on': '/' });
  assert.deepEqual(h.get('1 '), { '': '11/' });   // 9 unusable + 2 controls: the population still equals the stage-2 total
  assert.deepEqual(h.get('2 '), { objects: '9/9' });
  assert.equal(prov(db).get('4 ').unusable, '9/9', 'stage 8 and stage 9 agree on the unusable set');
  assert.equal(prov(db).get('4 ').direct_confirmed, '1/1', 'the control is analysed by stage 8 ...');
  // ... and never by stage 9: nothing below mentions it (the control listings 10 and 11 hold the only both-list event and the only no-event object)
  assert.deepEqual(h.get('3 '), { all: '10/9', 'with a linked saved snapshot (save confirmed)': '1/1', 'with BOTH lists (must be 0: stage 8 would not call them unusable)': '0/0' });
  assert.deepEqual(h.get('10 ')['photos_changed with BOTH lists, any time'], '0/0');
});

test('why unusable: the jsonb type of each stored side (SQL NULL, JSON null, string, object, empty list, list) with event counts', opts, () => {
  assert.deepEqual(un(makeDb9()).get('4 '), {
    'before=SQL NULL, after=list': '1/1',            // S1
    'before=JSON null, after=list': '2/2',           // S2, S6 (second event)
    'before=list, after=string': '4/4',              // S3, S6 (first event), S8, S9
    'before=list, after=object': '1/1',              // S4
    'before=string, after=string': '1/1',            // S5
    'before=string, after=empty list': '1/1' });     // S7
});

test('what the edit says about THIS image: per object, from the lists that exist (direct), conflicts kept visible', opts, () => {
  assert.deepEqual(un(makeDb9()).get('5 '), {
    'before-list HAS the image, after-list is not a list: a removal cannot be shown (the after-list is missing)': '2/2',   // S3, S8 (nested + encoded + query string)
    'after-list HAS the image, before-list is not a list: this edit left the image in the gallery': '1/1',                  // S2
    'before-list LACKS the image, after-list is not a list: this edit did not remove it': '2/2',                            // S4, S9 (look-alikes only)
    'after-list LACKS the image, before-list is not a list: whether it was there before is unknown': '2/2',                 // S1, S7
    'neither side is a list: no membership evidence from this edit': '1/1',                                                 // S5
    'conflicting: one event points to a removal, another says the edit did not remove it': '1/1' });                        // S6
});

// the aggregate above could hide a swap between two scenarios: each scenario also runs ALONE and must give exactly its own label
for (const n of Object.keys(SCEN)) {
  test(`ISOLATED scenario S${n}: its own shape, its own membership label, its own linked-snapshot label, nothing else`, opts, () => {
    const h = un(makeDb9(SCEN[n].sql, ''));
    assert.deepEqual(h.get('2 '), { objects: '1/1' });
    assert.deepEqual(h.get('4 '), SCEN[n].shapes);
    assert.deepEqual(h.get('5 '), SCEN[n].cls);
    assert.deepEqual(h.get('6 '), SCEN[n].linked);
  });
}

test('linked snapshot (the gallery the editor saved) is kept apart from events without one; a linked snapshot can be the first later state', opts, () => {
  assert.deepEqual(un(makeDb9()).get('6 '), {
    'linked snapshot LACKS the image; it IS the first later gallery state': '1/1',   // S1
    [NOT_LINKED]: '9/8' });                                                         // the other nine events on eight listings (S6 has two)
});

test('delete snapshots of the listing row: a recorded gallery STATE placed against each object window (not a removal); listings without one are counted', opts, () => {
  assert.deepEqual(un(makeDb9()).get('7 '), {
    'no delete snapshot of the listing': '6/6',
    'between the record and the first later gallery state: list HAS the image': '1/1',   // S2
    'after the first later gallery state: list LACKS the image': '1/1',                  // S3
    'between the record and the first later gallery state: images is not a list': '1/1' });   // S5
});

test('Gallery Recovery records, import records and other change-log events are labelled circumstantial and only counted', opts, () => {
  const h = un(makeDb9());
  assert.match(h.rows.find((r) => /^8 /.test(r.section)).section, /circumstantial/);
  assert.match(h.rows.find((r) => /^9 /.test(r.section)).section, /circumstantial: an import record does not show an import changed this gallery/);
  assert.match(h.rows.find((r) => /^10 /.test(r.section)).section, /circumstantial/);
  assert.deepEqual(h.get('8 '), {
    'assign record at the same instant as the object\'s latest record (includes that record)': '9/9',   // each object's own record
    'assign record before the object\'s latest record': '1/1',                                          // L1 2026-08-01
    'unassign record between the latest record and the first later gallery state': '1/1',               // L1 2026-08-07
    'assign record after the first later gallery state': '1/1' });                                       // L1 2026-08-20
  assert.deepEqual(h.get('9 '), {
    'before the earliest record': '1/1', 'between the earliest record and the latest first later state': '1/1', 'after the latest first later state': '1/1' });
  const e = h.get('10 ');
  assert.equal(e['photos_changed between the earliest record and the latest first later state'], '10/9');
  assert.equal(e['field_changed between the earliest record and the latest first later state'], '1/1');
  assert.equal(e['listing_deleted after the latest first later state'], '1/1');
  assert.equal(e['other type before the earliest record'], '1/1', 'an unknown event type is bucketed, never printed');
});

test('current state of the listing: active / soft-deleted / missing and a gallery size bucket; the image is never present (probe must be 0)', opts, () => {
  const h = un(makeDb9()).get('11 ');
  assert.equal(h['listing active; gallery empty'], '7/7');
  assert.equal(h['listing soft-deleted; gallery empty'], '1/1');
  assert.equal(h['listing active; gallery 1-5 images'], '1/1');
  assert.equal(h['image present in the current gallery (must be 0: the population is defined as referenced by nothing)'], '0/0');
});

test('nothing is concluded: no cause, no "safe to delete", direct and circumstantial sections are labelled as such', opts, () => {
  const labels = un(makeDb9()).rows.map((r) => r.section + ' ' + r.label).join('\n');
  assert.doesNotMatch(labels, /caused|because|safe to|proves? the/i);
});

test('READ ONLY guard: outside a READ ONLY transaction every count is zero and the guard row says so; nothing is changed', opts, () => {
  const db = makeDb9();
  const off = un(db, { readOnly: false });
  assert.deepEqual(off.get('0'), { 'transaction_read_only=off': '/' });
  assert.deepEqual(off.get('1 '), { '': '0/' });
  assert.deepEqual(off.get('2 '), { objects: '0/0' });
  const count = () => psqlRaw(db, ['-A', '-t'], 'SELECT (SELECT count(*) FROM listing_provenance)||(SELECT count(*) FROM listing_image_snapshots)||(SELECT count(*) FROM gallery_assignments)||(SELECT count(*) FROM properties)||(SELECT count(*) FROM properties_row_snapshots)||(SELECT count(*) FROM import_records);').stdout;
  const before = count(); un(db);
  assert.equal(count(), before);
});

test('aggregates only: no object name, image list, listing id, event id, record id, actor, title, event type value or payload is ever printed', opts, () => {
  const h = un(makeDb9());
  assert.doesNotMatch(h.text, IDENT);
  assert.doesNotMatch(h.text, /SYN-TITLE|SYN-PAYLOAD|zzz_custom|payload|@/);
});

test('the query selects no title, payload, actor value or id (output columns are section / label / n / listings) and reads nothing outside the six existing tables', () => {
  const sql = fs.readFileSync(path.join(D, '9-unusable-provenance-events.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.match(sql, /SELECT section, label, n, listings FROM \(/);
  assert.doesNotMatch(sql, /raw_payload|title|phone|email|details|field_name/i);
  const from = [...sql.matchAll(/\b(?:FROM|JOIN)\s+((?:public\.)?[a-z_]+\.?[a-z_]*)/gi)].map((m) => m[1].toLowerCase()).filter((t) => /^(public\.|storage\.)?(properties|unit_types|parties|property_images|gallery_assignments|listing_image_snapshots|import_records|listing_provenance|properties_row_snapshots|objects)$/.test(t));
  const tables = new Set(from.map((t) => t.replace(/^(public|storage)\./, '')));
  for (const t of tables) assert.ok(['properties', 'unit_types', 'parties', 'property_images', 'gallery_assignments', 'listing_image_snapshots', 'import_records', 'listing_provenance', 'properties_row_snapshots', 'objects'].includes(t), t);
});

// ── run.sh unusable against a fake psql ──
const ALIGNED = (n = 553) => ` 0 session guard (must be on) | transaction_read_only=on |     | \n 1 unreferenced originals (must equal the stage-2 total) |  | ${String(n).padStart(3)} | \n 2 scope: objects | objects | 8 | 1\n`;
const PASS_ALL = 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\nVERDICT | provenance-schema | PASS\n';
function runFake({ preflight, diag = ' 1 TOTAL | 189 MB | 553\n', out9, env = {}, failOn, stale = false, mode = 'unusable' } = {}) {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pu9-'));
  const work = path.join(dir2, 'work'); fs.mkdirSync(work); fs.mkdirSync(path.join(dir2, 'bin'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  if (stale) for (const f of ['unusable-events.txt', 'diagnostic.txt']) fs.writeFileSync(path.join(work, f), 'STALE\n');
  fs.writeFileSync(path.join(dir2, 'pre.out'), preflight ?? PASS_ALL);
  fs.writeFileSync(path.join(dir2, 'diag.out'), diag);
  fs.writeFileSync(path.join(dir2, 'o9.out'), out9 ?? ALIGNED());
  const log = path.join(dir2, 'psql.log');
  fs.writeFileSync(path.join(dir2, 'bin', 'psql'), `#!/bin/bash
echo "CALL $*" >> "${log}"
case "$*" in
  *${failOn || 'NEVER-MATCHES'}*) echo "ERROR:  invalid input: \\"SYN-OBJ-leak.jpg\\" listing ${L(1)} ops@example.com" >&2; echo "ERROR:  22P02" >&2; echo "SYN-IMG-stdout-leak"; exit 3;;
  *1-preflight.sql*) cat "${dir2}/pre.out";; *2-diagnostic.sql*) cat "${dir2}/diag.out";; *9-unusable-provenance-events.sql*|*8-gallery-provenance-photos-changed.sql*) cat "${dir2}/o9.out";;
esac
`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(work, 'run.sh'), mode], { env: { PATH: `${path.join(dir2, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir2, PINTAG_PROD_DB_URL: SECRET_URL, ...env }, encoding: 'utf8', input: '' });
  const files = {};
  for (const f of fs.readdirSync(work)) if (/\.(txt|md|csv)$/.test(f)) files[f] = fs.readFileSync(path.join(work, f), 'utf8');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('CALL ').filter(Boolean) : [];
  return { r, out: r.stdout + r.stderr, files, calls };
}

test('unusable mode: lint, preflight, stage-2 cross-check, then ONLY stage 9; every call READ ONLY; the population must equal stage 2', () => {
  const { r, out, files, calls } = runFake();
  assert.equal(r.status, 0, out);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /1-preflight\.sql/); assert.match(calls[1], /2-diagnostic\.sql/); assert.match(calls[2], /9-unusable-provenance-events\.sql/);
  for (const c of calls) assert.match(c, /BEGIN READ ONLY.*\.sql.*ROLLBACK/);
  assert.match(calls[2], /VERBOSITY=sqlstate/);
  assert.match(out, /lint ok: 9-unusable-provenance-events\.sql/);
  assert.match(out, /=== stage 9: the objects stage 8 calls unusable, for the 553 objects/);
  assert.match(files['unusable-events.txt'], /unreferenced originals/);
  assert.ok(!('provenance-events.txt' in files));
  assert.doesNotMatch(out + Object.values(files).join(''), /S3cr3tPassw0rd/);
});

test('unusable mode: a rebuilt population different from the stage-2 total is DISCARDED (job fails, no result file)', () => {
  for (const out9 of [ALIGNED(551), ALIGNED(554), ' 0 guard | transaction_read_only=off |  | \n 1 unreferenced originals (must equal the stage-2 total) |  |   0 | \n', ' no population row at all\n']) {
    const { r, out, files } = runFake({ out9, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, /Stage 9 rebuilt a population of '[0-9?]*' objects but stage 2 counted 553 - the result was discarded/);
    assert.ok(!('unusable-events.txt' in files));
  }
});

for (const v of ['provenance-schema', 'history-schema', 'gallery-schema', 'reconcile-schema']) {
  test(`unusable mode stops before stage 9 on ${v} FAIL or missing: job fails visibly, no result file`, () => {
    for (const preflight of [PASS_ALL.replace(`${v} | PASS`, `${v} | FAIL`), PASS_ALL.replace(`VERDICT | ${v} | PASS\n`, '')]) {
      const { r, out, files, calls } = runFake({ preflight, stale: true });
      assert.equal(r.status, 1, out);
      assert.match(out, new RegExp(`${v.toUpperCase()} VERDICT DID NOT PASS`));
      assert.ok(!calls.some((c) => /9-unusable/.test(c)));
      assert.ok(!('unusable-events.txt' in files));
    }
  });
}

for (const [label, preflight] of [['a role+session FAIL', PASS_ALL.replace('role+session | PASS', 'role+session | FAIL')], ['a WARN row', `role | rolbypassrls | WARN false\n${PASS_ALL}`], ['a schema FAIL', PASS_ALL.replace('schema | PASS', 'schema | FAIL')]]) {
  test(`unusable mode keeps the preflight gates: ${label} stops everything before any data stage`, () => {
    const { r, calls } = runFake({ preflight });
    assert.equal(r.status, 1);
    assert.equal(calls.length, 1);
  });
}

test('unusable mode: expected_objects must match the stage-2 total (or be numeric); a different count stops before stage 9', () => {
  assert.equal(runFake({ env: { EXPECTED_OBJECTS: '553' } }).r.status, 0);
  const bad = runFake({ env: { EXPECTED_OBJECTS: '551' } });
  assert.equal(bad.r.status, 1);
  assert.match(bad.out, /Stage 2 counted 553 objects but expected_objects is 551 - stage 9 NOT run/);
  assert.equal(bad.calls.length, 2);
  const nn = runFake({ env: { EXPECTED_OBJECTS: '1;DROP' } });
  assert.equal(nn.r.status, 1);
  assert.match(nn.out, /expected_objects must be a number/);
});

for (const failOn of ['2-diagnostic.sql', '9-unusable-provenance-events.sql']) {
  test(`unusable mode: psql failure in ${failOn} withholds the error text (SQLSTATE only); no identifier, no partial result`, () => {
    const { r, out, files } = runFake({ failOn, stale: true });
    assert.notEqual(r.status, 0);
    assert.match(out, /psql failed \(exit 3\); its error text is withheld/);
    assert.doesNotMatch(out, /SYN-IMG|SYN-OBJ|0000-8888|ops@example/);
    assert.ok(!('unusable-events.txt' in files));
    for (const t of Object.values(files)) assert.doesNotMatch(t, /SYN-IMG|SYN-OBJ|ops@example/);
  });
}

test('the other modes never run stage 9; provenance mode still runs stage 8 exactly as before', () => {
  for (const mode of ['diagnostic', 'gallery', 'probe', 'history']) assert.ok(!runFake({ mode }).calls.some((c) => /9-unusable/.test(c)), mode);
  const p = runFake({ mode: 'provenance' });
  assert.equal(p.r.status, 0, p.out);
  assert.ok(p.calls.some((c) => /8-gallery-provenance/.test(c)) && !p.calls.some((c) => /9-unusable/.test(c)));
  assert.match(p.out, /=== stage 8: gallery 'assign' images vs the editor's photos_changed events, for the 553 objects/);
  assert.ok('provenance-events.txt' in p.files && !('unusable-events.txt' in p.files));
});

// ── end to end on real Postgres with a read-only role ──
test('end to end (real Postgres, read-only role): `run.sh unusable` passes every gate, rebuilds the stage-2 population, prints aggregates only', opts, () => {
  const db = makeDb9(DATA9, `ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS updated_at timestamptz;`);
  const work = fs.mkdtempSync(path.join(dir, 'e2e-'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  const r = spawnSync('bash', [path.join(work, 'run.sh'), 'unusable'], { encoding: 'utf8', input: '',
    env: { PATH: `${PGBIN}${path.delimiter}${process.env.PATH}`, HOME: dir, EXPECTED_OBJECTS: '11', PINTAG_PROD_DB_URL: `postgresql://ue_ro@/${db}?host=${sock}&port=${port}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const v of ['schema', 'role+session', 'reconcile-schema', 'gallery-schema', 'history-schema', 'provenance-schema']) assert.ok(r.stdout.includes(`VERDICT | ${v} | PASS`), v);
  assert.match(r.stdout, /transaction_read_only=on/);
  assert.match(r.stdout, /1 unreferenced originals[^\n]*\|\s+11 \|/);
  assert.match(r.stdout, /before=SQL NULL, after=list/);
  assert.doesNotMatch(r.stdout + r.stderr, IDENT);
  assert.doesNotMatch(r.stdout + r.stderr, /SYN-PAYLOAD|zzz_custom/);
  assert.doesNotMatch(fs.readFileSync(path.join(work, 'unusable-events.txt'), 'utf8'), IDENT);
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
  assert.ok(withSecret.some((s) => /bash scripts\/diagnostics\/orphan-originals\/run\.sh unusable\n/.test(s)));
  assert.equal((code.match(/run\.sh/g) || []).length, 1);
  assert.ok(!/\$\{\{ *inputs\./.test(code.replace(/EXPECTED_OBJECTS: \$\{\{ inputs\.expected_objects \}\}/, '')), 'the input only reaches the runner through env');
  assert.ok(!/\b(git (push|commit|tag)|gh (api|pr|release)|curl|wget|rclone)\b/.test(code));
  assert.ok(!/^\s*psql\b/m.test(code));
});

test('workflow: the log and job summary come only from preflight.txt, diagnostic.txt and unusable-events.txt', () => {
  const pub = steps.find((s) => /Publish results/.test(s));
  assert.match(pub, /unusable-events\.txt/);
  assert.ok(!/provenance-events|gallery-listing|reconcile-objects|gallery-state|history-vs-gallery|\.csv/.test(pub));
});

test('repository hygiene: the result file is ignored and not tracked', () => {
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'scripts/diagnostics/orphan-originals/unusable-events.txt'], { cwd: ROOT }).status, 0);
  assert.ok(!spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').some((f) => /unusable-events\.txt$/.test(f)));
});
