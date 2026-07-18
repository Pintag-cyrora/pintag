// Unit tests for the Gemini client — run with `node --test`. Every test
// mocks global.fetch so this suite never makes a real network call (no
// GEMINI_API_KEY needed, deterministic, fast, safe to run in CI on every
// push). The retry-delay constants in gemini-client.js are multi-second,
// so tests that exercise a retry path temporarily patch global.setTimeout
// to fire immediately rather than actually waiting.
//
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import { callGemini } from './gemini-client.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}
function geminiPayload(obj) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] };
}

function withInstantTimers(fn) {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  // Real timers still needed for AbortController's own internal timeout —
  // only the retry backoff delay (a plain setTimeout the client awaits
  // between attempts) is fast-forwarded, so tests don't take 2-10s each.
  global.setTimeout = (cb, _ms) => originalSetTimeout(cb, 0);
  return fn().finally(() => {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  });
}

test('callGemini parses a well-formed JSON response on the first try', async () => {
  global.fetch = async () => jsonResponse(200, geminiPayload({ title: 'Hello', executive_summary: 'Hi' }));
  const result = await callGemini('fake-key', 'a prompt');
  assert.equal(result.title, 'Hello');
});

test('callGemini retries on 429 and succeeds on the next attempt', () => withInstantTimers(async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return jsonResponse(429, 'rate limited');
    return jsonResponse(200, geminiPayload({ title: 'Recovered' }));
  };
  const result = await callGemini('fake-key', 'a prompt');
  assert.equal(result.title, 'Recovered');
  assert.equal(calls, 2);
}));

test('callGemini retries on 503 and succeeds on the next attempt', () => withInstantTimers(async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return jsonResponse(503, 'unavailable');
    return jsonResponse(200, geminiPayload({ title: 'Recovered' }));
  };
  const result = await callGemini('fake-key', 'a prompt');
  assert.equal(result.title, 'Recovered');
}));

test('callGemini throws a clear error on a non-retryable HTTP error', async () => {
  global.fetch = async () => jsonResponse(400, 'bad request');
  await assert.rejects(() => callGemini('fake-key', 'a prompt'), /Gemini API 400/);
});

test('callGemini exhausts retries and throws after repeated 429s', () => withInstantTimers(async () => {
  global.fetch = async () => jsonResponse(429, 'still limited');
  await assert.rejects(() => callGemini('fake-key', 'a prompt'), /Gemini API 429/);
}));

test('callGemini throws when the response has no text content', async () => {
  global.fetch = async () => jsonResponse(200, { candidates: [{ content: { parts: [] } }] });
  await assert.rejects(() => callGemini('fake-key', 'a prompt'), /No text content/);
});

test('callGemini throws when the response text has no parseable JSON', async () => {
  global.fetch = async () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] });
  await assert.rejects(() => callGemini('fake-key', 'a prompt'), /Could not parse JSON/);
});

test('callGemini retries on a timeout (AbortError) and succeeds on the next attempt', () => withInstantTimers(async () => {
  let calls = 0;
  global.fetch = async (_url, opts) => {
    calls++;
    if (calls === 1) {
      // Simulate the real AbortController firing mid-request.
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
        // Trigger the abort "immediately" from the test's perspective —
        // gemini-client.js owns the real timeout; we just need the signal
        // to actually fire so the client's catch branch runs.
        opts.signal.dispatchEvent ? opts.signal.dispatchEvent(new Event('abort')) : null;
      });
    }
    return jsonResponse(200, geminiPayload({ title: 'Recovered after timeout' }));
  };
  const result = await callGemini('fake-key', 'a prompt');
  assert.equal(result.title, 'Recovered after timeout');
  assert.equal(calls, 2);
}));
