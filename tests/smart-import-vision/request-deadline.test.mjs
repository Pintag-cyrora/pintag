// Request-wide deadline for smart-listing-importer.
//   node --test tests/smart-import-vision/request-deadline.test.mjs
//
// Executes the REAL createRequestDeadline() and the REAL budget constants,
// extracted from index.ts with Node type-stripping (same technique as
// vision-memory.test.mjs) — not a re-implementation, and not a source grep.
//
// THE PRODUCTION FAILURE THIS DEFENDS AGAINST
// execution 7f1df030-fa10-4a2b-8eb0-03644d651ac5:
//   06:56:06  "Gemini 503, retry 1/3"
//   06:57:21  shutdown, reason EarlyDrop, memory 12.7 MB, cpu_time 73 ms
// 12.7 MB and 73 ms of CPU over 75 s = an idle isolate blocked on a network
// read. Wall clock, not a resource limit. The second Gemini attempt had no
// timeout, so it ran until the platform killed the worker mid-await — which is
// why no Response, and therefore no CORS headers, ever existed.
//
// AND the flaw in the FIRST attempt at this fix, which these tests pin
// permanently: a Gemini phase budget that started its clock AFTER image loading
// meant a 75 s image phase and a 92 s Gemini phase could still add to a 167 s
// request against a ~150 s ceiling. Phase budgets ADD. Only a shared deadline
// SUBTRACTS.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(here, '../../supabase/functions/smart-listing-importer/index.ts'), 'utf8');

function extractFn(src, sigRe) {
  const m = sigRe.exec(src);
  if (!m) throw new Error('not found: ' + sigRe);
  let i = src.indexOf('{', m.index), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { i++; break; } } }
  return src.slice(m.index, i);
}
const num = (name) => {
  const m = new RegExp('const ' + name + '\\s*(?::\\s*number)?\\s*=\\s*([0-9_]+)').exec(SRC);
  if (!m) throw new Error('constant not found: ' + name);
  return Number(m[1].replace(/_/g, ''));
};

const C = {
  REQUEST_BUDGET_MS:     num('REQUEST_BUDGET_MS'),
  RESPONSE_RESERVE_MS:   num('RESPONSE_RESERVE_MS'),
  IMAGE_PHASE_MAX_MS:    num('IMAGE_PHASE_MAX_MS'),
  IMAGE_FETCH_MAX_MS:    num('IMAGE_FETCH_MAX_MS'),
  IMAGE_FETCH_MIN_MS:    num('IMAGE_FETCH_MIN_MS'),
  GEMINI_ATTEMPT_MAX_MS: num('GEMINI_ATTEMPT_MAX_MS'),
  GEMINI_MIN_ATTEMPT_MS: num('GEMINI_MIN_ATTEMPT_MS'),
  MAX_IMAGES:            num('MAX_IMAGES'),
  IMAGE_CONCURRENCY:     num('IMAGE_CONCURRENCY'),
};
const RETRY_DELAYS = JSON.parse(/const RETRY_DELAYS = (\[[^\]]+\])/.exec(SRC)[1]);

