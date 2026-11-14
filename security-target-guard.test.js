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

// guard(): calls pt_guard_request exactly as helpers.sh would. `args` is the complete list of curl arguments after the URL; by default a project URL gets the one
// permitted pair (-H "apikey: anonkey") and a site URL gets none. Returns the exit status: 0 allowed, 1 refused.
const U = `https://${PROD_REF}.supabase.co`;
const SITE = 'https://pintag.io';
const KEY = ['-H', 'apikey: anonkey'];
const guard = (method, url, { site = SITE, args } = {}) => spawnSync('bash', ['-c', `source tests/security/lib/target-guard.sh; PT_MODE=production-readonly; SUPABASE_URL=https://${PROD_REF}.supabase.co; SITE_URL="${site}"; SUPABASE_ANON_KEY=anonkey; pt_guard_request "$@"`, 'g', method, url,
  // default arguments only: a project-looking URL (including look-alikes of it) gets the permitted pair so that a refusal is decided by the URL checks, not by missing arguments
  ...(args ?? (url.startsWith(U) ? KEY : []))], { cwd: ROOT, encoding: 'utf8' }).status;

test('production-readonly allows EXACTLY plain GET/HEAD of a permitted table with the anon-key header, and of the validated site', () => {
  assert.equal(guard('GET', `${U}/rest/v1/properties?status=eq.active&select=id&limit=1`), 0);
  assert.equal(guard('GET', `${U}/rest/v1/properties`), 0, 'no query');
  assert.equal(guard('GET', `${U}/rest/v1/properties?slug=eq.%27%20OR%201%3D1--&select=id`), 0, 'an injection payload in a GET filter is still a read');
  assert.equal(guard('GET', `${U}/rest/v1/listing_events?limit=5`), 0);
  assert.equal(guard('GET', `${SITE}/listings.html`), 0);
  assert.equal(guard('HEAD', `${SITE}/`), 0);
  assert.equal(guard('GET', SITE), 0);
});

