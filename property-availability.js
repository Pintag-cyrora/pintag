// property-availability.js — the canonical PROPERTY availability resolver.
//
// Same loading convention as listing-status.js / unit-availability.js (a plain global-var <script> tag,
// no build step, no `document`/`window`; the same file runs in a browser or an edge function).
//
// WHY THIS FILE EXISTS. "Is this property available right now?" used to be answered by three separate
// readers that disagreed (listing-status.js isPubliclyAvailable, components.js _ptIsUnavailableNow, and the
// contact-intent summary), and a fourth hand copy lives in the OG Worker and the intelligence SQL. This is
// the ONE place that combines the two inputs staff actually set:
//
//   * properties.market_status                (read through resolveListingStatus() when loaded)
//   * the unit_types availability rows        (read ONLY through resolveUnitAvailability())
//
// Dates (unit_types.next_available_date, properties.available_from) are NEVER consulted: a date can label a
// state, it cannot create one. A unit is open only when resolveUnitAvailability() says status 'available'.
//
// THE RULES
//
//   market_status          single-unit / no units       multi-unit (>= 2 unit types)
//   --------------------   --------------------------   ------------------------------------------
//   sold, off_market       OFF (history)                OFF   (units never override)
//   coming_soon            OFF (upcoming)               OFF   (units never override)
//   reserved/rented/       OFF (property wins, even     ON at UNIT level when >= 1 unit is open
//     fully_occupied         if a lone unit row is open)  (only those units are contactable); else OFF
//   available (or unset)   ON, or OFF when its unit     ON when >= 1 unit is open, and always
//                          row is closed                reported unit by unit
//
//   presentation  'live'      the property can be contacted now (possibly only some of its units)
//                 'upcoming'  coming_soon, or every unit is coming_soon: normal price, normal badge,
//                             no contact path, and NOT the sold/rented "history" treatment
//                 'history'   sold / rented / reserved / fully_occupied / off_market / temporarily unavailable:
//                             the original-asking-price + unavailable treatment
//
// CONTACTABILITY. `available` is the only gate for a lead-creating action. For a multi-unit property the
// action also needs a unit: use isPropertyUnitContactable(summary, unitId). A closed unit is never
// contactable, whatever the property says.
//
// resolvePropertyAvailability(property) -> {
//   available             boolean — may the visitor contact the agent (about the property / one of its open units)
//   presentation          'live' | 'upcoming' | 'history'
//   reason                null when ON; else 'sold' | 'off_market' | 'coming_soon' | 'reserved' | 'rented' |
//                         'fully_occupied' | 'temporarily_unavailable'
//   market                the property's own market_status ('available' when unset)
//   effectiveMarket       what the page should SHOW as the status, always a market_status value:
//                         'available' when the property is ON (including a unit-level override of a stale
//                         rented/reserved/fully_occupied), else the reason mapped onto that vocabulary
//   source                'market_status' | 'unit_types' | null (what decided it)
//   scope                 'property' | 'unit_specific' ('unit_specific' for EVERY multi-unit property)
//   multiUnit             >= 2 unit types (same threshold as ptIsMultiUnit())
//   unitOverride          true when market_status says reserved/rented/fully_occupied but an open unit keeps
//                         that unit available (multi-unit only)
//   requiresUnitSelection true when ON and multiUnit
//   units                 [{ id, status, available }] in the property's own order
//   openUnitIds / openUnitCount / totalUnits
//   waitingListApplies    true when OFF
// }
// Pure; never mutates the property.

var _PA_ALWAYS_OFF = { sold: true, off_market: true, coming_soon: true };     // units never override
var _PA_OCCUPANCY = { reserved: true, rented: true, fully_occupied: true };   // an open unit overrides on a multi-unit property only

function _paIsMultiUnit(property) {
  if (typeof ptIsMultiUnit === 'function') return ptIsMultiUnit(property);
  return !!(property && Array.isArray(property.unit_types) && property.unit_types.length >= 2);
}

function _paMarket(property) {
  if (typeof resolveListingStatus === 'function') return resolveListingStatus(property).market;
  return (property && property.market_status) || 'available';
}

// Reason a property whose market_status is 'available' but whose unit rows have NO open unit is off.
function _paUnitsOffReason(units) {
  var allComing = units.length > 0, anyFull = false;
  for (var i = 0; i < units.length; i++) {
    if (units[i].status !== 'coming_soon') allComing = false;
    if (units[i].status === 'fully_occupied') anyFull = true;
  }
  if (allComing) return 'coming_soon';
  if (anyFull) return 'fully_occupied';
  return 'temporarily_unavailable';
}

// A reason onto the market_status vocabulary the badge / overlay / status CTA tables are keyed by.
function _paReasonToMarket(reason) {
  return reason === 'temporarily_unavailable' ? 'fully_occupied' : reason;
}

function resolvePropertyAvailability(property) {
  var market = _paMarket(property);
  var rows = (property && Array.isArray(property.unit_types)) ? property.unit_types : [];
  var multi = _paIsMultiUnit(property);

  var units = rows.map(function (u) {
    var r = (typeof resolveUnitAvailability === 'function')
      ? resolveUnitAvailability(u)
      : { status: 'temporarily_unavailable' };
    return { id: (u && u.id != null) ? u.id : null, status: r.status, available: r.status === 'available' };
  });
  var open = units.filter(function (u) { return u.available; });
  var openIds = open.map(function (u) { return u.id; });

  function out(available, reason, source, unitOverride) {
    var presentation = available ? 'live' : (reason === 'coming_soon' ? 'upcoming' : 'history');
    return {
      available: available,
      presentation: presentation,
      reason: available ? null : reason,
      market: market,
      effectiveMarket: available ? 'available' : _paReasonToMarket(reason),
      source: source,
      scope: multi ? 'unit_specific' : 'property',
      multiUnit: multi,
      unitOverride: !!unitOverride,
      requiresUnitSelection: !!(available && multi),
      units: units,
      openUnitIds: openIds,
      openUnitCount: open.length,
      totalUnits: units.length,
      waitingListApplies: !available
    };
  }

  // sold / off_market / coming_soon: the PROPERTY is off the market (or not on it yet); no unit row can turn
  // that back on.
  if (_PA_ALWAYS_OFF[market]) return out(false, market, 'market_status', false);

  // reserved / rented / fully_occupied: the property-level status wins, EXCEPT that on a multi-unit property an
  // explicitly open unit keeps THAT unit available. A single-unit property (no unit rows, or one lone row) is
  // closed by its own status even when the lone row says open.
  if (_PA_OCCUPANCY[market]) {
    if (multi && open.length) return out(true, null, 'unit_types', true);
    return out(false, market, 'market_status', false);
  }

  // market_status 'available' (or unset / any value that is not an off-market state).
  if (!units.length) return out(true, null, null, false);
  if (open.length) return out(true, null, 'unit_types', false);
  return out(false, _paUnitsOffReason(units), 'unit_types', false);
}

// May the visitor start a contact (WhatsApp / Call / Book a viewing / per-unit Inquire) about this unit?
//   * the property must be ON, and
//   * on a multi-unit property the unit must be one of the OPEN units (a closed unit never is), and a missing
//     unit id is not contactable (a unit has to be named).
// On a single-unit property the property answers for itself (unitId is ignored).
function isPropertyUnitContactable(summary, unitId) {
  if (!summary || !summary.available) return false;
  if (!summary.multiUnit) return true;
  if (unitId == null || unitId === '') return false;
  return summary.openUnitIds.indexOf(unitId) !== -1;
}
