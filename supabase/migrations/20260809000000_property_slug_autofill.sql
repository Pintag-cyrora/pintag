-- ============================================================================
-- ACTIVE LISTINGS ALWAYS HAVE A SLUG — root-cause fix for empty ?slug= links
-- ============================================================================
-- THE BUG (public browsing): some active listings linked to
--   https://pintag.io/listing.html?slug=&lang=lo
-- i.e. an empty slug. listing.html is fetched BY slug, so an empty slug is a
-- public dead end ("No property selected.").
--
-- WHY THOSE ROWS EXIST (traced in main):
--   * scripts/recover-listings-from-manifest.sql re-created the deleted
--     listings with slug = NULL *by design* — a status='draft', slug-NULL row
--     is unreachable on every public surface, which is exactly the guard that
--     kept half-recovered rows hidden until a human reviewed them.
--   * The ONLY code path that assigns a slug is a *new* listing (admin.html
--     saveListing POST; add-property.html). The paths that ACTIVATE a row —
--     admin.html publishDraft() (PATCH workflow_status='active') and the edit
--     PATCH — never set one. So when a recovered draft was published, it went
--     live still slug-NULL.
--   * Nothing at the database level guaranteed the invariant, so the gap in
--     the application code became live, broken URLs.
--
-- Every active listing is *supposed* to have a slug (it is the canonical,
-- shareable, OG-preview URL). This migration makes that a database guarantee
-- instead of an application convention, so NO path — admin edit, publishDraft,
-- a recovery script, or a hand-written SQL UPDATE — can activate a listing
-- without one.
--
-- WHAT IT DOES
--   1. pintag_slugify(text)            — same slug shape as the JS slugify().
--   2. pintag_unique_property_slug()   — collision-safe (appends -2, -3, …).
--   3. trg_properties_autofill_slug    — BEFORE INSERT/UPDATE: when a row is
--      active and its slug is NULL/blank, fill it. Drafts are left slug-NULL,
--      preserving the recovery hidden-until-reviewed guard.
--   4. One-time backfill of existing active, slug-less, non-deleted rows.
--   5. De-duplicate any pre-existing shared slugs (keep the oldest row's slug,
--      re-suffix the newer ones) so a unique index can be enforced.
--   6. Partial UNIQUE index on slug — future collisions are impossible.
--
-- ONLY the slug column is ever written. No title, price, status, or any other
-- listing data is changed. Drafts are untouched. Transactional: inspect the
-- RAISE NOTICE counts, then COMMIT or ROLLBACK.
-- ============================================================================

BEGIN;

