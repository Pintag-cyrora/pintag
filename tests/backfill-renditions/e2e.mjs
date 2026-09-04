// End-to-end proof that the rendition backfill works against a Supabase
// deployment where the PUBLIC Storage object endpoint cannot be trusted to
// answer "does this exist" at all: it returns 400 (not 404) for GET or HEAD
// of a missing object, which is what broke production twice (first HEAD,
// then GET+Range). Discovery now uses ONLY the authenticated Storage list
// API, with the existing least-privilege DB role kept for the property/
// unit-type queries (still public-schema-only; storage.objects is never
// queried at all any more, not even as a fallback).
//
//   node tests/backfill-renditions/e2e.mjs
//
// Nothing here touches production. It boots a throwaway PostgreSQL cluster, a
// fake Supabase Storage server on localhost, and a stub `convert`, then runs
// the REAL scripts/backfill-renditions.mjs against them. Skips (exit 0) when
// initdb/psql are unavailable, so it is safe to run anywhere.
//
// What it proves:
//   1. A dry run now REFUSES (exit 2) without SUPABASE_SERVICE_ROLE_KEY,
//      because discovery itself needs the authenticated Storage API.
//   2. A dry run WITH the key completes and writes NOTHING to Storage.
//   2b. THE REGRESSION: the fake public endpoint returns 400 (never 404) for
//       ANY request -- GET or HEAD, existing name or not -- to an object the
//       run has not already confirmed exists via listing. Neither dry-run
//       nor apply ever triggers one of these 400s, proving existence is
//       settled purely by the authenticated `list` API, never by asking the
//       public endpoint about a possibly-missing object.
//   3. Discovery finds unit-type photos, deduplicates them against the
//      building gallery, skips objects that are not in Storage, and
//      recognises a PRE-EXISTING rendition through the listing (not a probe).
//   4. Apply writes only the renditions that do not already exist, all under
//      renditions/, and leaves every original AND the pre-existing rendition
//      byte-identical.
//   5. Apply is idempotent: a second run writes nothing new.
//   6. Storage API pagination is genuinely exercised: 1000+ filler objects
//      force a real second page (not just a hardcoded PAGE constant nobody
//      crosses), and each file's metadata.size is what discovery/the ceiling
//      actually use.
//   7. Apply REFUSES to write (exit 4) when total storage cannot be measured,
//      so the ceiling is never bypassed.
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const PGBIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/pgsql-16/bin']
  .find((d) => { try { execFileSync(join(d, 'initdb'), ['--version'], { stdio: 'pipe' }); return true; } catch { return false; } });
if (!PGBIN) { console.log('SKIP: no local PostgreSQL (initdb) available'); process.exit(0); }

const ROOT = new URL('../../', import.meta.url).pathname;
const mod = await import(new URL('../../image-renditions.js', import.meta.url));
const { PT_RENDITION_PROFILES, renditionPath } = mod.default ?? mod;

const work = mkdtempSync(join(tmpdir(), 'rend-e2e-'));
const PORT = 5401 + (process.pid % 120);
const HTTP_PORT = PORT + 1000;
let pgStarted = false;
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n         ${detail}`}`);
};

