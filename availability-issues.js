// availability-issues.js -- the Admin "Availability Issues" collector. READ-ONLY: it classifies property rows, it never
// writes, rewrites or "corrects" anything.
//
// Same loading convention as property-availability.js / unit-availability.js (a plain global-var <script> tag, no
// `document`/`window`; also runs under node --test).
//
// IT DEFINES NO AVAILABILITY RULES OF ITS OWN. Every decision is delegated:
//   * is a listing's Market Status contradicted by its unit rows?   -> describePropertyAvailabilityConflict()
//                                                                      (property-availability.js; the same function
//                                                                      the listings-table badge and the editor warning use)
//   * is a unit open / closed, and which date does it carry?        -> resolveUnitAvailability() (unit-availability.js)
//   * is a date live or expired?                                    -> liveAvailabilityDate() (Asia/Vientiane day)
//   * is the listing available right now?                           -> resolvePropertyAvailability()
//
// ISSUE TYPES -- exactly the five mismatch codes the existing detector can return, plus the expired-date check:
//   available_units_closed | single_unit_status_wins | multi_unit_status_stale | closed_property_open_units |
//   coming_soon_open_units | expired_date
// A property has at most ONE mismatch (the detector's cases are mutually exclusive) and at most ONE expired_date issue
// (all of its affected units / its listing-level date are listed inside it), so one underlying problem is counted once.
// A property can carry a mismatch AND an expired date: it is then one affected listing with two issues.
//
// WHO IS CHECKED: published (workflow_status 'active') listings that are not soft-deleted. Drafts, archived and deleted
// listings are not visible to visitors, so a mismatch there changes nothing public.
//
// EXPIRED DATE (only where it changes what visitors see):
//   * a UNIT that is switched on, has no stock (available_count not above 0) and carries a stored next_available_date
//     that has expired / is malformed -- the site now shows "Currently Unavailable" instead of the date;
//   * the LISTING's available_from when it has expired / is malformed and the listing is currently unavailable (the case
//     where that date would have been shown).
//   A stale date on an open unit, a switched-off unit, or an available listing has no public effect and is NOT flagged.
//
// collectAvailabilityIssues(properties, opts?) -> {
//   listingsChecked, listingsAffected, issueCount, byType: { <type>: n },
//   issues: [{ key, type, propertyId, title, slug, district, marketStatus, message, units: [...], listingDate: ... }]
// }
//   opts.today  'YYYY-MM-DD' -- the expiry reference (default: the Lao calendar day now); tests pass it explicitly.

var AVAIL_ISSUE_TYPES = [
  { type: 'available_units_closed',     label: 'Available, but no unit is open',
    hint: 'Market Status says Available but every unit type is closed, so visitors see it as fully occupied and cannot contact anyone.' },
  { type: 'single_unit_status_wins',    label: 'Status overrides the open unit',
    hint: 'A single-unit listing marked Rented / Reserved / Fully Occupied while its unit is open: the status wins and the unit is not offered.' },
  { type: 'multi_unit_status_stale',    label: 'Stale status on a multi-unit listing',
    hint: 'Marked Rented / Reserved / Fully Occupied, but some unit types are open, so visitors see the listing as available per unit.' },
  { type: 'closed_property_open_units', label: 'Sold / off market with an open unit',
    hint: 'Marked Sold or Off Market while a unit is still marked available: the unit cannot be contacted.' },
  { type: 'coming_soon_open_units',     label: 'Coming soon with an open unit',
    hint: 'Marked Coming Soon while a unit is marked available: nobody can contact until the status is changed.' },
  { type: 'expired_date',               label: 'Expired availability date',
    hint: 'A stored availability date has passed, so the site ignores it. Update the date or the available count.' },
];

function _aiTypeInfo(type) {
  for (var i = 0; i < AVAIL_ISSUE_TYPES.length; i++) if (AVAIL_ISSUE_TYPES[i].type === type) return AVAIL_ISSUE_TYPES[i];
  return { type: type, label: type, hint: '' };
}

// The admin deep link. ?edit=<id> already existed (Intelligence alerts use it); &unit=<unit id> is optional and only ever
// expands the matching unit card of THAT listing (admin.html checks it against the loaded listing's own unit rows).
function availabilityIssueEditHref(propertyId, unitId) {
  var href = 'admin.html?edit=' + encodeURIComponent(propertyId);
  if (unitId != null && unitId !== '') href += '&unit=' + encodeURIComponent(unitId);
  return href;
}

