// Live security suite: elapsed times and the reports built from them.
//
// security-regression run 45152177959 (2026-11-23) failed because a suite duration came out NEGATIVE: durations were differences of two wall-clock
// readings (date +%s%3N), the runner's clock stepped backwards, and ms_to_sec printed "0.-05". That made the JSON summary invalid
// ("Unterminated fractional number in JSON"). These tests pin the fix:
//   * ms_to_sec always prints a valid JSON number with three decimals, and never a negative one (negative, empty or junk input -> 0.000);
//   * now_ms reads a monotonic clock where one exists (/proc/uptime on Linux) and never goes backwards between consecutive readings;
//   * generate_reports writes a JSON summary that parses and a JUnit file whose times are valid, even when every recorded duration is negative.
// They use the real functions from tests/security/lib/helpers.sh, run bash in a temporary directory (helpers.sh writes its output relative to the
// current directory), and issue no network request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HELPERS = path.join(ROOT, 'tests/security/lib/helpers.sh');

function bash(snippet) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'report-timing-'));
  const r = spawnSync('bash', ['-c', `source '${HELPERS}'\n${snippet}`], { cwd, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  return { ...r, cwd };
}

const CASES = [
  // [input, expected printed value]
  ['-1', '0.000'], ['-5', '0.000'], ['-999', '0.000'], ['-1000', '0.000'], ['-1500', '0.000'], ['-123456789', '0.000'],   // negative
  ['0', '0.000'],                                                                                                       // zero
  ['1', '0.001'], ['7', '0.007'], ['12', '0.012'], ['99', '0.099'], ['999', '0.999'],                                     // small positive
  ['1000', '1.000'], ['1500', '1.500'], ['61234', '61.234'], ['180001', '180.001'], ['3600000', '3600.000'],            // normal
  ['', '0.000'], ['abc', '0.000'], ['1.5', '0.000'], ['12ms', '0.000'], ['-', '0.000'],                                  // not a number
  ['007', '0.007'], ['08', '0.008'], ['0999', '0.999'],                                                                 // leading zeros are decimal, never octal
];

test('ms_to_sec prints a valid, non-negative JSON number with three decimals for negative, zero, small, normal and malformed input', () => {
  const snippet = CASES.map(([v]) => `printf '%s\\n' "$(ms_to_sec '${v}')"`).join('\n');
  const r = bash(snippet);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split('\n');
  assert.equal(out.length, CASES.length);
  CASES.forEach(([input, expected], i) => {
    assert.equal(out[i], expected, `ms_to_sec '${input}'`);
    assert.match(out[i], /^\d+\.\d{3}$/, `ms_to_sec '${input}' has the form N.NNN`);
    const parsed = JSON.parse(`{"duration_sec":${out[i]}}`).duration_sec;   // must not throw
    assert.equal(parsed, Number(expected));
    assert.ok(parsed >= 0, `ms_to_sec '${input}' is not negative`);
  });
});

test('the old formatter was the bug: printf "%d.%03d" of a negative millisecond count is not valid JSON (the guard above is what prevents it)', () => {
  const r = spawnSync('bash', ['-c', 'ms=-5; printf "%d.%03d" "$((ms/1000))" "$((ms%1000))"'], { encoding: 'utf8' });
  assert.equal(r.stdout, '0.-05');
  assert.throws(() => JSON.parse(`{"d":${r.stdout}}`), /Unterminated fractional number|Unexpected|JSON/);
});

test('now_ms is monotonic: integer milliseconds, never decreasing over consecutive readings, and taken from /proc/uptime where it exists', { skip: !fs.existsSync('/proc/uptime') && 'no /proc/uptime on this system (the wall-clock fallback is used there)' }, () => {
  const r = bash('for i in $(seq 1 300); do now_ms; done; read -r up _ < /proc/uptime; echo "UP=$up"');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  const up = Number(lines.pop().replace('UP=', ''));
  const v = lines.map(Number);
  assert.equal(v.length, 300);
  v.forEach((x) => assert.ok(Number.isInteger(x) && x >= 0, `integer milliseconds: ${x}`));
  for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1], `reading ${i} went backwards: ${v[i - 1]} -> ${v[i]}`);
  // the readings are uptime in milliseconds (seconds since boot), not wall-clock epoch milliseconds
  assert.ok(Math.abs(v[v.length - 1] - up * 1000) < 5000, `now_ms ${v[v.length - 1]} vs /proc/uptime ${up}s`);
  assert.ok(v[0] < 1e12, 'not an epoch timestamp');
});

test('now_ms falls back to the wall clock, in milliseconds, when no monotonic source is readable', () => {
  // A copy of the real function with its monotonic source path pointed at a file that does not exist (simulates macOS).
  const r = bash(`eval "$(declare -f now_ms | sed -e '1s/now_ms/now_ms_noproc/' -e 's#/proc/uptime#/nonexistent/uptime#g')"; now_ms_noproc`);
  assert.equal(r.status, 0, r.stderr);
  const v = Number(r.stdout.trim());
  assert.ok(Math.abs(v - Date.now()) < 60000, `fallback is epoch milliseconds: ${v}`);
});

test('generate_reports writes a parseable JSON summary and valid JUnit times even when every recorded duration is negative', () => {
  const r = bash(`
TOTAL_PASS=2; TOTAL_FAIL=1; TOTAL_SKIP=0
SUITE_RESULTS[alpha]="1 0 0 -5"          # a backwards clock step inside a suite
SUITE_RESULTS[beta]="1 1 0 0"            # an instant suite
SUITE_RESULTS[gamma]="0 0 0 1234"        # a normal suite
SUITE_XML[alpha]=""; SUITE_XML[beta]=""; SUITE_XML[gamma]=""
RUN_START_MS=$(( $(now_ms) + 60000 ))     # total duration negative as well
generate_reports >/dev/null
ls tests/security/output/reports/`);
  assert.equal(r.status, 0, r.stderr);
  const dir = path.join(r.cwd, 'tests/security/output/reports');
  const json = fs.readdirSync(dir).find((f) => /^summary-.*\.json$/.test(f));
  const xml = fs.readdirSync(dir).find((f) => /^junit-.*\.xml$/.test(f));
  assert.ok(json && xml, `reports written: ${fs.readdirSync(dir)}`);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, json), 'utf8'));   // the assertion that failed in run 45152177959
  assert.equal(summary.duration_sec, 0);
  const byName = Object.fromEntries(summary.suites.map((s) => [s.name, s.duration_sec]));
  assert.deepEqual(byName, { alpha: 0, beta: 0, gamma: 1.234 });
  const times = [...fs.readFileSync(path.join(dir, xml), 'utf8').matchAll(/time="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(times.length >= 4, `JUnit times found: ${times}`);
  times.forEach((t) => assert.match(t, /^\d+\.\d{3}$/, `JUnit time="${t}"`));
});
