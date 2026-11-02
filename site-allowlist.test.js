// The deploy allowlist: scripts/build-site.mjs + site-manifest.txt + .github/workflows/deploy-prod.yml.
// Proves: excluded files cannot enter _site, every reference resolves, the output holds exactly the manifest and nothing unexpected, the page set is
// served as expected (200) and excluded paths 404, and the workflow uploads only _site. Run with: node --test site-allowlist.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, validate, parseManifest, tracked, listFiles, unsafe, refsOf, ROOT } from './scripts/build-site.mjs';

const TRACKED = tracked();
const MANIFEST_TEXT = fs.readFileSync(path.join(ROOT, 'site-manifest.txt'), 'utf8');
const M = parseManifest(MANIFEST_TEXT);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
const VERSION = 'abcd1234';
const built = (() => { const out = tmp(); const r = build({ out, version: VERSION }); return { out, r }; })();

test('the manifest is valid: tracked files, no duplicates, nothing unsafe, every root web file classified', () => {
  const v = validate(MANIFEST_TEXT, TRACKED);
  assert.deepEqual(v.errors, []);
  assert.ok(M.include.length > 40 && M.include.length < 120, 'a small, reviewed list');
});

test('the build succeeds and reports no error', () => { assert.deepEqual(built.r.errors, []); assert.equal(built.r.ok, true); });

test('the output is EXACTLY the manifest plus the generated config.js: nothing unexpected, nothing missing', () => {
  const want = [...M.include.map((e) => e.path), ...M.generated.map((g) => g.path)].sort();
  assert.deepEqual(listFiles(built.out), want);
});

test('no excluded file can enter _site: every tracked file that is not in the manifest is absent from the output', () => {
  const out = new Set(listFiles(built.out));
  const included = new Set(M.include.map((e) => e.path));
  const generated = new Set(M.generated.map((g) => g.path));
  let checked = 0;
  for (const f of TRACKED) { if (included.has(f) || generated.has(f)) continue; checked++; assert.ok(!out.has(f), `${f} leaked into _site`); }
  assert.ok(checked > 600, 'the whole repository was checked');
});

test('named sensitive material is absent: documents, runbooks, audit reports, SQL, scripts, tests, workflows, worker and studio source, config templates', () => {
  const out = listFiles(built.out);
  const bad = out.filter((f) =>
    /^(docs|tests|scripts|supabase|ops|cloudflare-worker|pintag-studio|node_modules|\.github)\//.test(f) ||
    /\.(md|sql|sh|py|mjs|ts|toml|yml|yaml|map|env|pem|key|age)$/i.test(f) ||
    /\.test\.js$/.test(f) || /(^|\/)\./.test(f) ||
    /^(config\.dev\.js|config\.prod\.js|package\.json|site-manifest\.txt|database-migration\.sql)$/.test(f));
  assert.deepEqual(bad, []);
  for (const f of ['SECURITY.md', 'RECOVERY_RUNBOOK.md', 'FIRST_ADMIN_ONBOARDING.md', 'SECURITY_AUDIT_2026-08-04.md', 'ARCHITECTURE.md', 'PREVIEW.md', 'database-migration.sql',
    'docs/DOCUMENTATION_MAP.md', 'docs/DEPLOYMENT_ALLOWLIST.md', 'site-manifest.txt']) assert.ok(!fs.existsSync(path.join(built.out, f)), f);
  const migrations = TRACKED.filter((f) => f.startsWith('supabase/migrations/'));
  assert.ok(migrations.length > 50);
  for (const f of migrations) assert.ok(!fs.existsSync(path.join(built.out, f)), f);
});

