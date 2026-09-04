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
// CREDENTIALS, and why a DRY RUN needs the service-role key too.
// The production read-only DB role deliberately has NO access to the
// `storage` schema, so `SELECT ... FROM storage.objects` fails with
// "permission denied for schema storage" — this script never issues that
// query, in dry-run or apply. Object existence and size cannot be settled by
// asking the DB, and they also cannot be settled by asking Storage's PUBLIC
// object endpoint: this deployment's public GET/HEAD route returns 400 (not
// 404) for an object that does not exist, for BOTH methods, with or without
// a Range header (see history in this file's git log: HEAD 400, then GET+
// Range 400 too). A 400 is indistinguishable from a real error, so it can
// never be read as "missing" — which means public probing cannot be used
// for discovery at all, not even to find out an object is absent.
//
// The one operation proven to answer "what exists, and how big is it" on
// this deployment is the Storage API's AUTHENTICATED list endpoint
// (POST /storage/v1/object/list/{bucket}), which needs
// SUPABASE_SERVICE_ROLE_KEY. It is read-only — it lists, it does not write —
// so using it in a dry run does not weaken the dry run's write-safety
// guarantee. That guarantee is now structural rather than credential-based:
// every write in this file (upload()) is reached only from inside
// `if (APPLY)` in main(), so a dry run performs zero writes regardless of
// which credentials it holds. See the runner-invariant tests in
// image-renditions.test.js, which assert both things: no public HEAD/GET
// probing exists anywhere in this file, and every write is APPLY-gated.
//
// ENV
//   PINTAG_DB_URL              postgres connection. Read-only queries against
//                              the `public` schema only; no storage-schema
//                              grant, and none is ever requested.
//   SUPABASE_URL               https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  REQUIRED, for --dry-run AND --apply. Used only
//                              for the authenticated (read-only) Storage list
//                              operation in a dry run; also used to upload
//                              and re-verify renditions in --apply. Read only
//                              from the environment inside the GitHub Actions
//                              runtime — never logged, committed, or shipped
//                              to any browser-facing code path.
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
const SEP = '\x01';   // ASCII SOH: cannot occur in an object name or slug

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
// every comparison against NaN is false. Refuse to continue instead. Used both
// for psql output and for each file row a Storage list response returns: a
// file with no parseable metadata.size is exactly as dangerous as an
// unparseable DB total, so it gets the same fatal treatment rather than a
// silent `|| 0`.
function bytesOf(raw, what) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`unparseable size for ${what}: ${JSON.stringify(raw)}`);
  return n;
}
const fmt = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

const authHeaders = () => ({ apikey: SKEY, Authorization: `Bearer ${SKEY}` });

// ── 1-3. active listings -> their images -> the real Storage object ─────────
// The active filter is the SAME predicate the public site uses
// (status in active/available). Drafts, archived, deleted and orphaned objects
// are excluded HERE rather than filtered later, so nothing outside the publicly
// delivered set can ever be written.
//
// Reads the `public` schema ONLY, and only `public` — never storage.objects.
// Whether each object actually exists — what the old JOIN to storage.objects
// decided — is settled afterwards against a Storage API listing (see
// listBucketObjects() below), so no storage-schema grant is required or used.
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

