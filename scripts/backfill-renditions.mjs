#!/usr/bin/env node
// backfill-renditions.mjs — one-time, resumable generation of delivery
// renditions for images on ACTIVE listings: the property gallery
// (properties.images, via the property_images registry) AND every unit
// type's own gallery (unit_types.images). The first backfill covered only
// the registry, which is synced from properties.images alone, so unit photos
// uploaded before renditions shipped had no rendition object and the public
// unit cards requested a 404. Re-running this script is what generates them.
//
// WHY A NODE RUNNER AND NOT AN ADMIN-PAGE BUTTON. ~550 images x 4 encodes is
// tens of minutes of work. Tying that to a browser tab staying open makes the
// job's success depend on someone not closing a laptop, and a half-finished run
// leaves no record of where it stopped. This runs headless, in bounded batches,
// and persists progress so it can be resumed.
//
// WHAT IT SHARES WITH THE FRONTEND. The rendition CONTRACT — profile widths,
// qualities, and the deterministic path — is imported from image-renditions.js,
// so the runner and the upload path can never disagree about where a rendition
// lives or how large it should be. Only the encoder differs (ImageMagick here,
// canvas in the browser), because Node has no canvas.
//
// SAFETY, in order of importance:
//   * NEVER writes to an original's path. Every write goes under renditions/.
//   * NEVER deletes. There is no delete call anywhere in this file.
//   * Idempotent: an existing rendition is skipped, so a partial run is simply
//     re-run rather than repaired.
//   * The storage ceiling is enforced from ACTUAL accumulated bytes, checked
//     BEFORE each write — not from an estimate made up front.
//   * One image failing never stops the run; failures are recorded for retry.
//
// USAGE
//   node scripts/backfill-renditions.mjs --dry-run [--sample N]
//   node scripts/backfill-renditions.mjs --apply [--batch-size N] [--limit N]
//
// CREDENTIALS, and why discovery goes over HTTP rather than the storage schema.
// The production read-only role deliberately has NO access to the `storage`
// schema, so `SELECT ... FROM storage.objects` fails with "permission denied
// for schema storage". Object existence and size are therefore discovered over
// plain HTTP instead: property-images is a public-read bucket ("Public read
// property images", migration 20260804150000), so an unauthenticated GET with
// Range: bytes=0-0 returns an object's real size (via Content-Range, or
// Content-Length if Range is ignored), or 404 when it is not there — the same
// request pattern a visitor's browser makes for every photo on the site.
// NOT HEAD: production's HEAD route for this exact endpoint returned 400 for
// an object that had simply never been generated, not the 404 a "does it
// exist" check needs (see probeObject()'s own comment for the full story).
// A dry run consequently needs NO Storage credential at all, which is what
// lets it run under least privilege AND keeps every write-capable credential
// out of it.
//
// ENV
//   PINTAG_DB_URL              postgres connection. Read-only queries against
//                              the `public` schema only; no storage-schema grant.
//   SUPABASE_URL               https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  REQUIRED for --apply only. Writes renditions and
//                              measures total storage for the ceiling. A dry
//                              run never needs it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('../image-renditions.js');
const { PT_RENDITION_PROFILES, PT_RENDITION_PREFIX, renditionPath } = mod.default ?? mod;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const APPLY      = has('--apply');
const SAMPLE     = parseInt(val('--sample', '60'), 10);
const BATCH      = parseInt(val('--batch-size', '25'), 10);
const LIMIT      = parseInt(val('--limit', '0'), 10);
const STATE_FILE = val('--state', '.rendition-backfill-state.json');
const QA_DIR     = val('--qa-dir', '');
// Hard ceiling, well under the 1 GB Free limit. Checked against ACTUAL bytes.
const STORAGE_CEILING = 0.75 * 1024 ** 3;
const SEP = '';   // ASCII SOH: cannot occur in an object name or slug

const DB     = process.env.PINTAG_DB_URL;
const SB     = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SKEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = 'property-images';

