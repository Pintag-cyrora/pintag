-- ============================================================================
-- L1 SECURITY BASELINE (2/3): SOFT DELETE + FULL-ROW SNAPSHOT + DE-CASCADE
-- ============================================================================
-- Finding (audit 2026-08-06): properties were hard-deleted from the admin,
-- and four foreign keys (leads, unit_types, listing_events ×2 variants)
-- carried ON DELETE CASCADE — the exact mechanism of the 2026-08-03
-- incident, still structurally possible. "Data is never destroyed, only
-- marked" (Engineering Principle #1) was policy, not schema.
--
-- This migration makes it schema:
--   1. properties.deleted_at — deletion becomes a reversible STATE.
--      Public read policies exclude soft-deleted rows; admin still sees
--      them (restore = set deleted_at back to NULL).
--   2. properties_row_snapshots — a full to_jsonb(row) copy is captured by
--      trigger BEFORE any hard delete AND at the moment of soft delete.
--      Linked by PLAIN uuid (no FK) so snapshots outlive the row — the
--      same delete-safe property that made listing_provenance and
--      lead_events survive the breach.
--   3. Every ON DELETE CASCADE referencing properties becomes
--      ON DELETE SET NULL (drift-proof: constraints are discovered from
--      pg_constraint, not assumed by name — production was built
--      out-of-band, so hardcoded constraint names cannot be trusted).
--      A hard delete, should one ever still happen, no longer destroys
--      leads/unit_types/analytics — they detach instead.
--
-- The admin UI (admin.html deleteListing) switches to soft delete in the
-- same commit, and FAILS CLOSED if this migration has not been applied
-- yet (no fallback to hard delete).
--
-- Rollback: each piece is independent and additive —
--   * triggers:   DROP TRIGGER trg_snapshot_property_delete ON properties;
--                 DROP TRIGGER trg_snapshot_property_softdelete ON properties;
--   * policy:     re-create "public read active properties" without the
--                 deleted_at predicate (see 20260804130000, section 3);
--   * column:     properties.deleted_at is additive — leave it (harmless)
--                 or ALTER TABLE properties DROP COLUMN deleted_at;
--   * cascades:   re-add with ON DELETE CASCADE (NOT recommended — doing
--                 so reopens the incident mechanism).
-- No existing rows are modified by this migration.
-- ============================================================================

BEGIN;

-- ── 1. Deletion is a state ──────────────────────────────────────────────────
ALTER TABLE properties ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
COMMENT ON COLUMN properties.deleted_at IS
  'Soft delete: non-NULL hides the listing from every public surface while keeping the row (reversible: set back to NULL to restore). Hard DELETE is no longer performed by the application.';

-- Public reads filter on it; keep that cheap.
CREATE INDEX IF NOT EXISTS idx_properties_deleted_at
  ON properties (deleted_at) WHERE deleted_at IS NOT NULL;

-- Public read policy now excludes soft-deleted rows. Admin write policy is
-- untouched: the admin continues to see soft-deleted rows (that is the
-- restore path).
DROP POLICY IF EXISTS "public read active properties" ON properties;
CREATE POLICY "public read active properties" ON properties
  FOR SELECT TO public
  USING (status IN ('active','available') AND deleted_at IS NULL);