test('production-readonly refuses EVERY non-GET method, whatever the body, id or table (no nil-UUID exception, no RPC exception)', () => {
  for (const m of ['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'TRACE', 'get', 'Get', 'head', 'GET ', '', 'CONNECT']) {
    for (const u of [`${U}/rest/v1/properties`, `${U}/rest/v1/properties?id=eq.${NIL}`, `${U}/rest/v1/listing_events`, `${U}/rest/v1/parties?id=eq.${REAL}`,
      `${U}/rest/v1/rpc/increment_listing_view`, `${U}/functions/v1/resolve-map-url`, `${U}/storage/v1/object/property-images/pentest.jpg`, `${SITE}/`]) {
      assert.equal(guard(m, u), 1, `${m} ${u}`);
    }
  }
});

test('production-readonly refuses RPC, Edge Function, Storage and authentication endpoints even for GET, and every host other than the project and the validated site', () => {
  for (const u of [`${U}/rest/v1/rpc/public_listing_stats?p_listing_id=x`, `${U}/functions/v1/resolve-map-url`, `${U}/functions/v1/generate-intelligence-report`, `${U}/storage/v1/object/public/property-images/x.jpg`,
    `${U}/auth/v1/settings`, `${U}/auth/v1/user`, `${U}/rest/v2/properties`, `https://evil.example/rest/v1/properties`, `${U}.evil.example/rest/v1/properties`, `https://maps.app.goo.gl/x`, `https://www.google.com/maps`,
    `http://${PROD_REF}.supabase.co/rest/v1/properties`, `https://${PROD_REF}.supabase.co@evil.example/rest/v1/properties`, `https://evil.example@${PROD_REF}.supabase.co/rest/v1/properties`, `${U}:8443/rest/v1/properties`]) {
    assert.equal(guard('GET', u), 1, u);
  }
  assert.equal(guard('GET', `${SITE}/x`, { site: '' }), 1, 'the site is allowed only when SITE_URL names it');
  assert.equal(guard('GET', `${SITE}.evil.example/x`), 1);
  assert.equal(guard('GET', `${U}/rest/v1/properties`, { args: [] }), 1, 'the anon-key header is required, not optional');
});

// THE 18 BYPASSES FOUND IN THE FINAL AUDIT of the previous denylist guard (each was ALLOWED then), plus variations. All must be refused now.
test('the audit bypasses are refused: attached and abbreviated options, method overrides, redirects, proxies, alternate destinations, credential headers, cookies, bodies, encoded and ambiguous paths', () => {
  const T = `${U}/rest/v1/properties?select=id`;
  const cases = {
    // method / override
    '-XPOST attached': { args: [...KEY, '-XPOST'] }, '-X POST': { args: [...KEY, '-X', 'POST'] }, '-XGET attached': { args: [...KEY, '-XGET'] }, '--request=POST': { args: [...KEY, '--request=POST'] },
    '--req POST (abbreviation)': { args: [...KEY, '--req', 'POST'] }, 'X-HTTP-Method-Override': { args: [...KEY, '-H', 'X-HTTP-Method-Override: DELETE'] }, '-H X-Method-Override': { args: [...KEY, '-H', 'X-Method-Override: PATCH'] },
    '-H Prefer: tx=rollback': { args: [...KEY, '-H', 'Prefer: return=representation'] }, '-I flips to HEAD': { args: [...KEY, '-I'] }, '--head': { args: [...KEY, '--head'] },
    // body / upload
    "-d'{}' attached": { args: [...KEY, "-d'{}'"] }, '--data-ascii': { args: [...KEY, '--data-ascii', '{}'] }, '--data=': { args: [...KEY, '--data={}'] }, '-d': { args: [...KEY, '-d', '{}'] },
    '-G -d': { args: [...KEY, '-G', '-d', 'a=b'] }, '--data-raw': { args: [...KEY, '--data-raw', '{}'] }, '--json': { args: [...KEY, '--json', '{}'] }, '-F': { args: [...KEY, '-F', 'a=b'] }, '-T': { args: [...KEY, '-T', '/etc/hostname'] },
    '--upload-file=': { args: [...KEY, '--upload-file=x'] }, '--form-string': { args: [...KEY, '--form-string', 'a=b'] }, '--data-urlencode': { args: [...KEY, '--data-urlencode', 'a=b'] }, '-dBODY': { args: [...KEY, '-da=b'] },
    // credentials
    'AUTHORIZATION upper case': { args: [...KEY, '-H', 'AUTHORIZATION: Bearer usertoken'] }, 'authorization lower case': { args: [...KEY, '-H', 'authorization: Bearer usertoken'] },
    'Authorization anon key bearer': { args: [...KEY, '-H', 'Authorization: Bearer anonkey'] }, 'Authorization no space': { args: [...KEY, '-H', 'Authorization:Bearer usertoken'] },
    'second apikey (service key)': { args: [...KEY, '-H', 'apikey: service-role-key'] }, 'other apikey instead': { args: ['-H', 'apikey: service-role-key'] }, 'apikey upper case name': { args: ['-H', 'APIKEY: anonkey'] },
    'apikey with trailing space': { args: ['-H', 'apikey: anonkey '] }, 'apikey attached -H': { args: ['-Hapikey: anonkey'] }, '--header=': { args: ['--header=apikey: anonkey'] }, '--header apikey': { args: ['--header', 'apikey: anonkey'] },
    'Cookie header': { args: [...KEY, '-H', 'Cookie: sb-access-token=t'] }, '-b cookie': { args: [...KEY, '-b', 'a=b'] }, '--cookie=': { args: [...KEY, '--cookie=a=b'] }, '-u': { args: [...KEY, '-u', 'a:b'] },
    '--oauth2-bearer': { args: [...KEY, '--oauth2-bearer', 'tok'] }, '--user=': { args: [...KEY, '--user=a:b'] }, '-H @file': { args: [...KEY, '-H', '@/tmp/headers'] }, '-K config': { args: [...KEY, '-K', '/tmp/cfg'] }, '--config=': { args: [...KEY, '--config=/tmp/cfg'] },
    '--netrc': { args: [...KEY, '--netrc'] }, '--aws-sigv4': { args: [...KEY, '--aws-sigv4', 'aws:amz'] },
    // redirects / destinations / network path
    '-L': { args: [...KEY, '-L'] }, '--location': { args: [...KEY, '--location'] }, '--location-trusted': { args: [...KEY, '--location-trusted'] }, '--max-redirs': { args: [...KEY, '--max-redirs', '5'] },
    'second --url': { args: [...KEY, '--url', 'https://evil.example/'] }, 'second bare URL': { args: [...KEY, 'https://evil.example/'] }, '--next': { args: [...KEY, '--next', 'https://evil.example/'] },
    '--request-target': { args: [...KEY, '--request-target', '/functions/v1/x'] }, '--proxy': { args: [...KEY, '--proxy', 'http://evil.example:8080'] }, '-x proxy': { args: [...KEY, '-x', 'http://evil.example:8080'] },
    '--connect-to': { args: [...KEY, '--connect-to', '::evil.example:443'] }, '--resolve': { args: [...KEY, '--resolve', `${PROD_REF}.supabase.co:443:1.2.3.4`] }, '--path-as-is': { args: [...KEY, '--path-as-is'] },
    '--interface': { args: [...KEY, '--interface', 'eth0'] }, '--unix-socket': { args: [...KEY, '--unix-socket', '/var/run/docker.sock'] }, '-o output file': { args: [...KEY, '-o', '/tmp/x'] }, '-O remote name': { args: [...KEY, '-O'] },
    '--output-dir': { args: [...KEY, '--output-dir', '/tmp'] }, '--trace': { args: [...KEY, '--trace', '/tmp/t'] }, '-w write-out': { args: [...KEY, '-w', '%{http_code}'] }, '--proto-redir': { args: [...KEY, '--proto-redir', '+http'] },
    '--insecure': { args: [...KEY, '-k'] }, '--cacert': { args: [...KEY, '--cacert', '/tmp/ca'] }, '--doh-url': { args: [...KEY, '--doh-url', 'https://evil.example/dns'] },
    // arguments in a different position / count
    'key pair twice': { args: [...KEY, ...KEY] }, 'junk first': { args: ['--foo', ...KEY] }, 'empty extra arg': { args: [...KEY, ''] }, 'extra arg to a site request': { url: `${SITE}/`, args: ['-H', 'X: y'] },
  };
  for (const [name, c] of Object.entries(cases)) assert.equal(guard('GET', c.url || T, { args: c.args }), 1, `must be refused: ${name}`);
});

test('the audit path bypasses are refused: encoded segments, dot segments, empty segments, extra segments, unlisted tables, fragments, globs, controls and absolute-form tricks', () => {
  const bad = [
    `${U}/rest/v1/%72pc/increment_listing_view`, `${U}/rest/v1/%2e%2e/%2e%2e/%66unctions/v1/x`, `${U}/rest/v1//rpc/x`, `${U}/rest//v1/properties`, `${U}//rest/v1/properties`,
    `${U}/rest/v1/../v1/properties`, `${U}/rest/v1/./properties`, `${U}/rest/v1/properties/`, `${U}/rest/v1/properties/x`, `${U}/rest/v1/%70roperties`, `${U}/rest/v1/properties%00`, `${U}/rest/v1/properties%2f`, `${U}/rest/v1/Properties`,
    `${U}/rest/v1/`, `${U}/rest/v1`, `${U}/rest/v1/rpc`, `${U}/rest/v1/rpc/`, `${U}/rest/v1/unlisted_table`, `${U}/rest/v1/profiles`, `${U}/rest/v1/admins`, `${U}/rest/v1/properties;x=1`, `${U}/rest/v1/properties#frag`, `${U}/rest/v1/properties\\x`,
    `${U}/rest/v1/pro perties`, `${U}/rest/v1/properties?a=b c`, `${U}/rest/v1/properties?a=b#c`, `${U}/rest/v1/properties?a=[1-5]`, `${U}/rest/v1/properties?a={x,y}`, `${U}/rest/v1/properties?a=%`, `${U}/rest/v1/properties?a=%G0`, `${U}/rest/v1/properties?a=%1`,
    `${U}/rest/v1/properties?a=b|c`, `${U}/rest/v1/properties?a=b;c`, `${U}/rest/v1/properties?a=<s>`, `${U}/rest/v1/properties?a="x"`, `${U}/rest/v1/properties?a=@evil`, `${U}/rest/v1/properties?a=\\`, `${U}/rest/v1/properties?a=$HOME`,
    `${U}/rest/v1/properties?a=\n`, `${U}/rest/v1/properties\n`, `${U}/rest/v1/properties?a=b https://evil.example/`, 
    `${SITE}/%2e%2e/x`, `${SITE}/../x`, `${SITE}/a/../b`, `${SITE}/./a`, `${SITE}//evil.example/x`, `${SITE}/a//b`, `${SITE}/.git/config`, `${SITE}/.env`, `${SITE}/a?x=1`, `${SITE}/a#x`, `${SITE}/a%2fb`, `${SITE}/a b`, `${SITE}/a;b`, `${SITE}/\\evil`,
    `${SITE}@evil.example/`, `${SITE}:8443/`, 'https://pintag.io.evil.example/', 'https://evilpintag.io/', 'https://sub.pintag.io/', 'ftp://pintag.io/', 'file:///etc/passwd', '//pintag.io/', 'pintag.io/', 'HTTPS://pintag.io/',
  ];
  for (const u of bad) assert.equal(guard('GET', u), 1, `must be refused: ${JSON.stringify(u)}`);
});

test('SITE_URL is validated before it is trusted as a destination: scheme, host, path, port, userinfo, case and look-alikes', () => {
  const ok = ['https://pintag.io', 'https://pintag.io/', 'https://www.pintag.io'];
  const badSite = ['http://pintag.io', 'https://pintag.io/x', 'https://pintag.io/?a=b', 'https://pintag.io#f', 'https://pintag.io:443', 'https://user@pintag.io', 'https://user:pw@pintag.io', 'https://PINTAG.io', 'https://evil.example',
    'https://pintag.io.evil.example', 'https://evil-pintag.io', 'https://sub.pintag.io', 'https://127.0.0.1', 'https://localhost', 'https://pintag.io\\@evil.example', 'https://pintag.io ', ' https://pintag.io', 'https://pintag.io\n', 'pintag.io', '//pintag.io', 'javascript:alert(1)', 'https://xn--pintag.io', 'https://pintag.io..'];
  for (const s of ok) assert.equal(guard('GET', `${s.replace(/\/$/, '')}/listings.html`, { site: s }), 0, `accepted: ${s}`);
  for (const s of badSite) assert.equal(guard('GET', s.startsWith('https://') ? `${s.trim()}/` : `${SITE}/`, { site: s }), 1, `refused: ${JSON.stringify(s)}`);
  // run.sh refuses a bad SITE_URL before the first request, naming the problem
  for (const s of ['http://pintag.io', 'https://evil.example', 'https://pintag.io/x', 'https://user@pintag.io']) {
    const { r, calls } = dryRun({ SITE_URL: s });
    assert.equal(r.status, 1, s); assert.match(r.stderr, /SITE_URL is not an acceptable destination/); assert.deepEqual(calls, [], 'no request before the refusal');
  }
  // a trailing slash in the secret is normalised, not turned into a // path
  const { r, calls } = dryRun({ SITE_URL: 'https://pintag.io/' });
  assert.notEqual(r.status, 97, r.stderr); assert.doesNotMatch(r.stderr, /not an acceptable destination/);
  assert.ok(siteRootRequested(calls), 'the site was requested at its normalised root'); assert.ok(calls.every((l) => !/pintag\.io\/\//.test(l)), 'no // path');
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

// URL assertions never use string containment. A recorded curl call is split into arguments, each http(s) argument is parsed with the URL parser, and the parts
// (protocol, hostname, port, credentials, path) are compared exactly. `raw === href` additionally rejects spellings the parser would silently normalise (an explicit
// default port such as :443, an upper-case host, a dot segment), so "the request went to pintag.io" cannot be satisfied by a lookalike or embedded host.
const requestedUrls = (line) => line.replace(/^CALL /, '').split(/\s+/).filter((t) => /^[a-z][a-z0-9+.-]*:/i.test(t) && t.includes('//')).map((raw) => { try { return { raw, url: new URL(raw) }; } catch { return null; } }).filter(Boolean);
const isSiteRoot = ({ raw, url }) => url.protocol === 'https:' && url.hostname === 'pintag.io' && url.port === '' && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '' && raw === url.href;
const siteRootRequested = (calls) => calls.some((l) => requestedUrls(l).some(isSiteRoot));
const isProjectRead = ({ url }) => url.protocol === 'https:' && url.hostname === `${PROD_REF}.supabase.co` && url.port === '' && url.username === '' && url.password === '' && url.pathname.startsWith('/rest/v1/');

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
    assert.ok(requestedUrls(line).length === 1 && isProjectRead(requestedUrls(line)[0]), `exactly one URL, on the project host (https, no port, no credentials), under /rest/v1/: ${c.url}`);
    const pu = requestedUrls(line)[0].url;
    assert.ok(!/\/rpc\/|\/functions\/v1\/|\/storage\/v1\/|\/auth\/v1\//.test(pu.pathname), `no rpc / function / storage / auth: ${pu.pathname}`);
    assert.equal(c.bearer, undefined, `no Authorization header at all: ${c.text}`);
    // EXACTLY the one permitted form: curl -q --proto =https --noproxy '*' -s -w <fmt> -X GET <url> -H "apikey: anonkey"  (nothing else, in this order)
    assert.match(c.text.trim(), /^-q --proto =https --noproxy \* -s -w \S* ?\S*\s*-X GET https:\/\/\S+ -H apikey: anonkey$/, `only the permitted argument form: ${c.text}`);
    assert.match(pu.pathname, /^\/rest\/v1\/(properties|parties|contacts|lead_events|listing_events|intelligence_reports|intelligence_insights|report_insights|intelligence_sweep_lock)$/, `only permitted tables: ${pu.pathname}`);
  }
  // the requests that DO get sent are the read probes (a few examples that must be present)
  for (const must of ['/rest/v1/properties?status=eq.draft', '/rest/v1/lead_events', '/rest/v1/intelligence_reports', '/rest/v1/report_insights']) assert.ok(calls.some((l) => requestedUrls(l).some((r) => isProjectRead(r) && `${r.url.pathname}${r.url.search}`.startsWith(must))), `read probe present: ${must}`);
});

test('with SITE_URL set the header suite sends only GET/HEAD to the site, through the same guard', () => {
  const { r, calls } = dryRun({ SITE_URL: 'https://pintag.io' });
  assert.notEqual(r.status, 97, r.stderr);
  assert.ok(calls.every((l) => !/\s-X\s(POST|PUT|PATCH|DELETE)\s/.test(l) && !/\s(-d|--data\S*)\s/.test(l)), 'no write verb and no body, with or without SITE_URL');
  assert.ok(siteRootRequested(calls), 'the site root was requested (HEAD/GET) with protocol https:, host pintag.io, no port, no credentials');
});

test('the URL assertions used by these tests reject look-alike and embedded hosts, other ports, credentials and protocols (parsed, never substring)', () => {
  const call = (u) => [`CALL -q --proto =https --noproxy * -sI --max-time 10 ${u}`];
  const accepted = ['https://pintag.io/'];
  const rejected = ['https://evil.example/https://pintag.io/', 'https://pintag.io.evil.example/', 'https://evil.example@pintag.io/', 'https://pintag.io@evil.example/', 'https://user:pw@pintag.io/', 'https://pintag.io:8443/', 'https://pintag.io:443/',
    'http://pintag.io/', 'ftp://pintag.io/', 'file://pintag.io/', 'https://evilpintag.io/', 'https://sub.pintag.io/', 'https://www.pintag.io/', 'https://PINTAG.io/', 'https://pintag.io/x', 'https://pintag.io/?u=1', 'https://pintag.io/#f',
    'https://evil.example/?u=https://pintag.io/', 'https://evil.example/%2F..%2Fhttps://pintag.io/', 'https://pintag.io/../', 'https://pintag.io//', 'https://pintag.io:/'];
  for (const u of accepted) assert.equal(siteRootRequested(call(u)), true, u);
  for (const u of rejected) assert.equal(siteRootRequested(call(u)), false, `must not be accepted: ${u}`);
  // the same strictness for the project host
  const P = (u) => isProjectRead(requestedUrls(`CALL ${u}`)[0]);
  assert.equal(P(`${U}/rest/v1/properties?select=id`), true);
  for (const u of [`${U}.evil.example/rest/v1/properties`, `https://evil.example/${U}/rest/v1/properties`, `https://${PROD_REF}.supabase.co@evil.example/rest/v1/properties`, `https://evil.example@${PROD_REF}.supabase.co/rest/v1/properties`, `${U}:8443/rest/v1/properties`, `http://${PROD_REF}.supabase.co/rest/v1/properties`, `${U}/functions/v1/x`]) assert.equal(P(u), false, u);
  // and the guard itself refuses the look-alike / embedded / port / credential / protocol forms as destinations (plain site paths such as /x are legitimately allowed by the guard, so they are not in this list)
  for (const u of rejected.filter((x) => !/^https:\/\/pintag\.io(\/(x|\?u=1|#f|\.\.\/|\/)?)?$/.test(x))) assert.equal(guard('GET', u), 1, `guard refuses: ${u}`);
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

test('the pure-bash fallback encoder is byte-wise and locale-independent: exact UTF-8 percent-encoding under LC_ALL=C and LC_ALL=C.UTF-8 (the bash function itself, not Python), round-trips, and agrees with Python', () => {
  const src = fs.readFileSync(path.join(SUITE_DIR, '10_sql_injection_read.sh'), 'utf8');
  assert.doesNotMatch(src, /rls_regression\.sql section N\b/, 'increment_listing_view is section O');
  assert.match(src, /rls_regression\.sql section O/);
  const fnSrc = /^_sqli_urlencode_bash\(\) \{[\s\S]*?\n\}/m.exec(src)[0];
  assert.doesNotMatch(fnSrc, /python|perl|node|awk|sed|xxd|od\b|iconv/, 'the fallback uses no external program');
  assert.match(fnSrc, /local LC_ALL=C/, 'the locale is fixed locally inside the encoder');
  assert.doesNotMatch(src, /^\s*(export\s+)?(LC_ALL|LANG)=/m, 'no script-wide locale change');
  const enc = (text, loc) => spawnSync('bash', ['-c', `${fnSrc}\n_sqli_urlencode_bash "$1"; printf '|%s' "\${LC_ALL-unset}"`, 'x', text], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: loc } });
  const exact = [
    ['abc-XYZ_019.~', 'abc-XYZ_019.~'], ['a b', 'a%20b'], ["'; DROP TABLE x;--", '%27%3B%20DROP%20TABLE%20x%3B--'], ['<s>[1]{a,b}\\^`$|"#@/?&=+', '%3Cs%3E%5B1%5D%7Ba%2Cb%7D%5C%5E%60%24%7C%22%23%40%2F%3F%26%3D%2B'],
    ['é', '%C3%A9'], ['日本語', '%E6%97%A5%E6%9C%AC%E8%AA%9E'], ['😀', '%F0%9F%98%80'], ['a é 日 😀 b', 'a%20%C3%A9%20%E6%97%A5%20%F0%9F%98%80%20b'], ['', ''],
  ];
  for (const loc of ['C', 'C.UTF-8']) {
    for (const [input, want] of exact) {
      const r = enc(input, loc); assert.equal(r.status, 0, r.stderr);
      const [out, after] = r.stdout.split('|');
      assert.equal(out, want, `LC_ALL=${loc}: ${JSON.stringify(input)}`);
      assert.equal(decodeURIComponent(out), input, `round trip under ${loc}`);
      assert.equal(after, loc, `the caller's LC_ALL is untouched (${loc})`);
    }
  }
  // the long payload from the audit: no character outside the unreserved set survives, under both locales, and the guard accepts the result as a harmless read
  const payload = `'; DROP TABLE x;-- <script>alert(1)</script> [1-5] {a,b} \\ ^ \` $HOME | " # @ / ? & = + é 日 😀`;
  for (const loc of ['C', 'C.UTF-8']) {
    const out = enc(payload, loc).stdout.split('|')[0];
    assert.match(out, /^[A-Za-z0-9._~%-]+$/); assert.equal(decodeURIComponent(out), payload);
    const g = spawnSync('bash', ['-c', `source tests/security/lib/target-guard.sh; PT_MODE=production-readonly; SUPABASE_URL=${U}; SUPABASE_ANON_KEY=anonkey; pt_guard_request GET "${U}/rest/v1/properties?slug=eq.${out}" -H "apikey: anonkey"`], { cwd: ROOT }).status;
    assert.equal(g, 0, `the encoded payload is an acceptable (and harmless) read under ${loc}`);
  }
  // identical to Python's quote(safe='') when Python is present
  if (spawnSync('python3', ['-c', 'pass']).status === 0) {
    for (const [input] of exact) {
      const py = spawnSync('python3', ['-I', '-c', "import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.argv[1],safe=''))", input], { encoding: 'utf8' }).stdout;
      assert.equal(enc(input, 'C.UTF-8').stdout.split('|')[0], py, `same as Python for ${JSON.stringify(input)}`);
    }
  }
});

test('_sqli_urlencode really falls back to the pure-bash path when python3 is unavailable, and prefers Python when it is present', () => {
  const src = fs.readFileSync(path.join(SUITE_DIR, '10_sql_injection_read.sh'), 'utf8');
  const both = /^_sqli_urlencode_bash\(\) \{[\s\S]*?\n\}\n[\s\S]*?^_sqli_urlencode\(\) \{[\s\S]*?\n\}/m.exec(src)[0];
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'nopy-'));
  for (const loc of ['C', 'C.UTF-8']) {
    // no python3 on PATH at all (bash is called by absolute path): python3 is "command not found", so only the bash function can produce the output
    const bashPath = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
    const r = spawnSync(bashPath, ['-c', `command -v python3 >/dev/null && echo PYTHON-PRESENT; ${both}\n_sqli_urlencode "$1"`, 'x', 'é 日 😀'], { encoding: 'utf8', env: { PATH: emptyBin, LC_ALL: loc } });
    assert.equal(r.stdout, '%C3%A9%20%E6%97%A5%20%F0%9F%98%80', `fallback under ${loc}: ${r.stdout}${r.stderr}`);
  }
  // with a stub python3 that prints a marker, the wrapper uses it (so the first test's direct call to the bash function is the only way it exercises the fallback)
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'pystub-')); fs.writeFileSync(path.join(stub, 'python3'), '#!/bin/sh\nprintf PYTHON-USED\n', { mode: 0o755 });
  const r2 = spawnSync('bash', ['-c', `${both}\n_sqli_urlencode "$1"`, 'x', 'é'], { encoding: 'utf8', env: { PATH: `${stub}:${process.env.PATH}` } });
  assert.match(r2.stdout, /^PYTHON-USED/);
});

test('every curl in the live helpers is hardened: it takes its options from PT_CURL_OPTS (no curlrc, https only, no proxy by default), and the guard runs first', () => {
  const h = fs.readFileSync(path.join(ROOT, 'tests/security/lib/helpers.sh'), 'utf8');
  const calls = h.split('\n').filter((l) => /\bcurl\b/.test(l) && !/^\s*#/.test(l));
  assert.ok(calls.length >= 3);
  for (const l of calls) assert.match(l, /curl "\$\{PT_CURL_OPTS\[@\]\}" /, l);
  const g = fs.readFileSync(path.join(ROOT, 'tests/security/lib/target-guard.sh'), 'utf8');
  assert.match(g, /^PT_CURL_OPTS=\(-q --proto =https --noproxy '\*'\)$/m, 'the fail-closed default already ignores proxies');
});

// ── Environment behaviour: proxy variables, custom CA settings, BASH_ENV and imported functions ───────────────────────────────────────────────
const SECRET_PROXY = 'http://secret-proxy.invalid:3128', SECRET_CA = '/nonexistent/secret-ca.pem';
const POISON = { http_proxy: SECRET_PROXY, https_proxy: SECRET_PROXY, all_proxy: SECRET_PROXY, ftp_proxy: SECRET_PROXY, no_proxy: 'x', HTTP_PROXY: SECRET_PROXY, HTTPS_PROXY: SECRET_PROXY, ALL_PROXY: SECRET_PROXY, FTP_PROXY: SECRET_PROXY, NO_PROXY: 'x',
  CURL_CA_BUNDLE: SECRET_CA, SSL_CERT_FILE: SECRET_CA, SSL_CERT_DIR: '/nonexistent/secret-ca-dir', CURL_HOME: '/nonexistent/secret-home', OPENSSL_CONF: '/nonexistent/secret-openssl.cnf', SSLKEYLOGFILE: '/nonexistent/secret-keylog' };
const WATCHED = Object.keys(POISON);

// A curl stand-in that records its arguments AND which of the watched variables it can see in its environment.
function envRecordingCurl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envcurl-')); const bin = path.join(dir, 'bin'); fs.mkdirSync(bin); const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\nvis=""; for v in ${WATCHED.join(' ')} LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT; do [[ -v $v ]] && vis+="$v "; done\nprintf 'CALL %s | ENV: %s\\n' "$*" "$vis" >> '${log}'\nprintf '[]\\n401'\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('CALL ')) : []) };
}
function runWith(extraEnv, { cmd = ['bash', 'tests/security/run.sh', 'intelligence_read'] } = {}) {
  const rc = envRecordingCurl();
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { PATH: `${rc.bin}:${process.env.PATH}`, HOME: os.tmpdir(), SUPABASE_URL: U, SUPABASE_ANON_KEY: 'anonkey', ...extraEnv } });
  return { r, calls: rc.calls() };
}

test('production-readonly removes inherited proxy, CA/TLS and loader settings: no request can reach curl while any of them is set, every curl is told --noproxy "*", and no value is printed', () => {
  const { r, calls } = runWith({ ...POISON, LD_LIBRARY_PATH: '/nonexistent/secret-ldpath' });
  assert.notEqual(r.status, 97, r.stderr);
  assert.ok(calls.length >= 4, `requests were made (${calls.length})`);
  for (const l of calls) {
    assert.match(l, /^CALL -q --proto =https --noproxy \* /, l);
    assert.match(l, /\| ENV: $/, `curl must see none of the proxy / CA / loader variables: ${l}`);
  }
  const out = r.stdout + r.stderr;
  assert.match(out, /Production environment hardened: removed inherited .*HTTPS_PROXY.*CURL_CA_BUNDLE.*SSL_CERT_FILE.*SSL_CERT_DIR.*\(names only; values are never printed\)/);
  for (const secret of ['secret-proxy', 'secret-ca', 'secret-home', 'secret-openssl', 'secret-keylog', 'secret-ldpath']) assert.ok(!out.includes(secret), `a value leaked into the output: ${secret}`);
});

test('a BASH_ENV, ENV or imported shell function in a production run is REFUSED before any request (Bash runs them before the script body, so unsetting would be too late); no value is printed', () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bashenv-')), 'ran');
  const hook = path.join(path.dirname(marker), 'hook.sh'); fs.writeFileSync(hook, `echo ran > '${marker}'\n`);
  // 1. the threat is real: Bash executes BASH_ENV before the script, whatever the script then does
  let x = runWith({ BASH_ENV: hook });
  assert.ok(fs.existsSync(marker), 'plain bash executed the BASH_ENV file before run.sh started');
  assert.equal(x.r.status, 1); assert.match(x.r.stderr, /BASH_ENV is set\. Bash executes that file before this script starts/); assert.deepEqual(x.calls, [], 'no request was made');
  assert.ok(!(x.r.stdout + x.r.stderr).includes(hook), 'the value (a path) is not printed');
  fs.unlinkSync(marker);
  // 2. ENV, and an exported function that would shadow curl
  x = runWith({ ENV: hook }); assert.equal(x.r.status, 1); assert.match(x.r.stderr, /ENV is set/); assert.deepEqual(x.calls, []);
  x = runWith({ 'BASH_FUNC_curl%%': '() { echo hijacked; }' }); assert.equal(x.r.status, 1); assert.match(x.r.stderr, /exported shell function\(s\) were imported from the environment \(BASH_FUNC_curl%%\)/); assert.deepEqual(x.calls, []);
  assert.ok(!(x.r.stdout + x.r.stderr).includes('hijacked'));
  // 3. the empty values are harmless and accepted
  x = runWith({ BASH_ENV: '', ENV: '' }); assert.notEqual(x.r.status, 97); assert.doesNotMatch(x.r.stderr, /REFUSED/); assert.ok(x.calls.length > 0);
  // 4. the way the workflow starts the step prevents the execution altogether
  x = runWith({ BASH_ENV: hook }, { cmd: ['env', '-u', 'BASH_ENV', '-u', 'ENV', 'bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', 'bash tests/security/run.sh intelligence_read'] });
  assert.ok(!fs.existsSync(marker), 'env -u BASH_ENV: the file was never executed');
  assert.doesNotMatch(x.r.stderr, /BASH_ENV is set/); assert.ok(x.calls.length > 0, 'and the suite then runs normally');
});