// Load the real function into a module, with the constants it closes over.
const mod = path.join(os.tmpdir(), `pintag-deadline-${process.pid}.mts`);
fs.writeFileSync(mod, [
  ...Object.entries(C).map(([k, v]) => `const ${k} = ${v};`),
  extractFn(SRC, /function createRequestDeadline\(/),
  'export { createRequestDeadline };',
].join('\n'));
const { createRequestDeadline } = await import(pathToFileURL(mod).href);

const WALL_CLOCK_MS = 150_000;   // Supabase Edge Runtime default

// ── The primitive ─────────────────────────────────────────────────────────
test('the deadline is anchored to the ORIGINAL request start', () => {
  const d = createRequestDeadline(C.REQUEST_BUDGET_MS, 1000);
  assert.equal(d.startedAt, 1000);
  assert.equal(d.expiresAt, 1000 + C.REQUEST_BUDGET_MS);
  assert.equal(d.remaining(1000), C.REQUEST_BUDGET_MS);
});

test('usable() withholds the response reserve and never goes negative', () => {
  const d = createRequestDeadline(C.REQUEST_BUDGET_MS, 0);
  assert.equal(d.usable(0), C.REQUEST_BUDGET_MS - C.RESPONSE_RESERVE_MS);
  assert.equal(d.usable(C.REQUEST_BUDGET_MS + 60_000), 0, 'must clamp at 0, not report negative time');
});

test('allot() returns the smaller of what is wanted and what is affordable', () => {
  const d = createRequestDeadline(C.REQUEST_BUDGET_MS, 0);
  assert.equal(d.allot(C.GEMINI_ATTEMPT_MAX_MS, 0), C.GEMINI_ATTEMPT_MAX_MS, 'early: the ceiling wins');
  const late = C.REQUEST_BUDGET_MS - C.RESPONSE_RESERVE_MS - 3_000;
  assert.equal(d.allot(C.GEMINI_ATTEMPT_MAX_MS, late), 3_000, 'late: what is left wins');
});

// ── Image time reduces the Gemini budget (the whole point) ────────────────
test('image time REDUCES the remaining Gemini budget, one-for-one', () => {
  const d = createRequestDeadline(C.REQUEST_BUDGET_MS, 0);
  const before = d.usable(0);
  const afterImages = d.usable(40_000);
  assert.equal(before - afterImages, 40_000,
    'every millisecond the image phase spends must come out of Gemini\'s share');
});

test('THE 167s FLAW: a full image phase plus a full Gemini phase cannot exceed the request budget', () => {
  // The first version of this fix capped the Gemini phase at 105s but started
  // that clock AFTER images, so 75s + 92s = 167s was reachable. Now both draw
  // from one deadline, so the sum is bounded by construction.
  const d = createRequestDeadline(C.REQUEST_BUDGET_MS, 0);
  const imagePhaseSpent = 75_000;                       // the old worst case
  const geminiShare = d.usable(imagePhaseSpent);
  const total = imagePhaseSpent + geminiShare + C.RESPONSE_RESERVE_MS;
  assert.equal(total, C.REQUEST_BUDGET_MS);
  assert.ok(total < WALL_CLOCK_MS, `${total}ms must stay under the ${WALL_CLOCK_MS}ms wall clock`);
  assert.ok(total < 167_000, 'the 167s combination must be unreachable');
});

// ── Simulated worst case, end to end ─────────────────────────────────────
function simulate({ imageMsEach = C.IMAGE_FETCH_MAX_MS, geminiHangs = true, geminiStatus = null } = {}) {
  let now = 0;
  const d = createRequestDeadline(C.REQUEST_BUDGET_MS, now);
  const events = [];

  // Image phase: capped by its own ceiling AND by the shared deadline.
  const imagePhaseEndsAt = Math.min(now + C.IMAGE_PHASE_MAX_MS, d.expiresAt - C.RESPONSE_RESERVE_MS);
  const waves = Math.ceil(C.MAX_IMAGES / C.IMAGE_CONCURRENCY);
  for (let w = 0; w < waves; w++) {
    const left = imagePhaseEndsAt - now;
    if (left < C.IMAGE_FETCH_MIN_MS) { events.push('image_skipped_deadline'); continue; }
    const spend = Math.min(imageMsEach, left);
    now += spend; events.push(`image_wave:${spend}`);
  }

  // Gemini phase: same clock.
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const budget = Math.min(C.GEMINI_ATTEMPT_MAX_MS, Math.max(0, d.expiresAt - now - C.RESPONSE_RESERVE_MS));
    if (budget < C.GEMINI_MIN_ATTEMPT_MS) { events.push('budget_exhausted'); break; }
    now += geminiHangs ? budget : 1_000;
    events.push(`gemini_attempt:${budget}`);
    if (!geminiHangs && geminiStatus === null) { events.push('gemini_ok'); break; }
    const usable = Math.max(0, d.expiresAt - now - C.RESPONSE_RESERVE_MS);
    if (attempt < RETRY_DELAYS.length && usable > RETRY_DELAYS[attempt] + C.GEMINI_MIN_ATTEMPT_MS) {
      now += RETRY_DELAYS[attempt]; events.push(`sleep:${RETRY_DELAYS[attempt]}`);
    } else { events.push('no_budget_to_retry'); break; }
  }
  return { totalMs: now + C.RESPONSE_RESERVE_MS, events, deadline: d };
}