// -q matters more than it looks. Without it psql prints the command TAG of every
// non-SELECT statement to stdout, so the read-only pin below emits a bare "SET"
// line that -t does NOT suppress. Parsed as data that becomes a phantom row: an
// object named "SET" with no size, which poisons every byte total to NaN and
// sends the downloader after an object that does not exist.
function psql(sql) {
  return execFileSync('psql', [DB, '-X', '-q', '-A', '-t', '-F', SEP, '-v', 'ON_ERROR_STOP=1',
    '-c', `SET default_transaction_read_only=on; ${sql}`],
    { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').filter(Boolean).map((l) => l.split(SEP));
}

// A byte count that silently becomes NaN disables the storage ceiling, because
// every comparison against NaN is false. Refuse to continue instead.
function bytesOf(raw, what) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`unparseable size for ${what}: ${JSON.stringify(raw)}`);
  return n;
}
const fmt = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

// ── 1-3. active listings -> their images -> the real Storage object ─────────
// The active filter is the SAME predicate the public site uses
// (status in active/available). Drafts, archived, deleted and orphaned objects
// are excluded HERE rather than filtered later, so nothing outside the publicly
// delivered set can ever be written.
//
// Reads the `public` schema ONLY. Whether each object actually exists — what
// the old JOIN to storage.objects decided — is settled afterwards by
// probeObject(), so no storage-schema grant is required.
//
// Two sources, de-duplicated on the object name:
//   * property_images — the registry of properties.images (building gallery).
//   * unit_types.images — each unit type's OWN gallery. The registry never
//     tracks these (its sync trigger is on properties.images only), so they
//     must be enumerated from the column: a text[] of full public URLs, mapped
//     back to the object name the same way objectNameFromPublicUrl() does in
//     the browser (strip the public-bucket prefix and any query string).
function candidateImages() {
  const PUB = `/storage/v1/object/public/${BUCKET}/`;
  return psql(`
    SELECT storage_path, MIN(slug)
    FROM (
      SELECT pi.storage_path AS storage_path, p.slug AS slug
      FROM property_images pi
      JOIN properties p ON p.id = pi.property_id
      WHERE pi.status = 'active'
        AND p.status IN ('active','available')
        AND pi.storage_path NOT LIKE 'renditions/%'
      UNION ALL
      SELECT ui.name AS storage_path, p.slug AS slug
      FROM unit_types ut
      JOIN properties p ON p.id = ut.property_id
      CROSS JOIN LATERAL (
        SELECT split_part(substring(img FROM position('${PUB}' IN img) + length('${PUB}')), '?', 1) AS name
        FROM unnest(COALESCE(ut.images, ARRAY[]::text[])) AS img
        WHERE position('${PUB}' IN img) > 0
      ) ui
      WHERE p.status IN ('active','available')
        AND ui.name <> ''
        AND ui.name NOT LIKE 'renditions/%'
    ) src
    GROUP BY storage_path
    ORDER BY storage_path;`)
    .map(([storage_path, slug]) => ({ storage_path, slug }));
}

// GET one byte of an object on the PUBLIC bucket (Range: bytes=0-0). No
// credential is used or needed: this is the same unauthenticated request
// pattern the site's images already make; the Range header just keeps a
// probe of a 200-400KB rendition cheap.
//
// NOT a HEAD request. Production returned "HEAD 400 renditions/<stem>/
// card.webp" here for an object that had simply never been generated --
// not the 404 the code expected, so withRetry() (which never retries a 4xx)
// surfaced it as a fatal error and killed the run before a single rendition
// was checked. GET is what this codebase has already PROVEN correct against
// this exact bucket: cloudflare-worker/image-cdn-worker.js — live in
// production -- does `fetch(originUrl, { method: 'GET' })` for the identical
// /storage/v1/object/public/property-images/ path and keys its whole
// cache/404 behaviour on originResp.status === 404 for a missing object.
// Supabase's HEAD route for this endpoint is evidently not equivalent to
// its GET route; rather than guess at HEAD's rules, this uses the method
// already verified to behave correctly here.
//
// Still narrow: ONLY 404 is "does not exist". Any other non-2xx (400
// included) is a real, unexplained failure and is thrown/retried exactly as
// before -- a 400 must never be silently read as "missing".
async function probeObject(objectName) {
  const url = publicUrl(objectName);
  const res = await withRetry(`probe ${objectName}`, async () => {
    const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) });
    // A 404 is an ANSWER, not a failure: returned rather than thrown, so
    // withRetry() does not spend attempts re-asking a settled question.
    if (!r.ok && r.status !== 404) {
      const err = new Error(`GET ${r.status} ${objectName}`);
      err.status = r.status;
      throw err;
    }
    return r;
  });
  if (res.status === 404) { await drain(res); return { exists: false, size: 0 }; }
  // A satisfiable Range answers 206 with Content-Range: "bytes 0-0/<total>" --
  // the object's REAL size, not the one byte actually sent. A backend that
  // ignores Range just returns the whole object as 200, whose
  // Content-Length already IS the real size; only that path is the fallback.
  const range = res.headers.get('content-range');
  const total = range ? Number(range.split('/')[1]) : NaN;
  const len = Number.isFinite(total) ? total : Number(res.headers.get('content-length'));
  await drain(res);
  return { exists: true, size: Number.isFinite(len) ? len : 0 };
}