test('the live workflow starts the suite step without BASH_ENV / ENV, sets no proxy, CA or loader variable anywhere, and never enables the local proxy opt-in', () => {
  const y = stripWfComments(WORKFLOW);
  const step = y.slice(y.indexOf('- name: Run security suite'));
  assert.match(step, /^- name: Run security suite\n\s+shell: env -u BASH_ENV -u ENV bash --noprofile --norc -eo pipefail \{0\}\n\s+run: bash tests\/security\/run\.sh/);
  assert.doesNotMatch(y, /\b(https?_proxy|all_proxy|ftp_proxy|no_proxy|CURL_[A-Z_]+|SSL_CERT_(FILE|DIR)|OPENSSL_[A-Z_]+|LD_[A-Z_]+|SSLKEYLOGFILE|BASH_ENV|PT_PRODUCTION_ALLOW_PROXY|PT_MODE|PT_ROOT)\b\s*:/i, 'no such variable is set by the workflow');
  assert.doesNotMatch(y, /GITHUB_ENV|GITHUB_PATH/, 'no step writes to the job environment');
});
function stripWfComments(t) { return t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); }

test('the local proxy opt-in keeps proxy settings for local development only: refused in GitHub Actions / CI, never relaxes CA or loader settings; staging keeps proxies and its own trust settings', () => {
  const ok = runWith({ ...POISON, PT_PRODUCTION_ALLOW_PROXY: '1' });
  assert.ok(ok.calls.length > 0); const first = ok.calls[0];
  assert.doesNotMatch(first, /--noproxy/, 'the opt-in drops --noproxy'); assert.match(first, /\| ENV: .*HTTPS_PROXY/, 'proxy variables are kept'); assert.doesNotMatch(first, /CURL_CA_BUNDLE|SSL_CERT_FILE|SSL_CERT_DIR|CURL_HOME|OPENSSL_CONF|SSLKEYLOGFILE/, 'but trust settings are still removed');
  assert.match(ok.r.stderr, /PT_PRODUCTION_ALLOW_PROXY=1 -> inherited proxy settings are kept \(local use only/);
  for (const ci of [{ GITHUB_ACTIONS: 'true' }, { CI: 'true' }]) { const x = runWith({ ...POISON, PT_PRODUCTION_ALLOW_PROXY: '1', ...ci }); assert.equal(x.r.status, 1); assert.match(x.r.stderr, /not accepted in GitHub Actions \/ CI/); assert.deepEqual(x.calls, []); }
  assert.equal(runWith({ ...POISON, PT_PRODUCTION_ALLOW_PROXY: 'yes' }).calls[0].includes('--noproxy'), true, 'only the exact value 1 enables it');
  // staging-full: no --noproxy and nothing removed (a staging project may need a corporate proxy or CA)
  const sb = sandbox(); fs.writeFileSync(path.join(sb.root, 'tests/security/staging-targets.txt'), `${OTHER_REF}\n`);
  const r = bash(`source tests/security/lib/target-guard.sh; pt_enforce_target; printf '%s|' "\${PT_CURL_OPTS[*]}"; [[ -v HTTPS_PROXY && -v CURL_CA_BUNDLE ]] && echo kept`, { SUPABASE_URL: `https://${OTHER_REF}.supabase.co`, SECURITY_TARGET_CONFIRM: OTHER_REF, HTTPS_PROXY: SECRET_PROXY, CURL_CA_BUNDLE: SECRET_CA }, sb);
  assert.equal(r.stdout.trim(), '-q --proto =https|kept', r.stderr);
});

// Real curl, real sockets, no external network: the neutralised environment cannot redirect a request or replace TLS trust.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn } from 'node:child_process';
const runAsync = (script, env) => new Promise((resolve) => { const p = spawn('bash', ['-c', script], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env } }); let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('close', (code) => resolve({ code, out })); });

