// Repository invariants for the api.pintag.io migration.
//   node --test supabase-origins.test.js
//
// The three changes in that migration are each one line in one file — and each
// one, if it drifts, fails SILENTLY in production:
//
//   * a createClient() without an explicit storageKey logs every administrator
//     and agent out the moment the API hostname changes (supabase-js derives
//     the key from the URL's first DNS label);
//   * a CSP missing api.pintag.io blocks every API call the site makes;
//   * an image URL persisted under the API host instead of the storage origin
//     splits properties.images into two shapes and silently disables the image
//     CDN for every row written before the cutover.
//
// None of those produce an error anyone would notice in review, so they are
// pinned here as source-level invariants instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CSP_DIRECTIVES, SUPABASE_PROD, SUPABASE_DEV, PINTAG_API_PROXY } from './scripts/csp-policy.mjs';

const read = (f) => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const API_PROXY = 'https://api.pintag.io';
const PROD_REF  = 'eoladhcljbpbhnrmmpev';

// Every tracked .html/.js in the repo, excluding test harnesses (which
// legitimately stub createClient) and node_modules.
function sourceFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(html|js)$/.test(f))
    .filter(f => !f.startsWith('tests/') && !f.includes('node_modules') && !f.endsWith('.test.js'));
}

// Slice out a complete createClient(...) call by brace/paren matching, so a
// multi-line call is examined in full rather than by a fixed line window.
function createClientCalls(src) {
  const out = [];
  const re = /supabase\.createClient\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, end = -1;
    for (let i = m.end - 1; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    out.push(src.slice(m.index, end === -1 ? m.index + 300 : end));
  }
  return out;
}

// ── 1. Auth storage key ───────────────────────────────────────────────────

test('every createClient() in the app passes an explicit storageKey', () => {
  const offenders = [];
  let total = 0;
  for (const f of sourceFiles()) {
    for (const call of createClientCalls(read(f))) {
      total++;
      if (!/storageKey:\s*window\.PINTAG\.authStorageKey/.test(call)) {
        offenders.push(f + ' -> ' + call.replace(/\s+/g, ' ').slice(0, 100));
      }
    }
  }
  assert.ok(total >= 14, `expected at least 14 createClient() calls, found ${total}`);
  assert.deepEqual(offenders, [],
    'a createClient() without an explicit storageKey will derive `sb-<hostname-label>-auth-token` ' +
    'and silently log everyone out when supabaseUrl moves to api.pintag.io');
});

test('the auth storage key is pinned to the project ref, not the hostname', () => {
  for (const [file, ref] of [['config.prod.js', PROD_REF], ['config.dev.js', 'ebtgoqrywdywuqrvudcp']]) {
    const src = read(file);
    const key = src.match(/authStorageKey:\s*'([^']+)'/);
    assert.ok(key, `${file} must define authStorageKey`);
    assert.equal(key[1], `sb-${ref}-auth-token`,
      `${file}'s authStorageKey must keep the CURRENT supabase-js default so existing ` +
      'sessions survive the migration — changing it logs everyone out exactly once');
  }
});

test('the storage key matches the project that actually owns the session', () => {
  // Derived from storagePublicOrigin, not supabaseUrl: supabaseUrl moves to
  // api.pintag.io at cutover, and this invariant must survive that.
  for (const file of ['config.prod.js', 'config.dev.js']) {
    const src = read(file);
    const origin = src.match(/storagePublicOrigin:\s*'https:\/\/([a-z0-9]+)\.supabase\.co'/);
    const key = src.match(/authStorageKey:\s*'sb-([a-z0-9]+)-auth-token'/);
    assert.ok(origin && key, `${file} must define both keys`);
    assert.equal(key[1], origin[1], `${file}: storage key and project ref disagree`);
  }
});

// ── 2. Config abstraction ─────────────────────────────────────────────────

test('config files define all three origin/session keys', () => {
  for (const file of ['config.prod.js', 'config.dev.js', 'config.js']) {
    const src = read(file);
    for (const key of ['supabaseUrl', 'storagePublicOrigin', 'authStorageKey']) {
      assert.match(src, new RegExp(key + ':'), `${file} is missing ${key}`);
    }
  }
});

test('storagePublicOrigin is a DIRECT Supabase origin, never the API proxy', () => {
  // The whole point: stored image URLs must not follow the delivery host.
  for (const file of ['config.prod.js', 'config.dev.js', 'config.js']) {
    const origin = read(file).match(/storagePublicOrigin:\s*'([^']+)'/)[1];
    assert.match(origin, /^https:\/\/[a-z0-9]+\.supabase\.co$/, `${file}: ${origin}`);
    assert.notEqual(origin, API_PROXY);
  }
});

test('production supabaseUrl has NOT been flipped yet (cutover is a separate, deliberate step)', () => {
  // This test is expected to be UPDATED, by hand, as part of the cutover — it
  // exists so the flip cannot happen as an unnoticed side effect of another
  // change. See docs/API_PROXY.md.
  const url = read('config.prod.js').match(/supabaseUrl:\s*'([^']+)'/)[1];
  assert.equal(url, `https://${PROD_REF}.supabase.co`,
    'if you are performing the cutover deliberately, update this assertion in the same commit');
});