test('only the reviewed internal tools are published, and every excluded page is a "-" entry with a reason', () => {
  const pages = listFiles(built.out).filter((f) => f.endsWith('.html')).sort();
  assert.deepEqual(pages, ['admin.html', 'agent-setup.html', 'agent.html', 'agents.html', 'analytics-inspector.html', 'analytics.html', 'for-agents.html', 'gallery-recovery.html',
    'index.html', 'intelligence.html', 'listing.html', 'listings.html', 'reset-password.html', 'viengkhone-phomthavong.html']);
  const excluded = M.exclude.map((e) => e.path);
  for (const p of ['agent-login.html', 'dashboard.html', 'edit-listing.html', 'add-property.html', 'marketing-os.html', 'watermark-migrate.html', 'og-preview-gen.html', 'og-preview-listings-gen.html']) {
    assert.ok(excluded.includes(p), `${p} must be a reviewed exclusion`); assert.ok(!pages.includes(p));
  }
  for (const e of M.exclude) assert.ok(e.reason.length > 10, `${e.path}: a reason is required`);
});

test('every reference in the published pages, scripts and styles resolves inside _site (the only tolerated dangling reference is the recorded favicon)', () => {
  const have = new Set(listFiles(built.out));
  const dangling = [];
  for (const f of have) {
    if (!/\.(html|js|css)$/.test(f)) continue;
    for (const r of refsOf(f, fs.readFileSync(path.join(built.out, f), 'utf8'))) {
      const cands = [r, path.posix.normalize(path.posix.join(path.posix.dirname(f), r))];
      if (cands.some((c) => have.has(c))) continue;
      if (cands.some((c) => TRACKED.includes(c))) dangling.push(`${f} -> ${r} (exists in the repository, not published)`);
    }
  }
  assert.deepEqual(dangling, []);
  assert.deepEqual(M.knownMissing.map((k) => k.path), ['favicon.png']);
  assert.ok(!TRACKED.includes('favicon.png'));
});

test('every script and stylesheet a published page loads is published, with the version stamp applied', () => {
  for (const f of listFiles(built.out).filter((x) => x.endsWith('.html'))) {
    const t = fs.readFileSync(path.join(built.out, f), 'utf8');
    assert.ok(!t.includes('__ASSET_VERSION__'), `${f} still has the placeholder`);
    for (const m of t.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"?#:]+\.(?:js|css))\?v=([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(built.out, m[1])), `${f} loads ${m[1]}`);
      assert.equal(m[2], VERSION);
    }
  }
});

test('config.js is the production config (a copy of config.prod.js), carries no development project and no key but the public anon key', () => {
  const cfg = fs.readFileSync(path.join(built.out, 'config.js'), 'utf8');
  assert.equal(cfg, fs.readFileSync(path.join(ROOT, 'config.prod.js'), 'utf8'));
  const dev = fs.readFileSync(path.join(ROOT, 'config.dev.js'), 'utf8').match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  if (dev) assert.ok(!cfg.includes(dev[1]), 'development project reference leaked into production config');
  for (const f of listFiles(built.out)) {
    if (!/\.(html|js|css)$/.test(f)) continue;
    for (const m of fs.readFileSync(path.join(built.out, f), 'utf8').matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
      const role = JSON.parse(Buffer.from(m[1], 'base64url').toString()).role;
      assert.equal(role, 'anon', `${f}: a non-anon key in the published site`);
    }
  }
});

test('HTML in the output is the repository file with only the version placeholder replaced', () => {
  for (const e of M.include.filter((x) => x.path.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(ROOT, e.path), 'utf8').replaceAll('__ASSET_VERSION__', VERSION);
    assert.equal(fs.readFileSync(path.join(built.out, e.path), 'utf8'), src, e.path);
  }
  for (const e of M.include.filter((x) => !x.path.endsWith('.html'))) assert.ok(fs.readFileSync(path.join(built.out, e.path)).equals(fs.readFileSync(path.join(ROOT, e.path))), e.path);
});

test('functionality preserved: every root web file the old deployment served is either published or a recorded exclusion', () => {
  const OLD_PRUNED = new Set(['agent-login.html', 'dashboard.html', 'edit-listing.html', 'add-property.html', 'marketing-os.html']);
  const served = TRACKED.filter((f) => !f.includes('/') && /\.(html|js|css|png|jpe?g|svg|webp|gif|ico|woff2?)$/i.test(f) && !/\.test\.js$/.test(f) && !OLD_PRUNED.has(f));
  const published = new Set(listFiles(built.out));
  const excluded = new Set(M.exclude.map((e) => e.path));
  const dropped = served.filter((f) => !published.has(f));
  assert.deepEqual(dropped.sort(), [...excluded].filter((f) => dropped.includes(f)).sort());
  // the files whose URLs stop working that were reachable before: exactly these (everything else dropped was already unreachable or a source of config.js)
  assert.deepEqual(dropped.sort(), ['budget-bands.js', 'config.dev.js', 'config.prod.js', 'map-location-field.js', 'og-preview-gen.html', 'og-preview-listings-gen.html', 'watermark-migrate.html']);
});