test('worst case — every image maxes out AND every Gemini attempt hangs — stays under the wall clock', () => {
  const { totalMs, events } = simulate();
  assert.ok(totalMs <= C.REQUEST_BUDGET_MS, `${totalMs}ms exceeded the ${C.REQUEST_BUDGET_MS}ms budget`);
  assert.ok(totalMs < WALL_CLOCK_MS, `${totalMs}ms would still hit the ${WALL_CLOCK_MS}ms wall clock`);
  assert.ok(events.some(e => e === 'budget_exhausted' || e === 'no_budget_to_retry'),
    'the run must end by refusing to continue, not by being killed: ' + events.join(' -> '));
});

test('a slow gallery shortens Gemini rather than extending the request', () => {
  const fast = simulate({ imageMsEach: 500 });
  const slow = simulate({ imageMsEach: C.IMAGE_FETCH_MAX_MS });
  const geminiOf = (r) => r.events.filter(e => e.startsWith('gemini_attempt:'))
                                  .reduce((a, e) => a + Number(e.split(':')[1]), 0);
  assert.ok(geminiOf(slow) < geminiOf(fast), 'slow images must leave Gemini less time');
  for (const r of [fast, slow]) assert.ok(r.totalMs <= C.REQUEST_BUDGET_MS, r.totalMs + 'ms');
});

test('the image phase can never consume the whole request', () => {
  const { deadline } = simulate({ imageMsEach: C.IMAGE_FETCH_MAX_MS });
  const geminiShare = deadline.usable(C.IMAGE_PHASE_MAX_MS);
  assert.ok(geminiShare >= C.GEMINI_MIN_ATTEMPT_MS,
    'IMAGE_PHASE_MAX_MS must leave Gemini a usable slice, or a slow gallery starves generation entirely');
});

// ── Retries ───────────────────────────────────────────────────────────────
test('a second attempt gets ONLY the time left, never a fresh ceiling', () => {
  const { events } = simulate();
  const budgets = events.filter(e => e.startsWith('gemini_attempt:')).map(e => Number(e.split(':')[1]));
  assert.ok(budgets.length >= 2, 'expected at least two attempts');
  for (let i = 1; i < budgets.length; i++) {
    assert.ok(budgets[i] <= budgets[i - 1],
      `attempt ${i + 1} got ${budgets[i]}ms after ${budgets[i - 1]}ms — a later attempt must never get more`);
  }
});

test('retry delays are charged to the same deadline', () => {
  const { events, totalMs } = simulate();
  const slept = events.filter(e => e.startsWith('sleep:')).reduce((a, e) => a + Number(e.split(':')[1]), 0);
  const worked = events.filter(e => e.startsWith('gemini_attempt:') || e.startsWith('image_wave:'))
                       .reduce((a, e) => a + Number(e.split(':')[1]), 0);
  assert.equal(totalMs, worked + slept + C.RESPONSE_RESERVE_MS, 'sleeps must be inside the budget, not beside it');
});

test('no retry is started when there is not enough time for a meaningful attempt', () => {
  const { events } = simulate();
  const tail = events[events.length - 1];
  assert.ok(tail === 'budget_exhausted' || tail === 'no_budget_to_retry', 'ended with: ' + tail);
});

