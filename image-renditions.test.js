// Delivery renditions: path derivation, profile coverage, fallback safety.
//   node --test image-renditions.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const {
  PT_RENDITION_PROFILES, PT_RENDITION_PREFIX,
  renditionStem, renditionPath, objectNameFromPublicUrl,
  renditionPublicUrl, renditionTargets
} = await import('./image-renditions.js');

const SB = 'https://eoladhcljbpbhnrmmpev.supabase.co';
const pub = (name) => `${SB}/storage/v1/object/public/property-images/${name}`;

// ── 1. rendition URL generation ────────────────────────────────────────────
test('a rendition URL is derived deterministically from the original', () => {
  const url = renditionPublicUrl(pub('1787301675902-4gcl6e.jpg'), 'card', SB);
  assert.equal(url, pub('renditions/1787301675902-4gcl6e/card.webp'));
  // Deterministic: same input, same output, no database round-trip.
  assert.equal(url, renditionPublicUrl(pub('1787301675902-4gcl6e.jpg'), 'card', SB));
});

test('the extension is stripped so .jpg and .JPG cannot diverge', () => {
  assert.equal(renditionStem('a-b.jpg'), 'a-b');
  assert.equal(renditionStem('a-b.JPG'), 'a-b');
  assert.equal(renditionStem('a-b.PNG'), 'a-b');
  assert.equal(renditionPath('IMG_9560.png', 'hero'), 'renditions/IMG_9560/hero.webp');
});

// ── 2. every profile ───────────────────────────────────────────────────────
test('all four profiles resolve, and each lands on its own .webp object', () => {
  const seen = new Set();
  for (const profile of ['thumbnail', 'card', 'gallery', 'hero']) {
    const p = renditionPath('x.jpg', profile);
    assert.equal(p, `renditions/x/${profile}.webp`);
    assert.ok(!seen.has(p), 'profiles must not collide');
    seen.add(p);
  }
  assert.equal(seen.size, 4);
});

test('profile widths ascend and quality rises with size', () => {
  const order = ['thumbnail', 'card', 'gallery', 'hero'];
  for (let i = 1; i < order.length; i++) {
    const prev = PT_RENDITION_PROFILES[order[i - 1]], cur = PT_RENDITION_PROFILES[order[i]];
    assert.ok(cur.width > prev.width, `${order[i]} must be wider than ${order[i - 1]}`);
    assert.ok(cur.quality >= prev.quality, `${order[i]} quality must not drop`);
  }
});

// ── 3. fallback to the original ────────────────────────────────────────────
test('a non-property-image URL is left completely alone', () => {
  for (const u of [
    'https://scontent.xx.fbcdn.net/v/photo.jpg',
    'data:image/png;base64,iVBORw0KGgo=',
    `${SB}/storage/v1/object/public/agent-photos/a.jpg`,
    `${SB}/rest/v1/properties`,
  ]) {
    assert.equal(renditionPublicUrl(u, 'card', SB), null, u);
    assert.equal(objectNameFromPublicUrl(u, SB), null, u);
  }
});

test('a rendition URL never derives a rendition of itself', () => {
  const once = renditionPublicUrl(pub('a.jpg'), 'card', SB);
  assert.equal(renditionPublicUrl(once, 'card', SB), null,
    'deriving from a rendition would produce renditions/renditions/...');
});

test('junk input returns null rather than a malformed path', () => {
  for (const bad of [null, undefined, '', 42, {}]) {
    assert.equal(renditionPath(bad, 'card'), null);
    assert.equal(renditionPublicUrl(bad, 'card', SB), null);
  }
  assert.equal(renditionPath('a.jpg', 'nope'), null, 'unknown profile must not resolve');
});

// ── 4. correct WebP paths ──────────────────────────────────────────────────
test('every rendition is .webp under the renditions/ prefix', () => {
  for (const profile of Object.keys(PT_RENDITION_PROFILES)) {
    const p = renditionPath('some-object.jpg', profile);
    assert.ok(p.startsWith(PT_RENDITION_PREFIX), p);
    assert.ok(p.endsWith('.webp'), p);
  }
});

