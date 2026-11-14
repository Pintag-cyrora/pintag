// The live security suite reports how many HTTP requests it actually issued. The first production run printed "Requests: 0" after about 32 real requests, because
// the old counter was a shell variable incremented inside http_request, which runs in a subshell ($(...)), so every increment was lost.
// The count is now a FILE (one byte appended per curl process, written after the guard approved the request and before curl starts). This file proves it:
//   * it equals the number of curl processes a recording curl saw: sequential, in $(...), in pipelines, in background jobs, 40 in parallel, with retries;
//   * a request the production guard REFUSES is never counted (and never reaches curl);
//   * the site helpers are counted too;
//   * the whole suite's printed summary and JSON report agree with the recording curl;
//   * every curl invocation in the helpers is preceded by the counting call (so a new request path cannot silently bypass the counter).
// Run with: node --test security-request-counter.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROD_REF = /supabaseUrl: *'https:\/\/([a-z0-9]{20})\.supabase\.co'/.exec(fs.readFileSync(path.join(ROOT, 'config.prod.js'), 'utf8'))[1];
const U = `https://${PROD_REF}.supabase.co`;

// A recording curl: one line per process, appended with a single write. CURL_STUB_MODE=retry503 answers 503 on the first call and 200 afterwards.
function recorder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqcount-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'curl.log'); const state = path.join(dir, 'state');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
printf 'CALL %s\\n' "$*" >> '${log}'
n=$(wc -l < '${log}')
if [[ "\${CURL_STUB_MODE:-}" == "retry503" && $n -le 1 ]]; then printf '[]\\n503'; exit 0; fi
if [[ "\${CURL_STUB_MODE:-}" == "404" ]]; then printf '{}\\n404'; exit 0; fi
printf '[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","contact_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]\\n200'
`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('CALL ')) : []) };
}
// Runs a snippet with helpers.sh loaded in production-readonly mode; prints COUNT=<requests_issued> from an EXIT trap so refusals (exit 97) still report it.
function run(snippet, { env = {} } = {}) {
  const rc = recorder();
  const r = spawnSync('bash', ['-c', `source tests/security/lib/helpers.sh
