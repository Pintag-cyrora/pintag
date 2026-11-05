// The live security suite must never run credentialed, mutating, uploading or externally side-effecting tests against the production project.
// Proves: the target is classified from the project reference in SUPABASE_URL (not from APP_ENV); production + credentials is refused
// before any request; unknown targets fail closed; production-readonly sends ONLY plain GET/HEAD requests to the project's /rest/v1/ and the site
// (no body, no token, no RPC, no Edge Function, no Storage call, no auth endpoint, no other host); the guard stops the run (it never becomes a skipped or
// passing check); and a recording-curl dry run of the real suites shows exactly that. Nothing here relies on a production access-control policy to reject
// a dangerous request: such a request is never sent.
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

const guard = (method, url, { body = '', bearer = '', site = '', extra = [] } = {}) => spawnSync('bash', ['-c', `source tests/security/lib/target-guard.sh; PT_MODE=production-readonly; SUPABASE_URL=https://${PROD_REF}.supabase.co; SITE_URL="${site}"; SUPABASE_ANON_KEY=anonkey; pt_guard_request "$@"`, 'g', method, url,
  ...(bearer ? ['-H', `Authorization: Bearer ${bearer}`] : []), ...(body ? ['-d', body] : []), ...extra], { cwd: ROOT, encoding: 'utf8' }).status;
const U = `https://${PROD_REF}.supabase.co`;
const SITE = 'https://pintag.io';

test('production-readonly allows plain GET/HEAD of the project\'s /rest/v1/ (with the public anon key) and of the site, and nothing else', () => {
  assert.equal(guard('GET', `${U}/rest/v1/properties?status=eq.active&select=id&limit=1`), 0);
  assert.equal(guard('GET', `${U}/rest/v1/properties?select=id`, { bearer: 'anonkey' }), 0, 'the anon key as bearer is not a user token');
  assert.equal(guard('GET', `${U}/rest/v1/properties?slug=eq.%27%20OR%201%3D1--&select=id`), 0, 'an injection payload in a GET filter is still a read');
  assert.equal(guard('GET', `${SITE}/listings.html`, { site: SITE }), 0);
  assert.equal(guard('HEAD', `${SITE}/`, { site: SITE }), 0);
});

test('production-readonly refuses EVERY non-GET method, whatever the body, id or table (no nil-UUID exception, no RPC exception)', () => {
  const NIL = '00000000-0000-0000-0000-000000000000', REAL = '12345678-1234-1234-1234-123456789abc';
  for (const m of ['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']) {
    for (const u of [`${U}/rest/v1/properties`, `${U}/rest/v1/properties?id=eq.${NIL}`, `${U}/rest/v1/listing_events`, `${U}/rest/v1/parties?id=eq.${REAL}`,
      `${U}/rest/v1/rpc/increment_listing_view`, `${U}/functions/v1/resolve-map-url`, `${U}/storage/v1/object/property-images/pentest.jpg`]) {
      assert.equal(guard(m, u, { body: `{"p_listing_id":"${NIL}"}` }), 1, `${m} ${u}`);
    }
  }
});

