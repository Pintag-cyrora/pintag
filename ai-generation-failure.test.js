// Regression tests for "Generation failed: Load failed" (Admin → Generate AI Content).
//   node --test ai-generation-failure.test.js
//
// ROOT CAUSE. The Gemini request in smart-listing-importer had no timeout and no
// overall budget — unlike the image fetches in the same file, which correctly use
// AbortSignal.timeout(15000). Worst case was four unbounded vision requests plus
// 17s of retry sleeps, past the Edge Function wall-clock limit.
//
// Why that produced an unreadable error rather than a slow one: when the platform
// kills the isolate, NO JavaScript in the function runs. The outer catch never
// executes, no Response is produced, and the socket closes without the CORS
// headers every other path sets. fetch() in the browser therefore rejects with a
// bare TypeError, which WebKit renders as "Load failed".
//
// The distinguishing fact, and what these tests protect: EVERY real application
// error (missing GEMINI_API_KEY, 401, Gemini 4xx) already returns a numbered HTTP
// status with a readable JSON body. Only a platform kill is invisible. So the fix
// is to stay inside the budget and return a real error — not to reword anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const fn = fs.readFileSync(new URL('./supabase/functions/smart-listing-importer/index.ts', import.meta.url), 'utf8');

// ── The edge function's Gemini call is bounded ────────────────────────────
test('the Gemini fetch has an abort signal (it previously had none)', () => {
  const call = fn.slice(fn.indexOf('generativelanguage.googleapis.com'));
  const body = call.slice(0, call.indexOf('if (response.ok) break;'));
  assert.match(body, /signal:\s*AbortSignal\.timeout\(/,
    'an unbounded Gemini fetch can outlive the wall-clock limit, and a platform kill ' +
    'returns no CORS headers — which is what surfaces as "Load failed"');
});

test('the per-attempt timeout is clamped by the REQUEST-WIDE deadline', () => {
  // Superseded design: the original fix used GEMINI_TOTAL_BUDGET_MS, a budget
  // whose clock started AFTER image loading. Image time was therefore additive
  // (75s images + 92s Gemini = a 167s request against a ~150s ceiling). The
  // budget is now anchored to the request start and every phase subtracts from
  // it — see tests/smart-import-vision/request-deadline.test.mjs for the full
  // behavioural coverage.
  assert.equal(fn.includes('GEMINI_TOTAL_BUDGET_MS'), false, 'phase-local budget must be gone');
  assert.equal(fn.includes('phaseStart'), false, 'phase-local clock must be gone');
  assert.match(fn, /const attemptBudget = deadline\.allot\(GEMINI_ATTEMPT_MAX_MS\)/);
});

test('the request budget leaves real headroom under the platform wall clock', () => {
  const budget = Number(/const REQUEST_BUDGET_MS\s*=\s*([\d_]+)/.exec(fn)[1].replace(/_/g, ''));
  assert.ok(budget > 0 && budget <= 120_000,
    `${budget}ms must stay well under the 150s default wall clock`);
});

test('the deadline is created at handler entry, before any external call', () => {
  const handler = fn.slice(fn.indexOf('Deno.serve(async (req)'));
  const deadlineAt = handler.indexOf('createRequestDeadline()');
  const authAt = handler.indexOf('requireAdmin(req, deadline)');
  assert.ok(deadlineAt > -1 && authAt > -1);
  assert.ok(deadlineAt < authAt,
    'the clock must start before auth, or auth time escapes the budget');
});

test('the retry ladder charges its sleeps to the same deadline', () => {
  const guard = /deadline\.usable\(\) > RETRY_DELAYS\[attempt\] \+ GEMINI_MIN_ATTEMPT_MS/g;
  assert.equal((fn.match(guard) || []).length, 2,
    'both the timeout-retry and the 429/503-retry paths must check the shared budget before sleeping');
});

test('a timed-out attempt is rethrown as a normal Error, so the outer catch can answer', () => {
  assert.match(fn, /TimeoutError'\s*\|\|\s*e\.name === 'AbortError'/);
  assert.match(fn, /throw new Error\(GEMINI_TIMEOUT_MESSAGE\)/);
});

test('a retryable Gemini status that runs out of budget is explained, not left bare', () => {
  assert.match(fn, /Gemini is busy right now \(HTTP \$\{response\.status\}\)/);
  assert.match(fn, /Try again in a minute, or generate with fewer photos/);
});

// ── The admin client classifies a response-less failure correctly ─────────
const admin = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}
vm.runInThisContext(extractFn(admin, 'describeAiGenFailure'));
const { describeAiGenFailure } = globalThis;

test('the admin fetch has its own ceiling, above the function budget', () => {
  const call = admin.slice(admin.indexOf("'/functions/v1/smart-listing-importer'"));
  const opts = call.slice(0, call.indexOf('if (!res.ok)'));
  const ms = Number(opts.match(/AbortSignal\.timeout\((\d+)\)/)[1]);
  const budget = Number(fn.match(/REQUEST_BUDGET_MS\s*=\s*([\d_]+)/)[1].replace(/_/g, ''));
  assert.ok(ms > budget,
    'the client ceiling must be LOOSER than the whole-request budget, so the function\'s own ' +
    'readable JSON error wins the race instead of the client aborting first');
});

test('"Load failed" is explained as a response-less failure, and NOT blamed on the API key', () => {
  const msg = describeAiGenFailure(new TypeError('Load failed'));
  assert.match(msg, /NO response/i);
  assert.match(msg, /killed mid-request|wall-clock|memory limit/i);
  // The old message told the operator to check GEMINI_API_KEY — which is exactly
  // what this failure is NOT, since a missing key returns a readable 500.
  assert.match(msg, /would have returned a numbered HTTP error/i);
});

test('the Chrome and Firefox spellings classify identically', () => {
  for (const raw of ['Failed to fetch', 'NetworkError when attempting to fetch resource']) {
    assert.match(describeAiGenFailure(new TypeError(raw)), /NO response/i, raw);
  }
});

test('a client-side timeout is named as a timeout, with where to look', () => {
  const e = new Error('signal timed out'); e.name = 'TimeoutError';
  const msg = describeAiGenFailure(e);
  assert.match(msg, /timed out/i);
  assert.match(msg, /Edge Functions.*Logs/is);
});

test('a real HTTP error is passed through with its status intact', () => {
  const msg = describeAiGenFailure(new Error('500: {"error":"GEMINI_API_KEY is not configured."}'));
  assert.match(msg, /500/);
  assert.match(msg, /GEMINI_API_KEY is not configured/);
  // ...and only THIS branch mentions the secret, because only this branch can be it.
  assert.match(msg, /Manage secrets/);
});

test('a 401 is passed through rather than misdiagnosed as a network problem', () => {
  const msg = describeAiGenFailure(new Error('401: {"error":"Invalid token"}'));
  assert.match(msg, /401/);
  assert.equal(/NO response/i.test(msg), false);
});
