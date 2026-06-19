-- Pintag Marketing Kit Migration
-- Run this in Supabase SQL Editor (Database → SQL Editor)
-- Safe to run multiple times

-- ── marketing_assets table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_assets (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id        UUID REFERENCES properties(id) ON DELETE CASCADE,
  facebook_post     TEXT,
  tiktok_caption    TEXT,
  instagram_caption TEXT,
  flyer_json        JSONB,
  video_script_json JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint per listing (one marketing kit per property)
CREATE UNIQUE INDEX IF NOT EXISTS marketing_assets_listing_id_key
  ON marketing_assets(listing_id);

-- ── Row Level Security ─────────────────────────────────────────────
ALTER TABLE marketing_assets ENABLE ROW LEVEL SECURITY;

-- Allow anon to read marketing assets (cached content on listing page)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'marketing_assets' AND policyname = 'anon_select_marketing_assets'
  ) THEN
    CREATE POLICY anon_select_marketing_assets
      ON marketing_assets FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- Allow anon to insert (agents generate kits)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'marketing_assets' AND policyname = 'anon_insert_marketing_assets'
  ) THEN
    CREATE POLICY anon_insert_marketing_assets
      ON marketing_assets FOR INSERT TO anon WITH CHECK (true);
  END IF;
END $$;

-- Allow anon to update (regenerate replaces cached content)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'marketing_assets' AND policyname = 'anon_update_marketing_assets'
  ) THEN
    CREATE POLICY anon_update_marketing_assets
      ON marketing_assets FOR UPDATE TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── Auto-update updated_at ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_marketing_assets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS marketing_assets_updated_at ON marketing_assets;
CREATE TRIGGER marketing_assets_updated_at
  BEFORE UPDATE ON marketing_assets
  FOR EACH ROW EXECUTE FUNCTION update_marketing_assets_updated_at();

-- ── Verify ─────────────────────────────────────────────────────────
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'marketing_assets'
ORDER BY ordinal_position;
