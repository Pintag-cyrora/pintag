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


// ═════════════════════════════════════════════════════════════════════════
// Named places + the newer exact formats (classifyMapUrl)
//
// Two invariants carry everything below:
//   1. Every link that parsed (or was refused) before still parses (or is
//      refused) IDENTICALLY -- the golden tables were produced by the previous
//      implementation, not written by hand.
//   2. A named place NEVER carries a latitude/longitude. It is a place, not a pin.
// ═════════════════════════════════════════════════════════════════════════
const fs = require('node:fs');
const path = require('node:path');

// [url, lat, lng, pattern] -- recorded from the implementation before place support.
const GOLDEN_EXACT = [
  ["https://www.google.com/maps/place/Patuxai/@17.9800000,102.6250000,17z/data=!3m1!4b1!4m6!3m5!1s0x1!8m2!3d17.9757!4d102.6180!16s%2Fg%2F1", 17.9757, 102.618, "place-pin(!3d/!4d)"],
  ["https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3785!2d102.6488!3d17.9757!2m3!1f0", 17.9757, 102.6488, "embed-pb(!2d/!3d)"],
  ["https://www.google.com/maps?q=17.9585,102.5978", 17.9585, 102.5978, "query-param"],
  ["https://www.google.com/maps?q=17.9585%2C102.5978", 17.9585, 102.5978, "query-param"],
  ["https://www.google.com/maps?q=17.975706,102.633104&entry=gps", 17.975706, 102.633104, "query-param"],
  ["https://www.google.com/maps/search/?api=1&query=17.9883%2C102.5633", 17.9883, 102.5633, "query-param"],
  ["https://www.google.com/maps/search/17.97,102.63", 17.97, 102.63, "path-coords"],
  ["https://www.google.com/maps/@18.0433,102.7167,16z", 18.0433, 102.7167, "camera(@)"],
  ["https://www.google.com/maps/place/17.9757,102.6331", 17.9757, 102.6331, "camera(@)"],
  ["https://www.google.com/maps/place/X/@17.8869,102.7539,17z/data=!4m2!3m1!8m2!3d17.8869!4d102.7539", 17.8869, 102.7539, "place-pin(!3d/!4d)"],
  ["https://www.google.com/maps/dir/?api=1&destination=17.9757,102.6331", 17.9757, 102.6331, "query-param"],
  ["https://maps.google.com/maps?ll=17.9757,102.6331&z=15", 17.9757, 102.6331, "query-param"],
  ["https://www.google.com/maps/place/Wat+That+Luang/@17.9757,102.635,17z/", 17.9757, 102.635, "camera(@)"],
  ["https://www.google.com/maps/d/embed?mid=1AbCdEf&ll=17.97,102.63&z=14", 17.97, 102.63, "query-param"]
];
// [url, reason]
const GOLDEN_INVALID = [
  ["https://www.google.com/maps?q=102.6113961,17.9615743", "reversed-coordinates"],
  ["https://www.google.com/maps?q=0,0", "outside-bounds"],
  ["https://www.google.com/maps?q=200.5,300.5", "out-of-range"],
  ["https://www.google.com/maps?q=48.8566,2.3522", "outside-bounds"],
  ["https://maps.app.goo.gl/abc", "unresolved-short-link"],
  ["https://goo.gl/maps/abc", "unresolved-short-link"],
  ["https://www.google.com/maps/place/Vientiane+Center", "no-coordinates"],
  ["https://www.google.com/maps?q=apartments+in+Vientiane", "no-coordinates"],
  ["not a url", "not-a-url"],
  ["", "no-url"],
  [null, "no-url"]
];

test('REGRESSION: every previously-exact link is still exact, with the same coordinate and pattern', () => {
  for (const [url, lat, lng, pattern] of GOLDEN_EXACT) {
    ok(url, lat, lng, pattern);
    const c = M.classifyMapUrl(url);
    assert.strictEqual(c.type, 'exact', url);
    assert.strictEqual(c.lat, lat);
    assert.strictEqual(c.lng, lng);
  }
});
test('REGRESSION: every previously-refused link is still refused, for the same reason', () => {
  for (const [url, reason] of GOLDEN_INVALID) {
    fails(url, reason);
    const c = M.classifyMapUrl(url);
    assert.strictEqual(c.type, 'invalid', String(url));
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.reason, reason);
  }
});
test('REGRESSION: the exact parse beats a place id -- a link with both is an exact pin', () => {
  const r = M.classifyMapUrl('https://www.google.com/maps?q=17.9,102.6&ftid=0x3123456789abcdef:0x7f9e8d7c6b5a4f3e');
  assert.strictEqual(r.type, 'exact');
  assert.strictEqual(r.lat, 17.9);
  assert.strictEqual(r.lng, 102.6);
});