-- ── 2. Full-row snapshot, before anything is ever lost ──────────────────────
CREATE TABLE IF NOT EXISTS properties_row_snapshots (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid        NOT NULL,   -- PLAIN uuid, deliberately NO FK
  op          text        NOT NULL CHECK (op IN ('hard_delete','soft_delete')),
  row_data    jsonb       NOT NULL,   -- to_jsonb(the entire row)
  actor       text,                   -- auth.uid() when present, else db role
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_row_snapshots_property
  ON properties_row_snapshots (property_id, created_at DESC);

ALTER TABLE properties_row_snapshots ENABLE ROW LEVEL SECURITY;
-- Admin read only. NO insert/update/delete policies: rows are written solely
-- by the SECURITY DEFINER trigger function below, and nothing may ever
-- modify them through the API (append-only, like all provenance).
DROP POLICY IF EXISTS "admin read properties_row_snapshots" ON properties_row_snapshots;
CREATE POLICY "admin read properties_row_snapshots" ON properties_row_snapshots
  FOR SELECT TO authenticated USING (is_pintag_admin(auth.uid()));

CREATE OR REPLACE FUNCTION snapshot_property_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO properties_row_snapshots (property_id, op, row_data, actor)
    VALUES (OLD.id, 'hard_delete', to_jsonb(OLD),
            coalesce(auth.uid()::text, current_user));
    RETURN OLD;
  ELSE
    INSERT INTO properties_row_snapshots (property_id, op, row_data, actor)
    VALUES (OLD.id, 'soft_delete', to_jsonb(OLD),
            coalesce(auth.uid()::text, current_user));
    RETURN NEW;
  END IF;
END;
$$;

-- Fires on ANY hard delete, from ANY path (API, SQL editor, script) — the
-- snapshot exists even if someone bypasses the application.
DROP TRIGGER IF EXISTS trg_snapshot_property_delete ON properties;
CREATE TRIGGER trg_snapshot_property_delete
  BEFORE DELETE ON properties
  FOR EACH ROW EXECUTE FUNCTION snapshot_property_row();

-- Fires at the moment of soft delete (deleted_at NULL → NOT NULL), so the
-- exact pre-deletion state is on record even though the row remains.
DROP TRIGGER IF EXISTS trg_snapshot_property_softdelete ON properties;
CREATE TRIGGER trg_snapshot_property_softdelete
  BEFORE UPDATE OF deleted_at ON properties
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION snapshot_property_row();

-- ── 3. De-cascade: no delete may silently propagate ─────────────────────────
-- Discover every FK that references properties with ON DELETE CASCADE and
-- convert it to ON DELETE SET NULL (dropping NOT NULL on the referencing
-- column where needed — a detached lead/unit_type keeps existing, which is
-- the point). Known today: leads.property_id, unit_types.property_id,
-- listing_events.property_id — but the loop trusts pg_constraint, not this
-- comment, so schema drift cannot leave a cascade behind.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname,
           cl.relname  AS child_table,
           att.attname AS child_col,
           att.attnotnull
    FROM pg_constraint con
    JOIN pg_class cl      ON cl.oid = con.conrelid
    JOIN pg_namespace n   ON n.oid  = cl.relnamespace
    JOIN pg_attribute att ON att.attrelid = con.conrelid
                         AND att.attnum   = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.properties'::regclass
      AND con.confdeltype = 'c'          -- CASCADE only
      AND n.nspname = 'public'
      AND array_length(con.conkey, 1) = 1
  LOOP
    RAISE NOTICE 'De-cascading %.% (constraint %)', r.child_table, r.child_col, r.conname;
    IF r.attnotnull THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',
                     r.child_table, r.child_col);
    END IF;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',
                   r.child_table, r.conname);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.properties(id) ON DELETE SET NULL',
                   r.child_table, r.conname, r.child_col);
  END LOOP;
END $$;

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- 1. No cascades remain:
--      SELECT conname, conrelid::regclass FROM pg_constraint
--      WHERE confrelid='public.properties'::regclass AND confdeltype='c';
--    → 0 rows.
-- 2. Soft delete a TEST row: UPDATE properties SET deleted_at=now() WHERE id='<test>';
--    → row vanishes from the public site/feed; admin still lists it;
--      properties_row_snapshots has op='soft_delete' with the full row;
--      restore with SET deleted_at=NULL.
-- 3. Hard delete the same TEST row: snapshot op='hard_delete' appears and
--    its leads/unit_types survive with property_id NULL (not deleted).