-- ── 1. Slug shape — mirrors add-property.html / admin.html slugify() ─────────
-- lower-case, every run of non-[a-z0-9] becomes a single '-', trim '-', cap 60.
CREATE OR REPLACE FUNCTION pintag_slugify(txt text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT substring(
           btrim(
             regexp_replace(lower(coalesce(txt, '')), '[^a-z0-9]+', '-', 'g'),
             '-'
           )
         FROM 1 FOR 60);
$$;

-- ── 2. Uniqueness / collision handling ──────────────────────────────────────
-- Returns `base` if free, else base-2, base-3, … skipping the row itself.
-- An empty base (e.g. a Lao-only title, which slugifies to '') falls back to a
-- stable id-derived token so the result is always non-empty AND unique.
CREATE OR REPLACE FUNCTION pintag_unique_property_slug(base text, self_id uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  root text := NULLIF(base, '');
  candidate text;
  n int := 1;
BEGIN
  IF root IS NULL THEN
    root := 'listing-' || substr(self_id::text, 1, 8);
  END IF;
  candidate := root;
  WHILE EXISTS (
    SELECT 1 FROM properties
    WHERE slug = candidate
      AND id IS DISTINCT FROM self_id
  ) LOOP
    n := n + 1;
    candidate := root || '-' || n;
  END LOOP;
  RETURN candidate;
END;
$$;

-- ── 3. The guarantee: an active row never keeps a blank slug ─────────────────
-- Keyed on workflow_status (the source of truth the writer sets directly) so a
-- draft→active PATCH is caught even though this fires BEFORE the legacy-status
-- sync trigger. status IN ('active','available') is a belt-and-suspenders for
-- any writer that touches only the legacy column.
CREATE OR REPLACE FUNCTION properties_autofill_slug()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base text;
BEGIN
  IF (NEW.workflow_status = 'active' OR NEW.status IN ('active','available'))
     AND (NEW.slug IS NULL OR btrim(NEW.slug) = '') THEN
    base := pintag_slugify(coalesce(NEW.title_en, NEW.title_lo, ''));
    NEW.slug := pintag_unique_property_slug(base, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_properties_autofill_slug ON properties;
CREATE TRIGGER trg_properties_autofill_slug
  BEFORE INSERT OR UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_autofill_slug();

COMMENT ON FUNCTION properties_autofill_slug() IS
  'Guarantees every active listing has a non-empty, unique slug. Drafts are left slug-NULL (the recovery hidden-until-reviewed guard). Only the slug column is written.';

-- ── 4. Backfill existing active, slug-less, non-deleted rows ─────────────────
DO $$
DECLARE r record; base text; s text; touched int := 0;
BEGIN
  FOR r IN
    SELECT id, title_en, title_lo
    FROM properties
    WHERE (workflow_status = 'active' OR status IN ('active','available'))
      AND (slug IS NULL OR btrim(slug) = '')
      AND deleted_at IS NULL
    ORDER BY created_at NULLS LAST
  LOOP
    base := pintag_slugify(coalesce(r.title_en, r.title_lo, ''));
    s := pintag_unique_property_slug(base, r.id);
    UPDATE properties SET slug = s WHERE id = r.id;   -- slug ONLY
    touched := touched + 1;
  END LOOP;
  RAISE NOTICE 'slug backfill: % active listing(s) given a slug', touched;
END $$;

-- ── 5. Resolve any pre-existing duplicate slugs (keep the earliest row) ──────
-- Only rows that ALREADY collide are touched; the oldest keeps its slug (its
-- URL is unchanged), newer duplicates are re-suffixed. A duplicate is already
-- broken today (the listing page fetches slug=eq.X&limit=1), so this only
-- repairs, never regresses, a working URL.
DO $$
DECLARE r record; s text; fixed int := 0;
BEGIN
  FOR r IN
    SELECT id, slug
    FROM (
      SELECT id, slug,
             row_number() OVER (PARTITION BY slug ORDER BY created_at NULLS LAST, id) AS rn
      FROM properties
      WHERE slug IS NOT NULL AND btrim(slug) <> ''
    ) d
    WHERE d.rn > 1
  LOOP
    s := pintag_unique_property_slug(r.slug, r.id);
    UPDATE properties SET slug = s WHERE id = r.id;
    fixed := fixed + 1;
  END LOOP;
  RAISE NOTICE 'slug de-dup: % duplicate slug(s) re-suffixed', fixed;
END $$;

-- ── 6. Make future collisions impossible ────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_properties_slug
  ON properties (slug)
  WHERE slug IS NOT NULL AND btrim(slug) <> '';

COMMIT;

-- ── Verify (after COMMIT) ────────────────────────────────────────────────────
-- 0 rows expected:
--   SELECT count(*) FROM properties
--   WHERE (workflow_status='active' OR status IN ('active','available'))
--     AND (slug IS NULL OR btrim(slug)='') AND deleted_at IS NULL;
-- 0 rows expected (no dup slugs):
--   SELECT slug, count(*) FROM properties
--   WHERE slug IS NOT NULL AND btrim(slug)<>'' GROUP BY slug HAVING count(*)>1;
-- Trigger present & enabled:
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgname='trg_properties_autofill_slug';
