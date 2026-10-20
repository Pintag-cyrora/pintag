// scripts/diagnostics/orphan-originals/ + .github/workflows/diagnose-orphan-originals.yml -- the manual, READ-ONLY diagnostic
// for the Image Integrity line "Originals referenced by nothing". Run with:
//   node --test diagnose-orphan-originals.test.js
//
// What is pinned here:
//   1. The REAL run.sh, driven against a fake `psql`, stops before the data stage unless the preflight is clean
//      (two PASS verdicts, no WARN), refuses a missing URL, refuses tampered SQL before any connection, never prints the
//      URL, and always wraps every psql call in BEGIN READ ONLY ... ROLLBACK with ON_ERROR_STOP and the read-only default.
//   2. The workflow can only be started by hand, has read-only repo permissions, runs only that script, and exposes the
//      DB secret to the steps that need it -- not to the whole job.
// (The SQL itself is exercised against a real Postgres by the maintainers' scratch tests; CI has no Postgres server.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'diagnose-orphan-originals.yml');
const SECRET = 'postgres://backup_ro:S3cr3tPassw0rd@db.example.invalid:5432/postgres';

const PASS2 = 'schema | public.properties.id | ok\nVERDICT | schema | PASS\nVERDICT | role+session | PASS\n';
const DIAG = ' 1 TOTAL | 4000 bytes | 551\n';

// Builds a temp copy of the diagnostic folder plus a fake psql, runs run.sh, returns what happened.
function run({ preflight = PASS2, env = {}, url = SECRET, tamper, replace, stale = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-diag-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  for (const f of ['1-preflight.sql', '2-diagnostic.sql', 'run.sh']) fs.copyFileSync(path.join(SRC, f), path.join(work, f));
  if (tamper) fs.appendFileSync(path.join(work, tamper.file), tamper.text);
  if (replace) fs.writeFileSync(path.join(work, replace.file), replace.text);
  if (stale) fs.writeFileSync(path.join(work, 'diagnostic.txt'), 'STALE RESULTS FROM AN EARLIER RUN\n');
  fs.mkdirSync(path.join(dir, 'bin'));
  const log = path.join(dir, 'psql.log');
  fs.writeFileSync(path.join(dir, 'preflight.out'), preflight);
  fs.writeFileSync(path.join(dir, 'diag.out'), DIAG);
  fs.writeFileSync(path.join(dir, 'bin', 'psql'), `#!/bin/bash
# fake psql: log every argument except the connection string (arg 1), then answer from canned files
{ echo "CALL"; shift_args=("\$@"); for a in "\${shift_args[@]:1}"; do echo "ARG:\$a"; done; echo "PGOPTIONS=\${PGOPTIONS:-}"; } >> "${log}"
case "\$*" in *1-preflight.sql*) cat "${dir}/preflight.out";; *2-diagnostic.sql*) cat "${dir}/diag.out";; esac
`, { mode: 0o755 });
  const childEnv = { PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir, ...env };
  if (url !== null) childEnv.PINTAG_PROD_DB_URL = url;
  const r = spawnSync('bash', [path.join(work, 'run.sh')], { env: childEnv, encoding: 'utf8', input: '' });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('CALL\n').filter(Boolean) : [];
  const out = { status: r.status, output: r.stdout + r.stderr, calls, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    has: (f) => fs.existsSync(path.join(work, f)), read: (f) => fs.readFileSync(path.join(work, f), 'utf8') };
  return out;
}

test('clean preflight: lint ok, both stages run, results saved, stale file replaced', () => {
  const r = run({ stale: true });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /lint ok: 1-preflight\.sql/);
  assert.match(r.output, /lint ok: 2-diagnostic\.sql/);
  assert.match(r.output, /=== stage 2/);
  assert.equal(r.calls.length, 2);
  assert.equal(r.read('diagnostic.txt'), DIAG);                       // fresh, not the stale text
  assert.match(r.read('preflight.txt'), /VERDICT \| schema \| PASS/);
});

test('every psql call is inside BEGIN READ ONLY ... ROLLBACK, with ON_ERROR_STOP and the read-only default requested', () => {
  const r = run();
  for (const c of r.calls) {
    const args = c.split('\n').filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4));
    const b = args.indexOf('BEGIN READ ONLY'), f = args.findIndex((a) => /\.sql$/.test(a)), e = args.indexOf('ROLLBACK');
    assert.ok(b >= 0 && f > b && e > f, `BEGIN READ ONLY < file < ROLLBACK in ${args.join(' ')}`);
    assert.ok(args.includes('ON_ERROR_STOP=1'));
    assert.ok(!args.some((a) => /^(COMMIT|END)$/i.test(a)));
    assert.match(c, /PGOPTIONS=.*default_transaction_read_only=on/);
  }
});

for (const [name, preflight] of [
  ['a FAIL verdict', 'VERDICT | schema | PASS\nVERDICT | role+session | FAIL\n'],
  ['a schema FAIL verdict', 'VERDICT | schema | FAIL\nVERDICT | role+session | PASS\n'],
  ['only one PASS verdict', 'VERDICT | schema | PASS\n'],
  ['no verdict rows at all', 'schema | public.properties.id | ok\n'],
  ['empty preflight output', ''],
  ['a WARN row (even with both verdicts PASS)', 'role | rolbypassrls (...) | WARN false: see the row-level-security check below\n' + PASS2],
]) {
  test(`stops before the data stage on ${name}; stale diagnostic.txt is removed`, () => {
    const r = run({ preflight, stale: true });
    assert.equal(r.status, 1, r.output);
    assert.equal(r.calls.length, 1, `only the preflight ran -- script output:\n${r.output}\npsql log:\n${r.log}`);
    assert.ok(!/=== stage 2/.test(r.output));
    assert.match(r.output, /The data diagnostic was NOT run/);
    assert.ok(!r.has('diagnostic.txt'), 'stale diagnostic.txt must not survive');
    assert.ok(r.has('preflight.txt'), 'preflight.txt is kept for inspection');
  });
}