trap 'exit 97' TERM
trap 'echo "COUNT=$(requests_issued)"' EXIT
SUPABASE_URL='${U}'; SUPABASE_ANON_KEY=anonkey; PT_MODE=production-readonly; SITE_URL='https://pintag.io'; PT_ROOT='${ROOT}'
${snippet}`], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { PATH: `${rc.bin}:${process.env.PATH}`, HOME: os.tmpdir(), ...env } });
  const m = /COUNT=(\d+)/.exec(r.stdout);
  return { r, recorded: rc.calls().length, calls: rc.calls(), counted: m ? Number(m[1]) : null };
}
const eq = (x, n, why) => { assert.equal(x.counted, n, `${why}: counter ${x.counted} (stdout: ${x.r.stdout.slice(-200)} stderr: ${x.r.stderr.slice(-200)})`); assert.equal(x.recorded, n, `${why}: recording curl saw ${x.recorded}`); };

test('the old behaviour is real: a variable incremented inside $(...) is lost, so a counter must live outside the shell\'s memory', () => {
  const r = spawnSync('bash', ['-c', 'n=0; f() { n=$((n+1)); echo x; }; v=$(f); v=$(f); (f >/dev/null); f >/dev/null & wait; echo "n=$n"'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'n=0', 'every increment happened in a child process');
  const src = fs.readFileSync(path.join(ROOT, 'tests/security/lib/helpers.sh'), 'utf8');
  assert.doesNotMatch(src, /TOTAL_REQUESTS/, 'the lost-in-subshell variable is gone');
});

test('sequential requests, requests in $(...), in a pipeline and in a subshell are all counted, and equal what curl saw', () => {
  eq(run(`for i in 1 2 3 4 5; do r=$(api_get "properties?select=id&limit=$i"); done`), 5, 'five $(...) requests');
  eq(run(`api_get "parties?select=id" | cat >/dev/null; (api_get "contacts?select=id" >/dev/null); x=$( (api_get "listing_events?limit=1") )`), 3, 'pipeline, subshell, nested subshell');
  eq(run(`r=$(api_get "properties?select=id"); echo "$(requests_issued)" > /dev/null; r=$(api_get "properties?select=id")`), 2, 'reading the counter does not change it');
  eq(run(`:`), 0, 'no request, no count');
});

test('background jobs and 40 parallel requests are counted exactly (one atomic byte per request; nothing lost, nothing doubled)', () => {
  eq(run(`for i in 1 2 3; do ( r=$(api_get "properties?select=id") ) & done; wait`), 3, 'three background jobs');
  const x = run(`for i in $(seq 1 40); do ( api_get "properties?select=id&limit=$i" >/dev/null ) & done; wait`);
  eq(x, 40, 'forty parallel background requests');
  const y = run(`for i in $(seq 1 10); do { r=$(api_get "parties?select=id") ; } & { r=$(site_head "https://pintag.io/") ; } & done; wait`);
  eq(y, 20, 'mixed project and site requests in parallel');
});

test('every retry attempt is a separate request and is counted (the recording curl answers 503 once)', () => {
  const x = run(`r=$(api_get "properties?select=id"); echo "STATUS=$(resp_status "$r")"`, { env: { CURL_STUB_MODE: 'retry503' } });
  eq(x, 2, 'one 503 then one 200 = two requests'); assert.match(x.r.stdout, /STATUS=200/);
  eq(run(`r=$(api_get "properties?select=id")`, { env: { CURL_STUB_MODE: '404' } }), 1, '404 is not retried: one request');
});

test('site_head and site_get are counted', () => {
  eq(run(`site_head "https://pintag.io/" >/dev/null; site_get "https://pintag.io/listings.html" >/dev/null`), 2, 'two site requests');
});

test('requests REFUSED by the production guard are never counted and never reach curl; the run ends with exit 97', () => {
  const refused = {
    'POST to a table': `api_post "properties" '{"x":1}'`,
    'PATCH': `api_patch "properties?id=eq.1" '{}'`,
    'DELETE': `api_delete "properties?id=eq.1"`,
    'RPC': `http_request GET "${U}/rest/v1/rpc/increment_listing_view?p_listing_id=x" -H "apikey: anonkey"`,
    'Edge Function': `fn_post "resolve-map-url" '{}'`,
    'Storage': `http_request GET "${U}/storage/v1/object/public/property-images/x.jpg" -H "apikey: anonkey"`,
    'Auth': `http_request GET "${U}/auth/v1/user" -H "apikey: anonkey"`,
    'user token': `api_get "properties?select=id" "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"`,
    'other host': `http_request GET "https://evil.example/rest/v1/properties" -H "apikey: anonkey"`,
    'foreign site': `site_head "https://evil.example/"`,
    'unlisted table': `api_get "profiles?select=id"`,
  };
  for (const [name, snippet] of Object.entries(refused)) {
    for (const wrap of [(s) => s, (s) => `r=$(${s})`, (s) => `( ${s} ) || true`, (s) => `{ ${s}; } & wait`]) {
      const x = run(wrap(snippet));
      assert.equal(x.r.status, 97, `${name}: the run is killed (${x.r.stdout}${x.r.stderr})`);
      assert.equal(x.counted, 0, `${name}: a refused request is not counted`);
      assert.equal(x.recorded, 0, `${name}: and never reached curl`);
    }
  }
  // allowed requests before a refusal are counted, the refused one is not
  const mixed = run(`r=$(api_get "properties?select=id"); r=$(api_get "parties?select=id"); site_head "https://pintag.io/" >/dev/null; r=$(api_post "properties" '{}'); r=$(api_get "contacts?select=id")`);
  assert.equal(mixed.r.status, 97); assert.equal(mixed.counted, 3); assert.equal(mixed.recorded, 3);
});

test('staging-full mode counts too (the counter does not depend on the production guard)', () => {
  const x = run(`PT_MODE=staging-full; r=$(api_post "properties" '{}'); r=$(api_get "properties?select=id")`);
  eq(x, 2, 'two staging requests');
});

test('the whole suite: the printed "Requests:" line and the JSON report equal the recording curl, and the TSV request log agrees (project requests only)', () => {
  const rc = recorder();
  const r = spawnSync('bash', ['tests/security/run.sh'], { cwd: ROOT, encoding: 'utf8', timeout: 170000, env: { PATH: `${rc.bin}:${process.env.PATH}`, HOME: os.tmpdir(), SUPABASE_URL: U, SUPABASE_ANON_KEY: 'anonkey' } });
  assert.notEqual(r.status, 97, r.stderr);
  const recorded = rc.calls().length;
  assert.ok(recorded >= 25, `the suites actually ran (${recorded} requests)`);
  const printed = Number(/Requests:\s+(\d+)/.exec(r.stdout)[1]);
  assert.equal(printed, recorded, 'printed Requests: line equals the recording curl');
  const jsonPath = /JSON summary:\s+(\S+)/.exec(r.stdout)[1];
  const summary = JSON.parse(fs.readFileSync(path.join(ROOT, jsonPath), 'utf8'));
  assert.equal(summary.total_requests, recorded, 'JSON total_requests equals the recording curl');
  const id = /summary-([0-9a-f]+)\.json/.exec(jsonPath)[1];
  const tsv = fs.readFileSync(path.join(ROOT, `tests/security/output/requests-${id}.log`), 'utf8').trim().split('\n').length;
  assert.equal(tsv, recorded, 'the TSV request log has one line per project request (no SITE_URL in this run)');
  assert.equal(fs.statSync(path.join(ROOT, `tests/security/output/request-count-${id}`)).size, recorded);
  for (const f of [jsonPath, `tests/security/output/requests-${id}.log`, `tests/security/output/request-count-${id}`]) fs.rmSync(path.join(ROOT, f), { force: true });
});

test('every curl process started by the helpers is preceded by the counting call, and the counter is not bypassable by a new request path', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tests/security/lib/helpers.sh'), 'utf8').split('\n');
  const idx = src.map((l, i) => [l, i]).filter(([l]) => /\bcurl\s+"\$\{PT_CURL_OPTS\[@\]\}"/.test(l) && !/^\s*#/.test(l));
  assert.equal(idx.length, 3, 'exactly three curl invocations: http_request, site_head, site_get');
  for (const [l, i] of idx) assert.match(src.slice(Math.max(0, i - 2), i + 1).join('\n'), /_count_request/, `no counting call before: ${l.trim()}`);
  // within the same function the guard comes first, then the counter, then curl: a refused request can never be counted
  for (const [, i] of idx) {
    let h = i; while (h > 0 && !/^[A-Za-z_]\w*\(\) \{/.test(src[h])) h--;
    const body = src.slice(h, i + 1).join('\n');
    assert.ok(body.includes('pt_guard_request') && body.indexOf('pt_guard_request') < body.indexOf('_count_request'), `guard before counter in ${src[h]}`);
    assert.equal((body.match(/_count_request/g) || []).length, 1, `exactly one counting call before this curl in ${src[h]}`);
  }
  // no other script in the live suite starts curl
  for (const d of ['tests/security/suites', 'tests/security/run.sh', 'tests/security/lib/target-guard.sh']) {
    const files = fs.statSync(path.join(ROOT, d)).isDirectory() ? fs.readdirSync(path.join(ROOT, d)).map((f) => path.join(d, f)) : [d];
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), /(^|[^\w-])curl\s+-/m, `${f} must not start curl itself`);
  }
});
