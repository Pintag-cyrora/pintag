-- Add facebook_video_url column to properties table
ALTER TABLE properties ADD COLUMN IF NOT EXISTS facebook_video_url TEXT;
