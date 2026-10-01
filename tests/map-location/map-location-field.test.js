// map-location-field.js: the form-field controller shared by add-property.html
// and edit-listing.html. The browser behaviour is covered by map-forms.spec.js;
// this pins the pure rules, above all "an untouched field is never rewritten".
const { test } = require('node:test');
const assert = require('node:assert');

globalThis.PintagMapLocation = require('../../map-location.js');
const F = require('../../map-location-field.js');

const PLACE = 'https://www.google.com/maps?q=Lao+Plaza&ftid=0x1a:0x2b';
const EXACT = 'https://www.google.com/maps?q=17.9757,102.6331';

function fakeField() {
  const listeners = {};
  const input = { value: '', addEventListener: (n, f) => { listeners[n] = f; } };
  const attrs = {};
  const hint = { textContent: '', style: {}, setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] };
  return { input, hint, listeners };
}

test('changeFor: null until the listing has loaded (a failed load can never overwrite the link)', () => {
  const { input, hint } = fakeField();
  const c = F.attach({ input, hint });
  input.value = EXACT;
  assert.strictEqual(c.changeFor(), null);
});
test('changeFor: null while the value equals what is stored (whitespace ignored)', () => {
  const { input, hint } = fakeField();
  const c = F.attach({ input, hint });
  c.setOriginal(PLACE);
  assert.strictEqual(c.changeFor(), null);
  input.value = '  ' + PLACE + '  ';
  assert.strictEqual(c.changeFor(), null);
});
test('changeFor: reports a real change, a clearing, and treats null-stored like empty', () => {
  const a = fakeField(); const c = F.attach(a);
  c.setOriginal(PLACE);
  a.input.value = EXACT;
  assert.deepStrictEqual(c.changeFor(), { value: EXACT, clearing: false });
  a.input.value = '   ';
  assert.deepStrictEqual(c.changeFor(), { value: null, clearing: true });

  const b = fakeField(); const d = F.attach(b);
  d.setOriginal(null);
  assert.strictEqual(d.changeFor(), null);               // blank stays blank: nothing to send
  b.input.value = PLACE;
  assert.deepStrictEqual(d.changeFor(), { value: PLACE, clearing: false });
});
test('value(): trimmed, or null when blank (the add page inserts NULL for no link)', () => {
  const { input, hint } = fakeField();
  const c = F.attach({ input, hint });
  assert.strictEqual(c.value(), null);
  input.value = '  ' + EXACT + ' ';
  assert.strictEqual(c.value(), EXACT);
});
test('hint states: empty / exact / place / invalid', () => {
  const { input, hint, listeners } = fakeField();
  F.attach({ input, hint });
  assert.strictEqual(hint.getAttribute('data-map-state'), 'empty');
  for (const [v, s] of [[EXACT, 'exact'], [PLACE, 'place'], ['https://www.google.com/maps?q=apartments', 'invalid'], ['', 'empty']]) {
    input.value = v; listeners.input();
    assert.strictEqual(hint.getAttribute('data-map-state'), s, v);
  }
});
test('short link: resolved through resolve-map-url with the session token, then re-classified', async () => {
  const { input, hint, listeners } = fakeField();
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ resolved_url: PLACE }) }; };
  const c = F.attach({ input, hint, supabaseUrl: 'https://x.supabase.co', anonKey: 'anon', getToken: async () => 'tok' });
  input.value = 'https://maps.app.goo.gl/abc'; listeners.blur();
  await c.pending();
  assert.strictEqual(seen.url, 'https://x.supabase.co/functions/v1/resolve-map-url');
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer tok');
  assert.strictEqual(input.value, PLACE);
  assert.strictEqual(c.state(), 'place');
});
test('short link: a resolver failure is reported as invalid and the typed link is kept', async () => {
  const { input, hint, listeners } = fakeField();
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({ error: 'did not redirect' }) });
  const c = F.attach({ input, hint, supabaseUrl: 'https://x.supabase.co', anonKey: 'anon' });
  input.value = 'https://maps.app.goo.gl/abc'; listeners.blur();
  await c.pending();
  assert.strictEqual(input.value, 'https://maps.app.goo.gl/abc');
  assert.strictEqual(c.state(), 'invalid');
  assert.ok(hint.textContent.includes('did not redirect'));
});
test('short link: a stale resolution never overwrites a field the user has since changed', async () => {
  const { input, hint, listeners } = fakeField();
  let release;
  globalThis.fetch = () => new Promise((res) => { release = () => res({ ok: true, status: 200, json: async () => ({ resolved_url: PLACE }) }); });
  const c = F.attach({ input, hint, supabaseUrl: 'https://x.supabase.co', anonKey: 'anon' });
  input.value = 'https://maps.app.goo.gl/abc'; listeners.blur();
  input.value = EXACT;                                   // the user moved on
  release();
  await c.pending();
  assert.strictEqual(input.value, EXACT);
});
test('the helper makes no geocoding or non-resolver requests', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'map-location-field.js'), 'utf8');
  assert.ok(src.includes('/functions/v1/resolve-map-url'));
  for (const bad of ['nominatim', 'geocode', 'maps.googleapis', 'XMLHttpRequest', 'sendBeacon']) assert.ok(!src.includes(bad), bad);
  assert.strictEqual((src.match(/fetch\(/g) || []).length, 1);
});