// ── newer deterministic exact formats ────────────────────────────────────
function exactVia(url, lat, lng, pattern) {
  const c = M.classifyMapUrl(url);
  assert.strictEqual(c.type, 'exact', `${url} -> ${c.type}/${c.reason}`);
  assert.ok(Math.abs(c.lat - lat) < 1e-9, `lat ${c.lat} != ${lat}`);
  assert.ok(Math.abs(c.lng - lng) < 1e-9, `lng ${c.lng} != ${lng}`);
  if (pattern) assert.strictEqual(c.pattern, pattern);
  // and the backward-compatible wrapper agrees
  const p = M.parseMapUrl(url);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.lat, c.lat);
  assert.strictEqual(p.lng, c.lng);
}
test('?q=lat, lng (a space after the comma) is an exact coordinate', () => {
  exactVia('https://www.google.com/maps?q=17.9757, 102.6331', 17.9757, 102.6331, 'query-param(loose)');
  exactVia('https://www.google.com/maps?q=17.9757,%20102.6331', 17.9757, 102.6331);
  exactVia('https://www.google.com/maps?q=17.9757%2C%20102.6331', 17.9757, 102.6331);
});
test('?q=lat+lng (plus-separated) is an exact coordinate', () => {
  exactVia('https://www.google.com/maps?q=17.9757+102.6331', 17.9757, 102.6331, 'query-param(loose)');
  exactVia('https://www.google.com/maps?query=17.9757%20102.6331', 17.9757, 102.6331);
});
test('?q=loc:lat,lng is an exact coordinate, plain or percent-encoded', () => {
  exactVia('https://www.google.com/maps?q=loc:17.9757,102.6331', 17.9757, 102.6331);
  exactVia('https://www.google.com/maps?q=loc%3A17.9757%2C102.6331', 17.9757, 102.6331);
  exactVia('https://www.google.com/maps?q=loc:17.9757+102.6331', 17.9757, 102.6331);
});
test('/place/lat+lng and /place/lat,+lng are exact coordinates', () => {
  exactVia('https://www.google.com/maps/place/17.9757+102.6331', 17.9757, 102.6331, 'place-coords');
  exactVia('https://www.google.com/maps/place/17.9757,+102.6331', 17.9757, 102.6331, 'place-coords');
});
test('/place/ DMS (17°58\'32.4"N 102°37\'50.1"E) is converted by arithmetic, not looked up', () => {
  const url = 'https://www.google.com/maps/place/17%C2%B058%2732.4%22N+102%C2%B037%2750.1%22E';
  exactVia(url, 17 + 58 / 60 + 32.4 / 3600, 102 + 37 / 60 + 50.1 / 3600, 'place-dms');
  // southern / western hemispheres flip the sign (inside Laos bounds only for N/E; checked via the verdict)
  const south = M.classifyMapUrl('https://www.google.com/maps/place/17%C2%B058%2732.4%22S+102%C2%B037%2750.1%22E');
  assert.strictEqual(south.type, 'invalid');      // -17.97 is nowhere near Laos
});
test('a DMS link that also carries a camera keeps the ORIGINAL behaviour (camera wins, as before)', () => {
  ok('https://www.google.com/maps/place/17%C2%B058%2732.4%22N+102%C2%B037%2750.1%22E/@17.9756,102.6306,17z', 17.9756, 102.6306, 'camera(@)');
});

