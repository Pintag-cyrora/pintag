-- ============================================================================
-- Image Registry — property_images  (Image Disaster Recovery, Phase 1)
-- ============================================================================
-- Purpose: a permanent, authoritative, current-state registry mapping every
-- image to the exact listing it belongs to, with an IMMUTABLE per-image UUID
-- identity that does NOT depend on the filename or URL. If storage is
-- corrupted, filenames change, or the properties row is lost, this table (plus
-- the off-site backups that export it) still tells us which image belongs to
-- which listing, in what order, and which is the cover.
--
-- Design (approved architecture):
--   * property_images is AUTHORITATIVE current-state (one row per live image).
--   * properties.images stays as the display CACHE the frontend keeps reading
--     (unchanged behavior, order, cover) — this table is DERIVED from it.
--   * listing_image_snapshots stays as append-only HISTORY (complementary).
--   * The registry is kept in sync by a DB TRIGGER on properties.images, so the
--     app has a SINGLE writer (properties.images) and no competing write path —
--     new uploads/edits/reorders/deletes update the registry automatically.
--
-- SAFETY: additive and idempotent. Creates one new table + functions + a
-- trigger, then backfills from data ALREADY in the database. It NEVER reads,
-- moves, renames, or deletes a storage object, and never modifies
-- properties.images. Safe to re-run.
--
-- FK NOTE (deliberate): property_id is a PLAIN uuid with NO foreign key — the
-- same disaster-proven convention as listing_image_snapshots / import_images /
-- listing_provenance. A hard FK would either CASCADE-delete the recovery map
-- when a listing is deleted (defeating the entire purpose — this system exists
-- because of a deletion incident) or BLOCK listing deletion. Referential
-- correctness ("every image references a valid property") is enforced instead
-- by the integrity job (scripts/image-integrity.py), which is the right tool
-- for a survive-anything DR registry.
-- ============================================================================

CREATE TABLE IF NOT EXISTS property_images (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- immutable image identity
  property_id      uuid NOT NULL,                               -- PLAIN uuid (no FK — survives deletion)
  storage_bucket   text NOT NULL DEFAULT 'property-images',
  storage_path     text NOT NULL,                               -- durable object key (filename); NOT identity
  storage_url      text,                                        -- full public URL (convenience / direct rebuild)
  original_filename text,                                       -- the operator's original upload name, if captured
  display_order    int  NOT NULL DEFAULT 0,                     -- position in the listing gallery (0 = cover)
  is_cover         boolean NOT NULL DEFAULT false,              -- redundant-with-order but explicit + verifiable
  uploaded_at      timestamptz,                                 -- best-effort (earliest snapshot), null if unknown
  uploaded_by      uuid,                                        -- single-admin model; usually the admin uid
  sha256           text,                                        -- content fingerprint (filled by hashing pass)
  file_size        bigint,                                      -- bytes (from storage metadata / hashing pass)
  mime_type        text,
  width            int,
  height           int,
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','removed','missing','quarantined')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- One registry row per (listing, object). Re-adding the same object keeps its
  -- original image UUID (upsert target below), so identity is stable per path.
  CONSTRAINT property_images_property_path_uniq UNIQUE (property_id, storage_path)
);

CREATE INDEX IF NOT EXISTS idx_property_images_property  ON property_images(property_id);
CREATE INDEX IF NOT EXISTS idx_property_images_path      ON property_images(storage_path);
CREATE INDEX IF NOT EXISTS idx_property_images_sha256    ON property_images(sha256);
CREATE INDEX IF NOT EXISTS idx_property_images_status    ON property_images(status);
CREATE INDEX IF NOT EXISTS idx_property_images_order     ON property_images(property_id, display_order);

COMMENT ON TABLE property_images IS
  'Authoritative image registry (Image DR). One row per live image, immutable id (uuid) identity independent of filename. Derived from properties.images by trigger; properties.images is the display cache; listing_image_snapshots is append-only history. property_id has no FK on purpose (survives listing deletion, like all provenance tables).';

ALTER TABLE property_images ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read property_images"   ON property_images;
DROP POLICY IF EXISTS "admin write property_images"  ON property_images;
CREATE POLICY "admin read property_images"  ON property_images FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));
CREATE POLICY "admin write property_images" ON property_images FOR ALL    TO authenticated USING (is_pintag_admin(auth.uid())) WITH CHECK (is_pintag_admin(auth.uid()));

