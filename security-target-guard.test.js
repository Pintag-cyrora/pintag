// The live security suite must never run credentialed or mutating tests against the production project.
// Proves: the target is classified from the project reference in SUPABASE_URL (not from APP_ENV); production + credentials is refused
// before any request; unknown targets fail closed; production-readonly refuses user tokens, auth endpoints and any write that could
// touch a real row; and the guard stops the run (it never becomes a skipped or passing check).
// Run with: node --test security-target-guard.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROD_REF = /supabaseUrl: *'https:\/\/([a-z0-9]{20})\.supabase\.co'/.exec(fs.readFileSync(path.join(ROOT, 'config.prod.js'), 'utf8'))[1];
const OTHER_REF = 'abcdefghijklmnopqrst';
const NIL = '00000000-0000-0000-0000-000000000000';
const REAL = '12345678-1234-1234-1234-123456789abc';

// A fake curl that records every call; the guard tests must prove that NO request was made.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(dir, 'curl-calls.log');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf 'CALL %s\\n' "$*" >> '${calls}'\nprintf '{}\\n401'\n`, { mode: 0o755 });
  const root = path.join(dir, 'root'); fs.mkdirSync(path.join(root, 'tests/security'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config.prod.js'), path.join(root, 'config.prod.js'));
  return { dir, bin, calls, root, curlCalls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter((l) => l.startsWith('CALL ')) : []) };
}
const bash = (script, env = {}, sb) => spawnSync('bash', ['-c', script], {
  cwd: ROOT, encoding: 'utf8',
  env: { PATH: `${sb ? sb.bin + ':' : ''}${process.env.PATH}`, HOME: os.tmpdir(), PT_ROOT: sb ? sb.root : ROOT, ...env },
});
const classify = (env, sb) => bash(`source tests/security/lib/target-guard.sh; pt_classify_target`, env, sb).stdout.trim();

test('the target is classified from the project reference, not from APP_ENV', () => {
  assert.equal(classify({ SUPABASE_URL: `https://${PROD_REF}.supabase.co`, APP_ENV: 'staging' }), 'production-readonly');
  assert.equal(classify({ SUPABASE_URL: `https://${PROD_REF}.supabase.co/`, APP_ENV: 'local' }), 'production-readonly');
  assert.match(classify({ SUPABASE_URL: `https://${OTHER_REF}.supabase.co` }), /^refuse:.*neither production nor a listed staging/);
});

