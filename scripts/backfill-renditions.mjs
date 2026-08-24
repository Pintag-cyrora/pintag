#!/usr/bin/env node
// backfill-renditions.mjs — one-time, resumable generation of delivery
// renditions for images on ACTIVE listings.
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
// ENV
//   PINTAG_DB_URL              postgres connection (read-only queries only)
//   SUPABASE_URL               https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  REQUIRED for --apply only
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('../image-renditions.js');
const { PT_RENDITION_PROFILES, renditionPath } = mod.default ?? mod;

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

function psql(sql) {
  return execFileSync('psql', [DB, '-X', '-A', '-t', '-F', SEP, '-v', 'ON_ERROR_STOP=1',
    '-c', `SET default_transaction_read_only=on; ${sql}`],
    { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').filter(Boolean).map((l) => l.split(SEP));
}
const fmt = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

// ── 1-3. active listings -> their images -> the real Storage object ─────────
// The active filter is the SAME predicate the public site uses
// (status in active/available). Drafts, archived, deleted and orphaned objects
// are excluded HERE rather than filtered later, so nothing outside the publicly
// delivered set can ever be written. The JOIN to storage.objects also drops any
// registry row whose object is missing.
function activeImages() {
  return psql(`
    SELECT pi.storage_path, COALESCE((o.metadata->>'size')::bigint, 0), p.slug
    FROM property_images pi
    JOIN properties p      ON p.id = pi.property_id
    JOIN storage.objects o ON o.bucket_id = '${BUCKET}' AND o.name = pi.storage_path
    WHERE pi.status = 'active'
      AND p.status IN ('active','available')
      AND pi.storage_path NOT LIKE 'renditions/%'
    ORDER BY pi.storage_path;`)
    .map(([storage_path, size, slug]) => ({ storage_path, size: Number(size), slug }));
}

function existingRenditions() {
  const set = new Set();
  for (const [name] of psql(
    `SELECT name FROM storage.objects WHERE bucket_id='${BUCKET}' AND name LIKE 'renditions/%';`)) {
    set.add(name);
  }
  return set;
}

function currentStorageBytes() {
  const [[bytes]] = psql(`SELECT COALESCE(sum((metadata->>'size')::bigint),0) FROM storage.objects;`);
  return Number(bytes);
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

async function download(objectName, dest) {
  const res = await fetch(publicUrl(objectName));
  if (!res.ok) throw new Error(`download ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// ── 5-6. upload + verify ───────────────────────────────────────────────────
async function upload(path, filePath) {
  const body = readFileSync(filePath);
  const res = await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SKEY,
      Authorization: `Bearer ${SKEY}`,
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'x-upsert': 'true'   // idempotent: a re-run overwrites, never duplicates
    },
    body
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 160)}`);
  // Verify it is genuinely readable at its public URL before counting it done —
  // a 2xx on write is not proof that delivery works.
  const head = await fetch(publicUrl(path), { method: 'HEAD' });
  if (!head.ok) throw new Error(`verify ${head.status}`);
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

const images   = activeImages();
const already  = existingRenditions();
const profiles = Object.keys(PT_RENDITION_PROFILES);

const needed = images.filter((im) =>
  !doneSet.has(im.storage_path) &&
  profiles.some((p) => !already.has(renditionPath(im.storage_path, p))));

const baseline = currentStorageBytes();
console.log('── SCOPE ─────────────────────────────────────────────');
console.log(`  active-listing images        : ${images.length}`);
console.log(`  distinct active listings     : ${new Set(images.map((i) => i.slug)).size}`);
console.log(`  rendition objects already up : ${already.size}`);
console.log(`  images still needing work    : ${needed.length}`);
console.log(`  their originals total        : ${fmt(images.reduce((a, i) => a + i.size, 0))}`);
console.log(`  CURRENT storage, all buckets : ${fmt(baseline)}`);

const work = LIMIT > 0 ? needed.slice(0, LIMIT) : needed;
const tmp  = mkdtempSync(join(tmpdir(), 'rend-'));
if (QA_DIR) mkdirSync(QA_DIR, { recursive: true });

let produced = 0, bytes = 0, failed = 0, processed = 0;
const target = APPLY ? work.length : Math.min(SAMPLE, work.length);
console.log(`\n── ${APPLY ? 'APPLY' : 'DRY RUN'} (${target} images) ─────────────────────`);

for (let i = 0; i < target; i++) {
  const im = work[i];
  const src = join(tmp, 'src');
  try {
    await download(im.storage_path, src);
    for (const profile of profiles) {
      const path = renditionPath(im.storage_path, profile);
      if (already.has(path)) continue;
      const out = join(tmp, `${profile}.webp`);
      const size = encode(src, out, PT_RENDITION_PROFILES[profile].width, PT_RENDITION_PROFILES[profile].quality);

      // Ceiling check on ACTUAL accumulated bytes, before the write.
      if (baseline + bytes + size > STORAGE_CEILING) {
        console.error(`\n  ABORT: next write reaches ${fmt(baseline + bytes + size)}, over the ${fmt(STORAGE_CEILING)} ceiling.`);
        writeFileSync(STATE_FILE, JSON.stringify({ ...state, done: [...doneSet], bytesWritten: state.bytesWritten + bytes }, null, 2));
        process.exit(3);
      }
      if (APPLY) await upload(path, out);
      if (QA_DIR) copyFileSync(out, join(QA_DIR, `${im.storage_path.replace(/\W+/g, '_')}__${profile}.webp`));
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
if (!APPLY) {
  console.log(`\n  PROJECTION for all ${needed.length} images needing work:`);
  console.log(`    additional storage : ${fmt(projected)}`);
  console.log(`    projected total    : ${fmt(baseline + projected)} of 1024.0 MB limit`);
  console.log(`    ceiling            : ${fmt(STORAGE_CEILING)}`);
  console.log(`    VERDICT            : ${baseline + projected > STORAGE_CEILING ? 'EXCEEDS CEILING — DO NOT RUN' : 'within ceiling'}`);
}
if (Object.keys(state.failed).length) {
  console.log(`\n  retryable failures   : ${Object.keys(state.failed).length} (recorded in ${STATE_FILE})`);
}
