// ci-runner-pin.test.js -- every CI job that installs Playwright's Chromium runs on ubuntu-24.04.
//
// Since 2026-11-14 GitHub's `ubuntu-latest` label resolves to ubuntu-26.04, where the pinned Playwright (1.56.1) refuses to install Chromium
// ("Playwright does not support chromium on ubuntu26.04-x64"), so every browser job failed before any test ran. Those jobs are pinned to
// ubuntu-24.04 until Playwright is upgraded to a release that supports 26.04; this test stops a new browser job (or an edit) from silently
// going back to ubuntu-latest. Jobs that do not use a browser stay on ubuntu-latest and are not checked here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '.github', 'workflows');
const PINNED = 'ubuntu-24.04';

// { job, runsOn, usesPlaywright } for every job of a workflow file (top-level `jobs:` block, two-space job keys, as in this repository).
function jobsOf(text) {
  const lines = text.split('\n');
  const out = [];
  let inJobs = false; let cur = null;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (inJobs && /^\S/.test(line)) { inJobs = false; cur = null; continue; }
    if (!inJobs) continue;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) { cur = { job: m[1], runsOn: null, usesPlaywright: false }; out.push(cur); continue; }
    if (!cur) continue;
    const r = line.match(/^ {4}runs-on:\s*([^\s#]+)/);
    if (r) cur.runsOn = r[1];
    if (/^\s*[^#]*\bplaywright (install|test)\b/.test(line)) cur.usesPlaywright = true;
  }
  return out;
}

function pinErrors(files) {
  const errors = [];
  for (const [file, text] of Object.entries(files)) {
    for (const j of jobsOf(text)) {
      if (j.usesPlaywright && j.runsOn !== PINNED) errors.push(`${file}: job "${j.job}" runs Playwright on ${j.runsOn}, expected ${PINNED}`);
    }
  }
  return errors;
}

const workflows = Object.fromEntries(fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]));

test('every job that runs Playwright is pinned to ubuntu-24.04', () => {
  assert.deepStrictEqual(pinErrors(workflows), []);
});

test('the browser jobs known on 2026-11-14 are all found (the parser has not gone blind)', () => {
  const found = [];
  for (const [file, text] of Object.entries(workflows)) for (const j of jobsOf(text)) if (j.usesPlaywright) found.push(`${file}:${j.job}`);
  for (const expected of [
    'analytics-tests.yml:e2e', 'contact-tracking-tests.yml:contact-tracking', 'frontend-regression-tests.yml:playwright',
    'intelligence-tests.yml:frontend-tests', 'pricing-tests.yml:listing-card-price', 'pricing-tests.yml:smart-import-pricing',
    'rental-pricing-tests.yml:rental-pricing-e2e', 'security-regression.yml:local',
  ]) assert.ok(found.includes(expected), `${expected} not detected as a Playwright job`);
});

test('the check rejects a browser job on ubuntu-latest and accepts a non-browser one there', () => {
  const wf = (runsOn, step) => `name: x\non: push\njobs:\n  a:\n    runs-on: ${runsOn}\n    steps:\n      - run: ${step}\n`;
  assert.strictEqual(pinErrors({ 'x.yml': wf('ubuntu-latest', 'npx playwright install --with-deps chromium') }).length, 1);
  assert.strictEqual(pinErrors({ 'x.yml': wf('ubuntu-26.04', 'npx playwright test') }).length, 1);
  assert.strictEqual(pinErrors({ 'x.yml': wf('ubuntu-24.04', 'npx playwright install --with-deps chromium') }).length, 0);
  assert.strictEqual(pinErrors({ 'x.yml': wf('ubuntu-latest', 'node --test') }).length, 0);
  // a mention in a comment is not a use
  assert.strictEqual(pinErrors({ 'x.yml': wf('ubuntu-latest', 'node --test   # no playwright install here') }).length, 0);
});
