// image-renditions.js — ONE definition of what a delivery rendition is, where
// it lives, and how it is produced.
//
// WHY THIS EXISTS. Every public surface used to fetch the full-resolution
// original: a 330 kB photo behind a 320 px card. The obvious fix — Supabase
// Storage's render endpoint — is unavailable here:
//
//   GET /storage/v1/render/image/public/property-images/<obj>?width=400
//   -> 403 {"error":"FeatureNotEnabled","message":"feature not enabled for this tenant"}
//
// Image Transformations are a paid Supabase feature and this project is on
// Free (verified against production at 200/400/800/1200 px, with and without
// an Accept: image/webp header). So renditions are produced ONCE, at upload
// time, and stored as ordinary objects alongside the original.
//
// ARCHITECTURAL RULES
//
//   1. The ORIGINAL IS THE SOURCE OF TRUTH. It is never overwritten, never
//      moved, never deleted, and its path never changes. A rendition is a
//      derived convenience; losing every one of them must cost nothing but
//      bandwidth.
//
//   2. RENDITION PATHS ARE DERIVED, NOT STORED. renditionPath() is a pure
//      function of (original object name, profile), so the frontend can name a
//      rendition without a database round-trip and without a schema change.
//      No new column, no new table.
//
//   3. DELIVERY ALWAYS DEGRADES TO THE ORIGINAL. During the backfill most
//      images will have no renditions at all. A missing rendition must show the
//      photo, never a broken image — so the <img> carries the rendition and an
//      onerror that swaps in the original exactly once.
//
//   4. NEVER EMIT A 403 TRANSFORMATION URL. The render endpoint is not used
//      anywhere. If a rendition does not exist we serve the original, which
//      always works.
//
//   5. GENERATION IS IDEMPOTENT. Re-uploading or re-running the backfill for an
//      image that already has renditions is a no-op, so a partial backfill can
//      simply be run again.
//
//   6. ONE PIPELINE. Admin, agent self-service and any future path call the
//      same generator. No page re-implements resizing.
// ---------------------------------------------------------------------------

// The delivery contract. Widths are CSS-pixel targets doubled where the surface
// is small enough that retina matters; quality rises with size because
// artefacts are more visible the larger the image is shown.
//
// Deliberately FOUR sizes, not three: 800 is the mobile slide and 1200 the
// desktop hero, and dropping either forces a full-screen surface onto a
// rendition built for something much smaller. The measured storage cost of the
// extra size is small (see the sample analysis) and it is the difference
// between a sharp hero and a soft one.
var PT_RENDITION_PROFILES = {
  thumbnail: { width: 200,  quality: 0.70 },
  card:      { width: 400,  quality: 0.75 },
  gallery:   { width: 800,  quality: 0.78 },
  hero:      { width: 1200, quality: 0.82 }
};

var PT_RENDITION_PREFIX = 'renditions/';
var PT_RENDITION_BUCKET = 'property-images';

// Strip the extension so "1787301675902-4gcl6e.jpg" and a future
// "...-4gcl6e.JPG" cannot collide on different rendition paths.
function renditionStem(objectName) {
  if (!objectName || typeof objectName !== 'string') return null;
  var clean = objectName.split('?')[0].replace(/^\/+/, '');
  if (!clean) return null;
  return clean.replace(/\.[A-Za-z0-9]+$/, '');
}

// renditions/<stem>/<profile>.webp — one folder per original, so every
// rendition of an image sits together and a future cleanup can drop a whole
// prefix when its original is removed.
function renditionPath(objectName, profile) {
  var stem = renditionStem(objectName);
  if (!stem || !PT_RENDITION_PROFILES[profile]) return null;
  return PT_RENDITION_PREFIX + stem + '/' + profile + '.webp';
}

// The object name inside property-images for a full public URL, or null when
// the URL is not one of this project's public property images (agent photos,
// Facebook CDN, data: URIs, anything already a rendition).
function objectNameFromPublicUrl(url, supabaseUrl) {
  if (!url || typeof url !== 'string' || !supabaseUrl) return null;
  var base = supabaseUrl + '/storage/v1/object/public/' + PT_RENDITION_BUCKET + '/';
  if (url.indexOf(base) !== 0) return null;
  var name = url.slice(base.length).split('?')[0];
  if (!name || name.indexOf(PT_RENDITION_PREFIX) === 0) return null;  // never derive from a rendition
  return name;
}

