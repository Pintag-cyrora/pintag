// The administrator gate of the three Gemini-backed Edge Functions, exercised LOCALLY with a mocked network.
// The live security suite no longer sends any request to an Edge Function in production (even a request that is expected to be rejected can run code, call an AI
// provider or fetch a third-party URL), so these tests replace the old production probes: no token, the public anon key, a garbage token, a user at AAL1,
// a non-admin at AAL2, a failing admin check, and the one legitimate path. They execute the REAL gate functions extracted from the sources (Node type-stripping),
// with `fetch` replaced: nothing here can reach the network, and every test asserts which URLs the gate was allowed to contact.
// Run with: node --test edge-function-auth-gates.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(ROOT, 'supabase/functions', f, 'index.ts'), 'utf8');

function extractFn(src, sigRe) {
  const m = sigRe.exec(src);
  if (!m) throw new Error('not found: ' + sigRe);
  let i = src.indexOf('{\n', m.index), d = 0;   // the body opens at the end of a line (a return type may contain braces)
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { i++; break; } } }
  return src.slice(m.index, i);
}
async function loadGate(fnDir, gateName, signatureRe, helpers = []) {
  const src = read(fnDir);
  const body = [...helpers.map((h) => extractFn(src, h)), extractFn(src, signatureRe)].join('\n\n');
  const code = `const Deno = { env: { get: (k: string) => globalThis.__deno.env.get(k) } }; const fetch = (...a) => globalThis.__fetch(...a);\ntype RequestDeadline = { allot(n: number): number };\nconst AUTH_FETCH_MAX_MS = 10000;\n${body}\nexport { ${gateName} };\n`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')); const file = path.join(dir, `${fnDir}.mts`);
  fs.writeFileSync(file, code);
  return (await import(pathToFileURL(file).href))[gateName];
}

const SB = 'https://project.example.test', ANON = 'anon-key-value', SERVICE = 'service-role-key-value';
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const aal1 = jwt({ aal: 'aal1', sub: 'u1' }), aal2 = jwt({ aal: 'aal2', sub: 'u1' });

// a network that records every URL and answers like Supabase would; ANYTHING unexpected (an AI provider, a write) throws
function network({ userOk = true, adminAnswer = true, adminHttp = 200 } = {}) {
  const calls = [];
  globalThis.__deno = { env: { get: (k) => ({ SUPABASE_URL: SB, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE }[k]) } };
  globalThis.__fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url) === `${SB}/auth/v1/user`) return userOk ? new Response(JSON.stringify({ id: 'user-1' }), { status: 200 }) : new Response('{}', { status: 401 });
    if (String(url) === `${SB}/rest/v1/rpc/is_pintag_admin`) return adminHttp === 200 ? new Response(JSON.stringify(adminAnswer), { status: 200 }) : new Response('{}', { status: adminHttp });
    throw new Error(`UNEXPECTED network call from the gate: ${url}`);
  };
  return calls;
}
const req = (auth) => new Request('https://fn.example.test/', { method: 'POST', headers: auth === undefined ? {} : { Authorization: auth }, body: '{}' });

