// import-provenance.js — Smart Import Provenance v2 recorder (client-side).
//
// Called by admin.html's saveListing() right after a NEW imported listing is
// persisted. Writes ONE append-only import_records row (source + AI + the full
// raw payload manifest) plus one import_images row per saved photo (original
// URL → storage object → sha256 → order). Provenance links to the listing by a
// PLAIN uuid, so it survives any future deletion (see the migration).
//
// Fully best-effort and non-blocking: a provenance failure must NEVER break a
// save. admin.html wraps the call in try/catch and passes its own REST helper.
(function () {
  'use strict';

  // Extract a Facebook/Marketplace post/item id from a source URL, if present.
  function extractPostId(url) {
    if (!url) return null;
    var s = String(url);
    var m = s.match(/[?&](?:item_id|story_fbid|fbid|id|item)=(\d{5,})/i)
         || s.match(/\/(?:posts|permalink|marketplace\/item)\/(\d{5,})/i)
         || s.match(/\/(\d{8,})\/?(?:$|[?#])/);
    return m ? m[1] : null;
  }

  // Content fingerprint of a stored image (fetched from its public URL).
  // Best-effort: returns null on any CORS/network/crypto failure.
  async function sha256(url) {
    try {
      if (!url || !(self.crypto && crypto.subtle)) return null;
      var r = await fetch(url);
      if (!r.ok) return null;
      var buf = await r.arrayBuffer();
      var hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).map(function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    } catch (_) { return null; }
  }

  // post(table, rows) → the caller's PostgREST insert helper (admin-authed).
  // ctx: { listingId, slug, status, batchId?, sourcePlatform, sourceUrl,
  //        aiModel, promptVersion, success, confidence?, rawPayload,
  //        images: [{ url, path, original, order }] }
  async function record(post, ctx) {
    ctx = ctx || {};
    var importId = (self.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now() + '-' + Math.random().toString(36).slice(2));
    var batchId = ctx.batchId || importId;

    await post('import_records', [{
      id: importId,
      listing_id: ctx.listingId || null,
      batch_id: batchId,
      source_platform: ctx.sourcePlatform || 'manual',
      source_url: ctx.sourceUrl || null,
      source_post_id: extractPostId(ctx.sourceUrl),
      slug_at_import: ctx.slug || null,
      listing_status: ctx.status || null,
      import_version: '2',
      ai_model: ctx.aiModel || null,
      prompt_version: ctx.promptVersion || null,
      success: ctx.success !== false,
      confidence: (ctx.confidence != null ? ctx.confidence : null),
      raw_payload: ctx.rawPayload || null
    }]);

    var images = Array.isArray(ctx.images) ? ctx.images : [];
    if (images.length) {
      var rows = [];
      for (var i = 0; i < images.length; i++) {
        var im = images[i] || {};
        rows.push({
          import_id: importId,
          listing_id: ctx.listingId || null,
          original_url: im.original || im.originalUrl || null,
          storage_url: im.url || null,
          storage_path: im.path || (im.url ? String(im.url).split('/').pop() : null),
          storage_object_id: im.storageObjectId || null,
          sha256: await sha256(im.url),
          uploaded_at: new Date().toISOString(),
          image_order: (im.order != null ? im.order : i)
        });
      }
      await post('import_images', rows);
    }
    return importId;
  }

  window.PintagImportProvenance = { record: record, extractPostId: extractPostId };
})();