// ── fake Supabase Storage: public reads, authenticated writes, list API ──────
const store = new Map();                 // object name -> Buffer
const writes = [];                       // every write the script attempts
const headRequests = [];                 // every HEAD sent to the public bucket
const publicMiss400s = [];               // every public GET/HEAD that hit an absent name
const listCalls = [];                    // every call to the authenticated list endpoint
let bucketListWorks = true;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const pub = '/storage/v1/object/public/property-images/';
  const write = '/storage/v1/object/property-images/';
  const send = (code, body, headers = {}) => { res.writeHead(code, headers); res.end(body); };

  if (url.pathname.startsWith(pub)) {                      // public read: NO auth
    // THE REGRESSION THIS FILE REPRODUCES. Production returned 400 (never
    // 404) from this endpoint for an object that had simply never been
    // generated, for BOTH HEAD (2026-08) and GET+Range (2026-09) -- so
    // this fake mirrors that for EVERY request against a name not already
    // in `store`, regardless of method or headers. A correct runner must
    // never ask this endpoint "does X exist" in the first place, so it
    // must never receive one of these 400s; download() and upload()'s
    // verify step remain free to use it for a name already CONFIRMED
    // present by the authenticated list API, which is the one thing that
    // still answers correctly here.
    const name = decodeURIComponent(url.pathname.slice(pub.length));
    if (req.method === 'HEAD') headRequests.push(url.pathname);
    if (!store.has(name)) { publicMiss400s.push(`${req.method} ${name}`); return send(400, '{"error":"Bad Request"}'); }
    if (req.method === 'HEAD') return send(400, '{"error":"Bad Request"}');   // HEAD is unreliable here even for a real object
    const buf = store.get(name);
    const range = req.headers.range;
    const m = range && /^bytes=0-0$/.exec(range);
    if (m) return send(206, buf.subarray(0, 1), { 'content-range': `bytes 0-0/${buf.length}`, 'content-length': '1', 'content-type': 'image/png' });
    return send(200, buf, { 'content-length': String(buf.length), 'content-type': 'image/png' });
  }
  if (url.pathname === '/storage/v1/bucket') {
    if (!req.headers.authorization) return send(401, '{"error":"unauthorized"}');
    if (!bucketListWorks) return send(403, '{"error":"forbidden"}');
    return send(200, JSON.stringify([{ id: 'property-images', name: 'property-images' }]));
  }
  if (url.pathname === '/storage/v1/object/list/property-images') {
    if (!req.headers.authorization) return send(401, '{"error":"unauthorized"}');
    let body = ''; req.on('data', (d) => (body += d));
    return req.on('end', () => {
      const { prefix = '', limit = 100, offset = 0 } = JSON.parse(body || '{}');
      listCalls.push({ prefix, limit, offset });
      const seen = new Map();
      for (const [name, buf] of store) {
        if (!name.startsWith(prefix)) continue;
        const rest = name.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(rest, { name: rest, id: name, metadata: { size: buf.length } });
        else seen.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null });
      }
      // A real backend HONOURS limit/offset -- this is the behaviour that
      // makes pagination genuinely necessary rather than a formality the
      // fake server papers over by always returning everything in one page.
      const all = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      send(200, JSON.stringify(all.slice(offset, offset + limit)));
    });
  }
  if (req.method === 'POST' && url.pathname.startsWith(write)) {
    const name = decodeURIComponent(url.pathname.slice(write.length));
    if (!req.headers.authorization) return send(401, '{"error":"unauthorized"}');
    const chunks = []; req.on('data', (d) => chunks.push(d));
    return req.on('end', () => { writes.push(name); store.set(name, Buffer.concat(chunks)); send(200, '{}'); });
  }
  send(404, '{"error":"no route"}');
});

