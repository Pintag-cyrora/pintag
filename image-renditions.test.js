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
    assert.match(RUNNER, /PT_RENDITION_PROFILES, renditionPath/);
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
    assert.match(RUNNER, /const path = renditionPath\(im\.storage_path, profile\)/);
    assert.match(RUNNER, /await upload\(path, out\)/);
    assert.ok(!/upload\(\s*im\.storage_path/.test(RUNNER),
      'an original path must never be an upload target');
  });

  test('scope is restricted to publicly delivered images', () => {
    assert.match(RUNNER, /p\.status IN \('active','available'\)/,
      'must use the same predicate as the public site');
    assert.match(RUNNER, /pi\.status = 'active'/);
    assert.match(RUNNER, /storage_path NOT LIKE 'renditions\/%'/,
      'must not treat a rendition as a source image');
    assert.match(RUNNER, /JOIN storage\.objects/,
      'joining storage.objects drops registry rows whose object is missing');
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
    // storage gate rather than trip it.
    assert.match(RUNNER, /Number\.isFinite\(n\)/);
    assert.match(RUNNER, /bytesOf\(size, storage_path\)/);
    assert.match(RUNNER, /bytesOf\(bytes, 'storage\.objects total'\)/);
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
    assert.match(RUNNER, /if \(baseline \+ bytes \+ size > STORAGE_CEILING\)/,
      'the gate must use accumulated real bytes, not an up-front estimate');
    // and it must abort BEFORE the upload call, not after
    const gate = RUNNER.indexOf('> STORAGE_CEILING');
    const up   = RUNNER.indexOf('if (APPLY) await upload(');
    assert.ok(gate > -1 && up > gate, 'the ceiling check must precede the upload');
  });

  test('--apply refuses without a credential rather than silently doing nothing', () => {
    assert.match(RUNNER, /if \(APPLY && !SKEY\)/);
    assert.match(RUNNER, /process\.exit\(2\)/);
  });

  test('a failed image is recorded and does not stop the run', () => {
    assert.match(RUNNER, /state\.failed\[im\.storage_path\] = String/);
    assert.match(RUNNER, /catch \(err\)/);
    assert.match(RUNNER, /retryable failures/);
  });

  test('uploads are verified readable before being counted done', () => {
    assert.match(RUNNER, /method: 'HEAD'/, 'a 2xx write is not proof of delivery');
    assert.match(RUNNER, /throw new Error\(`verify \$\{head\.status\}`\)/);
  });

  test('the encoder never upscales, matching the browser path', () => {
    assert.match(RUNNER, /`\$\{width\}x>`/,
      "ImageMagick's > flag shrinks only — mirrors renditionTargets()'s Math.min");
  });
}