test('REAL curl: an inherited HTTPS_PROXY receives the request without the hardening and nothing with it', async () => {
  const seen = []; const proxy = net.createServer((sock) => { sock.on('data', (d) => seen.push(String(d).split('\r\n')[0])); sock.on('error', () => {}); sock.end(); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r)); const port = proxy.address().port;
  const env = { HTTPS_PROXY: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}` };
  const target = 'https://127.0.0.1:1/rest/v1/properties';
  try {
    const control = await runAsync(`curl -q --proto =https -s -m 5 -o /dev/null ${target}`, env);
    assert.ok(seen.some((l) => /^CONNECT 127\.0\.0\.1:1 /.test(l)), `control: without the hardening the proxy IS used (${control.code}, ${seen.join('|')})`);
    seen.length = 0;
    const hardened = await runAsync(`source tests/security/lib/target-guard.sh; pt_secure_production_env 2>/dev/null; curl "\${PT_CURL_OPTS[@]}" -s -m 5 -o /dev/null ${target}; echo "exit=$?"`, env);
    assert.deepEqual(seen, [], 'with the hardening the proxy received nothing');
    assert.match(hardened.out, /exit=7/, 'curl tried the real destination directly (connection refused)');
    seen.length = 0;
    const optOnly = await runAsync(`curl -q --proto =https --noproxy '*' -s -m 5 -o /dev/null ${target}; echo "exit=$?"`, env);
    assert.deepEqual(seen, [], '--noproxy "*" alone is enough, even if the variables were not removed'); assert.match(optOnly.out, /exit=7/);
  } finally { proxy.close(); }
});

test('REAL curl: an inherited CURL_CA_BUNDLE makes a self-signed server trusted without the hardening and is rejected with it (the standard trust store is used)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-')); const key = path.join(dir, 'k.pem'), crt = path.join(dir, 'c.pem');
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  if (gen.status !== 0) { t.skip('openssl is not available'); return; }
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (req, res) => res.end('[]'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  const env = { CURL_CA_BUNDLE: crt, SSL_CERT_FILE: crt };
  try {
    const control = await runAsync(`curl -q --proto =https --noproxy '*' -s -m 5 -o /dev/null https://127.0.0.1:${port}/; echo "exit=$?"`, env);
    assert.match(control.out, /exit=0/, `control: the injected CA is honoured without the hardening (${control.out})`);
    const hardened = await runAsync(`source tests/security/lib/target-guard.sh; pt_secure_production_env 2>/dev/null; curl "\${PT_CURL_OPTS[@]}" -s -m 5 -o /dev/null https://127.0.0.1:${port}/; echo "exit=$?"`, env);
    assert.match(hardened.out, /exit=(60|35|77)/, `with the hardening the certificate is NOT trusted (${hardened.out})`);
  } finally { server.close(); }
});
