-- Minimal stand-ins for the tables scripts/image-integrity.py reads.
CREATE SCHEMA storage;
CREATE TABLE storage.objects (name text, bucket_id text);
CREATE TABLE properties (id uuid PRIMARY KEY, images jsonb);
CREATE TABLE property_images (property_id uuid, storage_path text, storage_bucket text DEFAULT 'property-images',
  status text DEFAULT 'active', is_cover boolean DEFAULT false, display_order int DEFAULT 0, sha256 text);
CREATE TABLE unit_types (id uuid DEFAULT gen_random_uuid(), property_id uuid, images text[]);