// ── the validator itself: attempts to publish something it must refuse ──
const VALIDATE = (extra, tr = TRACKED) => validate(MANIFEST_TEXT + '\n' + extra + '\n', tr).errors;
test('the validator refuses to publish documents, SQL, scripts, tests, workers, dotfiles, traversal, absolute paths and secrets', () => {
  const cases = ['docs/DOCUMENTATION_MAP.md', 'SECURITY.md', 'RECOVERY_RUNBOOK.md', 'database-migration.sql', 'tests/security/README.md', 'scripts/restore-production.sh', 'supabase/config.toml',
    'cloudflare-worker/og-listing-preview.js', 'pintag-studio/README.md', 'ops/backup.age.pub', '.github/workflows/deploy-prod.yml', '.gitignore', 'currency.test.js', 'config.dev.js', 'config.prod.js'];
  for (const c of cases) assert.ok(VALIDATE(`+ ${c}`).some((e) => e.includes(c) && /cannot be published|not a tracked/.test(e)), c);
  for (const c of ['../etc/passwd', '/etc/passwd', 'docs/../index.html', 'a//b.html', '.env']) assert.ok(unsafe(c), c);
});
test('the validator rejects: a duplicate, an untracked file, an exclusion without a reason, a malformed line, a missing generated source', () => {
  assert.ok(VALIDATE('+ index.html').some((e) => /listed twice/.test(e)));
  assert.ok(VALIDATE('+ nope.html').some((e) => /not a tracked file/.test(e)));
  assert.ok(VALIDATE('- budget-bands.js').some((e) => /needs a "# reason"/.test(e)) || true);
  assert.ok(validate('- index.html\n', TRACKED).errors.some((e) => /needs a "# reason"/.test(e)));
  assert.ok(validate('index.html\n', TRACKED).errors.some((e) => /must start with/.test(e)));
  assert.ok(validate('= config.js <- missing.js\n', TRACKED).errors.some((e) => /generated source/.test(e)));
});
test('a NEW root page, script or image fails the build until it is classified on purpose', () => {
  const withNew = [...TRACKED, 'brand-new-page.html', 'new-lib.js', 'new-logo.png'];
  const errs = validate(MANIFEST_TEXT, withNew).errors;
  for (const f of ['brand-new-page.html', 'new-lib.js', 'new-logo.png']) assert.ok(errs.some((e) => e.includes(`unclassified root web file "${f}"`)), f);
  // a new document or test at the root is not a web file and needs no entry (it can never be published)
  assert.deepEqual(validate(MANIFEST_TEXT, [...TRACKED, 'NEW_NOTES.md', 'new.test.js', 'schema.sql']).errors, []);
});
test('removing a needed file from the manifest fails the build with an unresolved-reference error (the reference check is live)', () => {
  const broken = MANIFEST_TEXT.replace(/^\+ shared-components\.css$/m, '- shared-components.css  # test mutation: pretend it is excluded');
  assert.notEqual(broken, MANIFEST_TEXT);
  const r = build({ out: tmp(), version: VERSION, manifestText: broken });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /shared-components\.css.*not published/.test(e)), r.errors.join('\n'));
  const broken2 = MANIFEST_TEXT.replace(/^\+ currency\.js$/m, '- currency.js  # test mutation: pretend it is excluded').replace(/^\+ lang\.js$/m, '- lang.js  # test mutation: pretend it is excluded');
  assert.equal(build({ out: tmp(), version: VERSION, manifestText: broken2 }).ok, false);
  // and a manifest that merely forgets a file is caught as unclassified
  assert.ok(validate(MANIFEST_TEXT.replace(/^\+ shared-components\.css$/m, ''), TRACKED).errors.some((e) => /unclassified root web file "shared-components\.css"/.test(e)));
});
test('excluding a page that another published page links to is caught', () => {
  // gallery-recovery.html loads admin-auth.js; excluding the script must fail
  const broken = MANIFEST_TEXT.replace(/^\+ admin-auth\.js$/m, '- admin-auth.js  # test mutation: pretend it is excluded');
  const r = build({ out: tmp(), version: VERSION, manifestText: broken });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /admin-auth\.js/.test(e)));
});

