// End-to-end proof that the rendition backfill works under LEAST PRIVILEGE —
// i.e. with a database role that has no access to the `storage` schema, which
// is what the production read-only role is and what made the first CI dry run
// fail with "ERROR: permission denied for schema storage".
//
//   node tests/backfill-renditions/e2e.mjs
//
// Nothing here touches production. It boots a throwaway PostgreSQL cluster, a
// fake Supabase Storage server on localhost, and a stub `convert`, then runs
// the REAL scripts/backfill-renditions.mjs against them. Skips (exit 0) when
// initdb/psql are unavailable, so it is safe to run anywhere.
//
// What it proves:
//   1. A dry run completes as a role that CANNOT read the storage schema.
//   2. A dry run writes NOTHING to Storage.
//   2b. Neither a dry run nor apply EVER sends a HEAD request to the public
//       bucket -- the fake server 400s every HEAD to it, reproducing the
//       real production failure ("HEAD 400 renditions/<stem>/card.webp"),
//       so this is a genuine regression test for that bug, not just a
//       source-level assertion.
//   3. Discovery finds unit-type photos, deduplicates them against the
//      building gallery, and skips objects that are not in Storage.
//   4. Apply writes only under renditions/ and leaves every original byte-identical.
//   5. Apply is idempotent: a second run writes nothing new.
//   6. Apply REFUSES to write (exit 4) when total storage cannot be measured,
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
const headRequests = [];                 // every HEAD the script sends (must stay empty)
let bucketListWorks = true;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const pub = '/storage/v1/object/public/property-images/';
  const write = '/storage/v1/object/property-images/';
  const send = (code, body, headers = {}) => { res.writeHead(code, headers); res.end(body); };

  if (url.pathname.startsWith(pub)) {                      // public read: NO auth
    // Reproduces the REAL production bug (2026-09): Supabase's HEAD route for
    // this exact endpoint answered "HEAD 400 renditions/<stem>/card.webp" for
    // an object that had simply never been generated -- not the 404 a
    // "does it exist" check needs. Any HEAD here, to ANY path (existing
    // object or not), gets that same 400 -- exercising the fix means the
    // script must never depend on HEAD succeeding at all.
    if (req.method === 'HEAD') { headRequests.push(url.pathname); return send(400, '{"error":"Bad Request"}'); }

    const name = decodeURIComponent(url.pathname.slice(pub.length));
    const buf = store.get(name);
    if (!buf) return send(404, '{"error":"not found"}');
    // A real Range request is honoured: 206 + Content-Range carrying the
    // OBJECT'S TOTAL size (not the one byte actually sent), matching what
    // an S3-compatible backend does and what probeObject() relies on.
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
      const { prefix = '' } = JSON.parse(body || '{}');
      const seen = new Map();
      for (const [name, buf] of store) {
        if (!name.startsWith(prefix)) continue;
        const rest = name.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(rest, { name: rest, id: name, metadata: { size: buf.length } });
        else seen.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null });
      }
      send(200, JSON.stringify([...seen.values()]));
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
// blocking spawnSync would stop it answering the script's HEAD requests and
// every probe would time out.
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
    CREATE SCHEMA storage;
    CREATE TABLE storage.objects (bucket_id text, name text, metadata jsonb);
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
    -- The production shape: a role that can read public but NOT the storage schema.
    CREATE ROLE backup_ro LOGIN;
    GRANT USAGE ON SCHEMA public TO backup_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_ro;
    REVOKE ALL ON SCHEMA storage FROM backup_ro;
  `);

  // Objects that really exist. 'gone.jpg' deliberately does NOT.
  for (const n of ['bldg-1.jpg', 'unit-1.jpg', 'unit-2.jpg', 'draft-1.jpg', 'draft-unit.jpg']) store.set(n, Buffer.concat([PNG, Buffer.alloc(1000)]));
  const originalsBefore = new Map([...store].map(([k, v]) => [k, Buffer.from(v)]));
  await new Promise((r) => server.listen(HTTP_PORT, r));

  // Stub encoder: the script shells out to ImageMagick, which this harness is
  // not testing. It writes a plausibly smaller output so the size logic runs.
  mkdirSync(join(work, 'bin'), { recursive: true });
  writeFileSync(join(work, 'bin', 'convert'), '#!/bin/sh\nout=$(eval echo \\${$#})\nprintf "webp-stub" > "$out"\n');
  chmodSync(join(work, 'bin', 'convert'), 0o755);

  const RO = { PINTAG_DB_URL: `postgresql://backup_ro@localhost:${PORT}/postgres`, SUPABASE_URL: SB };
  delete RO.SUPABASE_SERVICE_ROLE_KEY;

  // 1. the role genuinely cannot read the storage schema (the reported failure)
  let denied = '';
  try { sql('backup_ro', 'SELECT count(*) FROM storage.objects'); } catch (e) { denied = e.message; }
  check('the test role reproduces "permission denied for schema storage"', /permission denied for schema storage/i.test(denied), denied);

  // 2. dry run completes under that role, and writes nothing
  const dry = await runScript(['--dry-run', '--sample', '10'], RO);
  if (process.env.E2E_DEBUG) { console.log('--- dry stdout ---\n' + dry.stdout + '\n--- dry stderr ---\n' + dry.stderr); }
  check('dry run exits 0 under the least-privilege role', dry.status === 0, (dry.stderr || '').slice(-400));
  // psql still prints the refusal on stderr (it inherits the terminal) — the
  // point is that it is no longer FATAL: the run hits the real condition and
  // carries on to produce a full report.
  check('the dry run really does hit the permission refusal', /permission denied for schema storage/i.test(dry.stdout + dry.stderr));
  check('…and treats it as expected rather than fatal', /not readable by this role/.test(dry.stdout) && /── SCOPE/.test(dry.stdout));
  check('dry run performs NO writes', writes.length === 0, `writes: ${writes.join(', ')}`);
  check('dry run reports no verdict it cannot compute', /projected total\s*: unknown/.test(dry.stdout));
  // THE REGRESSION: production failed with "HEAD 400 renditions/<stem>/
  // card.webp" during discovery. The fake server 400s EVERY HEAD to this
  // endpoint (existing object or not), so the dry run completing cleanly
  // above already proves the fix; this makes the guarantee explicit and
  // names exactly what must never happen again.
  check('discovery never sends a HEAD request to the public bucket', headRequests.length === 0, `HEAD sent to: ${headRequests.join(', ')}`);

  // 3. discovery: 3 real images (bldg-1 deduplicated, query string stripped,
  //    rendition/foreign/draft entries excluded), 1 reported missing
  check('discovery finds exactly the 3 live originals', /active-listing images\s*: 3/.test(dry.stdout), dry.stdout.match(/active-listing images.*/)?.[0]);
  check('a referenced object that is not in Storage is reported, not silently dropped', /gone\.jpg/.test(dry.stdout));
  check('all 3 need work (no renditions exist yet)', /images still needing work\s*: 3/.test(dry.stdout));

  // 4. apply writes only under renditions/, originals untouched
  const APPLY_ENV = { ...RO, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' };
  const apply = await runScript(['--apply'], APPLY_ENV);
  check('apply exits 0', apply.status === 0, (apply.stderr || '').slice(-400));
  check('apply wrote 12 renditions (3 images x 4 profiles)', writes.length === 12, `writes: ${writes.length}`);
  check('every write is under renditions/', writes.every((w) => w.startsWith('renditions/')), writes.filter((w) => !w.startsWith('renditions/')).join(', '));
  const untouched = [...originalsBefore].every(([n, b]) => store.get(n)?.equals(b));
  check('every original is byte-identical after apply', untouched);
  check('no original was deleted', [...originalsBefore.keys()].every((n) => store.has(n)));
  check('apply -- including its post-upload verify step -- never sends a HEAD request', headRequests.length === 0, `HEAD sent to: ${headRequests.join(', ')}`);

  // 5. idempotent: a second apply writes nothing new
  const before = writes.length;
  const again = await runScript(['--apply'], APPLY_ENV);
  check('a second apply exits 0', again.status === 0, (again.stderr || '').slice(-300));
  check('a second apply writes nothing new (idempotent)', writes.length === before, `new writes: ${writes.length - before}`);

  // 6. fail closed: apply refuses when total storage cannot be measured
  bucketListWorks = false;
  store.delete('renditions/unit-1/card.webp');          // give it work to do
  const blind = await runScript(['--apply'], APPLY_ENV);
  check('apply REFUSES to write when the ceiling cannot be enforced (exit 4)', blind.status === 4, `exit ${blind.status}`);
  check('the refusal explains itself and writes nothing', /storage ceiling cannot be enforced/.test(blind.stderr) && writes.length === before - 0, blind.stderr.slice(-200));
  bucketListWorks = true;
} finally {
  try { server.close(); } catch {}
  if (pgStarted) { try { pg('pg_ctl', ['-D', join(work, 'data'), 'stop']); } catch {} }
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
