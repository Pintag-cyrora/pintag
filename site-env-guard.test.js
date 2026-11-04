// Environment guard of scripts/build-site.mjs: a development build can never carry the production configuration (or the reverse), and a build fails closed if the
// configuration it would publish is missing, invalid, or names the other environment's Supabase project. Run with: node --test site-env-guard.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build, checkEnvConfig, parseConfig, PROJECT_REF, WORKFLOW_ENV, ROOT } from './scripts/build-site.mjs';

const REAL = { prod: fs.readFileSync(path.join(ROOT, 'config.prod.js'), 'utf8'), dev: fs.readFileSync(path.join(ROOT, 'config.dev.js'), 'utf8') };
const KEY = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.c2ln`;
const cfg = ({ env, isProduction, ref, tag, key = KEY('anon'), url } = {}) => `window.PINTAG = {\n  env: '${env}',\n  isProduction: ${isProduction},\n  supabaseUrl: '${url ?? `https://${ref}.supabase.co`}',\n  anonKey: '${key}',\n  tag: '${tag}'\n};\n`;
const GOOD = { prod: cfg({ env: 'production', isProduction: true, ref: PROJECT_REF.prod, tag: 'PROD' }), dev: cfg({ env: 'development', isProduction: false, ref: PROJECT_REF.dev, tag: 'DEV' }) };
const MANIFEST = '+ index.html\n= config.js <- config.prod.js\n- config.prod.js  # source of the generated config.js\n- config.dev.js  # development configuration\n';

function fx({ prod = GOOD.prod, dev = GOOD.dev, page = '<p>hi</p>', manifest = MANIFEST, omit = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envg-'));
  const files = { 'index.html': page, 'config.prod.js': prod, 'config.dev.js': dev };
  for (const o of omit) delete files[o];
  for (const [f, b] of Object.entries(files)) if (b !== null) fs.writeFileSync(path.join(root, f), b);
  const tracked = Object.keys(files);
  return (env, workflow = '') => build({ root, out: path.join(root, '_site'), trackedFiles: tracked, manifestText: manifest, version: 'v1', env, workflow });
}
const fails = (r, re) => { assert.equal(r.ok, false, 'must fail closed'); assert.ok(r.errors.some((e) => re.test(e)), r.errors.join(' | ')); };

test('the real repository: both environments build, the constants match the committed configs, and the configs pass their own checks', () => {
  assert.deepEqual(checkEnvConfig('prod', REAL.prod, 'config.prod.js'), []);
  assert.deepEqual(checkEnvConfig('dev', REAL.dev, 'config.dev.js'), []);
  assert.equal(parseConfig(REAL.prod).ref, PROJECT_REF.prod); assert.equal(parseConfig(REAL.dev).ref, PROJECT_REF.dev);
  assert.notEqual(PROJECT_REF.prod, PROJECT_REF.dev);
  for (const env of ['prod', 'dev']) { const r = build({ out: fs.mkdtempSync(path.join(os.tmpdir(), 'envg-')), env, version: 'v1', workflow: '' }); assert.deepEqual(r.errors, [], env); }
});

test('a valid pair builds for both environments, and each output carries its own environment (and only that environment) in config.js', () => {
  const run = fx();
  assert.equal(run('prod').ok, true); assert.equal(run('dev').ok, true);
});

test('MISMATCH: a development config that points to the PRODUCTION project fails every build (dev and prod)', () => {
  const run = fx({ dev: cfg({ env: 'development', isProduction: false, ref: PROJECT_REF.prod, tag: 'DEV' }) });
  fails(run('dev'), /config\.dev\.js points to the PRODUCTION Supabase project/); fails(run('prod'), /config\.dev\.js points to the PRODUCTION/);
});
test('MISMATCH: a production config that points to the DEVELOPMENT project fails', () => {
  const run = fx({ prod: cfg({ env: 'production', isProduction: true, ref: PROJECT_REF.dev, tag: 'PROD' }) });
  fails(run('prod'), /config\.prod\.js points to the DEVELOPMENT Supabase project/); fails(run('dev'), /config\.prod\.js points to the DEVELOPMENT/);
});
test('MISMATCH: both files holding the SAME (production) configuration is refused', () => fails(fx({ dev: GOOD.prod })('dev'), /config\.dev\.js points to the PRODUCTION|config\.dev\.js: env must be/));
test('MISMATCH: the two files swapped is refused', () => { const r = fx({ prod: GOOD.dev, dev: GOOD.prod })('dev'); assert.equal(r.ok, false); });
test('MISMATCH: the manifest generating config.js from the wrong file is refused (a prod build must use config.prod.js, a dev build config.dev.js)', () => {
  fails(fx({ manifest: MANIFEST.replace('= config.js <- config.prod.js', '= config.js <- config.dev.js') })('prod'), /generated config\.js comes from config\.dev\.js, but a prod build must use config\.prod\.js/);
  fails(fx({ manifest: '+ index.html\n- config.prod.js  # x\n- config.dev.js  # y\n' })('dev'), /does not generate config\.js/);
  assert.equal(fx({ manifest: MANIFEST.replace('config.prod.js\n', 'config.dev.js\n').replace('- config.dev.js  # source', '- config.prod.js  # source') })('dev').ok, true, 'a dev build reading config.dev.js directly is fine');
});

test('INVALID: missing, empty, malformed and wrongly-flagged configurations fail closed', () => {
  fails(fx({ omit: ['config.dev.js'], manifest: '+ index.html\n= config.js <- config.prod.js\n- config.prod.js  # x\n' })('dev'), /config\.dev\.js is missing or empty/);
  fails(fx({ dev: '' })('dev'), /config\.dev\.js is missing or empty/);
  fails(fx({ dev: '   \n' })('dev'), /missing or empty/);
  fails(fx({ omit: ['config.prod.js'], manifest: '+ index.html\n- config.dev.js  # y\n' })('prod'), /config\.prod\.js is missing or empty/);
  fails(fx({ dev: 'window.PINTAG = {};' })('dev'), /no supabaseUrl/);
  fails(fx({ dev: cfg({ env: 'development', isProduction: false, tag: 'DEV', url: 'http://localhost:54321' }) })('dev'), /not a https:\/\/<20-character project>\.supabase\.co address/);
  fails(fx({ dev: cfg({ env: 'development', isProduction: false, tag: 'DEV', url: 'https://abcdefghijklmnopqrst.supabase.co' }) })('dev'), /unexpected Supabase project/);
  fails(fx({ dev: cfg({ env: 'development', isProduction: false, ref: PROJECT_REF.dev, tag: 'DEV' }).replace("isProduction: false", "isProduction: true") })('dev'), /isProduction must be false/);
  fails(fx({ dev: cfg({ env: 'production', isProduction: false, ref: PROJECT_REF.dev, tag: 'DEV' }) })('dev'), /env must be 'development'/);
  fails(fx({ dev: cfg({ env: 'development', isProduction: false, ref: PROJECT_REF.dev, tag: 'PROD' }) })('dev'), /tag must be 'DEV'/);
  fails(fx({ prod: cfg({ env: 'production', isProduction: true, ref: PROJECT_REF.prod, tag: 'DEV' }) })('prod'), /tag must be 'PROD'/);
  fails(fx({ dev: cfg({ env: 'development', isProduction: false, ref: PROJECT_REF.dev, tag: 'DEV', key: KEY('service_role') }) })('dev'), /not the public anon key/);
  fails(fx({ dev: cfg({ env: 'development', isProduction: false, ref: PROJECT_REF.dev, tag: 'DEV', key: 'not-a-jwt' }) })('dev'), /not a valid JWT/);
  fails(fx({ dev: cfg({ env: 'development', isProduction: false, ref: PROJECT_REF.dev, tag: 'DEV', key: '' }) })('dev'), /no anonKey/);
});

test('WORKFLOW INTERLOCK: the development workflow cannot build production and the production workflow cannot build development', () => {
  const run = fx();
  fails(run('prod', 'Deploy Dev (mirror to pintag-dev)'), /builds dev, but this build was asked for --env prod/);
  fails(run('dev', 'Deploy Production (Pages + Worker)'), /builds prod, but this build was asked for --env dev/);
  assert.equal(run('dev', 'Deploy Dev (mirror to pintag-dev)').ok, true); assert.equal(run('prod', 'Deploy Production (Pages + Worker)').ok, true);
  assert.equal(run('prod', 'some other workflow').ok, true); assert.equal(run('dev', '').ok, true);
  assert.deepEqual(WORKFLOW_ENV, { 'Deploy Production (Pages + Worker)': 'prod', 'Deploy Dev (mirror to pintag-dev)': 'dev' });
  // the names the interlock keys on are the workflows' real names
  assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-dev.yml'), 'utf8'), /^name: Deploy Dev \(mirror to pintag-dev\)$/m);
  assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-prod.yml'), 'utf8'), /^name: Deploy Production \(Pages \+ Worker\)$/m);
});

test('CROSS-ENVIRONMENT REFERENCES: another environment\'s project in a published file fails the build, except on the generated CSP line', () => {
  const page = (ref, csp) => `${csp ? '<meta http-equiv="Content-Security-Policy" content="connect-src ' : '<script>var u="'}https://${ref}.supabase.co${csp ? '">' : '";</script>'}`;
  fails(fx({ page: page(PROJECT_REF.dev, false) })('prod'), /index\.html:1 names the development Supabase project/);
  fails(fx({ page: page(PROJECT_REF.prod, false) })('dev'), /index\.html:1 names the production Supabase project/);
  assert.equal(fx({ page: page(PROJECT_REF.dev, true) })('prod').ok, true);
  assert.equal(fx({ page: page(PROJECT_REF.prod, true) })('dev').ok, true);
});