test('fails closed: unparseable URLs, custom domains and missing config are refused', () => {
  for (const u of ['', 'http://localhost:54321', 'https://api.example.com', `https://${PROD_REF}.supabase.co.evil.com`, `http://${PROD_REF}.supabase.co`, `https://x.${PROD_REF}.supabase.co`]) {
    assert.match(classify({ SUPABASE_URL: u }), /^refuse:/, `refused: ${u}`);
  }
  const sb = sandbox(); fs.unlinkSync(path.join(sb.root, 'config.prod.js'));
  assert.match(classify({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` }, sb), /^refuse:cannot read the production project reference/);
});

test('a staging target needs BOTH a listing in staging-targets.txt and an explicit confirmation, and can never be the production ref', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.root, 'tests/security/staging-targets.txt'), `# listed staging projects\n${OTHER_REF}  # staging\n${PROD_REF}\n`);
  assert.match(classify({ SUPABASE_URL: `https://${OTHER_REF}.supabase.co` }, sb), /^refuse:staging target needs SECURITY_TARGET_CONFIRM/);
  assert.match(classify({ SUPABASE_URL: `https://${OTHER_REF}.supabase.co`, SECURITY_TARGET_CONFIRM: 'wrong' }, sb), /^refuse:/);
  assert.equal(classify({ SUPABASE_URL: `https://${OTHER_REF}.supabase.co`, SECURITY_TARGET_CONFIRM: OTHER_REF }, sb), 'staging-full');
  // listing the production ref as "staging" must not downgrade it
  assert.equal(classify({ SUPABASE_URL: `https://${PROD_REF}.supabase.co`, SECURITY_TARGET_CONFIRM: PROD_REF }, sb), 'production-readonly');
});

test('production + admin or test-user credentials is refused before any request, whatever APP_ENV says', () => {
  for (const creds of [{ ADMIN_EMAIL: 'a@example.test', ADMIN_PASSWORD: 'x' }, { TEST_USER_EMAIL: 'u@example.test', TEST_USER_PASSWORD: 'y' }, { ADMIN_PASSWORD: 'only-a-password' }]) {
    const sb = sandbox();
    const r = spawnSync('bash', ['tests/security/run.sh'], { cwd: ROOT, encoding: 'utf8', env: { PATH: `${sb.bin}:${process.env.PATH}`, HOME: os.tmpdir(), APP_ENV: 'staging', SUPABASE_URL: `https://${PROD_REF}.supabase.co`, SUPABASE_ANON_KEY: 'anon', ...creds } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /SECURITY SUITE REFUSED: .*PRODUCTION project/);
    assert.deepEqual(sb.curlCalls(), [], 'no request was sent');
  }
});

test('an unknown project is refused by run.sh before any request', () => {
  const sb = sandbox();
  const r = spawnSync('bash', ['tests/security/run.sh'], { cwd: ROOT, encoding: 'utf8', env: { PATH: `${sb.bin}:${process.env.PATH}`, HOME: os.tmpdir(), APP_ENV: 'staging', SUPABASE_URL: `https://${OTHER_REF}.supabase.co`, SUPABASE_ANON_KEY: 'anon' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SECURITY SUITE REFUSED/);
  assert.deepEqual(sb.curlCalls(), []);
});

const guard = (method, url, body = '', bearer = '') => spawnSync('bash', ['-c', `source tests/security/lib/target-guard.sh; PT_MODE=production-readonly; SUPABASE_ANON_KEY=anonkey; pt_guard_request "$@"`, 'g', method, url,
  ...(bearer ? ['-H', `Authorization: Bearer ${bearer}`] : []), ...(body ? ['-d', body] : [])], { cwd: ROOT, encoding: 'utf8' }).status;
const U = `https://${PROD_REF}.supabase.co`;

test('production-readonly allows anonymous reads and expected-denial probes', () => {
  assert.equal(guard('GET', `${U}/rest/v1/properties?status=eq.active&select=id&limit=1`), 0);
  assert.equal(guard('GET', `${U}/rest/v1/properties?select=id`, '', 'anonkey'), 0, 'the anon key as bearer is not a user token');
  assert.equal(guard('POST', `${U}/functions/v1/generate-listing-content`, '{}', 'not.a.valid.jwt.at.all'), 0, 'a deliberately malformed token carries no identity');
  assert.equal(guard('POST', `${U}/functions/v1/resolve-map-url`, '{"url":"https://evil.com"}'), 0);
  assert.equal(guard('POST', `${U}/functions/v1/generate-listing-content`, '{}', 'anonkey'), 0);
  assert.equal(guard('POST', `${U}/storage/v1/object/property-images/x.php`, 'X'), 0);
  assert.equal(guard('POST', `${U}/rest/v1/properties`, '{"title_en":"PENTEST_INSERT","status":"active"}'), 0, 'anon insert into a table with no anon insert policy');
  assert.equal(guard('PATCH', `${U}/rest/v1/properties?id=eq.${NIL}`, '{"title_en":"HACKED"}'), 0);
  assert.equal(guard('DELETE', `${U}/rest/v1/contacts?id=eq.${NIL}`), 0);
  assert.equal(guard('POST', `${U}/rest/v1/listing_events`, `{"property_id":"${NIL}","event_type":"view","session_id":"s"}`), 0);
  assert.equal(guard('POST', `${U}/rest/v1/rpc/increment_listing_view`, `{"property_id":"' OR 1=1--"}`), 0);
});

test('production-readonly refuses anything that could write to a real row, use a user token or log in', () => {
  const refused = [
    ['PATCH', `${U}/rest/v1/properties?status=eq.active`, '{"title_en":"HACKED"}'],            // blast radius: every active listing if RLS regressed
    ['DELETE', `${U}/rest/v1/properties?status=eq.active`],
    ['PATCH', `${U}/rest/v1/properties?id=eq.${REAL}`, '{"x":1}'],
    ['DELETE', `${U}/rest/v1/contacts?id=eq.${REAL}`],
    ['POST', `${U}/rest/v1/listing_events`, `{"property_id":"${REAL}","event_type":"view","session_id":"s"}`], // the three persistent rows
    ['POST', `${U}/rest/v1/lead_events`, `{"listing_id":"${REAL}","event_type":"whatsapp_click","session_id":"s"}`],
    ['POST', `${U}/rest/v1/listing_events`, `{"property_id":"${NIL}","x":"${REAL}"}`],
    ['POST', `${U}/rest/v1/rpc/increment_listing_view`, `{"p_listing_id":"${REAL}"}`],
    ['POST', `${U}/auth/v1/token?grant_type=password`, '{"email":"a","password":"b"}'],
    ['POST', `${U}/auth/v1/signup`, '{}'],
    ['GET', `${U}/auth/v1/admin/users`],
    ['POST', `${U}/rest/v1/contacts`, '{"role":"other"}', 'eyJ.user.jwt'],
    ['POST', `${U}/functions/v1/generate-listing-content`, '{}', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'],
    ['GET', `${U}/rest/v1/properties?select=id`, '', 'eyJ.user.jwt'],
    ['POST', `${U}/storage/v1/object/property-images/x.jpg`, 'X', 'eyJ.user.jwt'],
    ['PUT', `${U}/somewhere/else`, 'x'],
  ];
  for (const [m, u, b, t] of refused) assert.equal(guard(m, u, b, t), 1, `${m} ${u} ${b || ''}`);
});

test('a refused request STOPS the run (kill + exit 97) instead of becoming a failed, skipped or passing check', () => {
  const sb = sandbox();
  const script = `
    source tests/security/lib/helpers.sh
    trap 'echo "FATAL: run aborted by the production-readonly guard" >&2; exit 97' TERM
    SUPABASE_URL='${U}'; SUPABASE_ANON_KEY=anonkey; PT_MODE=production-readonly
    r=$(api_get "properties?select=id&limit=1"); echo "first ok"
    r=$(api_patch "properties?status=eq.active" '{"title_en":"HACKED"}'); echo "SHOULD NEVER PRINT"`;
  const r = bash(script, {}, sb);
  assert.equal(r.status, 97, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /SHOULD NEVER PRINT/);
  assert.match(r.stdout, /first ok/);
  assert.equal(sb.curlCalls().length, 1, 'only the allowed GET reached curl');
});

test('in staging-full mode the guard does not interfere', () => {
  const r = bash(`source tests/security/lib/target-guard.sh; PT_MODE=staging-full; pt_guard_request PATCH "${U}/rest/v1/properties?status=eq.active" -d '{}'`);
  assert.equal(r.status, 0);
});

// ── Dry run of the WHOLE suite against a recording curl: what would actually be sent to production? ─────────────────────────────────────
function recordingCurl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  // One line per call, newlines inside arguments flattened. Answers 401 with a one-row JSON array so discovery steps proceed (many checks fail; irrelevant here).
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf 'CALL %s\\n' "$(printf '%s ' "$@" | tr '\\n' ' ')" >> '${log}'\nprintf '[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","contact_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]\\n401'\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('CALL ')) : []) };
}
function dryRun(extraEnv = {}) {
  const rc = recordingCurl();
  const r = spawnSync('bash', ['tests/security/run.sh'], {
    cwd: ROOT, encoding: 'utf8', timeout: 170000,
    env: { PATH: `${rc.bin}:${process.env.PATH}`, HOME: os.tmpdir(), SUPABASE_URL: `https://${PROD_REF}.supabase.co`, SUPABASE_ANON_KEY: 'anonkey', ...extraEnv },
  });
  return { r, calls: rc.calls() };
}
const parse = (line) => {
  const t = line.replace(/^CALL /, '');
  return { method: (/-X (\w+)/.exec(t) || [, 'GET'])[1], url: (/https?:\/\/\S+/.exec(t) || [''])[0], bearer: (/Authorization: Bearer (\S+)/.exec(t) || [])[1], body: (/(?:-d|--data-raw|--data-binary) (.*?)(?: -[HXsw]\b|$)/.exec(t) || [, ''])[1], text: t };
};

test('dry run of the full production suite: anonymous, no login, and not one request that can create or change a real row', () => {
  const { r, calls } = dryRun();
  assert.notEqual(r.status, 97, 'the guard never fired: ' + r.stderr);
  assert.match(r.stdout, /Target mode: production-readonly/);
  assert.ok(calls.length > 100, `the suites actually ran (${calls.length} requests)`);
  const writes = [];
  for (const line of calls) {
    const c = parse(line);
    assert.ok(!/\/auth\/v1\//.test(c.url), `no authentication request: ${c.url}`);
    assert.ok(c.bearer === undefined || c.bearer === 'anonkey' || !/^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(c.bearer), `only the public anon key or a deliberately malformed token is ever sent as a bearer: ${c.text}`);
    if (c.method === 'GET') continue;
    writes.push(c);
    if (/\/rest\/v1\/(listing_events|lead_events)/.test(c.url)) {
      assert.match(c.body, new RegExp(NIL), `analytics insert names the nil UUID: ${c.body}`);
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(c.body.replaceAll(NIL, '')), `no real id in: ${c.body}`);
    }
    if ((c.method === 'PATCH' || c.method === 'DELETE') && c.url.includes('/rest/v1/')) assert.ok(c.url.includes(`id=eq.${NIL}`), `${c.method} is scoped to the nil UUID: ${c.url}`);
    if (c.method === 'DELETE' && c.url.includes('/storage/v1/')) assert.match(c.url, /\/does-not-exist-/, `storage DELETE names a file that cannot exist: ${c.url}`);
    if (c.url.includes('/storage/v1/')) assert.equal(c.bearer, undefined, 'storage probes carry no token');
  }
  assert.ok(writes.some((c) => /\/rest\/v1\/listing_events/.test(c.url)), 'the nil-UUID rejection probe for listing_events is present');
  assert.ok(!writes.some((c) => /\/storage\/v1\/object\/.*\.jpg$/.test(c.url) && c.bearer), 'no authenticated storage upload');
});

test('credentials set in the environment change nothing: the production run is refused before a single request', () => {
  const { r, calls } = dryRun({ ADMIN_EMAIL: 'a@example.test', ADMIN_PASSWORD: 'x', TEST_USER_EMAIL: 'u@example.test', TEST_USER_PASSWORD: 'y' });
  assert.equal(r.status, 1);
  assert.deepEqual(calls, []);
});

// ── Static properties of the repository ─────────────────────────────────────────────────────────────────────────────────────────────────────
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/security-regression.yml'), 'utf8');
const SUITES = fs.readdirSync(path.join(ROOT, 'tests/security/suites')).filter((f) => f.endsWith('.sh')).map((f) => [f, fs.readFileSync(path.join(ROOT, 'tests/security/suites', f), 'utf8')]);

test('the live workflow job receives no administrator or test-user credential and no environment label', () => {
  const job = WORKFLOW.slice(WORKFLOW.indexOf('\n  security:'));
  assert.doesNotMatch(WORKFLOW, /secrets\.(ADMIN|TEST_USER)/);
  assert.doesNotMatch(WORKFLOW, /^\s*(ADMIN_EMAIL|ADMIN_PASSWORD|TEST_USER_EMAIL|TEST_USER_PASSWORD|APP_ENV):/m);
  const env = job.slice(job.indexOf('env:'), job.indexOf('steps:'));
  assert.deepEqual([...env.matchAll(/^\s{6}([A-Z_]+):/gm)].map((m) => m[1]), ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SITE_URL']);
  assert.match(job, /if: github\.event_name != 'pull_request'/);
  assert.match(WORKFLOW, /push:\s*\n\s*branches: \[main\]/);
  assert.match(WORKFLOW, /cron: '0 2 \* \* 1'/);
});

test('no suite writes to a real record in production: every anonymous write is a rejection probe, no request bypasses http_request', () => {
  for (const [name, src] of SUITES) {
    const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    // an anonymous PATCH/DELETE (no jwt argument) may only filter on the nil UUID
    for (const m of code.matchAll(/api_(patch|delete) +"([^"]*)"([^\n]*)/g)) {
      const hasJwt = /JWT/.test(m[3]);
      // 09 probes a draft that only exists when an administrator created it (credentialed, staging only); production never reaches it and the runtime guard refuses it there.
      const stagingOnly = name.startsWith('09_') && /draft_id|test_slug/.test(m[2]);
      if (!hasJwt && !stagingOnly) assert.match(m[2], /id=eq\.00000000-0000-0000-0000-000000000000/, `${name}: anonymous ${m[1]} must filter on the nil UUID: ${m[0]}`);
    }
    // analytics inserts never name an active listing
    assert.doesNotMatch(code, /api_post +"(listing_events|lead_events)"[^\n]*\n?[^\n]*\$\{?active_id/, `${name}: no insert of events for a real listing`);
    // raw curl is allowed only for read-only GET/HEAD of the public site
    for (const m of code.matchAll(/\bcurl\b[^\n]*/g)) assert.doesNotMatch(m[0], /-X +(POST|PUT|PATCH|DELETE)|--data|\s-d\s/, `${name}: raw curl must be read-only: ${m[0]}`);
  }
});

test('no tracked file lists a staging target yet: credentialed tests are disabled everywhere', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'tests/security/staging-targets.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  assert.deepEqual(lines, []);
});