// ── 5. NO 403 transformation URLs ──────────────────────────────────────────
test('no code path emits a Supabase render/image URL', () => {
  for (const profile of Object.keys(PT_RENDITION_PROFILES)) {
    const u = renditionPublicUrl(pub('a.jpg'), profile, SB);
    assert.ok(!u.includes('/render/image/'),
      'the render endpoint answers 403 FeatureNotEnabled on this project');
    assert.ok(u.includes('/object/public/'), 'renditions are ordinary public objects');
  }
  // and the shipped sources must not reintroduce one
  for (const f of ['components.js', 'image-renditions.js', 'listing.html', 'listings.html']) {
    const src = fs.readFileSync(f, 'utf8');
    const live = src.split('\n')
      .filter(l => l.includes('render/image'))
      .filter(l => !/^\s*(\/\/|\*|<!--)/.test(l.trim()) && !l.trim().startsWith('//'));
    assert.deepEqual(live, [], `${f} must only mention render/image in comments`);
  }
});

// ── 6. the original is never altered ───────────────────────────────────────
test('deriving a rendition does not mutate or rewrite the original URL', () => {
  const original = pub('1787301675902-4gcl6e.jpg');
  const copy = String(original);
  renditionPublicUrl(original, 'hero', SB);
  assert.equal(original, copy, 'input must be untouched');
  assert.equal(objectNameFromPublicUrl(original, SB), '1787301675902-4gcl6e.jpg',
    'the original object name is unchanged — originals stay the source of truth');
});

// ── 7/8. generation targets + idempotence ──────────────────────────────────
test('renditions never upscale a small source', () => {
  const t = renditionTargets(300);
  for (const spec of t) assert.ok(spec.width <= 300, `${spec.profile} upscaled to ${spec.width}`);
  assert.equal(t.length, 4, 'every profile still gets an entry');
});

test('a large source gets each profile at its full target width', () => {
  const t = renditionTargets(4032);
  const byProfile = Object.fromEntries(t.map(x => [x.profile, x.width]));
  assert.deepEqual(byProfile, { thumbnail: 200, card: 400, gallery: 800, hero: 1200 });
});

test('generation is idempotent: the path is a pure function of name + profile', () => {
  // Re-running the backfill must overwrite the same object, never create a
  // second one — which is exactly what a deterministic path guarantees.
  const a = renditionPath('obj.jpg', 'card');
  const b = renditionPath('obj.jpg', 'card');
  assert.equal(a, b);
  assert.notEqual(renditionPath('obj.jpg', 'card'), renditionPath('obj.jpg', 'hero'));
  assert.notEqual(renditionPath('obj2.jpg', 'card'), a);
});

