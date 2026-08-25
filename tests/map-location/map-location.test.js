// Unit tests for map-location.js — the Google Maps URL -> coordinate parser.
//
// The bug these guard against is not "the parser throws"; it is "the parser
// returns a confident, plausible, WRONG coordinate". So every assertion here
// is about the VALUE, and several are about refusing to answer at all.
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../map-location.js');

// A real Vientiane point: the Presidential Palace area, Chanthabouly.
const LAT = 17.9615743, LNG = 102.6113961;

function ok(url, lat, lng, pattern) {
  const r = M.parseMapUrl(url);
  assert.strictEqual(r.ok, true, `expected a coordinate from ${url}, got ${r.reason}: ${r.detail}`);
  assert.strictEqual(r.lat, lat);
  assert.strictEqual(r.lng, lng);
  if (pattern) assert.strictEqual(r.pattern, pattern);
  return r;
}
function fails(url, reason) {
  const r = M.parseMapUrl(url);
  assert.strictEqual(r.ok, false, `expected ${url} to be refused, got ${r.lat},${r.lng}`);
  assert.strictEqual(r.reason, reason);
  return r;
}

test('place URL: the PIN wins over the camera position', () => {
  // Google puts both in one URL and they are not the same point. @ is where
  // the viewport was; !3d/!4d is the place itself. Taking @ is how a pin ends
  // up a block away from the building, which is exactly what the old parser did.
  const url = 'https://www.google.com/maps/place/Presidential+Palace/@17.9600000,102.6100000,17z/' +
              'data=!3m1!4b1!4m6!3m5!1s0x312468bd8b1b1b1b:0xabc!8m2!3d17.9615743!4d102.6113961!16s%2Fg%2F1td';
  ok(url, LAT, LNG, 'place-pin(!3d/!4d)');
});

test('embed URL: !2d is LONGITUDE and !3d is LATITUDE, in that order', () => {
  // The regression test for the transposition. Reading these two in the order
  // they appear yields 102.6N 17.9E — off Laos entirely.
  const url = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3785.9!2d102.6113961!3d17.9615743' +
              '!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1';
  ok(url, LAT, LNG, 'embed-pb(!2d/!3d)');
});

test('?q=lat,lng is taken literally', () => {
  ok(`https://www.google.com/maps?q=${LAT},${LNG}`, LAT, LNG);
});

test('percent-encoded comma in a query parameter still parses', () => {
  ok(`https://www.google.com/maps/search/?api=1&query=${LAT}%2C${LNG}`, LAT, LNG);
});

test('camera-only URL is accepted, but only because nothing better is present', () => {
  ok(`https://www.google.com/maps/@${LAT},${LNG},17z`, LAT, LNG, 'camera(@)');
});

test('full precision survives — no rounding', () => {
  const r = ok(`https://www.google.com/maps?q=${LAT},${LNG}`, LAT, LNG);
  assert.strictEqual(String(r.lat), '17.9615743');
  assert.strictEqual(String(r.lng), '102.6113961');
});

// ── Refusals. Each of these previously produced a marker anyway. ──────────

test('short links are refused with a reason that names the real problem', () => {
  // These are the 29 links production actually stores. They are valid links to
  // the right place; they simply carry no coordinate, and a browser cannot
  // follow the redirect (CORS makes the target opaque). Calling this
  // "unresolved" rather than "broken" is what tells an operator to re-save.
  for (const u of [
    'https://maps.app.goo.gl/yWXt9tEM7d4HBJFh7?g_st=com.google.maps.preview.copy',
    'https://maps.app.goo.gl/duPW1hq3Bb23EwPi7?g_st=ic',
    'https://goo.gl/maps/WVSgJX2J2xtiAWX18'
  ]) fails(u, 'unresolved-short-link');
});

test('a transposed pair is refused and NAMED, not silently swapped', () => {
  // Swapping it would also "repair" a coordinate that was simply wrong, and we
  // would never learn which. 102.6N does not exist as a latitude in Laos.
  const r = fails(`https://www.google.com/maps?q=${LNG},${LAT}`, 'reversed-coordinates');
  assert.match(r.detail, /transposed/);
});

test('a coordinate outside Laos is refused rather than plotted', () => {
  fails('https://www.google.com/maps?q=48.8584,2.2945', 'outside-bounds');
});

test('an impossible coordinate is refused', () => {
  fails('https://www.google.com/maps?q=917.9615743,102.6113961', 'out-of-range');
});

test('a Google Maps URL with no coordinate anywhere is refused', () => {
  fails('https://www.google.com/maps/place/Vientiane', 'no-coordinates');
});

test('null / blank / non-URL are each refused distinctly', () => {
  fails(null, 'no-url');
  fails('', 'no-url');
  fails('   ', 'no-url');
  fails('Vientiane, Laos', 'not-a-url');
});

test('THE REGRESSION: nothing yields a default or district coordinate', () => {
  // The old getLatLng() answered every one of these with MAP_CENTER plus
  // random jitter. If any of them ever returns ok:true again, the map is
  // lying to visitors.
  for (const u of [null, '', 'https://maps.app.goo.gl/abc', 'https://www.google.com/maps/place/X']) {
    assert.strictEqual(M.parseMapUrl(u).ok, false, `${u} must not resolve`);
  }
});

test('parsing is deterministic — the same URL always gives the same point', () => {
  // The old implementation used Math.random(), so a marker moved on every
  // re-render (every filter change). Two calls must be identical.
  const u = `https://www.google.com/maps?q=${LAT},${LNG}`;
  assert.deepStrictEqual(M.parseMapUrl(u), M.parseMapUrl(u));
});

test('isShortLink recognises the hosts that need server-side expansion', () => {
  assert.ok(M.isShortLink('https://maps.app.goo.gl/abc'));
  assert.ok(M.isShortLink('https://goo.gl/maps/abc'));
  assert.ok(!M.isShortLink('https://www.google.com/maps/place/X/@1,2,17z'));
  assert.ok(!M.isShortLink('https://evil.example.com/maps.app.goo.gl/abc'));
});