-- ── Derive registry rows from a listing's images array ─────────────────────
-- The ONE place properties.images -> property_images happens. Pure derivation:
-- upserts a row per current image (order + cover from array position), then
-- SOFT-removes (status='removed', never deletes) rows whose object is no longer
-- on the listing — so an image UUID and its listing mapping are never lost,
-- even when the photo is taken off the gallery.
CREATE OR REPLACE FUNCTION pintag_sync_property_images(p_property uuid, p_images jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_paths text[];
BEGIN
  IF p_property IS NULL THEN RETURN; END IF;

  IF p_images IS NOT NULL AND jsonb_typeof(p_images) = 'array' THEN
    WITH cur AS (
      SELECT url, (ord - 1) AS idx
      FROM jsonb_array_elements_text(p_images) WITH ORDINALITY AS t(url, ord)
      WHERE url IS NOT NULL AND url <> ''
    ), parsed AS (
      SELECT
        url,
        idx,
        CASE WHEN url LIKE '%/property-images/%' THEN 'property-images' ELSE 'external' END AS bucket,
        CASE WHEN url LIKE '%/property-images/%'
             THEN regexp_replace(url, '^.*/property-images/', '')
             ELSE url END AS path
      FROM cur
    ), dedup AS (   -- guard against the same object listed twice in the array
      SELECT DISTINCT ON (path) path, url, idx, bucket
      FROM parsed ORDER BY path, idx
    )
    INSERT INTO property_images AS pi
      (property_id, storage_bucket, storage_path, storage_url, display_order, is_cover, status, updated_at)
    SELECT p_property, bucket, path, url, idx, (idx = 0), 'active', now()
    FROM dedup
    ON CONFLICT (property_id, storage_path) DO UPDATE
      SET display_order  = EXCLUDED.display_order,
          is_cover       = EXCLUDED.is_cover,
          storage_url    = EXCLUDED.storage_url,
          storage_bucket = EXCLUDED.storage_bucket,
          status         = 'active',
          updated_at     = now();
  END IF;

  -- Soft-remove rows whose object is no longer present on the listing.
  SELECT coalesce(array_agg(
           CASE WHEN url LIKE '%/property-images/%'
                THEN regexp_replace(url, '^.*/property-images/', '') ELSE url END), '{}')
    INTO v_paths
  FROM jsonb_array_elements_text(coalesce(p_images, '[]'::jsonb)) AS q(url)
  WHERE url IS NOT NULL AND url <> '';

  UPDATE property_images
     SET status = 'removed', is_cover = false, updated_at = now()
   WHERE property_id = p_property
     AND status <> 'removed'
     AND NOT (storage_path = ANY (v_paths));
END $$;

COMMENT ON FUNCTION pintag_sync_property_images(uuid, jsonb) IS
  'Derive property_images rows from a listing''s images array (order + cover from position). Upserts current images (stable id per path), soft-removes absent ones (never deletes). Idempotent — safe to call repeatedly; this is what the trigger and the backfill both use.';

-- ── Trigger: keep the registry in sync automatically ───────────────────────
-- Fires only when properties.images is part of an INSERT/UPDATE, so ordinary
-- edits that don't touch images are untouched. This is how "new uploads
-- automatically create a registry record" is guaranteed without any app-code
-- change and with no way to bypass it.
CREATE OR REPLACE FUNCTION pintag_property_images_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Best-effort: a registry-sync failure must NEVER roll back the listing save
  -- (same "provenance never breaks a save" contract as listing-provenance.js).
  -- The weekly reconcile (backfill re-run) and the integrity check would catch
  -- any row the trigger failed to write.
  BEGIN
    PERFORM pintag_sync_property_images(NEW.id, NEW.images);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'property_images sync failed for listing %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_property_images_sync ON properties;
CREATE TRIGGER trg_property_images_sync
  AFTER INSERT OR UPDATE OF images ON properties
  FOR EACH ROW EXECUTE FUNCTION pintag_property_images_trg();

-- ── DR reconstruction: rebuild a listing's gallery from the registry alone ──
CREATE OR REPLACE FUNCTION rebuild_images_from_registry(p_property uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(storage_url ORDER BY display_order), '[]'::jsonb)
  FROM property_images
  WHERE property_id = p_property AND status = 'active';
$$;
REVOKE ALL ON FUNCTION rebuild_images_from_registry(uuid) FROM public;
GRANT EXECUTE ON FUNCTION rebuild_images_from_registry(uuid) TO authenticated;
COMMENT ON FUNCTION rebuild_images_from_registry IS
  'DR: reconstruct a listing''s ordered image URL array (cover first) purely from the registry, independent of properties.images. Admin/DR use.';

-- ============================================================================
-- BACKFILL — seed the registry from data ALREADY in the database.
-- Idempotent (upsert-based) and non-destructive. Running it now creates one
-- registry row per image on every existing listing, with correct order + cover.
-- ============================================================================
SELECT pintag_sync_property_images(id, images)
FROM properties
WHERE images IS NOT NULL AND jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0;

-- Enrich with sha256 already captured by the provenance layer (Smart Import +
-- gallery snapshots). Manual-upload images still lack a hash here — those are
-- filled later by the CI hashing pass (scripts/image-hash-backfill.py), which
-- reads bytes off-line. This step only ever fills a NULL hash; never overwrites.
UPDATE property_images pi
   SET sha256 = s.sha256, updated_at = now()
  FROM (
    SELECT DISTINCT ON (listing_id, storage_path) listing_id, storage_path, sha256
    FROM listing_image_snapshots
    WHERE sha256 IS NOT NULL
    ORDER BY listing_id, storage_path, created_at DESC
  ) s
 WHERE pi.sha256 IS NULL AND pi.property_id = s.listing_id AND pi.storage_path = s.storage_path;

UPDATE property_images pi
   SET sha256 = im.sha256, updated_at = now()
  FROM (
    SELECT DISTINCT ON (listing_id, storage_path) listing_id, storage_path, sha256
    FROM import_images
    WHERE sha256 IS NOT NULL
    ORDER BY listing_id, storage_path, id DESC
  ) im
 WHERE pi.sha256 IS NULL AND pi.property_id = im.listing_id AND pi.storage_path = im.storage_path;

-- Best-effort uploaded_at from the earliest snapshot of each object.
UPDATE property_images pi
   SET uploaded_at = s.first_seen
  FROM (
    SELECT listing_id, storage_path, min(created_at) AS first_seen
    FROM listing_image_snapshots GROUP BY listing_id, storage_path
  ) s
 WHERE pi.uploaded_at IS NULL AND pi.property_id = s.listing_id AND pi.storage_path = s.storage_path;