test('the newer formats are conservative: ambiguity is refused, not guessed', () => {
  const refused = [
    'https://www.google.com/maps?q=17+102',                       // two bare integers: a house and a unit number, not a point
    'https://www.google.com/maps?q=17.9757+102',                  // one number lacks a decimal
    'https://www.google.com/maps?q=apartment+17.9757+102.6331',   // coordinates inside free text
    'https://www.google.com/maps?q=17.9757+102.6331+Vientiane',   // trailing text
    'https://www.google.com/maps?foo=17.9757,%20102.6331',       // not a coordinate parameter
    'https://www.google.com/maps/place/Room+17.9757+102.6331',    // name that contains numbers
    'https://www.google.com/maps/place/102%C2%B037%2750.1%22E+17%C2%B058%2732.4%22N',  // longitude first
    'https://www.google.com/maps/place/17%C2%B075%2732.4%22N+102%C2%B037%2750.1%22E',  // 75 minutes
    'https://www.google.com/maps/place/17%C2%B058%2775%22N+102%C2%B037%2750.1%22E',    // 75 seconds
    'https://www.google.com/maps/place/17%C2%B058%2732.4%22+102%C2%B037%2750.1%22',    // no hemisphere letters
  ];
  for (const u of refused) {
    const c = M.classifyMapUrl(u);
    assert.strictEqual(c.type, 'invalid', `${u} should be refused, got ${c.type}`);
    assert.strictEqual(c.ok, false);
    assert.ok(!('lat' in c) && !('lng' in c), u);
  }
});
test('the newer formats go through the SAME bounds checks: reversed, out-of-range, outside Laos are refused', () => {
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?q=102.6331, 17.9757').reason, 'reversed-coordinates');
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?q=102.6331+17.9757').reason, 'reversed-coordinates');
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?q=loc:200.5,300.5').reason, 'out-of-range');
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?q=48.8566, 2.3522').reason, 'outside-bounds');
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps/place/0.0+0.0').reason, 'outside-bounds');
  assert.strictEqual(M.parseMapUrl('https://www.google.com/maps?q=48.8566, 2.3522').ok, false);
});

// ── named Google Maps places ─────────────────────────────────────────────
const PLACE_ID = '0x3123456789abcdef:0x7f9e8d7c6b5a4f3e';
const SHARE = 'https://www.google.com/maps?q=Lao+Plaza+Hotel,+23+Singha+Road,+Vientiane&ftid=' + PLACE_ID +
              '&entry=gps&g_ep=EgoyMDI2MDkyMS4wIKXMDSoASAFQAw%3D%3D&skid=0f4f6c8a-1111-2222-3333-444455556666';