function sql(user, statement) {
  const r = spawnSync('psql', [`postgresql://${user}@localhost:${PORT}/postgres`, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return r.stdout;
}
// Must be ASYNC: the fake Storage server runs in this very process, so a
// blocking spawnSync would stop it answering the script's requests and every
// list call would time out.
function runScript(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(ROOT, 'scripts/backfill-renditions.mjs'), ...args], {
      cwd: work,
      env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}`, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// PostgreSQL refuses to run as root, so as root the cluster is driven as the
// `postgres` service user — which then needs to be able to traverse the work
// directory. Run directly when we are not root.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const pg = (bin, args) => (asRoot
  ? execFileSync('runuser', ['-u', 'postgres', '--', join(PGBIN, bin), ...args], { stdio: 'pipe' })
  : execFileSync(join(PGBIN, bin), args, { stdio: 'pipe' }));

try {
  // ── throwaway cluster ──
  chmodSync(work, 0o755);
  mkdirSync(join(work, 'data'), { recursive: true });
  if (asRoot) execFileSync('chown', ['-R', 'postgres', join(work, 'data')], { stdio: 'pipe' });
  pg('initdb', ['-D', join(work, 'data'), '-A', 'trust', '-U', 'postgres']);
  // Socket and log live INSIDE the data directory: it is the one path the
  // postgres user is guaranteed to own.
  pg('pg_ctl', ['-D', join(work, 'data'), '-o', `-p ${PORT} -k ${join(work, 'data')}`, '-l', join(work, 'data', 'pg.log'), 'start']);
  pgStarted = true;
  await new Promise((r) => setTimeout(r, 1500));

  const SB = `http://localhost:${HTTP_PORT}`;
  const pub = (n) => `${SB}/storage/v1/object/public/property-images/${n}`;
  sql('postgres', `
    CREATE TABLE properties (id uuid PRIMARY KEY, slug text, status text, images text[]);
    CREATE TABLE unit_types (id uuid PRIMARY KEY, property_id uuid, images text[]);
    CREATE TABLE property_images (property_id uuid, storage_path text, status text);
    INSERT INTO properties VALUES
      ('11111111-1111-1111-1111-111111111111','active-bldg','active', ARRAY['${pub('bldg-1.jpg')}']),
      ('22222222-2222-2222-2222-222222222222','draft-bldg','draft',   ARRAY['${pub('draft-1.jpg')}']);
    INSERT INTO property_images VALUES ('11111111-1111-1111-1111-111111111111','bldg-1.jpg','active');
    INSERT INTO unit_types VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        ARRAY['${pub('unit-1.jpg')}','${pub('bldg-1.jpg')}','${pub('unit-2.jpg')}?t=1',
              '${pub('renditions/unit-1/card.webp')}','https://scontent.fbcdn.net/x.jpg','${pub('gone.jpg')}']),
      ('aaaaaaaa-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222', ARRAY['${pub('draft-unit.jpg')}']),
      ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111', NULL);
    -- The production shape: a role with NO storage-schema access at all
    -- (this script no longer even attempts to query it, in either mode).
    CREATE ROLE backup_ro LOGIN;
    GRANT USAGE ON SCHEMA public TO backup_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_ro;
  `);

  // Objects that really exist. 'gone.jpg' deliberately does NOT.
  for (const n of ['bldg-1.jpg', 'unit-1.jpg', 'unit-2.jpg', 'draft-1.jpg', 'draft-unit.jpg']) store.set(n, Buffer.concat([PNG, Buffer.alloc(1000)]));
  // A rendition already generated by a prior (partial) run: discovery must
  // recognise it through the LISTING, and apply must not re-upload it.
  const preexistingPath = renditionPath('bldg-1.jpg', 'thumbnail');
  store.set(preexistingPath, Buffer.alloc(222));
  // Pagination filler: 1005 objects under their own prefix, so the recursive
  // Storage listing genuinely needs a second page (PAGE=1000 in the script)
  // rather than the test merely asserting the constant exists.
  for (let i = 0; i < 1005; i++) store.set(`filler/f${String(i).padStart(4, '0')}.bin`, Buffer.alloc(10));
  const originalsBefore = new Map(['bldg-1.jpg', 'unit-1.jpg', 'unit-2.jpg', 'draft-1.jpg', 'draft-unit.jpg']
    .map((k) => [k, Buffer.from(store.get(k))]));
  const preexistingBefore = Buffer.from(store.get(preexistingPath));
  await new Promise((r) => server.listen(HTTP_PORT, r));

  // Stub encoder: the script shells out to ImageMagick, which this harness is
  // not testing. It writes a plausibly smaller output so the size logic runs.
  mkdirSync(join(work, 'bin'), { recursive: true });
  writeFileSync(join(work, 'bin', 'convert'), '#!/bin/sh\nout=$(eval echo \\${$#})\nprintf "webp-stub" > "$out"\n');
  chmodSync(join(work, 'bin', 'convert'), 0o755);

  const RO = { PINTAG_DB_URL: `postgresql://backup_ro@localhost:${PORT}/postgres`, SUPABASE_URL: SB };
  delete RO.SUPABASE_SERVICE_ROLE_KEY;

  // 1. the test role really has no storage-schema access — harness fidelity
  let denied = '';
  try { sql('backup_ro', 'SELECT count(*) FROM storage.objects'); } catch (e) { denied = e.message; }
  check('the test role has no storage-schema access, matching production', /permission denied|does not exist/i.test(denied), denied);

  // 2. dry run now REFUSES without the service-role key: discovery itself
  //    needs the authenticated Storage API, so it can no longer be optional.
  const noKey = await runScript(['--dry-run', '--sample', '10'], RO);
  check('dry run without SUPABASE_SERVICE_ROLE_KEY refuses (exit 2)', noKey.status === 2, `exit ${noKey.status}: ${(noKey.stderr || '').slice(-200)}`);
  check('the refusal names the Storage API as the reason', /Storage API/i.test(noKey.stderr));
  check('refusing for lack of a key performs no writes', writes.length === 0);

  // 3. dry run WITH the key completes and writes nothing
  const DRY_ENV = { ...RO, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' };
  const dry = await runScript(['--dry-run', '--sample', '10'], DRY_ENV);
  if (process.env.E2E_DEBUG) { console.log('--- dry stdout ---\n' + dry.stdout + '\n--- dry stderr ---\n' + dry.stderr); }
  check('dry run exits 0 with the service-role key', dry.status === 0, (dry.stderr || '').slice(-400));
  check('dry run performs NO writes', writes.length === 0, `writes: ${writes.join(', ')}`);
  check('dry run measures a real baseline (Storage API listing, not "unknown")', /CURRENT storage, all buckets\s*: \d/.test(dry.stdout), dry.stdout.match(/CURRENT storage.*/)?.[0]);
  check('dry run computes a verdict rather than refusing to judge', /VERDICT\s*: within ceiling/.test(dry.stdout));

  // THE REGRESSION: production returned 400 (not 404) from the public
  // endpoint for a missing object, for both HEAD and GET+Range. The fake
  // server reproduces that for every name it has not already been told
  // exists; a correct runner must never trigger one during discovery.
  check('discovery never sends a HEAD request to the public bucket', headRequests.length === 0, `HEAD sent to: ${headRequests.join(', ')}`);
  check('discovery never triggers a public 400 (never asks the public endpoint "does X exist")',
    publicMiss400s.length === 0, `hit: ${publicMiss400s.join(', ')}`);

  // 4. discovery: 3 real images (bldg-1 deduplicated, query string stripped,
  //    rendition/foreign/draft entries excluded), 1 reported missing
  check('discovery finds exactly the 3 live originals', /active-listing images\s*: 3/.test(dry.stdout), dry.stdout.match(/active-listing images.*/)?.[0]);
  check('a referenced object that is not in Storage is reported, not silently dropped', /gone\.jpg/.test(dry.stdout));
  // The pre-existing rendition is found through the LISTING: exactly 1
  // already up, so still-needing-work stays 3 (each image is missing at
  // least one of the other three profiles) but the total rendition count
  // due is one short of a from-scratch run.
  check('the pre-existing rendition is recognised via listing, not (re)generated', /rendition objects already up\s*: 1/.test(dry.stdout), dry.stdout.match(/already up.*/)?.[0]);
  check('all 3 images still have work outstanding', /images still needing work\s*: 3/.test(dry.stdout));

  // 5. Storage API pagination genuinely happened: the filler/ subtree has
  //    1005 objects, well past PAGE=1000, so it must have taken two calls.
  const fillerCalls = listCalls.filter((c) => c.prefix === 'filler/');
  check('discovery paginates a bucket that exceeds one page (filler/, 1005 objects)',
    fillerCalls.length === 2, `calls: ${JSON.stringify(fillerCalls)}`);
  check('pagination advances by offset, not by re-requesting the same page',
    fillerCalls.length === 2 && fillerCalls[0].offset === 0 && fillerCalls[1].offset === 1000,
    JSON.stringify(fillerCalls));

  // 6. apply writes only the renditions that do not already exist
  const APPLY_ENV = { ...RO, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' };
  const apply = await runScript(['--apply'], APPLY_ENV);
  check('apply exits 0', apply.status === 0, (apply.stderr || '').slice(-400));
  check('apply wrote 11 renditions (3 images x 4 profiles, minus the 1 pre-existing)', writes.length === 11, `writes: ${writes.length}`);
  check('every write is under renditions/', writes.every((w) => w.startsWith('renditions/')), writes.filter((w) => !w.startsWith('renditions/')).join(', '));
  check('the pre-existing rendition was never re-uploaded', !writes.includes(preexistingPath), writes.join(', '));
  const untouched = [...originalsBefore].every(([n, b]) => store.get(n)?.equals(b));
  check('every original is byte-identical after apply', untouched);
  check('no original was deleted', [...originalsBefore.keys()].every((n) => store.has(n)));
  check('the pre-existing rendition is untouched, byte-identical', store.get(preexistingPath)?.equals(preexistingBefore));
  check('apply never sends a HEAD request', headRequests.length === 0, `HEAD sent to: ${headRequests.join(', ')}`);
  check('apply — including its post-upload verify step — never triggers a public 400', publicMiss400s.length === 0, `hit: ${publicMiss400s.join(', ')}`);

  // 7. idempotent: a second apply writes nothing new
  const before = writes.length;
  const again = await runScript(['--apply'], APPLY_ENV);
  check('a second apply exits 0', again.status === 0, (again.stderr || '').slice(-300));
  check('a second apply writes nothing new (idempotent)', writes.length === before, `new writes: ${writes.length - before}`);

  // 8. fail closed: apply refuses when total storage cannot be measured
  bucketListWorks = false;
  store.delete(renditionPath('unit-1.jpg', 'thumbnail'));          // give it work to do
  const blind = await runScript(['--apply'], APPLY_ENV);
  check('apply REFUSES to write when the ceiling cannot be enforced (exit 4)', blind.status === 4, `exit ${blind.status}`);
  check('the refusal explains itself and writes nothing', /storage ceiling cannot be enforced/.test(blind.stderr) && writes.length === before, blind.stderr.slice(-200));
  bucketListWorks = true;
} finally {
  try { server.close(); } catch {}
  if (pgStarted) { try { pg('pg_ctl', ['-D', join(work, 'data'), 'stop']); } catch {} }
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
