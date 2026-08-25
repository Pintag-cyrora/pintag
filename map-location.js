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
  function parseMapUrl(url) {
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

  // Human-facing one-liner for a failure, for logs and the admin form.
  function describeFailure(result) {
    switch (result.reason) {
      case 'no-url':                return 'no Google Maps link on this listing';
      case 'unresolved-short-link': return 'short link not expanded yet — re-save the listing in admin to resolve it';
      case 'reversed-coordinates':  return 'latitude and longitude appear transposed in the link';
      case 'outside-bounds':        return 'coordinates fall outside Laos';
      case 'out-of-range':          return 'coordinates are not a valid point on Earth';
      case 'no-coordinates':        return 'link carries no coordinates';
      case 'not-a-url':             return 'value is not a URL';
      default:                      return result.reason;
    }
  }

  var api = {
    parseMapUrl: parseMapUrl,
    isShortLink: isShortLink,
    describeFailure: describeFailure,
    LAOS_BOUNDS: LAOS_BOUNDS,
    SHORT_LINK_HOSTS: SHORT_LINK_HOSTS
  };

  global.PintagMapLocation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