test('the reserve survives to the end, so a response can always be built', () => {
  const { totalMs, deadline } = simulate();
  assert.ok(deadline.expiresAt - (totalMs - C.RESPONSE_RESERVE_MS) >= C.RESPONSE_RESERVE_MS,
    'work must stop with the response reserve still intact');
});

// ── Source-level guarantees ──────────────────────────────────────────────
test('the Gemini fetch carries an AbortSignal derived from the deadline', () => {
  const call = SRC.slice(SRC.indexOf('generativelanguage.googleapis.com'));
  const body = call.slice(0, call.indexOf('if (response.ok) break;'));
  assert.match(body, /signal: AbortSignal\.timeout\(attemptBudget\)/);
  assert.match(SRC, /const attemptBudget = deadline\.allot\(GEMINI_ATTEMPT_MAX_MS\)/);
});

test('no phase keeps an independent budget any more', () => {
  for (const gone of ['GEMINI_TOTAL_BUDGET_MS', 'phaseStart']) {
    assert.equal(SRC.includes(gone), false, `${gone} is a phase-local budget and must not exist`);
  }
});

test('every external blocking call is bounded by the deadline', () => {
  // auth/v1/user, rpc/is_pintag_admin, image fetch, Gemini.
  assert.equal((SRC.match(/deadline\.allot\(AUTH_FETCH_MAX_MS\)/g) || []).length, 2, 'both auth lookups');
  assert.match(SRC, /fetch\(url, \{ signal: AbortSignal\.timeout\(timeoutMs\) \}\)/, 'image fetch');
  assert.match(SRC, /signal: AbortSignal\.timeout\(attemptBudget\)/, 'gemini');
  assert.equal(/AbortSignal\.timeout\(15000\)/.test(SRC), false, 'no fixed per-phase timeout should remain');
});

test('Gemini 503 remains retryable', () => {
  assert.match(SRC, /response\.status === 429 \|\| response\.status === 503/);
  assert.match(SRC, /Gemini \$\{response\.status\}, retry/);
});

test('a timeout throws a normal Error, so the outer catch returns 500 + CORS', () => {
  assert.match(SRC, /throw new Error\(GEMINI_TIMEOUT_MESSAGE\)/);
  const outer = SRC.slice(SRC.lastIndexOf('} catch (error)'));
  assert.match(outer, /status: 500/);
  assert.match(outer, /\.\.\.corsHeaders/);
});

test('the user-facing timeout message is actionable and leaks no runtime internals', () => {
  const msg = /const GEMINI_TIMEOUT_MESSAGE =\s*\n?\s*'([^']+)'/.exec(SRC)[1];
  assert.match(msg, /Try again in a minute, or generate with fewer photos/);
  for (const leak of ['isolate', 'EarlyDrop', 'wall clock', 'wall-clock', 'WORKER', 'cpu_time']) {
    assert.equal(msg.toLowerCase().includes(leak.toLowerCase()), false, `leaks "${leak}"`);
  }
});

test('the declared budgets are internally consistent and fit the wall clock', () => {
  const worst = C.IMAGE_PHASE_MAX_MS + (C.REQUEST_BUDGET_MS - C.IMAGE_PHASE_MAX_MS - C.RESPONSE_RESERVE_MS) + C.RESPONSE_RESERVE_MS;
  assert.equal(worst, C.REQUEST_BUDGET_MS);
  assert.ok(C.REQUEST_BUDGET_MS < WALL_CLOCK_MS - 20_000,
    'keep at least 20s of headroom under the wall clock for platform overhead');
  assert.ok(C.IMAGE_PHASE_MAX_MS < C.REQUEST_BUDGET_MS - C.RESPONSE_RESERVE_MS - C.GEMINI_MIN_ATTEMPT_MS);
});