// A probe response is read for its headers only; draining/cancelling the
// (0-1 byte, or occasionally a whole rendition) body is what lets undici
// release the connection instead of leaking it across thousands of probes.
async function drain(res) {
  try { await res.body?.cancel(); } catch (_e) { /* best effort */ }
}

// Bounded-concurrency map. Thousands of probes one at a time would dominate
// the run; unbounded would hammer Storage. Results keep the input's order.
async function mapPool(items, worker, concurrency = 12) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await worker(items[i]);
  }));
  return out;
}

// The candidate list narrowed to objects that really exist, each carrying its
// true size — the two things the storage.objects JOIN used to provide.
async function activeImages() {
  const rows = candidateImages();
  const probes = await mapPool(rows, (r) => probeObject(r.storage_path));
  const found = [];
  const missing = [];
  rows.forEach((r, i) => (probes[i].exists ? found.push({ ...r, size: probes[i].size }) : missing.push(r.storage_path)));
  if (missing.length) {
    // The old JOIN dropped these silently. A listing referencing an image that
    // is not in Storage is worth saying out loud; repairing it is not this
    // script's job, so it is reported and skipped.
    console.log(`  NOTE: ${missing.length} referenced image(s) are not in Storage and are skipped:`);
    for (const name of missing.slice(0, 10)) console.log(`        ${name}`);
    if (missing.length > 10) console.log(`        … and ${missing.length - 10} more`);
  }
  return found;
}

// Which renditions already exist, established by asking for each one. A 404
// means "still to generate"; anything present is skipped, so a re-run stays
// idempotent exactly as before.
async function existingRenditions(images) {
  const paths = [];
  for (const im of images) {
    for (const profile of Object.keys(PT_RENDITION_PROFILES)) {
      const path = renditionPath(im.storage_path, profile);
      if (path) paths.push(path);
    }
  }
  const probes = await mapPool(paths, probeObject);
  const set = new Set();
  paths.forEach((path, i) => { if (probes[i].exists) set.add(path); });
  return set;
}

// Total bytes across ALL buckets — the ceiling's starting point.
//
// The storage schema is exact and one query, and is what a full-access
// connection string run by hand will use. The production read-only role cannot
// read it, so the fallback measures the same total over the Storage API, which
// needs the service-role key and is therefore available in apply mode only.
// Returns null when neither source is available; the caller decides what that
// means — a dry run reports without a verdict, an apply run refuses to write.
// The exact, one-query answer — available only to a connection that can read
// the storage schema. Returns null when the role cannot.
//
// Kept as its own function so the no-print rule below is structural: NOTHING
// here may echo the error, because execFileSync puts the whole command line
// into its message and that includes the connection string.
function storageBytesFromDb() {
  try {
    const [[bytes]] = psql(`SELECT COALESCE(sum((metadata->>'size')::bigint),0) FROM storage.objects;`);
    return bytesOf(bytes, 'storage.objects total');
  } catch (err) {
    const denied = /permission denied|does not exist|no schema/i.test(String(err && err.message));
    if (!denied) throw new Error('storage.objects query failed (message suppressed: it quotes the connection string)');
    return null;
  }
}

async function currentStorageBytes() {
  const fromDb = storageBytesFromDb();
  if (fromDb != null) return fromDb;
  console.log('  storage.objects is not readable by this role — expected for the least-privilege role.');
  if (!SKEY) return null;
  console.log('  Measuring total storage over the Storage API instead…');
  try {
    return await storageApiUsageBytes();
  } catch (err) {
    // Returning null rather than throwing keeps the failure a clean, explained
    // refusal (apply exits 4 below) instead of an unhandled rejection.
    console.log(`  Storage API measurement failed: ${err && err.message}`);
    return null;
  }
}

