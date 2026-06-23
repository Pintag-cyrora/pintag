-- Track which property listings have had their images watermarked
ALTER TABLE properties ADD COLUMN IF NOT EXISTS images_watermarked BOOLEAN DEFAULT false;
