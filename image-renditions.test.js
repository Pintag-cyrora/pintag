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