test('the command line refuses a missing, empty, misspelled or unrecognised environment instead of falling back to production', () => {
  const sh = (args, env = {}) => spawnSync('node', [path.join(ROOT, 'scripts/build-site.mjs'), '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'envg-cli-')), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  for (const args of [['--env'], ['--env', ''], ['--env', 'staging'], ['--env', 'DEV'], ['--env', '--version', 'x'], ['--env=dev'], ['--environment', 'dev']]) {
    const r = sh(args); assert.equal(r.status, 1, JSON.stringify(args)); assert.match(r.stderr, /SITE BUILD FAILED/, JSON.stringify(args));
  }
  assert.equal(sh(['--env', 'dev']).status, 0); assert.equal(sh(['--env', 'prod']).status, 0); assert.equal(sh([]).status, 0);
  const wf = sh(['--env', 'prod'], { GITHUB_WORKFLOW: 'Deploy Dev (mirror to pintag-dev)' });
  assert.equal(wf.status, 1); assert.match(wf.stderr, /builds dev, but this build was asked for --env prod/);
});

test('the dev workflow always names its environment explicitly (it never relies on a default)', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-dev.yml'), 'utf8');
  for (const line of wf.split('\n').filter((l) => l.includes('build-site.mjs') && !l.trim().startsWith('#'))) assert.match(line, /--env dev\b/);
  const prod = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-prod.yml'), 'utf8');
  for (const line of prod.split('\n').filter((l) => l.includes('build-site.mjs') && !l.trim().startsWith('#'))) assert.doesNotMatch(line, /--env dev/);
});