test('production-readonly refuses RPC, Edge Function, Storage and authentication endpoints even for GET, hosts other than the project and the site, and options that carry a body or a credential', () => {
  for (const u of [`${U}/rest/v1/rpc/public_listing_stats?p_listing_id=x`, `${U}/functions/v1/resolve-map-url`, `${U}/functions/v1/generate-intelligence-report`, `${U}/storage/v1/object/public/property-images/x.jpg`,
    `${U}/auth/v1/settings`, `${U}/auth/v1/user`, `${U}/rest/v2/properties`, `https://evil.example/rest/v1/properties`, `${U}.evil.example/rest/v1/properties`, `https://maps.app.goo.gl/x`, `https://www.google.com/maps`]) {
    assert.equal(guard('GET', u, { site: SITE }), 1, u);
  }
  assert.equal(guard('GET', `${SITE}/x`), 1, 'the site is allowed only when SITE_URL names it');
  assert.equal(guard('GET', `${SITE}.evil.example/x`, { site: SITE }), 1);
  for (const extra of [['-d', 'x=1'], ['--data-raw', '{}'], ['--data-binary', 'x'], ['--json', '{}'], ['-F', 'a=b'], ['-T', 'f'], ['-b', 'a=b'], ['-u', 'a:b'], ['-X', 'POST'], ['-H', 'Authorization: Basic YTpi'], ['-H', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln']]) {
    assert.equal(guard('GET', `${U}/rest/v1/properties`, { extra }), 1, extra.join(' '));
  }
  assert.equal(guard('GET', `${U}/rest/v1/properties`, { bearer: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' }), 1, 'a user session token is never sent');
  assert.equal(guard('GET', `${U}/rest/v1/properties`, { bearer: 'not.a.valid.jwt.at.all' }), 1, 'no credential other than the public anon key, even a malformed one');
});

test('a refused request STOPS the run (kill + exit 97) instead of becoming a failed, skipped or passing check', () => {
  const sb = sandbox();
  const script = `
    source tests/security/lib/helpers.sh
    trap 'echo "FATAL: run aborted by the production-readonly guard" >&2; exit 97' TERM
    SUPABASE_URL='${U}'; SUPABASE_ANON_KEY=anonkey; PT_MODE=production-readonly
    r=$(api_get "properties?select=id&limit=1"); echo "first ok"
    r=$(api_post "properties" '{"title_en":"x"}'); echo "SHOULD NEVER PRINT"`;
  const r = bash(script, {}, sb);
  assert.equal(r.status, 97, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /SHOULD NEVER PRINT/);
  assert.match(r.stdout, /first ok/);
  assert.equal(sb.curlCalls().length, 1, 'only the allowed GET reached curl');
});

test('every way a refusal can be hidden still ends the run: nested substitution in a condition, || true, a pipeline, a background job, negation, and the site helpers', () => {
  for (const [name, snippet] of [
    ['condition', `if [[ "$(resp_status "$(fn_post "resolve-map-url" '{}')")" == "401" ]]; then echo SURVIVED; fi`],
    ['or-true', `r=$(api_delete "properties?id=eq.1" || true)`],
    ['pipeline', `api_patch "properties" '{}' | head -1`],
    ['background', `(storage_upload "property-images" "x.jpg" "image/jpeg" "x" >/dev/null) & wait || true`],
    ['negated', `! api_post "listing_events" '{}'`],
    ['site-helper', `SITE_URL=''; site_head "https://pintag.io/" >/dev/null`],
  ]) {
    const sb = sandbox();
    const r = bash(`set -euo pipefail
      source tests/security/lib/helpers.sh
      trap 'exit 97' TERM
      SUPABASE_URL='${U}'; SUPABASE_ANON_KEY=anonkey; PT_MODE=production-readonly
      ${snippet}
      echo "REACHED-AFTER"`, {}, sb);
    assert.equal(r.status, 97, `${name}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /REACHED-AFTER|SURVIVED/, name);
    assert.equal(sb.curlCalls().length, 0, `${name}: nothing reached curl`);
  }
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

test('dry run of the production suites against a recording curl: ONLY plain GET/HEAD to the project\'s /rest/v1/ and the site; no body, no token, no RPC, no function, no storage, no auth', () => {
  const { r, calls } = dryRun();
  assert.notEqual(r.status, 97, 'the guard never fired: ' + r.stderr);
  assert.match(r.stdout, /Mode:\s+production-readonly \(project ref [a-z0-9]{20}\)/);
  assert.doesNotMatch(r.stdout, /Env:\s/, 'the banner shows the target mode, not an APP_ENV label');
  assert.match(r.stdout, /Suites \(5\):[\s\S]*rls_read[\s\S]*headers[\s\S]*sql_injection_read[\s\S]*secret_scan[\s\S]*intelligence_read/, 'only the production-safe suites are loaded');
  assert.doesNotMatch(r.stdout, /staging-suites|\bstorage\b.*PASS|ssrf|open_redirect/i);
  assert.ok(calls.length >= 25, `the suites actually ran (${calls.length} requests)`);
  for (const line of calls) {
    const c = parse(line);
    assert.equal(c.method, 'GET', `only GET: ${c.text}`);
    assert.ok(c.url.startsWith(`https://${PROD_REF}.supabase.co/rest/v1/`), `only the project's /rest/v1/: ${c.url}`);
    assert.ok(!/\/rpc\/|\/functions\/v1\/|\/storage\/v1\/|\/auth\/v1\//.test(c.url), `no rpc / function / storage / auth: ${c.url}`);
    assert.ok(c.bearer === undefined || c.bearer === 'anonkey', `no bearer other than the public anon key: ${c.text}`);
    assert.ok(!/\s(-d|--data\S*|-F|-T|--json|-b|-u)\s/.test(' ' + c.text + ' '), `no body, upload, cookie or credential option: ${c.text}`);
  }
  // the requests that DO get sent are the read probes (a few examples that must be present)
  for (const must of ['/rest/v1/properties?status=eq.draft', '/rest/v1/lead_events', '/rest/v1/intelligence_reports', '/rest/v1/report_insights']) assert.ok(calls.some((l) => l.includes(must)), `read probe present: ${must}`);
});

test('with SITE_URL set the header suite sends only GET/HEAD to the site, through the same guard', () => {
  const { r, calls } = dryRun({ SITE_URL: 'https://pintag.io' });
  assert.notEqual(r.status, 97, r.stderr);
  assert.ok(calls.every((l) => !/\s-X\s(POST|PUT|PATCH|DELETE)\s/.test(l) && !/\s(-d|--data\S*)\s/.test(l)), 'no write verb and no body, with or without SITE_URL');
  assert.ok(calls.some((l) => l.includes('https://pintag.io/')), 'the site was requested (HEAD/GET)');
});

test('APP_ENV never changes the outcome or the label: the banner and the report name the real target mode and project ref', () => {
  const { r } = dryRun({ APP_ENV: 'staging-pretend' });
  assert.doesNotMatch(r.stdout, /staging-pretend/);
  const refused = dryRun({ APP_ENV: 'local', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' });
  assert.equal(refused.r.status, 1); assert.match(refused.r.stderr, /neither production nor a listed staging target/); assert.deepEqual(refused.calls, []);
  assert.equal(dryRun({ APP_ENV: 'production' }).r.status, 1, 'the literal APP_ENV=production is still refused');
});

test('credentials set in the environment change nothing: the production run is refused before a single request', () => {
  const { r, calls } = dryRun({ ADMIN_EMAIL: 'a@example.test', ADMIN_PASSWORD: 'x', TEST_USER_EMAIL: 'u@example.test', TEST_USER_PASSWORD: 'y' });
  assert.equal(r.status, 1);
  assert.deepEqual(calls, []);
});

// ── Static properties of the repository ─────────────────────────────────────────────────────────────────────────────────────────────────────
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/security-regression.yml'), 'utf8');
const SUITE_DIR = path.join(ROOT, 'tests/security/suites'), STAGING_DIR = path.join(ROOT, 'tests/security/staging-suites');
const SUITES = fs.readdirSync(SUITE_DIR).filter((f) => f.endsWith('.sh')).map((f) => [f, fs.readFileSync(path.join(SUITE_DIR, f), 'utf8')]);

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

test('production suites contain no write, upload, RPC, function or raw-curl code at all; the mutating suites live in staging-suites/, loaded only for a listed staging project', () => {
  assert.deepEqual(SUITES.map(([f]) => f).sort(), ['02_rls_read.sh', '08_headers.sh', '10_sql_injection_read.sh', '11_secret_scan.sh', '13_intelligence_read.sh']);
  for (const [name, src] of SUITES) {
    const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /\b(api_post|api_patch|api_delete|fn_post|storage_upload|storage_delete|acquire_jwt)\b/, `${name}: no write/upload/function helper`);
    assert.doesNotMatch(code, /\bcurl\b/, `${name}: no raw curl (every request goes through the guarded helpers)`);
    assert.doesNotMatch(code, /\/rpc\/|\/functions\/v1|\/storage\/v1|\/auth\/v1|ADMIN_JWT|TEST_USER_JWT/, `${name}: no rpc / function / storage / auth / token`);
  }
  assert.ok(fs.readdirSync(STAGING_DIR).length >= 10, 'the credentialed suites are kept, unchanged in substance, for the future staging project');
  const run = fs.readFileSync(path.join(ROOT, 'tests/security/run.sh'), 'utf8');
  assert.match(run, /if \[\[ "\$PT_MODE" == "staging-full" \]\]; then SUITE_FILES\+=\(tests\/security\/staging-suites\/\*\.sh\); fi/);
});

test('no tracked file lists a staging target yet: the credentialed suites cannot run anywhere from run.sh', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'tests/security/staging-targets.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  assert.deepEqual(lines, []);
});

test('the wording is accurate: credentialed tests are disabled in the live security-regression workflow, and verify-production-security.yml is documented as a separate workflow', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'tests/security/README.md'), 'utf8');
  const targets = fs.readFileSync(path.join(ROOT, 'tests/security/staging-targets.txt'), 'utf8');
  assert.doesNotMatch(readme + targets, /disabled everywhere/i);
  assert.match(readme, /verify-production-security\.yml/); assert.match(readme, /verify-admin-lockdown\.sh/);
  assert.match(readme, /separate workflow/i); assert.match(readme, /signs in/i);
  assert.match(targets, /live security-regression workflow/i);
});

test('the coverage gaps this change creates on production are stated, not hidden', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'tests/security/README.md'), 'utf8');
  for (const gap of [/write-path policy drift/i, /Storage/i, /Edge Function/i, /increment_listing_view/, /listing_view_throttle/]) assert.match(readme, gap, String(gap));
});
