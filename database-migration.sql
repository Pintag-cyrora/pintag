-- Pintag Multilingual Listing Content Migration
-- Run this in your Supabase SQL Editor (Database → SQL Editor)
-- Safe to run multiple times (uses IF NOT EXISTS / WHERE clause guards)

-- ── Property Highlight (multilingual) ──────────────────────────────
ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_highlight_en TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_highlight_lo TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_highlight_zh TEXT;

-- Migrate existing single-language data to the English column
UPDATE properties
SET property_highlight_en = property_highlight
WHERE property_highlight IS NOT NULL AND property_highlight_en IS NULL;

-- ── Neighborhood Insight (multilingual) ────────────────────────────
ALTER TABLE properties ADD COLUMN IF NOT EXISTS neighborhood_insight_en TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS neighborhood_insight_lo TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS neighborhood_insight_zh TEXT;

-- Migrate existing neighborhood_description to the English column
UPDATE properties
SET neighborhood_insight_en = neighborhood_description
WHERE neighborhood_description IS NOT NULL AND neighborhood_insight_en IS NULL;

-- ── Sale or Rent — dual pricing ────────────────────────────────────
ALTER TABLE properties ADD COLUMN IF NOT EXISTS sale_price TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rent_price TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rent_period TEXT;

-- ── Verify ─────────────────────────────────────────────────────────
-- After running, confirm the new columns exist:
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'properties'
  AND column_name IN (
    'property_highlight_en', 'property_highlight_lo', 'property_highlight_zh',
    'neighborhood_insight_en', 'neighborhood_insight_lo', 'neighborhood_insight_zh',
    'sale_price', 'rent_price', 'rent_period'
  )
ORDER BY column_name;
