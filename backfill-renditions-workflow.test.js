// Safety invariants of .github/workflows/backfill-renditions.yml — the manual
// workflow that runs scripts/backfill-renditions.mjs against PRODUCTION.
//   node --test backfill-renditions-workflow.test.js
//
// This workflow is the one place production Storage is written from CI, so the
// properties that make it safe are pinned here rather than left to review:
// manual trigger only, dry-run by default, a dry run BEFORE any apply, the
// service-role key withheld from every step that must not write, no secret
// echoed, and no free-text input interpolated into a shell.
//
// Source-level assertions, the same convention as xss-inline-handlers.test.js
// and static-contact-links.test.js: this repo has no root package.json, so a
// YAML parser is not available and the file's shape is what is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WORKFLOW = '.github/workflows/backfill-renditions.yml';
const SCRIPT = 'scripts/backfill-renditions.mjs';
const src = fs.readFileSync(new URL('./' + WORKFLOW, import.meta.url), 'utf8');

// Split the job's steps on their `      - name:` / `      - uses:` boundary so
// each step's own `if:`/`env:` can be asserted independently.
function steps() {
  const body = src.slice(src.indexOf('    steps:'));
  const parts = body.split(/\n(?=      - (?:name|uses):)/).slice(1);
  return parts.map((block) => ({
    name: (block.match(/- name: (.+)/) || [, block.match(/- uses: (\S+)/)?.[1] || ''])[1].trim(),
    block,
  }));
}
const stepNamed = (needle) => {
  const s = steps().find((x) => x.name.toLowerCase().includes(needle));
  assert.ok(s, `no step matching "${needle}" — steps are: ${steps().map((x) => x.name).join(' | ')}`);
  return s;
};

test('the workflow is manual only: no schedule, push or pull_request trigger', () => {
  const on = src.slice(src.indexOf('\non:'), src.indexOf('\nconcurrency:'));
  assert.match(on, /workflow_dispatch:/);
  for (const trigger of ['schedule:', 'push:', 'pull_request:', 'repository_dispatch:']) {
    assert.ok(!on.includes(trigger), `${trigger} would let this run without a person choosing to`);
  }
});

test('mode is a two-option choice that defaults to dry-run', () => {
  const mode = src.slice(src.indexOf('      mode:'), src.indexOf('      confirm:'));
  assert.match(mode, /type: choice/);
  assert.match(mode, /- dry-run/);
  assert.match(mode, /- apply/);
  assert.match(mode, /default: dry-run/);
  // A bare "Run workflow" click must never write.
  assert.ok(!/default: apply/.test(src), 'apply must never be the default');
});

test('the production DB secret is mapped to the PINTAG_DB_URL the script reads', () => {
  assert.match(src, /PINTAG_DB_URL:\s+\$\{\{ secrets\.PINTAG_PROD_DB_URL \}\}/);
  // The script reads process.env.PINTAG_DB_URL; PINTAG_PROD_DB_URL is the
  // secret's name. Passing the secret under its own name would leave the
  // script with no connection at all.
  const script = fs.readFileSync(new URL('./' + SCRIPT, import.meta.url), 'utf8');
  assert.match(script, /process\.env\.PINTAG_DB_URL/);
  assert.ok(!/\$\{\{ secrets\.PINTAG_DB_URL \}\}/.test(src), 'no secret of that name exists');
});

test('the dry run always runs and is never handed a credential that can write', () => {
  const dry = stepNamed('dry run');
  assert.ok(!/^\s+if:/m.test(dry.block), 'the dry run must run in BOTH modes — it is the apply pre-flight');
  assert.ok(!dry.block.includes('SUPABASE_SERVICE_ROLE_KEY'),
    'the dry-run step must not receive the service-role key: it cannot then write even if invoked wrongly');
  assert.match(dry.block, /--dry-run/);
  assert.ok(!dry.block.includes('--apply'));
});

test('apply is gated on the mode input, runs after the dry run, and needs the typed confirmation', () => {
  const names = steps().map((s) => s.name.toLowerCase());
  const dryIdx = names.findIndex((n) => n.includes('dry run'));
  const applyIdx = names.findIndex((n) => n.startsWith('apply'));
  const confirmIdx = names.findIndex((n) => n.includes('confirm'));
  assert.ok(confirmIdx < dryIdx, 'an unconfirmed apply must fail before anything is downloaded');
  assert.ok(dryIdx < applyIdx, 'the dry run (and its storage-ceiling verdict) must precede any write');

  const apply = steps()[applyIdx];
  assert.match(apply.block, /if: inputs\.mode == 'apply'/);
  assert.match(apply.block, /--apply/);
  assert.match(steps()[confirmIdx].block, /if: inputs\.mode == 'apply'/);
  assert.match(steps()[confirmIdx].block, /"\$CONFIRM" != "APPLY"/);
});

test('no step echoes a secret, and no free-text input is interpolated into a shell', () => {
  for (const step of steps()) {
    if (!step.block.includes('run: |')) continue;
    // Only the shell body: a YAML comment mentioning interpolation is prose,
    // not something the runner expands.
    const run = step.block.slice(step.block.indexOf('run: |'))
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    // Inputs and secrets reach the shell through env: only. A ${{ }} inside a
    // run block is a shell injection for free-text inputs and, for secrets,
    // puts the value on a command line.
    const interpolated = run.match(/\$\{\{[^}]*\}\}/g) || [];
    assert.deepEqual(interpolated, [], `${step.name}: interpolation inside a run block`);
    // A secret-bearing variable must not appear on any line that prints —
    // anywhere on it, not just at the start. GitHub masks registered secrets
    // in logs, but a workflow should never rely on masking as its only guard.
    const SECRET_VARS = /\$\{?(PINTAG_DB_URL|SUPABASE_SERVICE_ROLE_KEY)\b/;
    for (const line of run.split('\n')) {
      if (!/\b(echo|printf|cat|tee)\b/.test(line)) continue;
      assert.ok(!SECRET_VARS.test(line), `${step.name}: a secret value must never be printed: ${line.trim()}`);
      assert.ok(!/secrets\./.test(line), `${step.name}: never print a secrets.* expression`);
    }
  }
});

test('the limit input is validated, so a typo cannot silently mean "every image"', () => {
  // parseInt('abc') is NaN and `LIMIT > 0` is then false, which the script
  // treats as no limit at all — the opposite of the operator's intent.
  assert.match(src, /case "\$LIMIT" in/);
  assert.match(src, /\*\[!0-9\]\*\)/);
});

test('the workflow runs the committed script by path and pins every action to a SHA', () => {
  assert.ok(fs.existsSync(new URL('./' + SCRIPT, import.meta.url)), 'the script must exist at the referenced path');
  assert.match(src, /node scripts\/backfill-renditions\.mjs --dry-run/);
  assert.match(src, /node scripts\/backfill-renditions\.mjs --apply/);
  const uses = src.match(/uses: \S+/g) || [];
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} must be pinned to a full commit SHA`);
});

test('the job declares least-privilege permissions and cannot overlap another run', () => {
  assert.match(src, /permissions:\n  contents: read/);
  assert.match(src, /concurrency:\n  group: backfill-renditions\n  cancel-in-progress: false/);
  assert.match(src, /environment: production-backup/);
});
