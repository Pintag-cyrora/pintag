// Regression test for the "Unexpected end of JSON input" failure: a RETURNS
// void RPC (ensure_daily_metrics_snapshot) replies 204/empty, and the old
// `return r.json()` threw on it, aborting every report before the AI call.
//
// Run: node --test 'supabase/functions/generate-intelligence-report/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRpcBody } from './rest-body.js';

test('204 No Content → null (the RETURNS void RPC that regressed on Aug 5)', () => {
  assert.equal(parseRpcBody(204, ''), null);
  assert.equal(parseRpcBody(204, undefined), null);
});

test('empty / whitespace-only 200 body → null (no throw)', () => {
  assert.equal(parseRpcBody(200, ''), null);
  assert.equal(parseRpcBody(200, '   \n'), null);
  assert.equal(parseRpcBody(200, null), null);
});

test('a real JSON body is still parsed exactly as before', () => {
  assert.deepEqual(parseRpcBody(200, '{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] });
  assert.deepEqual(parseRpcBody(200, '[1,2,3]'), [1, 2, 3]);
  assert.equal(parseRpcBody(200, 'null'), null);   // an explicit JSON null
  assert.equal(parseRpcBody(200, '42'), 42);
});

test('malformed JSON in a non-empty body still surfaces as an error', () => {
  assert.throws(() => parseRpcBody(200, '{not json'));
});
