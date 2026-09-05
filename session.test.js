// Unit tests for session.js -- run with `node --test session.test.js`.
// session.js is a plain-global-var browser script (no module exports) that
// reads sessionStorage/crypto -- neither exists in a plain Node vm context,
// so each test builds a small fake global environment (same vm-sandbox
// convention as lang.test.js, which needed browser globals for the same
// reason). Math is also stubbed with a call-counting spy so tests can prove
// Math.random() is never invoked by getOrCreateSessionId()/generateSecureUUID()
// -- the exact CodeQL "insecure randomness" finding this file fixes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fakeStorage(initial) {
  const store = Object.assign({}, initial);
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    _store: store
  };
}

// A crypto stub whose methods count how many times they were called, so
// tests can assert exactly which path (randomUUID vs. getRandomValues) ran.
// getRandomValues fills the array with a fixed, deterministic byte sequence
// (0, 1, 2, ...) rather than real randomness -- this test cares about which
// API produced the id and that the UUID is assembled correctly from it, not
// about actual entropy.
function fakeCrypto({ withRandomUUID }) {
  const calls = { randomUUID: 0, getRandomValues: 0 };
  const crypto = {
    getRandomValues(arr) {
      calls.getRandomValues++;
      for (let i = 0; i < arr.length; i++) arr[i] = i;
      return arr;
    }
  };
  if (withRandomUUID) {
    crypto.randomUUID = () => { calls.randomUUID++; return 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; };
  }
  return { crypto, calls };
}

// Spies on Math.random via prototype delegation (so every other Math.*
// method -- unused by session.js, but harmless to keep real -- still works)
// while counting calls. Passed as the sandbox's own `Math` global: vm
// contextify keeps a sandbox-provided global as-is instead of creating a
// fresh built-in for that name, which is what makes the spy observable.
function mathSpy() {
  const calls = { random: 0 };
  const math = Object.create(Math);
  math.random = () => { calls.random++; return 0.123456; };
  return { math, calls };
}

function loadSessionModule(env) {
  const src = fs.readFileSync(new URL('./session.js', import.meta.url), 'utf8');
  const spy = mathSpy();
  const sandbox = {
    sessionStorage: env.sessionStorage || fakeStorage({}),
    crypto: env.crypto,
    Math: spy.math,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'session.js' });
  sandbox.__mathCalls = spy.calls;
  return sandbox;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('getOrCreateSessionId', () => {
  test('a new id is generated when none is stored yet', () => {
    const { crypto } = fakeCrypto({ withRandomUUID: true });
    const env = loadSessionModule({ crypto });
    const id = env.getOrCreateSessionId();
    assert.equal(id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.equal(env.sessionStorage._store[env.PINTAG_SESSION_KEY], id);
  });

  test('an existing stored id is reused, not regenerated', () => {
    const { crypto, calls } = fakeCrypto({ withRandomUUID: true });
    const storage = fakeStorage({ pintag_session_id: 'existing-id-123' });
    const env = loadSessionModule({ crypto, sessionStorage: storage });
    const id = env.getOrCreateSessionId();
    assert.equal(id, 'existing-id-123');
    assert.equal(calls.randomUUID, 0, 'must not generate a new id when one already exists');
  });

  test('calling twice in the same "tab" returns the same id both times', () => {
    const { crypto } = fakeCrypto({ withRandomUUID: true });
    const env = loadSessionModule({ crypto });
    const first = env.getOrCreateSessionId();
    const second = env.getOrCreateSessionId();
    assert.equal(first, second);
  });

  test('crypto.randomUUID() is used when available, and Math.random() is never called', () => {
    const { crypto, calls } = fakeCrypto({ withRandomUUID: true });
    const env = loadSessionModule({ crypto });
    const id = env.getOrCreateSessionId();
    assert.equal(calls.randomUUID, 1);
    assert.equal(calls.getRandomValues, 0, 'must not fall through to getRandomValues when randomUUID exists');
    assert.equal(env.__mathCalls.random, 0, 'Math.random must never be called');
    assert.equal(id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  test('falls back to crypto.getRandomValues() (never Math.random()) when randomUUID is unavailable', () => {
    const { crypto, calls } = fakeCrypto({ withRandomUUID: false });
    const env = loadSessionModule({ crypto });
    const id = env.getOrCreateSessionId();
    assert.equal(calls.getRandomValues, 1);
    assert.equal(env.__mathCalls.random, 0, 'Math.random must never be used as the fallback');
    assert.match(id, UUID_RE, 'must still produce a well-formed UUID string');
  });

  test('the getRandomValues fallback produces a valid version-4/variant-10xx UUID', () => {
    // Fixed bytes (0,1,2,...15) deterministically produce a known UUID once
    // the version/variant bits are patched in -- byte[6] gets its high
    // nibble forced to 4 (0x06 -> 0x46), byte[8] gets its top two bits
    // forced to 10 (0x08 -> 0x88).
    const { crypto } = fakeCrypto({ withRandomUUID: false });
    const env = loadSessionModule({ crypto });
    const id = env.getOrCreateSessionId();
    assert.equal(id, '00010203-0405-4607-8809-0a0b0c0d0e0f');
    assert.match(id, UUID_RE);
  });

  test('sessionStorage throwing (private-browsing edge case) fails to null, not an unhandled throw', () => {
    const { crypto } = fakeCrypto({ withRandomUUID: true });
    const throwingStorage = {
      getItem() { throw new Error('SecurityError'); },
      setItem() {}
    };
    const env = loadSessionModule({ crypto, sessionStorage: throwingStorage });
    assert.equal(env.getOrCreateSessionId(), null);
  });
});