// ── 3. CSP ────────────────────────────────────────────────────────────────

const directive = (name) => CSP_DIRECTIVES.find(([d]) => d === name)[1];

for (const name of ['connect-src', 'img-src', 'media-src']) {
  test(`CSP ${name} allows the API proxy`, () => {
    assert.ok(directive(name).includes(PINTAG_API_PROXY), `${name} must include ${API_PROXY}`);
  });

  test(`CSP ${name} still allows the direct Supabase origins`, () => {
    // Legacy stored image URLs, the image-CDN fallback path, and rollback all
    // depend on these staying listed.
    assert.ok(directive(name).includes(SUPABASE_PROD), `${name} lost ${SUPABASE_PROD}`);
    assert.ok(directive(name).includes(SUPABASE_DEV), `${name} lost ${SUPABASE_DEV}`);
  });
}

test('CSP never introduces a *.supabase.co wildcard', () => {
  // A wildcard would let an attacker exfiltrate to a Supabase project they
  // created themselves, which is free and takes a minute.
  const flat = JSON.stringify(CSP_DIRECTIVES);
  assert.equal(/\*\.supabase\.co/.test(flat), false);
});

test('CSP proxy entry is the exact host, not a pintag.io wildcard', () => {
  assert.equal(PINTAG_API_PROXY, API_PROXY);
  assert.equal(/\*\.pintag\.io/.test(JSON.stringify(CSP_DIRECTIVES)), false);
});

test('the deployed pages carry the api.pintag.io entry (apply-csp has been run)', () => {
  const html = read('listing.html');
  const csp = html.match(/content="([^"]*default-src[^"]*)"/)[1];
  assert.ok(csp.includes(API_PROXY), 'run `node scripts/apply-csp.mjs`');
  assert.ok(csp.includes(SUPABASE_PROD), 'the direct Supabase origin must remain');
});

// ── 4. Storage URL handling ───────────────────────────────────────────────

test('admin.html persists the STORAGE origin and uploads through the API origin', () => {
  const src = read('admin.html');
  assert.match(src, /const SUPABASE_PUBLIC_STORAGE = window\.PINTAG\.storagePublicOrigin/);

  // The two URLs written into properties.images.
  const persisted = src.match(/\$\{[A-Z_]+\}\/storage\/v1\/object\/public\/property-images\//g) || [];
  assert.equal(persisted.length, 2, 'expected exactly two persisted-public-URL sites');
  for (const p of persisted) {
    assert.match(p, /SUPABASE_PUBLIC_STORAGE/,
      'a public image URL persisted from SUPABASE_URL would follow the API host into the database');
  }

  // The upload requests themselves — these SHOULD go through the API host.
  const uploads = src.match(/\$\{[A-Z_]+\}\/storage\/v1\/object\/property-images\//g) || [];
  assert.equal(uploads.length, 2, 'expected exactly two upload sites');
  for (const u of uploads) {
    assert.match(u, /SUPABASE_URL/, 'uploads must go through the proxied API host');
  }
});

test('ptCdnImage matches on the storage origin, not the API host', () => {
  const src = read('components.js');
  assert.match(src, /function _ptStorageOrigin\(\)/);
  assert.match(src, /P\.storagePublicOrigin \|\| P\.supabaseUrl/,
    'must prefer storagePublicOrigin, falling back for a config predating the key');
  const fn = src.slice(src.indexOf('function ptCdnImage('), src.indexOf('function ptCdnImageFallback('));
  assert.equal(/P\.supabaseUrl \+ PT_PROPERTY_IMAGES_PATH/.test(fn), false,
    'matching on supabaseUrl silently disables the CDN for every pre-cutover image URL');
});

// ── 5. The Worker agrees with the config ──────────────────────────────────

test('the Worker origin equals production storagePublicOrigin', () => {
  const worker = read('cloudflare-worker/api-proxy-worker.js');
  const workerOrigin = worker.match(/const SUPABASE_ORIGIN = '([^']+)'/)[1];
  const configOrigin = read('config.prod.js').match(/storagePublicOrigin:\s*'([^']+)'/)[1];
  assert.equal(workerOrigin, configOrigin);
});

test('the image CDN Worker still points DIRECTLY at Supabase', () => {
  // Routing it through the API proxy would make every image a Worker-to-Worker
  // hop and double the Free-plan request count for zero benefit.
  const cdn = read('cloudflare-worker/image-cdn-worker.js');
  const origin = cdn.match(/const SUPABASE_ORIGIN\s*=\s*'([^']+)'/)[1];
  assert.equal(origin, `https://${PROD_REF}.supabase.co`);
  assert.equal(cdn.includes(API_PROXY), false, 'the image CDN must not chain through the API proxy');
});

test('edge functions still resolve Supabase from the server-side env, not the proxy', () => {
  // Server-to-server traffic must never egress through Cloudflare.
  for (const f of execFileSync('git', ['ls-files', 'supabase/functions'], { encoding: 'utf8' })
                    .split('\n').filter(f => f.endsWith('index.ts'))) {
    assert.equal(read(f).includes(API_PROXY), false, `${f} must not reference the browser API proxy`);
  }
});