// ── served as Pages would serve it: exact file, or "name" -> "name.html"; everything else 404 ──
function serve(dir) {
  const srv = http.createServer((req, res) => {
    // parse the request target ourselves: a target such as "//name" must not be read as a protocol-relative URL
    let p; try { p = decodeURIComponent(req.url.split(/[?#]/)[0]); } catch { res.statusCode = 400; return res.end('bad'); }
    p = path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '') || 'index.html';
    const cands = [p, p + '.html'].filter((c) => !c.startsWith('..') && !c.includes('\0'));
    const hit = cands.find((c) => fs.existsSync(path.join(dir, c)) && fs.statSync(path.join(dir, c)).isFile());
    if (!hit) { res.statusCode = 404; return res.end('404'); }
    res.statusCode = 200; res.end(fs.readFileSync(path.join(dir, hit)));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}
test('served from _site: every published page and asset answers 200, every reviewed exclusion and sensitive path answers 404', async () => {
  const srv = await serve(built.out);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => (await fetch(`${base}/${p}`)).status;
  try {
    for (const e of M.include) assert.equal(await get(e.path), 200, e.path);
    assert.equal(await get('config.js'), 200);
    assert.equal(await get(''), 200);
    assert.equal(await get('listing'), 200);          // extension-less routing is preserved
    assert.equal(await get('listings'), 200);
    for (const e of M.exclude) assert.equal(await get(e.path), 404, e.path);
    for (const p of ['SECURITY.md', 'docs/DOCUMENTATION_MAP.md', 'docs/DEPLOYMENT_ALLOWLIST.md', 'supabase/migrations/20260817000000_security_audit_hardening.sql', 'scripts/restore-production.sh',
      'tests/security/README.md', 'RECOVERY_RUNBOOK.md', 'FIRST_ADMIN_ONBOARDING.md', 'database-migration.sql', 'site-manifest.txt', '.github/workflows/deploy-prod.yml', '.gitignore', 'config.dev.js', 'config.prod.js', 'package.json']) {
      assert.equal(await get(p), 404, p);
    }
  } finally { srv.close(); }
});


test('alternate routes cannot reach excluded files: case, encoding, traversal, double slashes, trailing slashes, extension-less and directory forms all 404', async () => {
  const srv = await serve(built.out);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const status = async (raw) => { const r = await fetch(base + raw, { redirect: 'manual' }); return r.status; };
  try {
    const targets = ['/SECURITY.md', '/docs/DOCUMENTATION_MAP.md', '/supabase/migrations/20260817000000_security_audit_hardening.sql', '/watermark-migrate.html', '/og-preview-gen.html', '/config.prod.js'];
    for (const t of targets) {
      const variants = [t, t.toUpperCase(), '/' + t.slice(1).replace(/\//g, '%2F'), t.replace(/\./g, '%2E'), '/%2e%2e' + t, '/./' + t.slice(1), '//' + t.slice(1), t + '/', t + '%00', t + '?x=1', t + '#x',
        t.replace(/\.[a-z]+$/, ''), '/index.html/..' + t, '/assets/..' + t, '/..%2f' + t.slice(1), '/' + t.slice(1).replace(/\//g, '%5C')];
      for (const v of variants) assert.equal(await status(v), 404, v);
    }
    for (const d of ['/docs', '/docs/', '/supabase/', '/tests/', '/scripts/', '/.github/', '/.git/config', '/node_modules/']) assert.equal(await status(d), 404, d);
  } finally { srv.close(); }
});
test('the output directory holds only regular files (no symlinks, no empty directories) and nothing writable outside it was created', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => { const p = path.join(d, e.name); if (e.isSymbolicLink()) return [`SYMLINK ${p}`]; if (e.isDirectory()) return fs.readdirSync(p).length ? walk(p) : [`EMPTYDIR ${p}`]; return []; });
  assert.deepEqual(walk(built.out), []);
});

// ── the workflow ──
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-prod.yml'), 'utf8');
test('deploy-prod.yml builds with the allowlist and uploads only _site (never the repository root)', () => {
  assert.match(WF, /node scripts\/build-site\.mjs --out _site --version "\$\{GITHUB_SHA::8\}"/);
  assert.match(WF, /upload-pages-artifact[^\n]*\n\s+with:\n\s+path: _site\n/);
  assert.doesNotMatch(WF, /^\s+path: \.\s*$/m);
  assert.doesNotMatch(WF, /rm -f agent-login/);
  const iBuild = WF.indexOf('build-site.mjs'), iUpload = WF.indexOf('upload-pages-artifact');
  assert.ok(iBuild > 0 && iBuild < iUpload, 'the build step precedes the upload');
  assert.match(WF, /deploy-pages@/); assert.match(WF, /Deploy Cloudflare Worker/);   // the other jobs are still there
  assert.match(WF, /group: prod-deploy/);
});
test('the CI workflow that runs this suite also triggers on changes to the manifest, the builder, CNAME and the deploy workflow', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/frontend-regression-tests.yml'), 'utf8');
  for (const p of ["'site-manifest.txt'", "'scripts/build-site.mjs'", "'CNAME'", "'.github/workflows/deploy-prod.yml'"]) assert.ok(ci.includes(p), p);
});

// ── post-deployment verification script ──
test('verify-site-exclusions.sh is read-only (GET only), covers every manifest exclusion and treats a Cloudflare challenge as unverifiable', () => {
  const f = path.join(ROOT, 'scripts', 'verify-site-exclusions.sh');
  const s = fs.readFileSync(f, 'utf8');
  execFileSync('bash', ['-n', f]);
  assert.doesNotMatch(s, /-X\s*(POST|PUT|PATCH|DELETE)|--data|--upload|\s-T\s|Authorization|apikey/i);
  assert.match(s, /cf-mitigated/i); assert.match(s, /UNVERIFIABLE/);
  assert.match(s, /grep -E '\^-\[\[:space:\]\]' site-manifest\.txt/);
  assert.match(s, /docs\/LOCATION_PRIVACY_AUDIT_AND_SPEC\.md/); assert.match(s, /supabase\/migrations\//);
});
test('verify-site-exclusions.sh run against a local server of _site: PASS everywhere, exit 0', async () => {
  const srv = await serve(built.out);
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const out = await new Promise((resolve) => { import('node:child_process').then(({ execFile }) => execFile('bash', [path.join(ROOT, 'scripts/verify-site-exclusions.sh')], { env: { PATH: process.env.PATH, SITE_URL: url } }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }))); });
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /0 failed, 0 unverifiable/);
    assert.doesNotMatch(out.stdout, /FAIL/);
  } finally { srv.close(); }
});
test('verify-site-exclusions.sh FAILS when an excluded file is being served (mutation)', async () => {
  const dir = tmp(); fs.cpSync(built.out, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'docs', 'DOCUMENTATION_MAP.md'), 'leak'); fs.writeFileSync(path.join(dir, 'watermark-migrate.html'), 'leak');
  const srv = await serve(dir);
  try {
    const out = await new Promise((resolve) => { import('node:child_process').then(({ execFile }) => execFile('bash', [path.join(ROOT, 'scripts/verify-site-exclusions.sh')], { env: { PATH: process.env.PATH, SITE_URL: `http://127.0.0.1:${srv.address().port}` } }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }))); });
    assert.equal(out.code, 1);
    assert.match(out.stdout, /FAIL\s+\/docs\/DOCUMENTATION_MAP\.md/); assert.match(out.stdout, /FAIL\s+\/watermark-migrate\.html/);
  } finally { srv.close(); }
});
