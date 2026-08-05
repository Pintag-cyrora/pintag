// listing-provenance.js — permanent, append-only listing lifecycle + field
// provenance recorder (client-side). Complements import-provenance.js.
//
// Writes rows into the `listing_provenance` table (migration
// 20260805010000). That table links to a listing by a PLAIN uuid with NO
// foreign key, so every event survives the listing's deletion — the exact
// property that let lead_events survive the 2026-08-03 incident. The table
// has admin SELECT + INSERT policies only (no UPDATE/DELETE), so provenance
// is append-only and never-overwrite BY CONSTRUCTION; this helper only ever
// inserts.
//
// Generic by design: `source` ∈ import|manual|ai|system and a `details`
// jsonb column carry future origins (websites/CSV/APIs) with no schema
// change. This helper is forward-looking — it records provenance for
// listings created/edited from now on; it does NOT recover the 91 lost rows.
//
// Fully best-effort and non-blocking: a provenance failure must NEVER break
// a save or a delete. admin.html wraps every call in try/catch and passes
// its own REST helper `api(method, path, body)` (= sbApi).
(function () {
  'use strict';

  // Business-meaningful fields whose changes are worth a permanent record.
  // Anything not listed is intentionally not tracked (layout/derived noise).
  var TRACKED = [
    'title_en', 'title_lo', 'title_zh',
    'description_en',
    'property_type', 'transaction_type',
    'workflow_status', 'market_status',
    'price_display', 'price_amount', 'sale_price', 'rent_price', 'rent_price_amount',
    'district_en', 'village_en',
    'map_embed_url',
    'managed_by_party_id', 'owner_id', 'contact_id',
    'images'
  ];

  // Map a field to a specific event_type so timelines read naturally.
  function eventTypeFor(field) {
    if (/price/.test(field)) return 'price_changed';
    if (field === 'map_embed_url') return 'map_changed';
    if (field === 'managed_by_party_id') return 'agent_changed';
    if (field === 'owner_id') return 'owner_changed';
    if (field === 'contact_id') return 'contact_changed';
    if (field === 'images') return 'photos_changed';
    return 'field_changed';
  }

  // Stable comparison: null/undefined/'' collapse to null; arrays/objects by
  // structural JSON. Returns true when the two values are meaningfully equal.
  function sameValue(a, b) {
    var na = (a === undefined || a === '' ) ? null : a;
    var nb = (b === undefined || b === '' ) ? null : b;
    if (na === null && nb === null) return true;
    if (na === null || nb === null) return false;
    try { return JSON.stringify(na) === JSON.stringify(nb); }
    catch (_) { return na === nb; }
  }

  function normalize(v) {
    return (v === undefined || v === '') ? null : v;
  }

  var ISO = function () { return new Date().toISOString(); };

  // Build one provenance row.
  function makeEvent(o) {
    return {
      listing_id:  o.listingId || null,
      event_type:  o.eventType,
      field_name:  o.field || null,
      old_value:   o.oldValue !== undefined ? o.oldValue : null,
      new_value:   o.newValue !== undefined ? o.newValue : null,
      source:      o.source || 'system',
      actor:       o.actor || null,
      import_uuid: o.importUuid || null,
      details:     o.details || null,
      created_at:  ISO()
    };
  }

  // Insert rows (append-only). Returns the inserted rows (with DB-assigned
  // ids, via PostgREST return=representation). No-ops on an empty batch.
  async function insert(api, rows) {
    if (!rows || !rows.length) return [];
    var res = await api('POST', 'listing_provenance', rows);
    return Array.isArray(res) ? res : (res ? [res] : []);
  }

  // A new listing was created. source = 'import' (from Smart Import, carries
  // the Import UUID) or 'manual'. Emits one lifecycle event and returns its
  // DB id (used to anchor a storage snapshot), or null.
  async function logCreated(api, ctx) {
    ctx = ctx || {};
    var fromImport = !!ctx.importUuid || ctx.source === 'import';
    var inserted = await insert(api, [makeEvent({
      listingId: ctx.listingId,
      eventType: fromImport ? 'smart_import' : 'listing_created',
      source: fromImport ? 'import' : 'manual',
      actor: ctx.actor,
      importUuid: ctx.importUuid || null,
      details: ctx.details || null
    })]);
    return (inserted[0] && inserted[0].id) || null;
  }

  // An existing listing was edited. Fetch the current row's TRACKED fields,
  // diff against the about-to-be-saved body, and record one manual
  // field-change event per changed field. Called BEFORE the PATCH so the
  // fetched values are the true "old" values.
  async function captureEdit(api, listingId, newBody, actor) {
    if (!listingId || !newBody) return [];
    var rows;
    try {
      rows = await api('GET', 'properties?id=eq.' + listingId + '&select=' + TRACKED.join(','));
    } catch (_) { return []; }
    var old = Array.isArray(rows) ? rows[0] : rows;
    if (!old) return [];
    var events = [];
    for (var i = 0; i < TRACKED.length; i++) {
      var f = TRACKED[i];
      if (!(f in newBody)) continue;            // field not part of this save
      var oldV = normalize(old[f]);
      var newV = normalize(newBody[f]);
      if (sameValue(oldV, newV)) continue;
      events.push(makeEvent({
        listingId: listingId,
        eventType: eventTypeFor(f),
        field: f,
        oldValue: oldV,
        newValue: newV,
        source: 'manual',
        actor: actor
      }));
    }
    // Return the inserted rows (with DB ids) so the caller can find the
    // photos_changed event id to anchor a storage snapshot.
    return await insert(api, events);
  }

  // A listing is about to be deleted. Record it BEFORE the DELETE so the
  // removal itself is on the permanent record (the row survives the delete).
  async function logDeleted(api, ctx) {
    ctx = ctx || {};
    await insert(api, [makeEvent({
      listingId: ctx.listingId,
      eventType: 'listing_deleted',
      source: 'manual',
      actor: ctx.actor,
      details: ctx.details || null
    })]);
  }

  // Storage Object Snapshot: record every image attached to the listing at
  // this point in time, keyed to a provenance event. Append-only; lets us
  // rebuild properties.images purely from provenance if it is ever lost again.
  // images: the listing's image URL strings (properties.images). hashMap:
  // optional { url: sha256 } from the import flow. bucket defaults to
  // 'property-images'. Skips silently when there's nothing to record.
  async function snapshotImages(api, ctx) {
    ctx = ctx || {};
    var images = Array.isArray(ctx.images) ? ctx.images : [];
    if (!ctx.listingId || !ctx.eventId || !images.length) return;
    var bucket = ctx.bucket || 'property-images';
    var hashMap = ctx.hashMap || {};
    var rows = [];
    for (var i = 0; i < images.length; i++) {
      var url = images[i];
      if (!url) continue;
      rows.push({
        listing_id: ctx.listingId,
        provenance_event_id: ctx.eventId,
        storage_bucket: bucket,
        storage_path: String(url).split('/').pop(),
        storage_url: url,
        storage_object_id: null,
        image_order: i,
        sha256: hashMap[url] || null
      });
    }
    if (rows.length) await api('POST', 'listing_image_snapshots', rows);
  }

  window.PintagProvenance = {
    TRACKED: TRACKED,
    eventTypeFor: eventTypeFor,
    logCreated: logCreated,
    captureEdit: captureEdit,
    logDeleted: logDeleted,
    snapshotImages: snapshotImages
  };
})();
