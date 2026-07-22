// unit-availability.js — "Next Available Date" enhancement to Unit Type
// availability. Same loading convention as terminology.js/rental-terms.js.
//
// ARCHITECTURAL RULES:
//
// 1. This module must remain completely independent from rental-terms.js —
//    neither file may import or reference the other. Each owns its own
//    field definitions (here: a small, fixed, documented list rather than
//    a generic kind-dispatch registry — deliberate: unlike Rental Terms,
//    Availability has no stated extensibility requirement, so it doesn't
//    carry that machinery), its own resolver, its own formatter, its own
//    admin save/load logic.
//
// 2. resolveUnitAvailability() is the sole public read API for
//    unit_types.available_count/total_units/next_available_date/
//    availability_note/is_available. No code outside this file may read
//    those columns directly — including AI-generated description copy,
//    which must consume this resolver's output, never raw fields.
//
// 3. Pure, portable: no `document`/`window` references in
//    resolveUnitAvailability()/formatAvailabilityDisplay()/
//    compareUnitTypesForDisplay(), so the same file works from a browser
//    <script> tag and a Deno edge function unchanged. Never mutates its
//    inputs.
//
// 4. Availability is deliberately flat columns, not JSONB — this is
//    operational/occupancy state (and will connect to lease data in a
//    future inventory phase), not configuration/policy data. See
//    rental-terms.js's JSONB scope-boundary note for the general rule this
//    follows.
//
// 5. The public formatter's THREE user-facing messages are a frozen
//    contract: "Available Now" / "Fully Occupied — Available from {date}"
//    / "Currently Unavailable". The internal `status` enum has a 4th value
//    (coming_soon) reserved for a future 4th public message — today it
//    collapses into "Currently Unavailable". This is the seam a future
//    richer public copy plugs into without a resolver change.

// resolveUnitAvailability(unitType, computedNextAvailableDate?)
//
// `computedNextAvailableDate` is optional and unused today — reserved for
// a future inventory-management phase, where a caller computes it from
// lease/move-out data and passes it in. `unitType.next_available_date`
// (manually entered by staff) always takes precedence when set — an
// explicit human entry is treated as a deliberate correction, never
// silently overridden by automation. This lets the manual field become a
// fallback/override with zero change to this function's contract when
// that phase arrives.
function resolveUnitAvailability(unitType, computedNextAvailableDate) {
  var manualDate = (unitType.next_available_date != null) ? unitType.next_available_date : null;
  var nextAvailableDate = (manualDate != null) ? manualDate : (computedNextAvailableDate || null);
  var count = unitType.available_count;
  var total = (unitType.total_units != null) ? unitType.total_units : null;

  var status;
  if (unitType.is_available === false) {
    status = (total != null) ? 'coming_soon' : 'temporarily_unavailable';
  } else if (count > 0) {
    status = 'available';
  } else if (nextAvailableDate) {
    status = 'fully_occupied';
  } else {
    status = 'temporarily_unavailable';
  }

  return {
    availableCount: count,
    totalUnits: total,
    nextAvailableDate: nextAvailableDate,
    note: unitType.availability_note || null,
    status: status // 'available' | 'fully_occupied' | 'coming_soon' | 'temporarily_unavailable'
  };
}

// formatAvailabilityDisplay(resolved, lang) -- the public-facing string.
// Byte-stable contract: exactly one of the three sanctioned messages.
// Availability Note is NEVER folded into this string -- it always renders
// as a separate, supplementary line by the caller (see
// getAvailabilityNoteLine() below), never replacing the status.
function formatAvailabilityDisplay(resolved, lang) {
  lang = lang || 'en';
  var T = {
    availableNow:  {en:'Available Now',       lo:'ວ່າງດຽວນີ້',        zh:'现在可租'},
    fullyOccupied: {en:'Fully Occupied',      lo:'ເຕັມແລ້ວ',          zh:'已满租'},
    availableFrom: {en:'Available from',      lo:'ວ່າງຕັ້ງແຕ່',       zh:'可入住时间'},
    currentlyUnavailable: {en:'Currently Unavailable', lo:'ບໍ່ວ່າງໃນຕອນນີ້', zh:'暂不可用'}
  };
  function t(key) { return T[key][lang] || T[key].en; }

  switch (resolved.status) {
    case 'available':
      return t('availableNow');
    case 'fully_occupied':
      return t('fullyOccupied') + ' — ' + t('availableFrom') + ' ' + _formatAvailabilityDate(resolved.nextAvailableDate, lang);
    case 'coming_soon':
    case 'temporarily_unavailable':
    default:
      return t('currentlyUnavailable');
  }
}

function _formatAvailabilityDate(isoDate, lang) {
  if (!isoDate) return '';
  var d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d.getTime())) return isoDate;
  var months = {
    en: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    lo: ['ມ.ກ','ກ.ພ','ມີ.ນ','ມ.ສ','ພ.ພ','ມິ.ຖ','ກ.ລ','ສ.ຫ','ກ.ຍ','ຕ.ລ','ພ.ຈ','ທ.ວ'],
    zh: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']
  };
  var m = (months[lang] || months.en)[d.getMonth()];
  return d.getDate() + ' ' + m + ' ' + d.getFullYear();
}

// availableCount > 1 shows a unit count per the frozen public contract
// (only plural). This is a small helper, not a 4th message -- still
// composes with formatAvailabilityDisplay(), doesn't replace it.
function formatAvailableUnitCount(resolved) {
  return (resolved.status === 'available' && resolved.availableCount > 1) ? resolved.availableCount : null;
}

// Availability Note is always supplementary -- a separate line, never
// merged into formatAvailabilityDisplay()'s output.
function getAvailabilityNoteLine(resolved) {
  return resolved.note || null;
}

// compareUnitTypesForDisplay(a, b) -- public listing ordering: Available
// Now, then Available Soon (soonest date first), then Currently
// Unavailable, staff's own sort_order as the tiebreak within a bucket.
// `a`/`b` are {resolved, sort_order} pairs. Render-time only -- never
// rewrites sort_order in the database (keeps the resolver's purity intact).
var _AVAILABILITY_BUCKET_RANK = { available: 0, fully_occupied: 1, coming_soon: 1, temporarily_unavailable: 2 };
function compareUnitTypesForDisplay(a, b) {
  var rankDiff = _AVAILABILITY_BUCKET_RANK[a.resolved.status] - _AVAILABILITY_BUCKET_RANK[b.resolved.status];
  if (rankDiff !== 0) return rankDiff;
  if (a.resolved.status === 'fully_occupied' && b.resolved.status === 'fully_occupied') {
    var ad = a.resolved.nextAvailableDate || '', bd = b.resolved.nextAvailableDate || '';
    if (ad !== bd) return ad < bd ? -1 : 1;
  }
  return (a.sort_order || 0) - (b.sort_order || 0);
}

// ---------------------------------------------------------------------------
// Admin collapsed-card status label -- DOM-free string builder, browser or
// portable either way, kept separate from formatAvailabilityDisplay()
// since the admin card shows Total Units context the public 3-message
// contract deliberately doesn't (rule 5's collapsing).
// ---------------------------------------------------------------------------
function formatAvailabilityAdminSummary(resolved) {
  var base = formatAvailabilityDisplay(resolved, 'en');
  if (resolved.totalUnits != null) {
    return base + ' (' + resolved.availableCount + '/' + resolved.totalUnits + ')';
  }
  return base;
}
