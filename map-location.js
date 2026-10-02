// map-location.js — the ONE place a Google Maps URL is turned into coordinates.
//
// The listing's Google Maps link is the source of truth for where a property
// is. There is no separate coordinate model to drift from it: properties has
// latitude/longitude columns, but they are NULL across the board and nothing
// writes them, so reading them would only invent a second, staler answer to a
// question the link already answers.
//
// WHY THIS FILE EXISTS
// Two copies of this parsing lived in the codebase and disagreed with each
// other -- listings.html read a column that does not exist (properties.map_url,
// 42703) and listing.html paired !3d with !2d, which reverses latitude and
// longitude on an embed URL. Both are the kind of bug that produces a
// confident-looking pin in the wrong place, which is worse than no pin.
//
// THE RULES THIS ENCODES
//   1. Only a coordinate that came out of the link counts. There is no
//      district centroid, no city default, no jitter. A listing whose link
//      cannot be resolved is REPORTED, never approximated -- a marker at a
//      plausible-but-invented location is a lie the visitor cannot detect.
//   2. Google writes the same coordinate in several places in one URL and they
//      are not equally trustworthy, so the patterns are tried in order of
//      authority (the place pin first, the camera position last) rather than in
//      whatever order matches first.
//   3. Every candidate is range-checked and bounds-checked before it is
//      accepted. A reversed pair is detected and rejected with a named reason,
//      not silently swapped -- silently swapping would also "fix" a genuinely
//      wrong coordinate into a different wrong coordinate.
//   4. Nothing is rounded. Google gives 7 decimal places (~1cm); truncating to
//      4 (~11m) would visibly drift a pin off its building.
//   5. Two kinds of usable location, never confused. EXACT is a coordinate that
//      came out of the link. PLACE is a Google "Share place" link (ftid + label)
//      that names one place but carries NO coordinates: it is reported as a place,
//      keeps its original URL as the destination, and never gains a lat/lng --
//      no geocoding, no network, no centroid. classifyMapUrl() is the entry point;
//      parseMapUrl() keeps its original contract (ok means "has a coordinate").
(function (global) {
  'use strict';

  // Laos, generously bounded. This is a sanity check on the PARSE, not a
  // business rule about where Pintag may list: it catches a coordinate that
  // came out of the wrong capture group or a URL that never held a coordinate
  // at all. A listing genuinely outside these bounds is reported as
  // out-of-bounds rather than silently plotted, which is the correct outcome
  // for a link nobody expected.
  var LAOS_BOUNDS = { minLat: 13.5, maxLat: 23.0, minLng: 99.5, maxLng: 108.5 };

  // Hosts whose links carry no coordinate and must be expanded first. A short
  // link CANNOT be resolved in the browser: the redirect target is opaque to
  // fetch() under CORS, so following it is a server-side job (the
  // resolve-map-url edge function, called by admin.html when the link is
  // pasted). Recognising them by name is what lets the map say "this one needs
  // resolving" instead of "this one is broken".
  var SHORT_LINK_HOSTS = ['maps.app.goo.gl', 'goo.gl', 'g.co'];

  function isShortLink(url) {
    if (typeof url !== 'string') return false;
    var m = url.match(/^https?:\/\/([^/?#]+)/i);
    if (!m) return false;
    var host = m[1].toLowerCase();
    for (var i = 0; i < SHORT_LINK_HOSTS.length; i++) {
      if (host === SHORT_LINK_HOSTS[i]) return true;
    }
    return false;
  }

  // Ordered most-authoritative first. Each entry names which capture group is
  // latitude, because THAT is the detail the two previous implementations got
  // wrong: Google emits longitude before latitude in the embed parameter block
  // and latitude before longitude in the place-pin block.
  var PATTERNS = [
    {
      // The place PIN. In a resolved /maps/place/ URL the data segment ends
      // !8m2!3d<lat>!4d<lng> -- this is the marker Google itself drops, and it
      // is the only value that is guaranteed to be the PLACE rather than the
      // view. Highest authority.
      name: 'place-pin(!3d/!4d)',
      re: /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
      lat: 1, lng: 2
    },
    {
      // The EMBED parameter block: ...!2d<lng>!3d<lat>... Longitude comes
      // FIRST here. The old listing.html regex read these two as (lat,lng) in
      // the order it found them, which reverses the pair -- a Vientiane
      // listing at 17.97N 102.63E became 102.63N 17.97E, off the planet's
      // usable range entirely and clamped to nonsense by Leaflet.
      name: 'embed-pb(!2d/!3d)',
      re: /!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/,
      lat: 2, lng: 1
    },
    {
      // Explicit coordinate parameters. These are unambiguous when present:
      // the author asked for exactly this point.
      name: 'query-param',
      re: /[?&](?:q|query|ll|center|destination|daddr|sll)=(-?\d+(?:\.\d+)?)%2C(-?\d+(?:\.\d+)?)/i,
      lat: 1, lng: 2
    },
    {
      name: 'query-param',
      re: /[?&](?:q|query|ll|center|destination|daddr|sll)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
      lat: 1, lng: 2
    },
    {
      // /maps/search/17.97,102.63 and /maps/dir//17.97,102.63
      name: 'path-coords',
      re: /\/maps\/(?:search|dir\/?)\/(?:[^/]*\/)?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
      lat: 1, lng: 2
    },
    {
      // The CAMERA: /@<lat>,<lng>,<zoom>z. Deliberately LAST. On a /place/
      // URL this is where the viewport was centred when the link was made,
      // which is near the pin but not the pin -- and on a link created while
      // scrolled away from the place it can be a street or two off. It is a
      // correct answer only when nothing more authoritative is present.
      name: 'camera(@)',
      re: /[/@](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,[\d.]+[a-z])?/,
      lat: 1, lng: 2
    }
  ];

  function inBounds(lat, lng) {
    return lat >= LAOS_BOUNDS.minLat && lat <= LAOS_BOUNDS.maxLat &&
           lng >= LAOS_BOUNDS.minLng && lng <= LAOS_BOUNDS.maxLng;
  }

  // Returns one of:
  //   { ok:true,  lat, lng, pattern }
  //   { ok:false, reason, detail }
  //
  // reason is a stable machine-readable code so a caller can treat "we have no
  // link yet" differently from "the link is broken" -- the first is an
  // ordinary gap in the data, the second is a defect somebody must fix.
  function parseExactCore(url) {
    if (url === null || url === undefined || url === '') {
      return { ok: false, reason: 'no-url', detail: 'listing has no Google Maps link' };
    }
    if (typeof url !== 'string') {
      return { ok: false, reason: 'not-a-string', detail: typeof url };
    }
    var trimmed = url.trim();
    if (!trimmed) {
      return { ok: false, reason: 'no-url', detail: 'blank string' };
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      return { ok: false, reason: 'not-a-url', detail: trimmed.slice(0, 80) };
    }
    if (isShortLink(trimmed)) {
      // Not an error in the link -- an error in the DATA PIPELINE. The link is
      // valid and points at the right place; it simply has not been expanded
      // yet, and only a server can expand it.
      return { ok: false, reason: 'unresolved-short-link', detail: trimmed };
    }

    for (var i = 0; i < PATTERNS.length; i++) {
      var p = PATTERNS[i];
      var m = trimmed.match(p.re);
      if (!m) continue;
      var lat = parseFloat(m[p.lat]);
      var lng = parseFloat(m[p.lng]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      if (inBounds(lat, lng)) {
        return { ok: true, lat: lat, lng: lng, pattern: p.name };
      }

      // Reversal is the classic failure here, so it is diagnosed BEFORE the
      // generic range check -- a transposed Vientiane pair has a latitude of
      // 102.6, which "not a point on Earth" describes accurately but
      // unhelpfully. The transposed case is checked first precisely because
      // it is the one an operator can act on.
      //
      // It is still REJECTED, not swapped. Swapping would also silently
      // "correct" a coordinate that was simply wrong into a different wrong
      // coordinate, and a confident pin in the wrong place is the exact
      // outcome this file exists to prevent.
      if (inBounds(lng, lat)) {
        return {
          ok: false, reason: 'reversed-coordinates',
          detail: p.name + ' matched ' + lat + ',' + lng + ' (lat/lng appear transposed)'
        };
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return {
          ok: false, reason: 'out-of-range',
          detail: p.name + ' matched ' + lat + ',' + lng
        };
      }
      return {
        ok: false, reason: 'outside-bounds',
        detail: p.name + ' matched ' + lat + ',' + lng
      };
    }

    return { ok: false, reason: 'no-coordinates', detail: trimmed.slice(0, 120) };
  }


  // ── The newer deterministic coordinate formats ────────────────────────────
  // Tried ONLY when none of the original patterns above matched the URL at all,
  // so every link that parsed (or was rejected) before parses (or is rejected)
  // identically now. Each one is a whole-value match, not a search inside free
  // text: "apartments 17.9 102.6" is a search, not a coordinate.

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }
  // Query-string values: '+' is a space, then percent-decoding.
  function formDecode(s) { return safeDecode(String(s).replace(/\+/g, ' ')); }

  var NUM = '(-?\\d+(?:\\.\\d+)?)';
  var COMMA_PAIR = new RegExp('^\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*$');
  // Whitespace-only separation ("17.9757 102.6331", i.e. ?q=lat+lng) is only
  // accepted when BOTH numbers carry a decimal point: two bare integers could be
  // a house number and a unit number, and guessing there is how a wrong pin is made.
  var SPACE_PAIR = new RegExp('^\\s*(-?\\d+\\.\\d+)\\s+(-?\\d+\\.\\d+)\\s*$');
  var COORD_PARAMS = /^(?:q|query|ll|center|destination|daddr|sll)$/i;

  function pairFromText(text) {
    var t = String(text).replace(/^\s*loc:\s*/i, '');
    var m = t.match(COMMA_PAIR) || t.match(SPACE_PAIR);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  }

  // Degrees-minutes-seconds exactly as Google writes them into /place/ paths:
  // 17°58'32.4"N 102°37'50.1"E. Latitude (N/S) first, longitude (E/W) second,
  // minutes and seconds in range, hemisphere letters present -- anything else is
  // not parsed.
  var DMS = new RegExp(
    '^\\s*(\\d{1,3})\\s*\u00b0\\s*(\\d{1,2})\\s*[\'\u2032]\\s*(\\d{1,2}(?:\\.\\d+)?)\\s*(?:"|\u2033|\'\')?\\s*([NS])' +
    '[\\s,]+' +
    '(\\d{1,3})\\s*\u00b0\\s*(\\d{1,2})\\s*[\'\u2032]\\s*(\\d{1,2}(?:\\.\\d+)?)\\s*(?:"|\u2033|\'\')?\\s*([EW])\\s*$', 'i');
  function dmsPair(text) {
    var m = String(text).match(DMS);
    if (!m) return null;
    var latM = +m[2], latS = parseFloat(m[3]), lngM = +m[6], lngS = parseFloat(m[7]);
    if (latM > 59 || lngM > 59 || latS >= 60 || lngS >= 60) return null;
    var lat = +m[1] + latM / 60 + latS / 3600;
    var lng = +m[5] + lngM / 60 + lngS / 3600;
    if (/s/i.test(m[4])) lat = -lat;
    if (/w/i.test(m[8])) lng = -lng;
    return [lat, lng];
  }

  function pathAndQuery(trimmed) {
    var m = trimmed.match(/^https?:\/\/[^/?#]+([^?#]*)(?:\?([^#]*))?/i);
    return m ? { path: m[1] || '', query: m[2] || '' } : { path: '', query: '' };
  }

  // Candidate coordinate pairs from the newer formats, in order of authority:
  // explicit parameters first, then the /place/ path segment.
  function newFormatCandidate(trimmed) {
    var pq = pathAndQuery(trimmed);
    var parts = pq.query ? pq.query.split('&') : [];
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq < 0) continue;
      var key = formDecode(parts[i].slice(0, eq));
      if (!COORD_PARAMS.test(key)) continue;
      var pair = pairFromText(formDecode(parts[i].slice(eq + 1)));
      if (pair) return { name: 'query-param(loose)', lat: pair[0], lng: pair[1] };
    }
    var pm = pq.path.match(/\/maps\/place\/([^/]+)/i);
    if (pm) {
      var seg = formDecode(pm[1]);
      var d = dmsPair(seg);
      if (d) return { name: 'place-dms', lat: d[0], lng: d[1] };
      var p2 = pairFromText(seg);
      if (p2) return { name: 'place-coords', lat: p2[0], lng: p2[1] };
    }
    return null;
  }

  function boundsVerdict(name, lat, lng) {
    if (inBounds(lat, lng)) return { ok: true, lat: lat, lng: lng, pattern: name };
    if (inBounds(lng, lat)) {
      return { ok: false, reason: 'reversed-coordinates', detail: name + ' matched ' + lat + ',' + lng + ' (lat/lng appear transposed)' };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { ok: false, reason: 'out-of-range', detail: name + ' matched ' + lat + ',' + lng };
    }
    return { ok: false, reason: 'outside-bounds', detail: name + ' matched ' + lat + ',' + lng };
  }

  // ── Named Google Maps places ──────────────────────────────────────────────
  // A Google "Share place" link names a place without giving its coordinates:
  //   https://www.google.com/maps?q=<name, address>&ftid=0x...:0x...&entry=gps...
  // ftid is Google's own feature id for that place, so the link identifies ONE
  // place deterministically. It is NOT a coordinate and is never turned into
  // one: no geocoding, no network, no centroid. The result carries the place id,
  // the label Google put in q, and the original URL -- and no lat/lng at all.
  var GOOGLE_HOST = /^([a-z0-9-]+\.)*google(\.[a-z]{2,3}){1,2}$/i;
  var FTID = /^0x[0-9a-f]+:0x[0-9a-f]+$/i;

  function cleanLabel(raw) {
    // eslint-disable-next-line no-control-regex
    var t = String(raw).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 200) return null;
    if (pairFromText(t) || dmsPair(t)) return null;           // a coordinate is not a name
    return t;
  }

  function parsePlace(trimmed) {
    var hm = trimmed.match(/^https?:\/\/([^/?#]+)/i);
    if (!hm) return null;
    var host = hm[1].toLowerCase().replace(/:\d+$/, '');
    if (!GOOGLE_HOST.test(host)) return null;
    var pq = pathAndQuery(trimmed);
    if (!/^\/maps(\/|$)/i.test(pq.path) && !/^maps\./i.test(host)) return null;

    var ftid = null, label = null;
    var parts = pq.query ? pq.query.split('&') : [];
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq < 0) continue;
      var key = formDecode(parts[i].slice(0, eq)).toLowerCase();
      var val = formDecode(parts[i].slice(eq + 1)).trim();
      if (key === 'ftid' && ftid === null) ftid = val;
      else if (key === 'q' && label === null) label = cleanLabel(val);
    }
    if (ftid === null || !FTID.test(ftid)) return null;
    return { placeId: ftid.toLowerCase(), label: label, url: trimmed, source: 'ftid' };
  }

  // The single classification entry point. Always returns one of
  //   { type:'exact',   ok:true,  lat, lng, pattern }          -- a verified coordinate
  //   { type:'place',   ok:false, reason:'place-only', placeId, label, url, detail }
  //                                                            -- a named place, NO coordinates
  //   { type:'invalid', ok:false, reason, detail }             -- nothing usable
  // `ok` means "has a coordinate", exactly as parseMapUrl has always meant it, so
  // a place can never be mistaken for a pin by code that only checks ok/lat/lng.
  function classifyMapUrl(url) {
    var r = parseExactCore(url);
    if (r.ok) return { type: 'exact', ok: true, lat: r.lat, lng: r.lng, pattern: r.pattern };
    if (r.reason !== 'no-coordinates') return { type: 'invalid', ok: false, reason: r.reason, detail: r.detail };

    var trimmed = url.trim();    // parseExactCore returned no-coordinates, so url is a non-blank string
    var cand = newFormatCandidate(trimmed);
    if (cand) {
      var v = boundsVerdict(cand.name, cand.lat, cand.lng);
      return v.ok
        ? { type: 'exact', ok: true, lat: v.lat, lng: v.lng, pattern: v.pattern }
        : { type: 'invalid', ok: false, reason: v.reason, detail: v.detail };
    }

    var place = parsePlace(trimmed);
    if (place) {
      return {
        type: 'place', ok: false, reason: 'place-only', placeId: place.placeId, label: place.label,
        url: place.url, detail: 'named Google Maps place' + (place.label ? ' "' + place.label + '"' : '') + ' (no coordinates)'
      };
    }
    return { type: 'invalid', ok: false, reason: 'no-coordinates', detail: r.detail };
  }

  // Backward-compatible wrapper: { ok:true, lat, lng, pattern } for any link that
  // yields a coordinate, otherwise { ok:false, reason, detail } -- and, for a named
  // place, `place` carries its details while lat/lng stay absent.
  function parseMapUrl(url) {
    var c = classifyMapUrl(url);
    if (c.type === 'exact') return { ok: true, lat: c.lat, lng: c.lng, pattern: c.pattern };
    if (c.type === 'place') {
      return { ok: false, reason: 'place-only', detail: c.detail, place: { placeId: c.placeId, label: c.label, url: c.url } };
    }
    return { ok: false, reason: c.reason, detail: c.detail };
  }

  // Human-facing one-liner for a failure, for logs and the admin form.
  function describeFailure(result) {
    switch (result.reason) {
      case 'no-url':                return 'no Google Maps link on this listing';
      case 'unresolved-short-link': return 'short link not expanded yet — re-save the listing in admin to resolve it';
      case 'reversed-coordinates':  return 'latitude and longitude appear transposed in the link';
      case 'outside-bounds':        return 'coordinates fall outside Laos';
      case 'out-of-range':          return 'coordinates are not a valid point on Earth';
      case 'no-coordinates':        return 'link carries no coordinates';
      case 'place-only':            return 'named Google Maps place: it has no exact coordinates, so it cannot be an exact pin';
      case 'not-a-url':             return 'value is not a URL';
      default:                      return result.reason;
    }
  }

  var api = {
    parseMapUrl: parseMapUrl,
    classifyMapUrl: classifyMapUrl,
    isShortLink: isShortLink,
    describeFailure: describeFailure,
    LAOS_BOUNDS: LAOS_BOUNDS,
    SHORT_LINK_HOSTS: SHORT_LINK_HOSTS
  };

  global.PintagMapLocation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
