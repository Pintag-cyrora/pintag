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
//    inputs. The one implicit input is the clock, used only to expire stale
//    availability dates (the Lao calendar day, see "AVAILABILITY DATES"
//    below); pass `today` to make it explicit.
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

// ---------------------------------------------------------------------------
// AVAILABILITY DATES: what "today" is, and when a date has expired. The ONE implementation -- the property-level
// date (ptResolveNextAvailable, components.js), the per-unit resolver below and every formatter read it.
//
// A stored availability date (unit_types.next_available_date, properties.available_from) is a Laos calendar day
// (`date` column, no time, no zone). "Today" is therefore the calendar day in Asia/Vientiane -- the same zone the
// Intelligence pipeline and the Admin Analytics page use (laos-date.js; a test pins the two together) -- NOT the
// visitor's or the server's local day, so a visitor in another timezone sees the same expiry moment as staff.
//
//   * a date EQUAL to today is still live for the whole Lao calendar day; only dates BEFORE today are expired
//   * the string must be a real calendar date in strict YYYY-MM-DD form: '2026-02-31', '2026-2-3', '26-02-03',
//     '2026-02-03T00:00:00' and non-strings are malformed
//   * an expired or malformed date is treated exactly as "no date on file": it is never shown ("Available from ...",
//     "Fully Occupied -- Available from ..."), never used to pick the fully_occupied label, and never sorts a unit into
//     "Available Soon". It changes NOTHING else: is_available, available_count, total_units and market_status keep
//     deciding availability, so an expired date can never make a unit available, and never makes one unavailable.
//
// The default `today` is the device clock (`new Date()`) read as a Lao day -- no page has a server-supplied date, and a
// wrong device clock only moves WHEN a display-only date stops showing (never availability). See ARCHITECTURE.md.
// Pure/portable (no document/window), like the rest of this file. Every function takes an optional explicit `today`
// ('YYYY-MM-DD') so tests and servers never depend on the machine clock or timezone.
// ---------------------------------------------------------------------------
var _AVAIL_TZ = 'Asia/Vientiane';          // no DST; fixed UTC+7 (the fallback below relies on that)
var _AVAIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// availabilityTodayLao(now?) -> 'YYYY-MM-DD', the calendar day in Asia/Vientiane of an instant (Date or epoch ms;
// default: the current instant).
function availabilityTodayLao(now) {
  var d = (now instanceof Date) ? now : (typeof now === 'number' ? new Date(now) : new Date());
  if (isNaN(d.getTime())) d = new Date();
  try {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: _AVAIL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    var get = function (t) { for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value; return ''; };
    var out = get('year') + '-' + get('month') + '-' + get('day');
    if (_AVAIL_DATE_RE.test(out)) return out;
  } catch (e) { /* Intl/timeZone unavailable: use the fixed offset below */ }
  return new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

// isValidAvailabilityDate(value) -> true only for a real calendar date written exactly YYYY-MM-DD.
function isValidAvailabilityDate(value) {
  if (typeof value !== 'string') return false;
  var m = _AVAIL_DATE_RE.exec(value);
  if (!m) return false;
  var y = +m[1], mo = +m[2], da = +m[3];
  if (mo < 1 || mo > 12 || da < 1) return false;
  var dt = new Date(Date.UTC(y, mo - 1, da));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === da;
}

// liveAvailabilityDate(value, today?) -> the date itself when it is well-formed and not before `today`
// (default: the Lao calendar day now), else null. YYYY-MM-DD strings compare correctly as plain strings.
function liveAvailabilityDate(value, today) {
  if (!isValidAvailabilityDate(value)) return null;
  var t = isValidAvailabilityDate(today) ? today : availabilityTodayLao();
  return value >= t ? value : null;
}

// resolveUnitAvailability(unitType, computedNextAvailableDate?, today?)
//
// `today` ('YYYY-MM-DD', default: the Lao calendar day now) is the expiry reference for the date -- see
// liveAvailabilityDate() above. An expired or malformed date is dropped BEFORE the status is chosen, so the unit
// resolves exactly as if no date had been entered; `ignoredNextAvailableDate` carries the dropped value so the admin
// can say why (it is never for public display).
//
// `computedNextAvailableDate` is optional and unused today — reserved for
// a future inventory-management phase, where a caller computes it from
// lease/move-out data and passes it in. `unitType.next_available_date`
// (manually entered by staff) always takes precedence when set — an
// explicit human entry is treated as a deliberate correction, never
// silently overridden by automation. This lets the manual field become a
// fallback/override with zero change to this function's contract when
// that phase arrives.
function resolveUnitAvailability(unitType, computedNextAvailableDate, today) {
  var manualDate = (unitType.next_available_date != null && unitType.next_available_date !== '') ? unitType.next_available_date : null;
  var nextAvailableDate = null, ignoredDate = null;
  if (manualDate != null) {
    // An explicit manual entry still wins over a computed one -- but only while it is a live date. A stale manual
    // date no longer overrides (or blocks) a computed one.
    nextAvailableDate = liveAvailabilityDate(manualDate, today);
    if (nextAvailableDate == null) ignoredDate = manualDate;
  }
  if (nextAvailableDate == null && computedNextAvailableDate) {
    nextAvailableDate = liveAvailabilityDate(computedNextAvailableDate, today);
    if (nextAvailableDate == null && ignoredDate == null) ignoredDate = computedNextAvailableDate;
  }
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
    nextAvailableDate: nextAvailableDate,           // a LIVE date or null -- never an expired/malformed one
    ignoredNextAvailableDate: ignoredDate,          // the expired/malformed value that was dropped (admin hint only)
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

// formatUnitInventory(resolved, lang) -- the "7 of 24 units available"
// inventory line for a unit TYPE that spans many physical units
// (total_units set). Especially relevant to townhouse/villa/apartment
// PROJECTS where one type ("3-Bedroom Townhouse") holds N rentable units --
// property_type is irrelevant here, only whether total_units is tracked, so
// it works identically for every rental property type. Optional/self-
// suppressing: returns null when total_units is not tracked (a standalone
// or single-unit property shows nothing, never a wrong "1 of 1" default) or
// when the unit is not currently 'available' (a fully-occupied or
// unavailable unit is already fully described by formatAvailabilityDisplay()).
// Composes with, never replaces, that frozen 3-message contract (rule 5) --
// same rule as formatAvailableUnitCount()/formatMoveInDate() above.
function formatUnitInventory(resolved, lang) {
  lang = lang || 'en';
  if (!resolved || resolved.totalUnits == null || resolved.status !== 'available') return null;
  var available = resolved.availableCount;
  if (available == null) return null;
  var T = {
    en: function(a, t) { return a + ' of ' + t + (t === 1 ? ' unit available' : ' units available'); },
    lo: function(a, t) { return 'ວ່າງ ' + a + ' ຈາກ ' + t + ' ໜ່ວຍ'; },
    zh: function(a, t) { return a + '/' + t + ' 套可租'; }
  };
  return (T[lang] || T.en)(available, resolved.totalUnits);
}

// Availability Note is always supplementary -- a separate line, never
// merged into formatAvailabilityDisplay()'s output.
function getAvailabilityNoteLine(resolved) {
  return resolved.note || null;
}

// A move-in date is already embedded inside formatAvailabilityDisplay()'s
// 'fully_occupied' message ("Fully Occupied — Available from {date}"), but
// a caller sometimes needs the date on its own -- e.g. a per-unit card that
// shows Availability and Move-in date as two separate fields. This is that
// seam: a public wrapper around the private _formatAvailabilityDate(), so
// callers never need to know that helper exists or call it directly. Still
// composes with, never replaces, formatAvailabilityDisplay()'s frozen
// 3-message contract -- same rule as formatAvailableUnitCount() above.
// Returns null when there's no date to show (nothing to render).
function formatMoveInDate(resolved, lang) {
  return resolved.nextAvailableDate ? _formatAvailabilityDate(resolved.nextAvailableDate, lang) : null;
}

// formatAvailableFromLine(isoDate, lang) -- "Available from {date}" for a
// PER-LISTING available_from date (properties.available_from), the plain-
// listing complement to unit_types.next_available_date. Reuses the exact same
// date formatter and the same "Available from" wording as the unit-level
// fully_occupied message, so a plain apartment (no unit_types) and a
// multi-unit building read identically. Returns null when no date is set, or
// when it has expired / is malformed (liveAvailabilityDate, `today` optional) --
// the listing then just shows its price, which is a valid state. Pure/
// portable; composes with the frozen contract, never replaces it.
var _AVAILABLE_FROM_LABEL = { en: 'Available from', lo: 'ວ່າງຕັ້ງແຕ່', zh: '可入住时间' };
function formatAvailableFromLine(isoDate, lang, today) {
  lang = lang || 'en';
  isoDate = liveAvailabilityDate(isoDate, today);
  if (!isoDate) return null;
  var d = _formatAvailabilityDate(isoDate, lang);
  if (!d) return null;
  return (_AVAILABLE_FROM_LABEL[lang] || _AVAILABLE_FROM_LABEL.en) + ' ' + d;
}

// getUnitAvailabilityEmoji(status) -- a quick-scan color indicator to pair
// with formatAvailabilityDisplay()'s text, mirroring
// _AVAILABILITY_BUCKET_RANK's existing 3 buckets rather than inventing a
// new one: available (🟢), fully_occupied/coming_soon -- i.e. a status that
// may carry a next-available date (🟡), temporarily_unavailable -- no date
// on file (🔴). Composes with, never replaces, the frozen 3-message
// contract in formatAvailabilityDisplay() (rule 5 above).
var _AVAILABILITY_BUCKET_EMOJI = { 0: '🟢', 1: '🟡', 2: '🔴' };
function getUnitAvailabilityEmoji(status) {
  var rank = _AVAILABILITY_BUCKET_RANK[status];
  return _AVAILABILITY_BUCKET_EMOJI[rank] || '';
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

// ---------------------------------------------------------------------------
// ptIsMultiUnit(property) -- true when the listing offers MORE THAN ONE unit
// type, i.e. when a visitor has to say which unit they are asking about.
//
// The threshold is deliberately the one listing.html's buildAvailableUnitsSection()
// already uses to decide whether to show the unit picker at all: a lone unit type
// folds into the ordinary single-listing layout (there is nothing to choose
// between), so it is NOT multi-unit here either -- including a lone unit type that
// tracks a total_units inventory. Reads only the number of unit_types rows, never
// the availability columns (rule 2 above). Pure and DOM-free.
// ---------------------------------------------------------------------------
function ptIsMultiUnit(property) {
  return !!(property && Array.isArray(property.unit_types) && property.unit_types.length >= 2);
}