function _aiUnitInfo(row, today) {
  var r = resolveUnitAvailability(row, null, today);
  return {
    id: row.id == null ? null : row.id,
    name: row.name_en || row.name || null,
    sortOrder: row.sort_order || 0,
    status: r.status,
    isAvailable: row.is_available !== false,
    availableCount: r.availableCount == null ? null : r.availableCount,
    totalUnits: r.totalUnits,
    date: r.nextAvailableDate,
    ignoredDate: r.ignoredNextAvailableDate,
  };
}

function collectAvailabilityIssues(properties, opts) {
  opts = opts || {};
  var today = (typeof isValidAvailabilityDate === 'function' && isValidAvailabilityDate(opts.today)) ? opts.today : availabilityTodayLao();
  var rows = Array.isArray(properties) ? properties : [];
  var issues = [], affected = {}, byType = {}, checked = 0, seen = {};
  for (var t = 0; t < AVAIL_ISSUE_TYPES.length; t++) byType[AVAIL_ISSUE_TYPES[t].type] = 0;

  for (var i = 0; i < rows.length; i++) {
    var p = rows[i];
    if (!p || p.id == null) continue;
    if (seen[p.id]) continue;                                     // the same row twice (e.g. across page boundaries) counts once
    seen[p.id] = true;
    if ((p.workflow_status || 'active') !== 'active') continue;   // drafts and archived
    if (p.deleted_at) continue;                                    // soft-deleted
    checked++;

    var unitRows = Array.isArray(p.unit_types) ? p.unit_types : [];
    var units = unitRows.map(function (u) { return _aiUnitInfo(u, today); })
                        .sort(function (a, b) { return a.sortOrder - b.sortOrder; });
    var base = { propertyId: p.id, title: p.title_en || null, slug: p.slug || null, district: p.district_en || null,
                 marketStatus: p.market_status || 'available' };

    // 1) Mismatch -- the existing detector, unchanged.
    var c = describePropertyAvailabilityConflict(p);
    if (c) {
      var open = units.filter(function (u) { return u.status === 'available'; });
      var shown = (c.code === 'available_units_closed') ? units : open;       // closed-everything shows each closed unit
      issues.push(Object.assign({ key: p.id + ':' + c.code, type: c.code, message: c.message, units: shown, listingDate: null }, base));
      byType[c.code] = (byType[c.code] || 0) + 1;
      affected[p.id] = true;
    }

    // 2) Expired date, only where it changes what visitors see.
    var summary = resolvePropertyAvailability(p);
    var expiredUnits = units.filter(function (u) {
      return u.isAvailable && !(u.availableCount > 0) && u.ignoredDate;
    });
    var listingDate = null;
    if (p.available_from && !liveAvailabilityDate(p.available_from, today) &&
        !summary.available && summary.presentation !== 'upcoming') {
      listingDate = { value: p.available_from };
    }
    if (expiredUnits.length || listingDate) {
      var fmt = function (d) { return (typeof _formatAvailabilityDate === 'function' && isValidAvailabilityDate(d)) ? _formatAvailabilityDate(d, 'en') : String(d); };
      var parts = [];
      expiredUnits.forEach(function (u) {
        parts.push((u.name || 'A unit type') + ': Next Available Date ' + fmt(u.ignoredDate) + ' has passed' + (isValidAvailabilityDate(u.ignoredDate) ? '' : ' (not a valid date)') +
                   ', so the site ignores it and shows "Currently Unavailable".');
      });
      if (listingDate) {
        parts.push('Listing-level Available From ' + fmt(listingDate.value) + ' has passed' + (isValidAvailabilityDate(listingDate.value) ? '' : ' (not a valid date)') +
                   ', so the site no longer shows an "Available from" date for this unavailable listing.');
      }
      issues.push(Object.assign({ key: p.id + ':expired_date', type: 'expired_date',
        message: parts.join(' ') + ' Update the date, or the available count if the unit is free.',
        units: expiredUnits, listingDate: listingDate }, base));
      byType.expired_date++;
      affected[p.id] = true;
    }
  }

  var order = {};
  AVAIL_ISSUE_TYPES.forEach(function (x, idx) { order[x.type] = idx; });
  issues.sort(function (a, b) {
    return (order[a.type] - order[b.type]) || String(a.title || '').localeCompare(String(b.title || '')) || String(a.propertyId).localeCompare(String(b.propertyId));
  });
  return { listingsChecked: checked, listingsAffected: Object.keys(affected).length, issueCount: issues.length, byType: byType, issues: issues, today: today };
}
