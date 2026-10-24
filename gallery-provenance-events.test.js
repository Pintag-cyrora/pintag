// scripts/diagnostics/orphan-originals/8-gallery-provenance-photos-changed.sql + `run.sh provenance` + .github/workflows/gallery-provenance-events.yml:
// can the admin editor's photos_changed events (the gallery BEFORE and AFTER each edit) explain the Gallery Recovery 'assign' images that are missing
// from their listings' galleries? SYNTHETIC data only. Pins: direct before/after evidence vs events that only fall in the time window, save confirmation by
// a linked snapshot, ambiguity, chronology (server time for confirmed events, browser time +/- 1 day for unconfirmed ones), exact matching (nested paths,
// percent-encoding, near-miss names, external URLs), actor reporting without values, the same bounded population as 7-gallery-history-vs-snapshots.sql,
// READ ONLY guard, aggregates-only privacy, failure handling and the workflow invariants (manual, read-only, NO artifact).
// Run with: node --test gallery-provenance-events.test.js   (CI=true: a missing PostgreSQL install is a FAILURE, not a skip)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'gallery-provenance-events.yml');
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
  if (skip) { if (process.env.CI) assert.fail('CI runner has no PostgreSQL: the provenance-events tests must run in CI'); return; }
  dir = fs.mkdtempSync('/tmp/pgpe-');
  if (IS_ROOT) { spawnSync('chown', ['-R', 'postgres', dir]); fs.chmodSync(dir, 0o755); }
  sock = path.join(dir, 's'); fs.mkdirSync(sock);
  if (IS_ROOT) spawnSync('chown', ['postgres', sock]);
  port = 20000 + Math.floor(Math.random() * 20000);
  assert.equal(asPg(path.join(PGBIN, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C']).status, 0);
  assert.equal(asPg(path.join(PGBIN, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'log'), '-o', `-p ${port} -k ${sock} -c listen_addresses= -c fsync=off`, 'start']).status, 0);
  psqlRaw('postgres', [], 'CREATE ROLE pe_ro LOGIN BYPASSRLS;');
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

// Every listing has ONE assign record (2026-08-06 10:00) for ONE object, and a first later state that EXCLUDES the image ("bounded").
const DATA = `
${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => listing(n)).join('\n')}
${['SYN-OBJ-1.jpg', 'SYN-OBJ-2.jpg', 'SYN-OBJ-3.jpg', 'SYN-OBJ-4.jpg', 'SYN-OBJ-5.jpg', 'SYN-OBJ-6.jpg', 'SYN-OBJ-7.jpg', 'SYN-OBJ-8.jpg', 'SYN-OBJ-9.jpg', 'SYN-OBJ-10.jpg', 'SYN-OBJ-11.jpg',
   'SYN-OBJ-dir/my file.jpg', 'SYN-OBJ-flat.jpg', 'SYN-OBJ-14.jpg', 'SYN-OBJ-15.jpg'].map(obj).join('\n')}
${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => assign(n, [`SYN-OBJ-${n}.jpg`])).join('\n')}
${assign(12, ['SYN-OBJ-dir/my file.jpg'])} ${assign(13, ['SYN-OBJ-flat.jpg'])} ${assign(14, ['SYN-OBJ-14.jpg'])} ${assign(15, ['SYN-OBJ-15.jpg'])}
-- L1 direct_confirmed: the removing event's own saved snapshot IS the first later state; actor equals the Gallery Recovery operator (case/space ignored)
${event(1, 1, urls('SYN-IMG-x.jpg', 'SYN-OBJ-1.jpg', 'SYN-IMG-y.jpg'), urls('SYN-IMG-x.jpg', 'SYN-IMG-y.jpg'), '2026-08-10 11:00', ' Ops@Example.com ')}
${state(1, 1, ['SYN-IMG-x.jpg', 'SYN-IMG-y.jpg'], '2026-08-10 11:00:05')}
-- L2 direct_unconfirmed: removing event 2 days+ after the record but NO snapshot linked to it; the first later state (another save) is 3 days later; a different actor
${event(2, 2, urls('SYN-OBJ-2.jpg', 'SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg'), '2026-08-09 08:00', 'other@example.com')}
${state(2, null, ['SYN-IMG-x.jpg'], '2026-08-12 09:00')}
-- L3 already_absent: the event's before-list already lacks the image (this edit did not remove it)
${event(3, 3, urls('SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg', 'SYN-IMG-z.jpg'), '2026-08-08 10:00')}
${state(3, 3, ['SYN-IMG-x.jpg', 'SYN-IMG-z.jpg'], '2026-08-08 10:00:05')}
-- L4 ambiguous: two events remove it and one adds it back, all before the first later state
${event(41, 4, urls('SYN-OBJ-4.jpg', 'SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg'), '2026-08-07 09:00')}
${event(42, 4, urls('SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg', 'SYN-OBJ-4.jpg'), '2026-08-07 12:00')}
${event(43, 4, urls('SYN-OBJ-4.jpg', 'SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg'), '2026-08-08 09:00')}
${state(4, null, ['SYN-IMG-x.jpg'], '2026-08-09 10:00')}
-- L5 none: no photos_changed event at all (only a different event type)
${event(5, 5, urls('SYN-OBJ-5.jpg'), urls(), '2026-08-08 10:00', 'ops@example.com', 'field_changed')}
${state(5, null, ['SYN-IMG-x.jpg'], '2026-08-09 10:00')}
-- L6 unusable: events whose before/after are not image lists
${event(6, 6, undefined, 'a string', '2026-08-08 10:00')}
${state(6, null, ['SYN-IMG-x.jpg'], '2026-08-09 10:00')}
-- L7 circumstantial: an event in the window that does not involve the image's removal (it survives that edit)
${event(7, 7, urls('SYN-OBJ-7.jpg', 'SYN-IMG-x.jpg'), urls('SYN-OBJ-7.jpg', 'SYN-IMG-x.jpg', 'SYN-IMG-w.jpg'), '2026-08-08 10:00')}
${state(7, null, ['SYN-IMG-x.jpg', 'SYN-IMG-w.jpg'], '2026-08-12 10:00')}
-- L8 chronology: the removing event is AFTER the first later state + 1 day -> outside the window -> none
${event(8, 8, urls('SYN-OBJ-8.jpg', 'SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg'), '2026-08-20 10:00')}
${state(8, null, ['SYN-IMG-x.jpg'], '2026-08-12 10:00')}
-- L9 chronology: UNCONFIRMED removing event 30 minutes BEFORE the record (browser-clock tolerance of one day) -> in the window -> direct_unconfirmed; no actor
${event(9, 9, urls('SYN-OBJ-9.jpg', 'SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg'), '2026-08-06 09:30', null)}
${state(9, null, ['SYN-IMG-x.jpg'], '2026-08-07 10:00')}
-- L10 chronology: UNCONFIRMED removing event 2 days BEFORE the record -> outside the tolerance -> none
${event(10, 10, urls('SYN-OBJ-10.jpg', 'SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg'), '2026-08-04 10:00')}
${state(10, null, ['SYN-IMG-x.jpg'], '2026-08-07 10:00')}
-- L11 chronology: a CONFIRMED event whose linked snapshot (server time) is BEFORE the record is outside the window even though its browser time is inside
${event(111, 11, urls('SYN-OBJ-11.jpg', 'SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg'), '2026-08-07 10:00')}
${state(11, 111, ['SYN-IMG-x.jpg'], '2026-08-05 10:00')}
${state(11, null, ['SYN-IMG-x.jpg'], '2026-08-12 10:00')}
-- L12 nested + percent-encoded + external URL: the before-list holds the nested, encoded URL (with a query string); the after-list only an external URL
${event(12, 12, [U('SYN-OBJ-dir/my%20file.jpg?v=2'), 'https://cdn.ext.example/a.jpg?w=1'], ['https://cdn.ext.example/a.jpg?w=2'], '2026-08-07 10:00')}
${state(12, null, ['SYN-IMG-x.jpg'], '2026-08-12 10:00')}
-- L13 near-miss: the before-list has the SAME basename in ANOTHER directory -> not this image -> already_absent, never direct
${event(13, 13, urls('SYN-OBJ-other/SYN-OBJ-flat.jpg', 'SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg'), '2026-08-07 10:00')}
${state(13, null, ['SYN-IMG-x.jpg'], '2026-08-12 10:00')}
-- L14: the first later state still CONTAINS the image (not analysed here); L15: no later state at all (not analysed here)
${state(14, null, ['SYN-OBJ-14.jpg', 'SYN-IMG-x.jpg'], '2026-08-12 10:00')}
${event(14, 14, urls('SYN-OBJ-14.jpg'), urls(), '2026-08-12 09:00')}
`;
function makeDb(extra = '') {
  const db = `p${++counter}`;
  assert.equal(psqlRaw('postgres', ['-v', 'ON_ERROR_STOP=1'], `CREATE DATABASE ${db};`).status, 0);
  const s = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1'], SCHEMA + DATA + extra + 'GRANT USAGE ON SCHEMA public, storage TO pe_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public, storage TO pe_ro;');
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
const prov = (db, o) => run(db, '8-gallery-provenance-photos-changed.sql', o);

test('population and scope: the unreferenced originals (= the stage-2 total); only assign objects whose first later state EXCLUDES the image are analysed', opts, () => {
  const db = makeDb();
  const h = prov(db);
  assert.deepEqual(h.get('0'), { 'transaction_read_only=on': '/' });
  assert.deepEqual(h.get('1 '), { '': '15/' });
  const d = psqlRaw(db, ['-A', '-t', '-F', ' | ', '-c', 'BEGIN READ ONLY', '-f', path.join(D, '2-diagnostic.sql'), '-c', 'ROLLBACK']);
  assert.equal(Number(d.stdout.split('\n').find((l) => /TOTAL/.test(l)).split(' | ').pop()), 15);
  assert.deepEqual(h.get('2 '), {
    'first later state EXCLUDES the image (analysed here)': '13/13',
    'first later state still contains the image (NOT analysed here)': '1/1',
    'no later gallery state (NOT analysed here: see the history diagnostic)': '1/1' });
});

test('the analysed population is exactly the "bounded" assign population of 7-gallery-history-vs-snapshots.sql (guards the copied logic against drift)', opts, () => {
  const db = makeDb();
  const seven = run(db, '7-gallery-history-vs-snapshots.sql').rows.find((r) => /^6 assign/.test(r.section) && /ABSENT/.test(r.label));
  const eight = prov(db).get('2 ')['first later state EXCLUDES the image (analysed here)'];
  assert.equal(`${seven.n}/${seven.listings}`, eight);
});

test('classification of the analysed objects: direct (confirmed / unconfirmed), ambiguous, already absent, circumstantial, unusable, none', opts, () => {
  const h = prov(makeDb());
  assert.deepEqual(h.get('4 '), {
    direct_confirmed: '1/1',     // L1
    direct_unconfirmed: '3/3',   // L2, L9 (tolerance), L12 (nested + encoded)
    ambiguous: '1/1',            // L4
    already_absent: '2/2',       // L3, L13 (same basename, other directory)
    circumstantial: '1/1',       // L7
    unusable: '1/1',             // L6
    none: '4/4' });              // L5 (other event type), L8 (after the window), L10 (before the tolerance), L11 (linked snapshot BEFORE the record)
  assert.equal(Object.values(h.get('4 ')).reduce((t, v) => t + Number(v.split('/')[0]), 0), 13, 'the classes are mutually exclusive and add up to the analysed population');
});

test('events are separated from causation: only direct classes carry before/after evidence about THIS image; nothing is called a cause', opts, () => {
  const h = prov(makeDb());
  const labels = h.rows.map((r) => r.section + ' ' + r.label).join('\n');
  assert.doesNotMatch(labels, /caused|because|proves? the/i);
  assert.match(h.rows.find((r) => /^4 /.test(r.section)).section, /what the photos_changed events in the record-to-snapshot window show/);
  assert.deepEqual(h.get('8 '), { '': '11/9' });   // distinct events inside any window (timing only unless section 4 says direct)
});

test('chronology: confirmed events use the linked snapshot SERVER time; unconfirmed ones the browser time with a one-day tolerance', opts, () => {
  const c = prov(makeDb()).get('4 ');
  // L9 (unconfirmed, 30 min before the record) is in; L10 (unconfirmed, 2 days before) is out; L11 (confirmed, server time before the record) is out; L8 (after the window) is out
  assert.equal(c.direct_unconfirmed, '3/3');
  assert.equal(c.none, '4/4');
});

test('narrowing: a removing event IS the bounding state, or is earlier than it (narrows), or has a browser time before the record (not a valid narrowing)', opts, () => {
  const h = prov(makeDb());
  assert.deepEqual(h.get('5 '), {
    'direct_confirmed: the removing event IS the first later gallery state (no narrowing)': '1/1',
    'direct_unconfirmed: earlier than the first later state by more than 1 hour (narrows the window)': '2/2',
    'direct_unconfirmed: event time is BEFORE the record (browser-clock difference; no valid narrowing)': '1/1' });
  assert.deepEqual(h.get('6 '), {
    'direct_confirmed: 2-7 days': '1/1',
    'direct_unconfirmed: 2-7 days': '1/1',
    'direct_unconfirmed: within 1 day': '1/1',
    'direct_unconfirmed: event time is BEFORE the record (browser-clock difference inside the 1-day tolerance; not a real narrowing)': '1/1' });
});

test('actor: reported only as present / equal to the Gallery Recovery operator (case and spaces ignored), never as a value', opts, () => {
  const h = prov(makeDb());
  assert.deepEqual(h.get('7 '), {
    'actor equals the Gallery Recovery operator of the latest assign record': '2/2',   // L1 (" Ops@Example.com "), L12
    'actor differs from the Gallery Recovery operator': '1/1',                           // L2
    'no actor recorded on the removing event': '1/1' });                                 // L9
  const op = h.rows.find((r) => /^7 /.test(r.section)).section;
  assert.match(op, /single shared admin login/);
});

test('coverage of the evidence source: all-listings totals, date range, usable lists, actors (count only), linked snapshots', opts, () => {
  const h = prov(makeDb());
  const get = (frag) => h.rows.find((r) => /^3 /.test(r.section) && r.section.includes(frag));
  assert.equal(`${get('total and date range').label}|${get('total and date range').n}/${get('total and date range').listings}`, '2026-08-04 to 2026-08-20|15/13');
  assert.equal(`${get('usable').n}/${get('usable').listings}`, '14/12');
  assert.equal(`${get('actor recorded').label}|${get('actor recorded').n}/${get('actor recorded').listings}`, 'distinct actors: 2|14/12');
  assert.equal(`${get('linked saved snapshot').n}/${get('linked saved snapshot').listings}`, '3/3');
});

test('exact matching: nested + percent-encoded + query-string URL matches the decoded nested object; a same-basename image in another directory does not; external URLs never match', opts, () => {
  const c = prov(makeDb()).get('4 ');
  assert.equal(c.direct_unconfirmed, '3/3');   // includes L12 (nested "dir/my file.jpg" vs ".../dir/my%20file.jpg?v=2")
  assert.equal(c.already_absent, '2/2');       // includes L13 (SYN-OBJ-other/SYN-OBJ-flat.jpg is NOT SYN-OBJ-flat.jpg)
});

// Isolated scenarios: the aggregate classes of the big fixture could hide a swap between two scenarios, so each exact-matching rule is also checked as a DELTA.
const scenario = (n, name, oldL, newL, extraEvents = '') => `${listing(n)} ${obj(name)} ${assign(n, [name])} ${event(300 + n, n, oldL, newL, '2026-08-07 10:00')} ${extraEvents}
  ${state(n, null, ['SYN-IMG-x.jpg'], '2026-08-12 10:00')}`;

test('ISOLATED: a nested, percent-encoded, query-string URL in the before-list matches the decoded nested object exactly -> one more direct, nothing else moves', opts, () => {
  const c = prov(makeDb(scenario(16, 'SYN-OBJ-dir2/my file 2.jpg', [U('SYN-OBJ-dir2/my%20file%202.jpg?v=9'), U('SYN-IMG-x.jpg')], [U('SYN-IMG-x.jpg')]))).get('4 ');
  assert.equal(c.direct_unconfirmed, '4/4'); assert.equal(c.already_absent, '2/2'); assert.equal(c.none, '4/4');
});

test('ISOLATED: the same basename in ANOTHER directory is a different image -> one more already_absent, never a direct match', opts, () => {
  const c = prov(makeDb(scenario(17, 'SYN-OBJ-near.jpg', [U('SYN-OBJ-elsewhere/SYN-OBJ-near.jpg'), U('SYN-IMG-x.jpg')], [U('SYN-IMG-x.jpg')]))).get('4 ');
  assert.equal(c.already_absent, '3/3'); assert.equal(c.direct_unconfirmed, '3/3');
});

test('ISOLATED: a longer name that merely CONTAINS the object name ("X" + name, or name + ".bak") is not a match', opts, () => {
  const c = prov(makeDb(scenario(18, 'SYN-OBJ-sub.jpg', [U('XSYN-OBJ-sub.jpg'), U('SYN-OBJ-sub.jpg.bak'), U('SYN-IMG-x.jpg')], [U('SYN-IMG-x.jpg')]))).get('4 ');
  assert.equal(c.already_absent, '3/3'); assert.equal(c.direct_unconfirmed, '3/3');
});

test('ISOLATED: the AFTER-list holds only a longer look-alike name -> the image is still REMOVED (direct), the look-alike does not keep it', opts, () => {
  const c = prov(makeDb(scenario(22, 'SYN-OBJ-gone.jpg', [U('SYN-OBJ-gone.jpg'), U('SYN-IMG-x.jpg')], [U('SYN-IMG-x.jpg'), U('XSYN-OBJ-gone.jpg'), U('SYN-OBJ-gone.jpg.bak')]))).get('4 ');
  assert.equal(c.direct_unconfirmed, '4/4'); assert.equal(c.circumstantial, '1/1');
});

test('ISOLATED: an external URL in the lists never matches an object, even one with the same file name', opts, () => {
  const c = prov(makeDb(scenario(19, 'SYN-OBJ-ext.jpg', ['https://cdn.ext.example/SYN-OBJ-ext.jpg?w=1', U('SYN-IMG-x.jpg')], [U('SYN-IMG-x.jpg')]))).get('4 ');
  assert.equal(c.already_absent, '3/3'); assert.equal(c.direct_unconfirmed, '3/3');
});

test('ISOLATED: an image in BOTH lists (survives the edit) is circumstantial, not removal', opts, () => {
  const c = prov(makeDb(scenario(21, 'SYN-OBJ-keep.jpg', [U('SYN-OBJ-keep.jpg'), U('SYN-IMG-x.jpg')], [U('SYN-OBJ-keep.jpg'), U('SYN-IMG-x.jpg'), U('SYN-IMG-w.jpg')]))).get('4 ');
  assert.equal(c.circumstantial, '2/2'); assert.equal(c.direct_unconfirmed, '3/3');
});

test('a removal whose event is the ONLY evidence but whose save is unconfirmed stays "unconfirmed": an event written before a failed save is not proof', opts, () => {
  const db = makeDb(`${listing(20)} ${obj('SYN-OBJ-20.jpg')} ${assign(20, ['SYN-OBJ-20.jpg'])}
    ${event(200, 20, urls('SYN-OBJ-20.jpg', 'SYN-IMG-x.jpg'), urls('SYN-IMG-x.jpg'), '2026-08-07 10:00')}
    ${state(20, null, ['SYN-IMG-x.jpg'], '2026-08-12 10:00')}`);
  const c = prov(db).get('4 ');
  assert.equal(c.direct_unconfirmed, '4/4');
  assert.equal(c.direct_confirmed, '1/1');
});

test('READ ONLY guard: outside a READ ONLY transaction every count is zero and the guard row says so; nothing is changed', opts, () => {
  const db = makeDb();
  const off = prov(db, { readOnly: false });
  assert.deepEqual(off.get('0'), { 'transaction_read_only=off': '/' });
  assert.deepEqual(off.get('1 '), { '': '0/' });
  assert.deepEqual(off.get('4 '), {});
  const count = () => psqlRaw(db, ['-A', '-t'], 'SELECT (SELECT count(*) FROM listing_provenance)||(SELECT count(*) FROM listing_image_snapshots)||(SELECT count(*) FROM gallery_assignments)||(SELECT count(*) FROM properties);').stdout;
  const before = count(); prov(db);
  assert.equal(count(), before);
  const w = psqlRaw(db, ['-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY', '-c', 'DELETE FROM listing_provenance']);
  assert.notEqual(w.status, 0); assert.match(w.stderr, /read-only transaction/);
});

test('aggregates only: no object name, image list, listing id, event id, actor or title is ever printed', opts, () => {
  const h = prov(makeDb());
  assert.doesNotMatch(h.text, IDENT);
  assert.doesNotMatch(h.text, /SYN-TITLE|payload|@/);
});

test('the query selects no title, payload, actor value or id (output columns are section / label / n / listings)', () => {
  const sql = fs.readFileSync(path.join(D, '8-gallery-provenance-photos-changed.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.match(sql, /SELECT section, label, n, listings FROM \(/);
  assert.doesNotMatch(sql, /raw_payload|title|phone|email|row_data/i);
});

// ── run.sh provenance against a fake psql ──
const ALIGNED = (n = 553) => ` 0 session guard (must be on) | transaction_read_only=on |     | \n 1 unreferenced originals (must equal the stage-2 total) |  | ${String(n).padStart(3)} | \n 2 scope: assign objects | analysed | 100 | 12\n`;
function runFake({ preflight, diag = ' 1 TOTAL | 189 MB | 553\n', out8, env = {}, failOn, stale = false, mode = 'provenance' } = {}) {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pr8-'));
  const work = path.join(dir2, 'work'); fs.mkdirSync(work); fs.mkdirSync(path.join(dir2, 'bin'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  if (stale) for (const f of ['provenance-events.txt', 'diagnostic.txt']) fs.writeFileSync(path.join(work, f), 'STALE\n');
  fs.writeFileSync(path.join(dir2, 'pre.out'), preflight ?? 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\nVERDICT | provenance-schema | PASS\n');
  fs.writeFileSync(path.join(dir2, 'diag.out'), diag);
  fs.writeFileSync(path.join(dir2, 'o8.out'), out8 ?? ALIGNED());
  const log = path.join(dir2, 'psql.log');
  fs.writeFileSync(path.join(dir2, 'bin', 'psql'), `#!/bin/bash
echo "CALL $*" >> "${log}"
case "$*" in
  *${failOn || 'NEVER-MATCHES'}*) echo "ERROR:  invalid input: \\"SYN-OBJ-leak.jpg\\" listing ${L(1)} ops@example.com" >&2; echo "ERROR:  22P02" >&2; echo "SYN-IMG-stdout-leak"; exit 3;;
  *1-preflight.sql*) cat "${dir2}/pre.out";; *2-diagnostic.sql*) cat "${dir2}/diag.out";; *8-gallery-provenance-photos-changed.sql*) cat "${dir2}/o8.out";;
esac
`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(work, 'run.sh'), mode], { env: { PATH: `${path.join(dir2, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir2, PINTAG_PROD_DB_URL: SECRET_URL, ...env }, encoding: 'utf8', input: '' });
  const files = {};
  for (const f of fs.readdirSync(work)) if (/\.(txt|md|csv)$/.test(f)) files[f] = fs.readFileSync(path.join(work, f), 'utf8');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('CALL ').filter(Boolean) : [];
  return { r, out: r.stdout + r.stderr, files, calls };
}

test('provenance mode: lint, preflight, stage-2 cross-check, then ONLY stage 8; every call READ ONLY; the population must equal stage 2', () => {
  const { r, out, files, calls } = runFake();
  assert.equal(r.status, 0, out);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /1-preflight\.sql/); assert.match(calls[1], /2-diagnostic\.sql/); assert.match(calls[2], /8-gallery-provenance-photos-changed\.sql/);
  for (const c of calls) assert.match(c, /BEGIN READ ONLY.*\.sql.*ROLLBACK/);
  assert.match(calls[2], /VERBOSITY=sqlstate/);
  assert.match(out, /lint ok: 8-gallery-provenance-photos-changed\.sql/);
  assert.match(out, /=== stage 8: gallery 'assign' images vs the editor's photos_changed events, for the 553 objects/);
  assert.match(files['provenance-events.txt'], /unreferenced originals/);
  assert.doesNotMatch(out + Object.values(files).join(''), /S3cr3tPassw0rd/);
});

test('provenance mode: a rebuilt population different from the stage-2 total is DISCARDED (job fails, no result file)', () => {
  for (const out8 of [ALIGNED(551), ALIGNED(554), ' 0 guard | transaction_read_only=off |  | \n 1 unreferenced originals (must equal the stage-2 total) |  |   0 | \n', ' no population row at all\n']) {
    const { r, out, files } = runFake({ out8, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, /Stage 8 rebuilt a population of '[0-9?]*' objects but stage 2 counted 553 - the result was discarded/);
    assert.ok(!('provenance-events.txt' in files));
  }
});

for (const [label, preflight, text] of [
  ['provenance-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\nVERDICT | provenance-schema | FAIL\n', /PROVENANCE-SCHEMA VERDICT DID NOT PASS/],
  ['provenance-schema missing', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\n', /PROVENANCE-SCHEMA VERDICT DID NOT PASS/],
  ['history-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | FAIL\nVERDICT | provenance-schema | PASS\n', /HISTORY-SCHEMA VERDICT DID NOT PASS/],
  ['gallery-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | FAIL\nVERDICT | history-schema | PASS\nVERDICT | provenance-schema | PASS\n', /GALLERY-SCHEMA VERDICT DID NOT PASS/],
  ['reconcile-schema FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | FAIL\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\nVERDICT | provenance-schema | PASS\n', /RECONCILE-SCHEMA VERDICT DID NOT PASS/],
]) {
  test(`provenance mode stops before stage 8 on ${label}: job fails visibly, no result file`, () => {
    const { r, out, files, calls } = runFake({ preflight, stale: true });
    assert.equal(r.status, 1, out);
    assert.match(out, text);
    assert.ok(!calls.some((c) => /8-gallery-provenance/.test(c)));
    assert.ok(!('provenance-events.txt' in files));
  });
}

for (const [label, preflight] of [
  ['a role+session FAIL', 'VERDICT | schema | PASS\nVERDICT | role+session | FAIL\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\nVERDICT | provenance-schema | PASS\n'],
  ['a WARN row', 'role | rolbypassrls | WARN false\nVERDICT | schema | PASS\nVERDICT | role+session | PASS\nVERDICT | reconcile-schema | PASS\nVERDICT | gallery-schema | PASS\nVERDICT | history-schema | PASS\nVERDICT | provenance-schema | PASS\n'],
]) {
  test(`provenance mode keeps the preflight gates: ${label} stops everything before any data stage`, () => {
    const { r, calls } = runFake({ preflight });
    assert.equal(r.status, 1);
    assert.equal(calls.length, 1);
  });
}

test('provenance mode: expected_objects must match the stage-2 total (or be numeric)', () => {
  assert.equal(runFake({ env: { EXPECTED_OBJECTS: '553' } }).r.status, 0);
  const bad = runFake({ env: { EXPECTED_OBJECTS: '551' } });
  assert.equal(bad.r.status, 1);
  assert.match(bad.out, /Stage 2 counted 553 objects but expected_objects is 551 - stage 8 NOT run/);
  assert.equal(bad.calls.length, 2);
  const nn = runFake({ env: { EXPECTED_OBJECTS: '1;DROP' } });
  assert.equal(nn.r.status, 1);
  assert.match(nn.out, /expected_objects must be a number/);
});

for (const failOn of ['2-diagnostic.sql', '8-gallery-provenance-photos-changed.sql']) {
  test(`provenance mode: psql failure in ${failOn} withholds the error text (SQLSTATE only); no identifier, no partial result`, () => {
    const { r, out, files } = runFake({ failOn, stale: true });
    assert.notEqual(r.status, 0);
    assert.match(out, /psql failed \(exit 3\); its error text is withheld/);
    assert.doesNotMatch(out, /SYN-IMG|SYN-OBJ|0000-8888|ops@example/);
    assert.ok(!('provenance-events.txt' in files));
    for (const t of Object.values(files)) assert.doesNotMatch(t, /SYN-IMG|SYN-OBJ|ops@example/);
  });
}

test('the other modes never run stage 8, and `provenance` is a known mode', () => {
  for (const mode of ['diagnostic', 'gallery', 'probe', 'history']) assert.ok(!runFake({ mode }).calls.some((c) => /8-gallery-provenance/.test(c)), mode);
  assert.equal(spawnSync('bash', [path.join(D, 'run.sh'), 'bogus'], { encoding: 'utf8' }).status, 2);
});

// ── end to end on real Postgres with a read-only role ──
test('end to end (real Postgres, read-only role): `run.sh provenance` passes every gate, rebuilds the stage-2 population, prints aggregates only', opts, () => {
  const db = makeDb(`ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS updated_at timestamptz;`);
  const work = fs.mkdtempSync(path.join(dir, 'e2e-'));
  for (const f of fs.readdirSync(D)) if (fs.statSync(path.join(D, f)).isFile()) fs.copyFileSync(path.join(D, f), path.join(work, f));
  const r = spawnSync('bash', [path.join(work, 'run.sh'), 'provenance'], { encoding: 'utf8', input: '',
    env: { PATH: `${PGBIN}${path.delimiter}${process.env.PATH}`, HOME: dir, EXPECTED_OBJECTS: '15', PINTAG_PROD_DB_URL: `postgresql://pe_ro@/${db}?host=${sock}&port=${port}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const v of ['schema', 'role+session', 'reconcile-schema', 'gallery-schema', 'history-schema', 'provenance-schema']) assert.ok(r.stdout.includes(`VERDICT | ${v} | PASS`), v);
  assert.match(r.stdout, /transaction_read_only=on/);
  assert.match(r.stdout, /1 unreferenced originals[^\n]*\|\s+15 \|/);
  assert.match(r.stdout, /direct_confirmed/);
  assert.doesNotMatch(r.stdout + r.stderr, IDENT);
  assert.doesNotMatch(fs.readFileSync(path.join(work, 'provenance-events.txt'), 'utf8'), IDENT);
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
  assert.ok(withSecret.some((s) => /bash scripts\/diagnostics\/orphan-originals\/run\.sh provenance\n/.test(s)));
  assert.equal((code.match(/run\.sh/g) || []).length, 1);
  assert.ok(!/\$\{\{ *inputs\./.test(code.replace(/EXPECTED_OBJECTS: \$\{\{ inputs\.expected_objects \}\}/, '')), 'the input only reaches the runner through env');
  assert.ok(!/\b(git (push|commit|tag)|gh (api|pr|release)|curl|wget|rclone)\b/.test(code));
  assert.ok(!/^\s*psql\b/m.test(code));
});

test('workflow: the log and job summary come only from preflight.txt, diagnostic.txt and provenance-events.txt', () => {
  const pub = steps.find((s) => /Publish results/.test(s));
  assert.match(pub, /provenance-events\.txt/);
  assert.ok(!/gallery-listing|reconcile-objects|gallery-state|history-vs-gallery|\.csv/.test(pub));
});

test('repository hygiene: the result file is ignored and not tracked', () => {
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'scripts/diagnostics/orphan-originals/provenance-events.txt'], { cwd: ROOT }).status, 0);
  assert.ok(!spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').some((f) => /provenance-events\.txt$/.test(f)));
});