// ── 9. delivery wiring ─────────────────────────────────────────────────────
test('ptImageUrl is flag-gated and falls back to the original when off', async () => {
  const src = fs.readFileSync('components.js', 'utf8');
  assert.match(src, /if \(!P \|\| !P\.renditionsEnabled/,
    'delivery must be gated on the rendition capability flag');
  assert.match(src, /return renditionPublicUrl\(url, profile, P\.supabaseUrl\) \|\| url/,
    'an underivable URL must fall back to the original');
});

test('every rendition <img> carries the original for onerror fallback', () => {
  for (const [file, min] of [['components.js', 2], ['listing.html', 3]]) {
    const src = fs.readFileSync(file, 'utf8');
    const n = (src.match(/data-pt-original/g) || []).length;
    assert.ok(n >= min, `${file}: expected >= ${min} fallback-wired images, found ${n}`);
  }
});

test('all three upload paths call the ONE shared generator', () => {
  for (const f of ['admin.html', 'add-property.html', 'edit-listing.html']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /uploadRenditions\(/, `${f} must generate renditions on upload`);
    assert.match(src, /image-renditions\.js/, `${f} must load the shared module`);
    // No page may re-implement WEBP encoding — that is the shared module's
    // job. admin.html's canvas.toBlob(..., 'image/jpeg') is the pre-existing
    // watermarker, a different concern, and is deliberately not caught here.
    assert.ok(!/toBlob\([^)]*image\/webp/.test(src),
      `${f} must NOT re-implement WebP encoding — that is the shared module's job`);
  }
});

test('renditions upload with the long immutable cache, like originals', () => {
  const src = fs.readFileSync('image-renditions.js', 'utf8');
  assert.match(src, /public, max-age=31536000, immutable/);
  // edit-listing.html used to upload with no cacheControl at all (1h default)
  const edit = fs.readFileSync('edit-listing.html', 'utf8');
  assert.match(edit, /cacheControl: '31536000'/, 'the original upload must be long-cached too');
});

// ---------------------------------------------------------------------------
// BACKFILL RUNNER — the guarantees are asserted from the source, because the
// runner touches production Storage and "we intended it to be safe" is not a
// test. Each of these would fail loudly if someone added a delete, widened the
// scope beyond active listings, or re-implemented the sizing contract.
// ---------------------------------------------------------------------------
{
  const RUNNER = fs.readFileSync('scripts/backfill-renditions.mjs', 'utf8');

  test('the runner reuses the shared contract instead of redefining sizes', () => {
    assert.match(RUNNER, /import\('\.\.\/image-renditions\.js'\)/,
      'profiles and paths must come from the one module');
    assert.match(RUNNER, /PT_RENDITION_PROFILES, PT_RENDITION_PREFIX, renditionPath/);
    // No hardcoded widths — those live in image-renditions.js and nowhere else.
    assert.ok(!/\b(200|400|800|1200)\s*[,)]\s*(?!.*resize)/.test(
      RUNNER.split('\n').filter(l => /width:\s*\d/.test(l)).join('\n')),
      'the runner must not declare its own profile widths');
  });

  test('the runner can never delete anything', () => {
    assert.ok(!/method:\s*['"]DELETE['"]/.test(RUNNER), 'no DELETE request');
    assert.ok(!/\.remove\(/.test(RUNNER), 'no storage remove()');
    assert.ok(!/\bDELETE\s+FROM\b|\bDROP\s+/i.test(RUNNER), 'no destructive SQL');
  });

  test('the runner only ever writes under renditions/', () => {
    // Every upload target is renditionPath(), which is prefixed by construction.
    // Scoped to the apply loop: the identical assignment inside
    // existingRenditions() must not be able to satisfy this by accident.
    const applyLoop = RUNNER.slice(RUNNER.indexOf('for (let i = 0; i < queue.length'));
    assert.ok(applyLoop.length > 0, 'apply loop not found');
    assert.match(applyLoop, /const path = renditionPath\(im\.storage_path, profile\)/);
    assert.match(applyLoop, /await upload\(path, out, auth\)/);
    assert.ok(!/upload\(\s*im\.storage_path/.test(RUNNER),
      'an original path must never be an upload target');
  });

  test('upload() re-checks its own destination, so a bad caller cannot overwrite an original', () => {
    // Defence in depth at the one function that can overwrite an object: the
    // call site being right is not enough, because that is exactly what a
    // future edit could get wrong.
    const fn = RUNNER.slice(RUNNER.indexOf('async function upload('));
    const guard = fn.slice(0, fn.indexOf('const body'));
    assert.match(guard, /startsWith\(PT_RENDITION_PREFIX\)/);
    assert.match(guard, /includes\('\.\.'\)/, 'a traversal segment must be refused too');
    assert.match(guard, /refusing to write outside/);
  });

  test('scope is restricted to publicly delivered images', () => {
    assert.match(RUNNER, /p\.status IN \('active','available'\)/,
      'must use the same predicate as the public site');
    assert.match(RUNNER, /pi\.status = 'active'/);
    assert.match(RUNNER, /storage_path NOT LIKE 'renditions\/%'/,
      'must not treat a rendition as a source image');
    // Unit-type galleries are enumerated too: the property_images registry is
    // synced from properties.images only, so unit photos are invisible to it.
    assert.match(RUNNER, /FROM unit_types ut/,
      'unit_types.images must be part of discovery, not just the registry');
  });

  test('discovery reads the public schema only and never touches storage.objects', () => {
    // The production read-only role has no `storage` schema grant, and this
    // design never asks it to try: unlike the two prior designs (a
    // storage.objects JOIN, then a storage.objects fallback query), NO query
    // anywhere in this file may reference the storage schema at all.
    const queries = [...RUNNER.matchAll(/psql\(`([\s\S]*?)`\)/g)].map((m) => m[1]);
    assert.ok(queries.length > 0, 'no psql query found');
    for (const q of queries) assert.ok(!/storage\./i.test(q), 'a query must not read the storage schema:\n' + q);
    assert.equal(queries.filter((q) => /storage\.objects/i.test(q)).length, 0,
      'storage.objects must never be queried, not even as a fallback');
    assert.ok(!RUNNER.includes('function storageBytesFromDb'),
      'the storage.objects fallback query must be gone entirely');
  });

  test('no public HEAD/GET existence probing remains — objects are discovered only by listing', () => {
    // Production returns 400 (not 404) for a missing object on its public
    // endpoint, for BOTH HEAD and GET, with or without Range: neither method
    // can distinguish "missing" from "broken" there, so existence discovery
    // must never ask the public endpoint about a specific object at all.
    // (download() and upload()'s write call still use the public/authed
    // object endpoints, but only ever against an object already CONFIRMED
    // to exist by a Storage listing — never to answer "does this exist?".)
    assert.ok(!RUNNER.includes('function probeObject'), 'probeObject() (public existence probing) must be gone');
    assert.ok(!RUNNER.includes('async function drain'), 'drain() existed only to support probeObject()');
    assert.ok(!/method:\s*'HEAD'/.test(RUNNER), 'no HEAD request may remain in the runner');
    assert.ok(!/Range['"]?\s*:\s*['"]bytes=/.test(RUNNER),
      'a Range probe header was only ever used for existence/verify probing of a possibly-missing object; none may remain in a request');
  });

  test('existence and size come from the authenticated Storage list API, with real pagination', () => {
    const fn = RUNNER.slice(RUNNER.indexOf('async function listPrefixObjects'), RUNNER.indexOf('async function listBucketObjects'));
    assert.ok(fn.length > 0, 'listPrefixObjects() not found');
    assert.match(fn, /\/storage\/v1\/object\/list\/\$\{bucket\}/, 'discovery must use the Storage list endpoint');
    assert.match(fn, /method: 'POST'/);
    assert.match(fn, /\.\.\.auth/, 'listing requires the service-role credential (the auth headers)');
    assert.match(fn, /limit: PAGE, offset/, 'pagination must advance by offset, not assume one page');
    assert.match(fn, /rows\.length < PAGE/, 'a short page is what ends pagination, not a fixed request count');
    assert.match(fn, /row\.id == null/, 'a folder row (null id) must be recursed into, not skipped');
    assert.match(fn, /bytesOf\(row\.metadata && row\.metadata\.size/,
      'a file row without a parseable metadata.size must be fatal, never a silent 0');
  });

  test('a dry run needs the service-role key too, because discovery itself needs it', () => {
    // Discovery is no longer optional-credential: without SUPABASE_SERVICE_ROLE_KEY
    // there is no way to ask Storage what exists, in EITHER mode.
    assert.match(RUNNER, /if \(!SKEY\)/);
    assert.ok(!/if \(APPLY && !SKEY\)/.test(RUNNER),
      'the credential gate must not be apply-only any more');
    assert.match(RUNNER, /process\.exit\(2\)/);
  });

  test('the property-images listing is fetched once and reused for both discovery and the ceiling', () => {
    assert.match(RUNNER, /const objects = await listBucketObjects\(BUCKET, auth\)/);
    assert.match(RUNNER, /activeImages\(objects\)/);
    assert.match(RUNNER, /existingRenditions\(images, objects\)/);
    assert.match(RUNNER, /currentStorageBytes\(objects, auth\)/);
    assert.match(RUNNER, /sumSizes\(propertyImagesObjects\)/,
      'the ceiling must reuse the already-fetched bucket total, not re-list it');
    assert.match(RUNNER, /if \(name === BUCKET\) continue/,
      'the property-images bucket must not be listed a second time for the ceiling');
  });

  test('a psql failure never reaches a log: its message quotes the connection string', () => {
    // execFileSync puts the whole command line into its error message, and
    // that includes PINTAG_DB_URL. Only candidateImages() calls psql() now
    // (the storage.objects fallback query is gone), and it may never echo
    // the error.
    const psqlCalls = (RUNNER.match(/\bpsql\(/g) || []).length;
    const start = RUNNER.indexOf('function candidateImages(');
    assert.ok(start > -1, 'function candidateImages( not found');
    const body = RUNNER.slice(start, RUNNER.indexOf('\n}', start));
    const accounted = (body.match(/\bpsql\(/g) || []).length;
    assert.ok(!/console\.(log|error|warn)\([^)]*err(\s*&&\s*err)?\.message/.test(body),
      'candidateImages(): a psql error must never be printed');
    assert.equal(psqlCalls - 1, accounted, 'psql() is called only from candidateImages()');
  });

  test('every query is pinned read-only', () => {
    const calls = RUNNER.match(/execFileSync\('psql'[\s\S]*?\)/g) || [];
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.match(c, /default_transaction_read_only=on/,
        'a psql call without the read-only pin');
      assert.match(c, /'-q'/,
        'without -q psql prints the SET command tag as a phantom data row');
    }
  });

  test('an unparseable size is fatal, never a silent NaN', () => {
    // NaN compares false against the ceiling, so a bad parse would disable the
    // storage gate rather than trip it. This now guards every Storage list
    // row's metadata.size, not a psql total: bytesOf() is shared between them.
    assert.match(RUNNER, /Number\.isFinite\(n\)/);
    assert.match(RUNNER, /function bytesOf\(raw, what\)/);
    assert.match(RUNNER, /into\.set\(full, bytesOf\(row\.metadata && row\.metadata\.size, full\)\)/,
      'a file row with an unparseable size must throw, never default to 0');
  });

  test('the dry-run sample strides across the whole set', () => {
    // Consecutive storage paths are same-listing, same-camera photos; the first
    // N would not be representative of the site.
    assert.match(RUNNER, /const stride = target > 0 \? work\.length \/ target : 1/);
    assert.match(RUNNER, /work\[Math\.floor\(k \* stride\)\]/);
    assert.match(RUNNER, /const queue = APPLY \? work/,
      '--apply must process every image, never a sample');
  });

  test('uploads are idempotent and long-cached', () => {
    assert.match(RUNNER, /'x-upsert': 'true'/, 're-running must overwrite, not duplicate');
    assert.match(RUNNER, /public, max-age=31536000, immutable/);
  });

  test('the storage ceiling is checked against ACTUAL bytes before each write', () => {
    assert.match(RUNNER, /STORAGE_CEILING = 0\.75 \* 1024 \*\* 3/);
    assert.match(RUNNER, /if \(baseline != null && baseline \+ bytes \+ size > STORAGE_CEILING\)/,
      'the gate must use accumulated real bytes, not an up-front estimate');
    // …and a run that cannot measure the baseline must refuse to write at all,
    // rather than writing with the gate disabled.
    assert.match(RUNNER, /if \(APPLY && baseline == null\)/);
    assert.match(RUNNER, /process\.exit\(4\)/);
    // and it must abort BEFORE the upload call, not after
    const gate = RUNNER.indexOf('> STORAGE_CEILING');
    const up   = RUNNER.indexOf('if (APPLY) await upload(');
    assert.ok(gate > -1 && up > gate, 'the ceiling check must precede the upload');
  });

  test('a failed image is recorded and does not stop the run', () => {
    assert.match(RUNNER, /state\.failed\[im\.storage_path\] = String/);
    assert.match(RUNNER, /catch \(err\)/);
    assert.match(RUNNER, /retryable failures/);
  });

  test('uploads are verified against the authenticated listing, with a size check, before being counted done', () => {
    // A 2xx on the write is not proof delivery works, and production 400s
    // (not 404s) on the public endpoint for a missing object — so verify
    // asks the SAME authenticated Storage list operation used for
    // discovery, never a public GET/HEAD.
    const upload = RUNNER.slice(RUNNER.indexOf('async function upload('), RUNNER.indexOf('async function verifyUploaded'));
    assert.ok(upload.length > 0, 'upload() not found');
    assert.match(upload, /const size = await verifyUploaded\(path, auth\)/);
    assert.match(upload, /if \(size !== body\.length\)/, 'a size mismatch after upload must be a failure, not a pass');
    const verifyStart = RUNNER.indexOf('async function verifyUploaded');
    const verify = RUNNER.slice(verifyStart, RUNNER.indexOf('\n}', verifyStart));
    assert.match(verify, /listPrefixObjects\(BUCKET, auth, prefix, new Map\(\)\)/,
      'verify must re-list Storage, not probe the public object endpoint');
    assert.ok(!/\{\s*apikey/.test(verify),
      'verify must not build its own request headers — it delegates to the shared, audited listing function');
    assert.match(verify, /if \(size == null\) throw/, 'an object absent from the re-listing must fail verification');
  });

  test('network calls have a deadline and retry only what is transient', () => {
    assert.match(RUNNER, /AbortSignal\.timeout\(60000\)/,
      'a stalled connection must not hang a tens-of-minutes backfill');
    assert.match(RUNNER, /const fatal = status >= 400 && status < 500/,
      'a 4xx is a fact about the object, not a hiccup — do not retry it');
    assert.match(RUNNER, /500 \* 2 \*\* \(attempt - 1\)/, 'backoff between retries');
  });

  test('the encoder never upscales, matching the browser path', () => {
    assert.match(RUNNER, /`\$\{width\}x>`/,
      "ImageMagick's > flag shrinks only — mirrors renditionTargets()'s Math.min");
  });
}