// Sum every object in every bucket through the Storage API. Read-only: the
// verbs are GET (buckets) and POST to the *list* endpoint, which creates
// nothing.
async function storageApiUsageBytes() {
  const auth = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };
  const buckets = await (await withRetry('list buckets', () => req(`${SB}/storage/v1/bucket`, { headers: auth }))).json();
  if (!Array.isArray(buckets)) throw new Error('unexpected /storage/v1/bucket response');
  let total = 0;
  for (const bucket of buckets) total += await listPrefixBytes(bucket.name || bucket.id, auth, '');
  return total;
}

async function listPrefixBytes(bucket, auth, prefix) {
  const PAGE = 1000;
  let total = 0;
  for (let offset = 0; ; offset += PAGE) {
    const res = await withRetry(`list ${bucket}/${prefix}`, () => req(`${SB}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    }));
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return total;
    for (const row of rows) {
      // A folder comes back with a null id and no metadata: recurse into it.
      if (row.id == null) total += await listPrefixBytes(bucket, auth, `${prefix}${row.name}/`);
      else total += Number(row.metadata && row.metadata.size) || 0;
    }
    if (rows.length < PAGE) return total;
  }
}

// ── 4. encode ──────────────────────────────────────────────────────────────
// "-resize WIDTHx>" only ever SHRINKS (ImageMagick's ">" flag), mirroring
// renditionTargets()'s Math.min in the browser: a 300px source is never blown
// up to 1200, which would cost bytes and add no detail.
function encode(srcPath, outPath, width, quality) {
  execFileSync('convert', [srcPath, '-resize', `${width}x>`,
    '-quality', String(Math.round(quality * 100)),
    '-define', 'webp:method=6', outPath], { stdio: 'pipe' });
  return statSync(outPath).size;
}

const publicUrl = (name) =>
  `${SB}/storage/v1/object/public/${BUCKET}/${name.split('/').map(encodeURIComponent).join('/')}`;

// A backfill runs for tens of minutes across hundreds of requests, so a single
// stalled connection must not be able to hang the whole job: every request gets
// a deadline. Transient failures (5xx, timeout) are retried with backoff; a 4xx
// is a fact about the object, not a hiccup, so it fails straight through to the
// per-image handler and gets recorded for later inspection.
async function withRetry(what, fn, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err && err.status;
      const fatal = status >= 400 && status < 500;
      if (fatal || attempt >= tries) throw err;
      console.error(`  retry ${attempt}/${tries - 1} ${what}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
}

async function req(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  if (!res.ok) {
    const err = new Error(`${init.method || 'GET'} ${res.status}: ${(await res.text()).slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function download(objectName, dest) {
  const res = await withRetry(`download ${objectName}`, () => req(publicUrl(objectName)));
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// ── 5-6. upload + verify ───────────────────────────────────────────────────
async function upload(path, filePath) {
  // Defence in depth AT THE WRITE BOUNDARY. This function is the only thing in
  // the repository that can overwrite a Storage object, so it re-checks the
  // destination itself rather than trusting whatever the caller computed: a
  // path outside renditions/ would overwrite an ORIGINAL photo, which nothing
  // in this script is ever allowed to do.
  if (typeof path !== 'string' || !path.startsWith(PT_RENDITION_PREFIX) || path.includes('..')) {
    throw new Error(`refusing to write outside ${PT_RENDITION_PREFIX}: ${JSON.stringify(path)}`);
  }
  const body = readFileSync(filePath);
  await withRetry(`upload ${path}`, () => req(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SKEY,
      Authorization: `Bearer ${SKEY}`,
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'x-upsert': 'true'   // idempotent: a re-run overwrites, never duplicates
    },
    body
  }));
  // Verify it is genuinely readable at its public URL before counting it done —
  // a 2xx on write is not proof that delivery works. GET+Range, not HEAD, for
  // the same reason probeObject() gives up HEAD entirely: production's HEAD
  // route 400'd on this exact endpoint, which req()'s "any non-2xx throws"
  // rule would have turned into every single successful upload being logged
  // as a FAILED image. req() already throws on a 404 here too (a truly
  // missing object right after its own upload is exactly the kind of real
  // failure this check exists to catch), so the "reject anything but 2xx"
  // contract is unchanged -- only the HTTP method is.
  const verified = await withRetry(`verify ${path}`, () => req(publicUrl(path), {
    method: 'GET', headers: { Range: 'bytes=0-0' }
  }));
  await drain(verified);
  return body.length;
}

// ── main ───────────────────────────────────────────────────────────────────
if (!DB) { console.error('PINTAG_DB_URL is required'); process.exit(1); }
if (APPLY && !SKEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required for --apply.');
  console.error('CI has no credential that can write to Storage today — add the secret first.');
  process.exit(2);
}

const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : { done: [], failed: {}, bytesWritten: 0 };
const doneSet = new Set(state.done);

console.log('── DISCOVERY ─────────────────────────────────────────');
console.log('  Reading listings from the database (public schema only)…');
const images   = await activeImages();
console.log(`  Checking which renditions already exist (GET, public bucket)…`);
const already  = await existingRenditions(images);
const profiles = Object.keys(PT_RENDITION_PROFILES);

const needed = images.filter((im) =>
  !doneSet.has(im.storage_path) &&
  profiles.some((p) => !already.has(renditionPath(im.storage_path, p))));

const baseline = await currentStorageBytes();
// A write must never be sized against a guess. Without a real baseline the
// ceiling cannot be enforced, so apply refuses rather than writing blind.
if (APPLY && baseline == null) {
  console.error('\n  ABORT: total storage could not be measured, so the storage ceiling cannot be enforced.');
  console.error('  Nothing was written. Give the run a connection that can read storage.objects,');
  console.error('  or a SUPABASE_SERVICE_ROLE_KEY that can list buckets over the Storage API.');
  process.exit(4);
}
console.log('\n── SCOPE ─────────────────────────────────────────────');
console.log(`  active-listing images        : ${images.length}`);
console.log(`  distinct active listings     : ${new Set(images.map((i) => i.slug)).size}`);
console.log(`  rendition objects already up : ${already.size}`);
console.log(`  images still needing work    : ${needed.length}`);
console.log(`  their originals total        : ${fmt(images.reduce((a, i) => a + i.size, 0))}`);
console.log(`  CURRENT storage, all buckets : ${baseline == null ? 'not measurable with dry-run credentials' : fmt(baseline)}`);

const work = LIMIT > 0 ? needed.slice(0, LIMIT) : needed;
const tmp  = mkdtempSync(join(tmpdir(), 'rend-'));
if (QA_DIR) mkdirSync(QA_DIR, { recursive: true });

let produced = 0, bytes = 0, failed = 0, processed = 0;
const perProfile = {};   // measured bytes per profile, for the delivery arithmetic
const target = APPLY ? work.length : Math.min(SAMPLE, work.length);
// Storage paths are timestamp-prefixed, so consecutive ones are photos of the
// SAME listing shot on the same camera. Sampling the first N would measure a
// handful of listings and call it the site average. Stride across the whole set
// instead — still deterministic, so a re-run measures the same images.
const stride = target > 0 ? work.length / target : 1;
const queue = APPLY ? work
  : Array.from({ length: target }, (_, k) => work[Math.floor(k * stride)]);
console.log(`\n── ${APPLY ? 'APPLY' : `DRY RUN (every ${stride.toFixed(1)}th image)`} (${target} images) ──`);

for (let i = 0; i < queue.length; i++) {
  const im = queue[i];
  const src = join(tmp, 'src');
  try {
    await download(im.storage_path, src);
    for (const profile of profiles) {
      const path = renditionPath(im.storage_path, profile);
      if (already.has(path)) continue;
      const out = join(tmp, `${profile}.webp`);
      const size = encode(src, out, PT_RENDITION_PROFILES[profile].width, PT_RENDITION_PROFILES[profile].quality);

      // Ceiling check on ACTUAL accumulated bytes, before the write. baseline
      // is guaranteed non-null here: apply aborts above when it is unknown.
      if (baseline != null && baseline + bytes + size > STORAGE_CEILING) {
        console.error(`\n  ABORT: next write reaches ${fmt(baseline + bytes + size)}, over the ${fmt(STORAGE_CEILING)} ceiling.`);
        writeFileSync(STATE_FILE, JSON.stringify({ ...state, done: [...doneSet], bytesWritten: state.bytesWritten + bytes }, null, 2));
        process.exit(3);
      }
      if (APPLY) await upload(path, out);
      if (QA_DIR) copyFileSync(out, join(QA_DIR, `${im.storage_path.replace(/\W+/g, '_')}__${profile}.webp`));
      (perProfile[profile] ||= []).push(size);
      bytes += size; produced++;
    }
    if (QA_DIR) copyFileSync(src, join(QA_DIR, `${im.storage_path.replace(/\W+/g, '_')}__original`));
    doneSet.add(im.storage_path);
    delete state.failed[im.storage_path];
  } catch (err) {
    failed++;
    state.failed[im.storage_path] = String(err.message || err);
    console.error(`  FAIL ${im.storage_path}: ${err.message}`);
  }
  processed++;
  if (processed % BATCH === 0) {
    console.log(`  … ${processed}/${target}  renditions=${produced}  ${fmt(bytes)}  failed=${failed}`);
    if (APPLY) writeFileSync(STATE_FILE, JSON.stringify({ ...state, done: [...doneSet], bytesWritten: state.bytesWritten + bytes }, null, 2));
  }
}

if (APPLY) writeFileSync(STATE_FILE, JSON.stringify({ ...state, done: [...doneSet], bytesWritten: state.bytesWritten + bytes }, null, 2));
rmSync(tmp, { recursive: true, force: true });

const ok = processed - failed;
const perImage = ok > 0 ? bytes / ok : 0;
const projected = perImage * needed.length;

console.log('\n── SUMMARY ───────────────────────────────────────────');
console.log(`  images processed     : ${processed}   (failed ${failed})`);
console.log(`  renditions produced  : ${produced}`);
console.log(`  bytes produced       : ${fmt(bytes)}`);
console.log(`  measured per image   : ${(perImage / 1024).toFixed(0)} kB across ${profiles.length} renditions`);
console.log('\n  per profile (measured from the encoded files):');
for (const profile of profiles) {
  const v = (perProfile[profile] || []).slice().sort((a, b) => a - b);
  if (!v.length) continue;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  console.log(`    ${profile.padEnd(9)} w=${String(PT_RENDITION_PROFILES[profile].width).padStart(4)}  `
    + `n=${String(v.length).padStart(3)}  mean=${(mean / 1024).toFixed(0)} kB  `
    + `median=${(v[v.length >> 1] / 1024).toFixed(0)} kB  max=${(v[v.length - 1] / 1024).toFixed(0)} kB`);
}
const srcSizes = queue.slice(0, processed).map((i) => i.size).sort((a, b) => a - b);
if (srcSizes.length) {
  console.log(`    ORIGINAL       n=${String(srcSizes.length).padStart(3)}  `
    + `mean=${(srcSizes.reduce((a, b) => a + b, 0) / srcSizes.length / 1024).toFixed(0)} kB  `
    + `median=${(srcSizes[srcSizes.length >> 1] / 1024).toFixed(0)} kB  `
    + `max=${(srcSizes[srcSizes.length - 1] / 1024).toFixed(0)} kB`);
}
if (!APPLY) {
  console.log(`\n  PROJECTION for all ${needed.length} images needing work:`);
  console.log(`    additional storage : ${fmt(projected)}`);
  console.log(`    ceiling            : ${fmt(STORAGE_CEILING)}`);
  if (baseline == null) {
    // Least-privilege dry run: total storage is not readable without a
    // Storage credential, and inventing one would be worse than saying so.
    // The guarantee is not weakened — apply measures the real total and
    // refuses to start without it, then re-checks before every single write.
    console.log('    projected total    : unknown (total storage needs a Storage credential)');
    console.log('    VERDICT            : apply measures the real total before it writes, and');
    console.log('                         aborts at the ceiling; it refuses to start if it cannot.');
  } else {
    console.log(`    projected total    : ${fmt(baseline + projected)} of 1024.0 MB limit`);
    console.log(`    VERDICT            : ${baseline + projected > STORAGE_CEILING ? 'EXCEEDS CEILING — DO NOT RUN' : 'within ceiling'}`);
  }
}
if (Object.keys(state.failed).length) {
  // The state file is only written under --apply; a dry run keeps nothing.
  console.log(`\n  retryable failures   : ${Object.keys(state.failed).length} ${APPLY ? `(recorded in ${STATE_FILE})` : '(not recorded: --dry-run writes no state file)'}`);
}
