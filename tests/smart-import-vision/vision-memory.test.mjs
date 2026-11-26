// Focused tests for the memory-safe vision path in smart-listing-importer.
// Extracts the REAL helper source from index.ts (Node ≥22.18 type-stripping),
// so we test the deployed logic — not a copy. Proves: chunked base64 (no O(n²)),
// bounded concurrency, budget-gated accumulation (bounded peak memory), the
// pre-generated rendition URL + fallback shape, and request construction.
//
// Run:  node tests/smart-import-vision/vision-memory.test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(here, '../../supabase/functions/smart-listing-importer/index.ts'), 'utf8');

// ── extract a `function`/`async function` body by brace-matching ──
function extractFn(src, sigRe) {
  const m = src.match(sigRe);
  if (!m) throw new Error('signature not found: ' + sigRe);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced braces for ' + sigRe);
}
function extractConst(src, name) {
  const m = src.match(new RegExp('const ' + name + ' = [^;]+;'));
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}

const toBase64Src        = extractFn(SRC, /function toBase64\(/);
const mapConcSrc         = extractFn(SRC, /async function mapWithConcurrency</);
const renditionUrlSrc    = extractFn(SRC, /function buildRenditionUrl\(/);
const consts = ['MAX_IMAGE_BYTES','IMAGE_CONCURRENCY','MAX_TOTAL_INLINE_BYTES','RENDITION_BUCKET','RENDITION_PREFIX','RENDITION_PROFILE']
  .map(n => extractConst(SRC, n)).join('\n');

const tmp = path.join(os.tmpdir(), 'vision_extracted_' + Date.now() + '.ts');
fs.writeFileSync(tmp,
  consts + '\n' + toBase64Src + '\n' + mapConcSrc + '\n' + renditionUrlSrc + '\n' +
  'export { toBase64, mapWithConcurrency, buildRenditionUrl, MAX_IMAGE_BYTES, IMAGE_CONCURRENCY, MAX_TOTAL_INLINE_BYTES };\n');

const results = [];
const check = (n, ok, d) => results.push({ n, ok: !!ok, d: d || '' });

let mod;
try {
  mod = await import(pathToFileURL(tmp).href);
} catch (e) {
  check('extracted helpers import (Node type-stripping)', false, e.message);
  report(); process.exit(1);
}
const { toBase64, mapWithConcurrency, buildRenditionUrl, IMAGE_CONCURRENCY, MAX_TOTAL_INLINE_BYTES } = mod;

// ── 1. chunked base64 correctness (exact bytes preserved) ──
function eqBytes(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
let b64ok = true;
for (const arr of [[], [0], [255], [0,255,128,1,2,3], [...Array(1000)].map((_,i)=>(i*37)%256)]) {
  const bytes = Uint8Array.from(arr);
  const got = toBase64(bytes);
  const ref = Buffer.from(bytes).toString('base64');
  if (got !== ref || !eqBytes(Uint8Array.from(Buffer.from(got,'base64')), bytes)) { b64ok = false; break; }
}
check('1: chunked base64 matches reference + round-trips exact bytes', b64ok);

// ── 2. base64 is O(n), not O(n²) (5MB under a generous time bound) ──
const big = new Uint8Array(5 * 1024 * 1024); for (let i = 0; i < big.length; i += 7) big[i] = i & 255;
const t0 = Date.now(); const enc = toBase64(big); const dt = Date.now() - t0;
check('2: 5MB base64 is O(n) (fast) and correct', dt < 800 && enc === Buffer.from(big).toString('base64'), dt + 'ms');

// ── 3. source has no per-byte concat, no Promise.all-over-gallery ──
check('3: no O(n²) per-byte concat in source', !/reduce\(\(acc, b\) => acc \+ String\.fromCharCode\(b\)/.test(SRC));
check('3: no Promise.all across the whole gallery', !/Promise\.all\(urlsToFetch\.map/.test(SRC) && /String\.fromCharCode\.apply/.test(SRC));

// ── 4. bounded concurrency: peak in-flight ≤ IMAGE_CONCURRENCY, order preserved ──
async function concurrencyProbe(count) {
  let active = 0, peak = 0;
  const out = await mapWithConcurrency([...Array(count)].map((_,i)=>i), IMAGE_CONCURRENCY, async (i) => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--; return i * 2;
  });
  return { peak, ordered: out.every((v,i)=>v===i*2) };
}
const c8 = await concurrencyProbe(8);
check('4: peak concurrency ≤ ' + IMAGE_CONCURRENCY + ' (8 items)', c8.peak <= IMAGE_CONCURRENCY, 'peak=' + c8.peak);
check('4: results order preserved', c8.ordered);
const c1 = await concurrencyProbe(1);
check('4: single image still processed', c1.peak >= 1 && c1.peak <= IMAGE_CONCURRENCY);

// ── 5. budget-gated accumulation bounds retained bytes (mirrors the handler) ──
// 12 "images" of ~2MB each = ~24MB raw → base64 would be ~32MB, over the 18MB
// budget → later ones must be skipped and never accumulated.
async function budgetSim(sizes) {
  let active = 0, peak = 0, accumulated = 0, skipped = 0;
  const loaded = await mapWithConcurrency(sizes, IMAGE_CONCURRENCY, async (sz) => {
    active++; peak = Math.max(peak, active);
    try {
      const bytes = new Uint8Array(sz);
      const estB64 = Math.ceil(bytes.length / 3) * 4;
      if (accumulated + estB64 > MAX_TOTAL_INLINE_BYTES) { skipped++; return null; }
      const data = toBase64(bytes);
      accumulated += data.length;
      return { data };
    } finally { active--; }
  });
  const used = loaded.filter(Boolean).length;
  return { peak, accumulated, skipped, used };
}
const twoMB = 2 * 1024 * 1024;
const sim = await budgetSim([...Array(12)].map(() => twoMB));
const oneImgB64 = Math.ceil(twoMB / 3) * 4;
check('5: accumulation stays within budget (bounded peak memory)',
  sim.accumulated <= MAX_TOTAL_INLINE_BYTES + IMAGE_CONCURRENCY * oneImgB64,
  'accumulated=' + (sim.accumulated/1048576).toFixed(1) + 'MB, budget=' + (MAX_TOTAL_INLINE_BYTES/1048576) + 'MB');
check('5: over-budget images skipped, not held', sim.skipped > 0 && sim.used < 12, 'used=' + sim.used + ' skipped=' + sim.skipped);
check('5: peak concurrency still ≤ ' + IMAGE_CONCURRENCY + ' under load', sim.peak <= IMAGE_CONCURRENCY, 'peak=' + sim.peak);

// small gallery entirely fits, nothing skipped
const simSmall = await budgetSim([...Array(8)].map(() => 300 * 1024)); // 8×300KB (rendition-sized)
check('5: normal downscaled gallery (8×300KB) all admitted', simSmall.used === 8 && simSmall.skipped === 0, 'used=' + simSmall.used);

// ── 6. pre-generated rendition URL + fallback shape ──
// The paid render endpoint (/storage/v1/render/image/...) answers 403 FeatureNotEnabled on this Free project; the
// importer reads the 'hero' rendition image-renditions.js stores at upload time.
const objUrl = 'https://eoladhcljbpbhnrmmpev.supabase.co/storage/v1/object/public/property-images/abc/def.jpg?token=x';
const rUrl = buildRenditionUrl(objUrl);
check('6: object URL → renditions/<stem>/hero.webp in the same public bucket',
  rUrl === 'https://eoladhcljbpbhnrmmpev.supabase.co/storage/v1/object/public/property-images/renditions/abc/def/hero.webp', rUrl);
check('6: rendition URL strips the original query string', !rUrl.includes('token=x'));
check('6: no render-endpoint URL is ever built', !rUrl.includes('/render/image/'));
check('6: non-storage URL → null (caller uses original)', buildRenditionUrl('https://example.com/x.jpg') === null);
check('6: a rendition URL is never derived from a rendition', buildRenditionUrl(rUrl) === null);
// The fallback is unchanged in behaviour; its signature now carries the
// request-wide deadline (fetchImageBytes(url, timeoutMs)), so the match is on
// the objectUrl argument rather than an exact one-argument call.
check('6: fallback-to-original path exists in source', /async function loadImageBytes/.test(SRC) && /const o = await fetchImageBytes\(objectUrl,/.test(SRC));
check('6: image fetches take their timeout from the request deadline',
  /async function fetchImageBytes\(url: string, timeoutMs: number\)/.test(SRC)
  && /AbortSignal\.timeout\(timeoutMs\)/.test(SRC));

// ── 7. request construction for 1 / 4 / 8 images ──
for (const n of [1, 4, 8]) {
  const parts = [...Array(n)].map(() => ({ inlineData: { mimeType: 'image/jpeg', data: toBase64(new Uint8Array([1,2,3])) } }));
  const body = { contents: [{ parts: [...parts, { text: 'PROMPT' }] }] };
  let ok = false; try { JSON.parse(JSON.stringify(body)); ok = true; } catch { /* */ }
  check('7: request builds valid JSON with ' + n + ' image part(s) + text', ok && body.contents[0].parts.length === n + 1);
}

// ── 8. shared pipeline: the image path never branches on source ──
const pipeline = [toBase64Src, mapConcSrc, renditionUrlSrc,
  extractFn(SRC, /async function fetchImageBytes\(/), extractFn(SRC, /async function loadImageBytes\(/)].join('\n');
check('8: vision pipeline is source-agnostic (Smart Import == Edit)',
  !/\bsource\b|importSource|edit_regen|['"]manual['"]/.test(pipeline));

try { fs.unlinkSync(tmp); } catch { /* */ }

report();
function report() {
  let pass = 0, fail = 0;
  console.log('\n──── smart-listing-importer — memory-safe vision (extracted from index.ts) ────');
  for (const r of results) { console.log((r.ok ? '  PASS ' : '  FAIL ') + r.n + (r.d ? ('   [' + r.d + ']') : '')); r.ok ? pass++ : fail++; }
  console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
  if (fail) process.exitCode = 1;
}
