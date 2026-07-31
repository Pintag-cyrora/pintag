import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// lang.js reads window.location/localStorage/navigator/history -- none of
// which exist in a plain Node vm context, so each test builds a small fake
// global environment (matching the existing vm-sandbox convention used by
// rental-terms.test.js etc., extended here since this is the first file in
// that convention needing browser globals beyond plain object/array logic).
function loadLangModule(env) {
  const src = fs.readFileSync(new URL('./lang.js', import.meta.url), 'utf8');
  const href = env.href || 'https://pintag.io/';
  const sandbox = {
    URLSearchParams,
    URL,
    window: { location: { href, search: new URL(href).search } },
    localStorage: env.localStorage || { getItem: () => null, setItem: () => {} },
    navigator: env.navigator || {},
    history: env.history || { replaceState: () => {} },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'lang.js' });
  return sandbox;
}

function fakeStorage(initial) {
  const store = Object.assign({}, initial);
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    _store: store
  };
}

describe('resolvePintagLang precedence', () => {
  test('1. explicit ?lang= wins over everything else', () => {
    const env = loadLangModule({
      href: 'https://pintag.io/listings.html?lang=zh',
      localStorage: fakeStorage({ pintag_lang: 'en' }),
      navigator: { languages: ['fr-FR'] }
    });
    assert.equal(env.resolvePintagLang(), 'zh');
  });

  test('invalid ?lang= value is ignored, falls through to next tier', () => {
    const env = loadLangModule({
      href: 'https://pintag.io/listings.html?lang=xx',
      localStorage: fakeStorage({ pintag_lang: 'en' })
    });
    assert.equal(env.resolvePintagLang(), 'en');
  });

  test('2. persisted preference wins when no ?lang=', () => {
    const env = loadLangModule({
      href: 'https://pintag.io/listings.html',
      localStorage: fakeStorage({ pintag_lang: 'zh' }),
      navigator: { languages: ['en-US'] }
    });
    assert.equal(env.resolvePintagLang(), 'zh');
  });

  test('3. browser language wins when no ?lang= and no persisted pref', () => {
    const env = loadLangModule({
      href: 'https://pintag.io/listings.html',
      localStorage: fakeStorage({}),
      navigator: { languages: ['en-US', 'en'] }
    });
    assert.equal(env.resolvePintagLang(), 'en');
  });

  test('browser language matches by prefix (zh-CN -> zh)', () => {
    const env = loadLangModule({
      href: 'https://pintag.io/',
      navigator: { languages: ['zh-CN'] }
    });
    assert.equal(env.resolvePintagLang(), 'zh');
  });

  test('browser language falls through unsupported languages to next candidate', () => {
    const env = loadLangModule({
      href: 'https://pintag.io/',
      navigator: { languages: ['fr-FR', 'de-DE', 'lo-LA'] }
    });
    assert.equal(env.resolvePintagLang(), 'lo');
  });

  test('4. default lo when nothing else resolves', () => {
    const env = loadLangModule({
      href: 'https://pintag.io/',
      navigator: { languages: ['fr-FR'] }
    });
    assert.equal(env.resolvePintagLang(), 'lo');
  });

  test('default lo is never a hardcoded override -- browser language still wins when present', () => {
    const env = loadLangModule({
      href: 'https://pintag.io/',
      navigator: { languages: ['en-GB'] }
    });
    assert.notEqual(env.resolvePintagLang(), 'lo');
    assert.equal(env.resolvePintagLang(), 'en');
  });
});

describe('persistPintagLang', () => {
  test('writes to localStorage under the shared key', () => {
    const storage = fakeStorage({});
    const env = loadLangModule({ localStorage: storage });
    env.persistPintagLang('zh');
    assert.equal(storage._store.pintag_lang, 'zh');
  });
});

describe('reflectLangInUrl', () => {
  test('sets ?lang= via history.replaceState when missing', () => {
    let replaced = null;
    const env = loadLangModule({
      href: 'https://pintag.io/listings.html',
      history: { replaceState: (_s, _t, url) => { replaced = url; } }
    });
    env.reflectLangInUrl('en');
    assert.ok(replaced, 'replaceState was called');
    assert.equal(new URL(replaced).searchParams.get('lang'), 'en');
  });

  test('is a no-op when the URL already has the matching value', () => {
    let calls = 0;
    const env = loadLangModule({
      href: 'https://pintag.io/listings.html?lang=en',
      history: { replaceState: () => { calls++; } }
    });
    env.reflectLangInUrl('en');
    assert.equal(calls, 0);
  });

  test('overwrites a mismatched existing ?lang=', () => {
    let replaced = null;
    const env = loadLangModule({
      href: 'https://pintag.io/listings.html?lang=zh',
      history: { replaceState: (_s, _t, url) => { replaced = url; } }
    });
    env.reflectLangInUrl('en');
    assert.equal(new URL(replaced).searchParams.get('lang'), 'en');
  });
});