function renditionPublicUrl(originalUrl, profile, supabaseUrl) {
  var name = objectNameFromPublicUrl(originalUrl, supabaseUrl);
  if (!name) return null;
  var path = renditionPath(name, profile);
  if (!path) return null;
  return supabaseUrl + '/storage/v1/object/public/' + PT_RENDITION_BUCKET + '/' + path;
}

// ── Generation (browser) ────────────────────────────────────────────────────
// Canvas encode. Returns [] rather than throwing when the browser cannot
// produce WebP: a failed rendition must never block the upload of the original,
// which is the only thing that actually matters.
function supportsWebpEncode() {
  if (typeof document === 'undefined') return false;
  try {
    var c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  } catch (_e) { return false; }
}

// Never upscale: an image narrower than the profile is delivered at its own
// width. Encoding a 300 px photo up to 1200 would cost bytes and add nothing.
function renditionTargets(naturalWidth) {
  var out = [];
  for (var k in PT_RENDITION_PROFILES) {
    if (!Object.prototype.hasOwnProperty.call(PT_RENDITION_PROFILES, k)) continue;
    var p = PT_RENDITION_PROFILES[k];
    out.push({ profile: k, width: Math.min(p.width, naturalWidth || p.width), quality: p.quality });
  }
  return out;
}

// generateRenditions(file, opts) -> [{ profile, path, blob }]
// Decodes ONCE into an ImageBitmap/Image, then draws it down to each target.
// Pure browser work: no network, no Storage write. The caller uploads.
//
// Returns [] on ANY failure (no WebP encoder, undecodable file, canvas
// tainted). Rule 3: the original still uploads and delivery falls back to it.
async function generateRenditions(file, objectName) {
  if (typeof document === 'undefined' || !file || !objectName) return [];
  if (!supportsWebpEncode()) return [];
  var url = null, img = null;
  try {
    url = URL.createObjectURL(file);
    img = await new Promise(function (resolve, reject) {
      var i = new Image();
      i.onload = function () { resolve(i); };
      i.onerror = function () { reject(new Error('decode failed')); };
      i.src = url;
    });

    var out = [];
    var targets = renditionTargets(img.naturalWidth || img.width);
    for (var t = 0; t < targets.length; t++) {
      var spec = targets[t];
      var w = spec.width;
      var h = Math.max(1, Math.round((img.naturalHeight || img.height) * (w / (img.naturalWidth || img.width))));
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      if (!ctx) continue;
      // Best available downscale quality — a nearest-neighbour shrink of a
      // photo looks obviously worse and this is property photography.
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);

      var blob = await new Promise(function (resolve) {
        canvas.toBlob(function (b) { resolve(b); }, 'image/webp', spec.quality);
      });
      if (!blob) continue;
      // A rendition that is not actually smaller is pointless — skip it and let
      // that profile fall back to the original.
      if (blob.size >= file.size) continue;
      out.push({ profile: spec.profile, path: renditionPath(objectName, spec.profile), blob: blob });
    }
    return out;
  } catch (_e) {
    return [];
  } finally {
    if (url) { try { URL.revokeObjectURL(url); } catch (_e2) {} }
  }
}

// uploadRenditions(file, objectName, io) — generate + store, best effort.
// `io.put(path, blob, contentType, cacheControl)` is supplied by the caller so
// this module never owns credentials and each page keeps its own auth.
//
// Idempotent by construction: every path is a pure function of the original's
// name, so re-running overwrites a byte-identical object rather than creating a
// second one. Failures are swallowed — the listing is already saved.
async function uploadRenditions(file, objectName, io) {
  if (!io || typeof io.put !== 'function') return 0;
  var made = 0;
  var renditions = await generateRenditions(file, objectName);
  for (var i = 0; i < renditions.length; i++) {
    try {
      await io.put(renditions[i].path, renditions[i].blob, 'image/webp',
                   'public, max-age=31536000, immutable');
      made++;
    } catch (_e) {
      // keep going: a partial rendition set is fine, each profile falls back
      // to the original independently
    }
  }
  return made;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PT_RENDITION_PROFILES, PT_RENDITION_PREFIX, PT_RENDITION_BUCKET,
    renditionStem, renditionPath, objectNameFromPublicUrl,
    renditionPublicUrl, supportsWebpEncode, renditionTargets,
    generateRenditions, uploadRenditions
  };
}