const GATES = [
  { name: 'generate-listing-content', gate: 'requireAdmin', sig: /async function requireAdmin\(/, helpers: [/function tokenAal\(/], call: (g, r) => g(r), status: (x) => x.status, denied: (x) => x.error },
  { name: 'smart-listing-importer', gate: 'requireAdmin', sig: /async function requireAdmin\(/, helpers: [/function tokenAal\(/], call: (g, r) => g(r, { allot: (n) => n }), status: (x) => x.status, denied: (x) => x.error },
  { name: 'generate-intelligence-report', gate: 'requireStaffOrService', sig: /async function requireStaffOrService\(/, helpers: [], call: (g, r) => g(r), status: () => 401, denied: (x) => x },
];

for (const G of GATES) {
  test(`${G.name}: the gate refuses no token, the public anon key, a garbage token, MFA-less users and non-admins, and fails closed on an error`, async () => {
    const gate = await loadGate(G.name, G.gate, G.sig, G.helpers);
    const only = (calls, allowed) => assert.deepEqual(calls.filter((u) => !allowed.includes(u)), [], `${G.name}: contacted only ${allowed.join(', ')}`);

    let calls = network();
    let out = await G.call(gate, req(undefined)); assert.ok(out, 'no Authorization header → refused'); assert.deepEqual(calls, [], 'no token: no network call at all');
    out = await G.call(gate, req('Basic abc')); assert.ok(out, 'a non-Bearer scheme → refused'); assert.deepEqual(calls, []);

    calls = network({ userOk: false });
    out = await G.call(gate, req(`Bearer ${ANON}`)); assert.ok(out, 'the public anon key is not a user session → refused'); only(calls, [`${SB}/auth/v1/user`]);
    out = await G.call(gate, req('Bearer not.a.valid.jwt.at.all')); assert.ok(out, 'a garbage token → refused');

    calls = network();
    out = await G.call(gate, req(`Bearer ${aal1}`)); assert.ok(out, 'a signed-in user at AAL1 (no MFA) → refused'); only(calls, [`${SB}/auth/v1/user`]);
    out = await G.call(gate, req('Bearer not-even-a-jwt')); assert.ok(out, 'an unparseable token fails closed (treated as AAL1)');

    calls = network({ adminAnswer: false });
    out = await G.call(gate, req(`Bearer ${aal2}`)); assert.ok(out, 'a non-admin at AAL2 → refused'); only(calls, [`${SB}/auth/v1/user`, `${SB}/rest/v1/rpc/is_pintag_admin`]);

    calls = network({ adminHttp: 500 });
    out = await G.call(gate, req(`Bearer ${aal2}`)); assert.ok(out, 'a failing is_pintag_admin() call fails CLOSED');

    calls = network({ adminAnswer: 'true' });
    out = await G.call(gate, req(`Bearer ${aal2}`)); assert.ok(out, 'only the boolean true authorizes (a truthy string does not)');

    calls = network({ adminAnswer: true });
    out = await G.call(gate, req(`Bearer ${aal2}`)); assert.equal(out, null, 'the legitimate path works: an allowlisted administrator at AAL2 is allowed');
    only(calls, [`${SB}/auth/v1/user`, `${SB}/rest/v1/rpc/is_pintag_admin`]);
  });

  test(`${G.name}: the request handler runs the gate before it reads the body, reads a secret or contacts any other service`, () => {
    const src = read(G.name);
    const handler = src.slice(src.indexOf('Deno.serve('));
    const gateAt = handler.search(/await require(Admin|StaffOrService)\(/);
    assert.ok(gateAt > 0, 'the handler awaits the gate');
    for (const later of [/req\.json\(\)/, /Deno\.env\.get\(['"]GEMINI_API_KEY['"]\)/, /generativelanguage\.googleapis\.com/, /new Db\(/, /\bfetch\(/]) {
      const i = handler.search(later);
      assert.ok(i === -1 || i > gateAt, `${later} must come after the gate`);
    }
  });
}

test('generate-intelligence-report: only the exact service-role key bypasses the user lookup (the public anon key does not)', async () => {
  const gate = await loadGate('generate-intelligence-report', 'requireStaffOrService', /async function requireStaffOrService\(/);
  let calls = network();
  assert.equal(await gate(req(`Bearer ${SERVICE}`)), null, 'the scheduled job (service role) is allowed');
  assert.deepEqual(calls, [], 'without any network call');
  calls = network({ userOk: false });
  assert.ok(await gate(req(`Bearer ${ANON}`)), 'the anon key is refused'); assert.deepEqual(calls, [`${SB}/auth/v1/user`]);
  assert.ok(await gate(req(`Bearer ${SERVICE}x`)), 'a near-miss of the service key is refused');
});