// ── discovery over the authenticated Storage API ────────────────────────────
// Recursively lists every object under `prefix` in `bucket` and records it
// into `into` as fullName -> size. A "folder" row comes back with a null id
// and no metadata and is recursed into; a "file" row's metadata.size is its
// real size, validated the same way a DB total is (bytesOf(): fatal, never a
// silent 0/NaN, because a corrupt size would poison the storage ceiling).
//
// This is the ONLY existence/size check in this script. There is no HEAD, no
// GET-without-list of a possibly-missing object, anywhere: production 400s
// (not 404s) on the public endpoint for a missing object regardless of
// method or Range, which makes "ask for it and see what comes back" useless
// for discovery — only listing what is actually there works.
async function listPrefixObjects(bucket, auth, prefix, into) {
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const res = await withRetry(`list ${bucket}/${prefix}`, () => req(`${SB}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    }));
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return into;
    for (const row of rows) {
      const full = `${prefix}${row.name}`;
      if (row.id == null) await listPrefixObjects(bucket, auth, `${full}/`, into);
      else into.set(full, bytesOf(row.metadata && row.metadata.size, full));
    }
    // A short page (fewer rows than asked for) is the API's own signal that
    // this was the last page — the same test pagination exercises directly.
    if (rows.length < PAGE) return into;
  }
}

async function listBucketObjects(bucket, auth) {
  return listPrefixObjects(bucket, auth, '', new Map());
}

function sumSizes(objects) {
  let total = 0;
  for (const size of objects.values()) total += size;
  return total;
}

async function listPrefixBytes(bucket, auth, prefix) {
  return sumSizes(await listPrefixObjects(bucket, auth, prefix, new Map()));
}

// The candidate list narrowed to objects the Storage listing actually found,
// each carrying its true size — the two things the storage.objects JOIN used
// to provide, now sourced from `objects` (property-images, fully listed
// up front) instead.
function activeImages(objects) {
  const rows = candidateImages();
  const found = [];
  const missing = [];
  for (const r of rows) {
    const size = objects.get(r.storage_path);
    if (size == null) missing.push(r.storage_path); else found.push({ ...r, size });
  }
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

// Which renditions already exist, established by looking each candidate path
// up in the SAME listing used for discovery — no per-object request at all,
// let alone a public HEAD/GET. A re-run stays idempotent exactly as before.
function existingRenditions(images, objects) {
  const set = new Set();
  for (const im of images) {
    for (const profile of Object.keys(PT_RENDITION_PROFILES)) {
      const path = renditionPath(im.storage_path, profile);
      if (path && objects.has(path)) set.add(path);
    }
  }
  return set;
}

// Total bytes across ALL buckets — the ceiling's starting point. Reuses the
// property-images listing already fetched for discovery (no reason to ask
// Storage for the same bucket twice) and lists every OTHER bucket fresh.
// Returns null when the total cannot be reliably measured; the caller
// decides what that means — a dry run reports without a verdict, an apply
// run refuses to write (see the fail-closed check in main(), below).
async function currentStorageBytes(propertyImagesObjects, auth) {
  try {
    const buckets = await (await withRetry('list buckets', () => req(`${SB}/storage/v1/bucket`, { headers: auth }))).json();
    if (!Array.isArray(buckets)) throw new Error('unexpected /storage/v1/bucket response');
    let total = sumSizes(propertyImagesObjects);
    for (const bucket of buckets) {
      const name = bucket.name || bucket.id;
      if (name === BUCKET) continue;   // already counted above
      total += await listPrefixBytes(name, auth, '');
    }
    return total;
  } catch (err) {
    // Returning null rather than throwing keeps the failure a clean, explained
    // refusal (apply exits 4 below) instead of an unhandled rejection.
    console.log(`  Storage API measurement failed: ${err && err.message}`);
    return null;
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

// Fetches the full original image bytes via a plain public GET — no Range,
// no existence probing. This only ever runs against an object the Storage
// listing above has ALREADY confirmed exists, so it needs none of
// probeObject()'s old "what does 400 mean here" caution: a plain GET of an
// object proven present is exactly what every visitor's browser already does
// for every photo on the site, and that path is known-good in production.
async function download(objectName, dest) {
  const res = await withRetry(`download ${objectName}`, () => req(publicUrl(objectName)));
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// ── 5-6. upload + verify ───────────────────────────────────────────────────
async function upload(path, filePath, auth) {
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
  // Verify it is genuinely present in Storage, with the right size, before
  // counting it done — a 2xx on write is not proof delivery works. This asks
  // the SAME authenticated list endpoint used for discovery, not a public
  // GET/HEAD: production's public route 400s (not 404s) for a missing
  // object, which is exactly why probing was abandoned for discovery in the
  // first place, and a just-uploaded object deserves the same rigor, not a
  // "trust the write" shortcut.
  const size = await verifyUploaded(path, auth);
  if (size !== body.length) {
    throw new Error(`verify ${path}: Storage reports ${size} bytes, uploaded ${body.length}`);
  }
  return body.length;
}

async function verifyUploaded(path, auth) {
  const idx = path.lastIndexOf('/');
  const prefix = idx >= 0 ? path.slice(0, idx + 1) : '';
  const objects = await listPrefixObjects(BUCKET, auth, prefix, new Map());
  const size = objects.get(path);
  if (size == null) throw new Error(`verify ${path}: not found in Storage listing after upload`);
  return size;
}

// ── main ───────────────────────────────────────────────────────────────────
if (!DB) { console.error('PINTAG_DB_URL is required'); process.exit(1); }
if (!SKEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required, for --dry-run AND --apply.');
  console.error('Object discovery uses the authenticated Storage API list operation (read-only):');
  console.error('production 400s on public HEAD/GET for a missing object, so existence can only');
  console.error('be established by listing, never by probing.');
  process.exit(2);
}

const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : { done: [], failed: {}, bytesWritten: 0 };
const doneSet = new Set(state.done);

console.log('── DISCOVERY ─────────────────────────────────────────');
console.log('  Reading listings from the database (public schema only)…');
console.log(`  Listing ${BUCKET} via the authenticated Storage API (read-only)…`);
const auth    = authHeaders();
const objects = await listBucketObjects(BUCKET, auth);
const images   = activeImages(objects);
console.log(`  Checking which renditions already exist (same listing, no extra requests)…`);
const already  = existingRenditions(images, objects);
const profiles = Object.keys(PT_RENDITION_PROFILES);

const needed = images.filter((im) =>
  !doneSet.has(im.storage_path) &&
  profiles.some((p) => !already.has(renditionPath(im.storage_path, p))));

const baseline = await currentStorageBytes(objects, auth);
// A write must never be sized against a guess. Without a real baseline the
// ceiling cannot be enforced, so apply refuses rather than writing blind.
if (APPLY && baseline == null) {
  console.error('\n  ABORT: total storage could not be measured, so the storage ceiling cannot be enforced.');
  console.error('  Nothing was written. Give the run a SUPABASE_SERVICE_ROLE_KEY that can list every');
  console.error('  bucket over the Storage API.');
  process.exit(4);
}
console.log('\n── SCOPE ─────────────────────────────────────────────');
console.log(`  active-listing images        : ${images.length}`);
console.log(`  distinct active listings     : ${new Set(images.map((i) => i.slug)).size}`);
console.log(`  rendition objects already up : ${already.size}`);
console.log(`  images still needing work    : ${needed.length}`);
console.log(`  their originals total        : ${fmt(images.reduce((a, i) => a + i.size, 0))}`);
console.log(`  CURRENT storage, all buckets : ${baseline == null ? 'not measurable' : fmt(baseline)}`);

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
      if (APPLY) await upload(path, out, auth);
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
    console.log('    projected total    : unknown (total storage was not measurable this run)');
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