test('a missing or empty database URL is refused before psql is ever called', () => {
  for (const url of [null, '']) {
    const r = run({ url });
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 0);
    assert.match(r.output, /No database URL supplied/);
  }
});

for (const [name, tamper] of [
  ['a trailing DELETE', { file: '2-diagnostic.sql', text: '\nDELETE FROM import_images;\n' }],
  ['a COMMIT after the preflight', { file: '1-preflight.sql', text: '\nCOMMIT;\n' }],
  ['a set_config() call', { file: '2-diagnostic.sql', text: "\n-- x\n" + "SELECT set_config('transaction_read_only','off',false);\n" }],
  ['a psql meta-command', { file: '1-preflight.sql', text: '\n\\set x 1\n' }],
]) {
  test(`lint refuses a tampered SQL file (${name}) before any connection`, () => {
    const r = run({ tamper });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /LINT FAIL/);
    assert.equal(r.calls.length, 0, 'psql must not be called');
  });
}

// Regression: the lint's `grep -q` / `head -c` stages used to die with SIGPIPE under `set -o pipefail`, so a VALID file was
// rejected at random (and always when large) and a rejection could be skipped. The lint now runs with pipefail off.
const bigSelect = 'SELECT ' + Array.from({ length: 40000 }, (_, i) => `${i} AS a${i}`).join(', ') + ';\n';

test('lint accepts a LARGE valid single-SELECT file every time (no pipefail/SIGPIPE false rejection)', () => {
  for (let i = 0; i < 4; i++) {
    const r = run({ replace: { file: '2-diagnostic.sql', text: bigSelect } });
    assert.equal(r.status, 0, r.output.slice(0, 400));
    assert.match(r.output, /lint ok: 2-diagnostic\.sql/);
  }
});

test('lint rejects a meta-command on line 1 of a LARGE file, for the right reason, every time', () => {
  for (let i = 0; i < 4; i++) {
    const r = run({ replace: { file: '2-diagnostic.sql', text: '\\set x 1\n' + bigSelect } });
    assert.notEqual(r.status, 0);
    assert.match(r.output, /LINT FAIL 2-diagnostic\.sql: psql meta-command/);
    assert.equal(r.calls.length, 0);
  }
});

test('the real SQL files pass the lint on every one of 12 consecutive runs (no intermittent rejection)', () => {
  for (let i = 0; i < 12; i++) {
    const r = run();
    assert.match(r.output, /lint ok: 1-preflight\.sql[\s\S]*lint ok: 2-diagnostic\.sql/, `run ${i}: ${r.output.slice(0, 300)}`);
  }
});

test('the database URL (password, host) never appears in the script output or the saved result files', () => {
  const r = run();
  assert.ok(!r.output.includes('S3cr3tPassw0rd') && !r.output.includes('db.example.invalid'));
  assert.ok(!r.read('preflight.txt').includes('S3cr3tPassw0rd'));
  assert.ok(!r.read('diagnostic.txt').includes('S3cr3tPassw0rd'));
});

// ── the workflow ────────────────────────────────────────────────────────────
const wf = fs.readFileSync(WORKFLOW, 'utf8');
const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // ignore comments

test('workflow: can only be started manually (no push / pull_request / schedule / workflow_run trigger)', () => {
  const on = code.match(/^on:\n((?:[ \t]+.*\n|\n)+)/m);
  assert.ok(on, 'on: block found');
  const triggers = [...on[1].matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(triggers, ['workflow_dispatch']);
  assert.ok(!/\b(pull_request_target|pull_request|push|schedule|workflow_run|repository_dispatch)\b\s*:/.test(on[1]));
});

test('workflow: repository permissions are read-only and the protected environment is used', () => {
  assert.match(code, /^permissions:\n {2}contents: read\n/m);
  assert.ok(!/(contents|id-token|actions|packages|pull-requests|issues|checks|statuses|deployments): *write/.test(code));
  assert.match(code, /^ {4}environment: production-backup$/m);
});

test('workflow: the DB secret is scoped to individual steps (never the job or workflow env) and only the runner uses it', () => {
  assert.ok(!/^env:/m.test(code), 'no workflow-level env');
  const job = code.split(/^jobs:/m)[1].split(/^ {4}steps:/m)[0];
  assert.ok(!/secrets\.PINTAG_PROD_DB_URL/.test(job), 'no job-level secret exposure');
  const steps = code.split(/^ {6}- /m).slice(1);
  const withSecret = steps.filter((s) => /secrets\.PINTAG_PROD_DB_URL/.test(s));
  assert.equal(withSecret.length, 2, 'only the presence check and the runner step see it');
  assert.ok(withSecret.some((s) => /bash scripts\/diagnostics\/orphan-originals\/run\.sh/.test(s)));
  assert.ok(!steps.filter((s) => /Publish results/.test(s)).some((s) => /secrets\./.test(s)));
});

test('workflow: runs nothing but the lint-gated runner (no other scripts, no git/gh/curl writes, no uploads)', () => {
  assert.ok(!/\b(git (push|commit|tag)|gh (api|pr|release)|curl|wget|upload-artifact|rclone)\b/.test(code));
  assert.ok(!/^\s*psql\b/m.test(code), 'psql is only ever run by the lint-gated runner');
  assert.equal((code.match(/scripts\/diagnostics\/orphan-originals\/run\.sh/g) || []).length, 1);
});