test('a Google "Share place" link (ftid) is a PLACE: id, label and original URL, no coordinates', () => {
  const c = M.classifyMapUrl(SHARE);
  assert.strictEqual(c.type, 'place');
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.reason, 'place-only');
  assert.strictEqual(c.placeId, PLACE_ID);
  assert.strictEqual(c.label, 'Lao Plaza Hotel, 23 Singha Road, Vientiane');
  assert.strictEqual(c.url, SHARE);                                  // the original, untouched
});
test('INVARIANT: a place never carries a latitude or longitude, in any API', () => {
  const c = M.classifyMapUrl(SHARE);
  assert.ok(!('lat' in c) && !('lng' in c));
  const p = M.parseMapUrl(SHARE);
  assert.strictEqual(p.ok, false);
  assert.ok(!('lat' in p) && !('lng' in p));
  assert.strictEqual(p.reason, 'place-only');
  assert.deepStrictEqual(p.place, { placeId: PLACE_ID, label: 'Lao Plaza Hotel, 23 Singha Road, Vientiane', url: SHARE });
  assert.ok(/named Google Maps place/.test(M.describeFailure(p)));
});
test('place id is lower-cased and must be a real ftid (0x..:0x..)', () => {
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?q=X&ftid=0XABC:0XDEF').placeId, '0xabc:0xdef');
  for (const bad of ['0x123', 'abc', '0x:0x', '0x12:', ':0x12', '0x12:0xZZ', '', '0x12:0x34 ; drop']) {
    const c = M.classifyMapUrl('https://www.google.com/maps?q=X&ftid=' + encodeURIComponent(bad));
    assert.strictEqual(c.type, 'invalid', 'ftid=' + bad);
  }
});
test('place label: decoded, whitespace-collapsed, control characters removed, Lao text preserved, optional', () => {
  const lao = M.classifyMapUrl('https://www.google.com/maps?q=' + encodeURIComponent('ໂຮງແຮມ ລາວພລາຊາ, ວຽງຈັນ') + '&ftid=' + PLACE_ID);
  assert.strictEqual(lao.label, 'ໂຮງແຮມ ລາວພລາຊາ, ວຽງຈັນ');
  const messy = M.classifyMapUrl('https://www.google.com/maps?q=A%20%20%09B%0A+C&ftid=' + PLACE_ID);
  assert.strictEqual(messy.label, 'A B C');
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?ftid=' + PLACE_ID).label, null);
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?ftid=' + PLACE_ID).type, 'place');
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?q=' + 'x'.repeat(201) + '&ftid=' + PLACE_ID).label, null);
});
test('a label is data, not markup: it is returned verbatim for the caller to escape', () => {
  const c = M.classifyMapUrl('https://www.google.com/maps?q=' + encodeURIComponent('<img src=x onerror=alert(1)>') + '&ftid=' + PLACE_ID);
  assert.strictEqual(c.type, 'place');
  assert.strictEqual(c.label, '<img src=x onerror=alert(1)>');
});
test('maps.google.com and country domains are recognised; other hosts are not', () => {
  assert.strictEqual(M.classifyMapUrl('https://maps.google.com/?q=X&ftid=' + PLACE_ID).type, 'place');
  assert.strictEqual(M.classifyMapUrl('https://www.google.co.th/maps?q=X&ftid=' + PLACE_ID).type, 'place');
  assert.strictEqual(M.classifyMapUrl('http://www.google.com/maps?q=X&ftid=' + PLACE_ID).type, 'place');
  for (const host of ['example.com', 'google.com.evil.com', 'evilgoogle.com', 'maps.google.com.evil.io']) {
    assert.strictEqual(M.classifyMapUrl('https://' + host + '/maps?q=X&ftid=' + PLACE_ID).type, 'invalid', host);
  }
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/search?q=X&ftid=' + PLACE_ID).type, 'invalid');   // not a maps URL
});
test('a generic Google search is NOT a place', () => {
  for (const u of [
    'https://www.google.com/maps?q=apartments+in+Vientiane',
    'https://www.google.com/maps/search/apartments+in+Vientiane',
    'https://www.google.com/maps/search/?api=1&query=Lao+Plaza+Hotel',
    'https://www.google.com/maps/place/Lao+Plaza+Hotel',               // a name with no place id is still only a name search
    'https://www.google.com/maps?cid=9162884456237591102',             // not ftid: out of scope here
    'https://www.google.com/maps?q=X&query_place_id=ChIJabc',
  ]) {
    const c = M.classifyMapUrl(u);
    assert.strictEqual(c.type, 'invalid', u);
    assert.strictEqual(c.reason, 'no-coordinates', u);
  }
});
test('malformed place links are refused', () => {
  assert.strictEqual(M.classifyMapUrl('www.google.com/maps?q=X&ftid=' + PLACE_ID).type, 'invalid');                // no scheme
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?q=X&ftid=').type, 'invalid');                    // empty id
  assert.strictEqual(M.classifyMapUrl('https://www.google.com/maps?q=X&ftid=0x1:0x2:0x3').type, 'invalid');        // wrong shape
  assert.strictEqual(M.classifyMapUrl('ftid=' + PLACE_ID).type, 'invalid');
  assert.strictEqual(M.classifyMapUrl('<iframe src="https://www.google.com/maps?ftid=' + PLACE_ID + '"></iframe>').type, 'invalid');
});
test('a short link stays an unresolved short link even if it carries an ftid-looking parameter', () => {
  const c = M.classifyMapUrl('https://maps.app.goo.gl/AbCdEf?ftid=' + PLACE_ID);
  assert.strictEqual(c.type, 'invalid');
  assert.strictEqual(c.reason, 'unresolved-short-link');
});
test('place links never become exact pins -- across many shapes', () => {
  const labels = ['A', 'Hotel 17.9757', 'Name, 12 Road', 'ລາວ', 'x y z'];
  const extras = ['', '&entry=gps', '&hl=en', '&g_ep=abc', '&lucs=,94297699,94284468'];
  for (const l of labels) for (const e of extras) for (const host of ['www.google.com', 'maps.google.com']) {
    const u = 'https://' + host + '/maps?q=' + encodeURIComponent(l) + '&ftid=' + PLACE_ID + e;
    const c = M.classifyMapUrl(u);
    assert.strictEqual(c.type, 'place', u);
    assert.ok(!('lat' in c) && !('lng' in c), u);
    assert.strictEqual(M.parseMapUrl(u).ok, false, u);
  }
});
test('the parser makes no network calls and has no geocoding', () => {
  // Executable code only: the file's own comments legitimately mention fetch()
  // when explaining why short links cannot be expanded in the browser.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'map-location.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'import(', 'require(', 'nominatim', 'geocode', 'maps.googleapis']) {
    assert.ok(!src.includes(forbidden), 'map-location.js must not contain ' + forbidden);
  }
});
test('the geographic bounds are unchanged', () => {
  assert.deepStrictEqual(M.LAOS_BOUNDS, { minLat: 13.5, maxLat: 23.0, minLng: 99.5, maxLng: 108.5 });
});
