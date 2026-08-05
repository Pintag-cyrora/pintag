-- ============================================================================
-- Smart Import Provenance v2 — durable, append-only, DELETE-SAFE recovery trail
-- ============================================================================
-- Direct lesson from the 2026-08-03 incident: the ONE table whose data survived
-- the mass listing deletion (lead_events) survived precisely because it had NO
-- foreign key to properties. Everything with an FK either cascaded away or was
-- on the deleted row. So provenance links to a listing by a PLAIN uuid with NO
-- foreign key and NO cascade — deleting a listing can NEVER remove its
-- provenance. This is the whole point: months from now we can still answer
-- "which Facebook post / which storage objects made this listing?" and rebuild
-- the gallery from storage even if the properties row is gone.
--
-- Contract: append-only (no UPDATE/DELETE policies), admin-read only, does not
-- affect the public listing in any way.
-- ============================================================================

-- One append-only row per import event (re-import = a NEW row, never a replace).
create table if not exists import_records (
  id                uuid primary key default gen_random_uuid(),   -- the Import UUID
  listing_id        uuid,                    -- PLAIN uuid, NO FK → survives listing deletion
  batch_id          uuid,                    -- groups a batch import
  source_platform   text,                    -- 'facebook' | 'marketplace' | 'manual' | ...
  source_url        text,                    -- original source URL
  source_post_id    text,                    -- extracted post/item id, if any
  slug_at_import    text,                    -- slug at import time
  listing_status    text,                    -- workflow_status at import time
  import_version    text not null default '2',
  ai_model          text,                    -- e.g. 'gemini-2.5-flash'
  prompt_version    text,
  success           boolean not null default true,
  confidence        numeric,                 -- optional overall confidence
  raw_payload       jsonb,                   -- THE import_manifest: full raw payload
  imported_at       timestamptz not null default now()
);
create index if not exists idx_import_records_listing     on import_records(listing_id);
create index if not exists idx_import_records_batch        on import_records(batch_id);
create index if not exists idx_import_records_source_post  on import_records(source_post_id);
create index if not exists idx_import_records_imported_at  on import_records(imported_at desc);

-- Permanent per-image mapping: source URL → storage object → listing.
create table if not exists import_images (
  id                uuid primary key default gen_random_uuid(),
  import_id         uuid references import_records(id) on delete restrict, -- provenance-internal only; import_records is never deleted
  listing_id        uuid,                    -- PLAIN uuid, NO FK → survives listing deletion
  original_url      text,                    -- original source image URL (e.g. FB CDN)
  storage_url       text,                    -- full public URL (rebuild the gallery straight from this)
  storage_path      text,                    -- storage.objects.name (the durable object key)
  storage_object_id uuid,                    -- storage.objects.id, if captured
  sha256            text,                    -- content fingerprint
  uploaded_at       timestamptz,
  image_order       int
);
create index if not exists idx_import_images_listing      on import_images(listing_id);
create index if not exists idx_import_images_import        on import_images(import_id);
create index if not exists idx_import_images_storage_path  on import_images(storage_path);
create index if not exists idx_import_images_sha256        on import_images(sha256);

comment on table import_records is
  'Smart Import Provenance v2 — one append-only row per import. listing_id is a PLAIN uuid (no FK) so a listing deletion never removes its provenance. raw_payload is the full import_manifest (raw evidence, survives any future Smart Import redesign).';
comment on table import_images is
  'Permanent original-URL → storage-object → listing mapping. Survives listing deletion (plain listing_id, no FK). rebuild_gallery() reconstructs images[] from storage_url even if the properties row is gone.';

-- ── RLS: admin-read + admin-insert only. NO update/delete policies exist, so
--    provenance is append-only and never-delete BY CONSTRUCTION (only a
--    superuser/migration could ever alter it). Never exposed publicly.
alter table import_records enable row level security;
alter table import_images  enable row level security;

drop policy if exists "admin read import_records"   on import_records;
create policy "admin read import_records"   on import_records for select to authenticated using (is_pintag_admin(auth.uid()));
drop policy if exists "admin insert import_records" on import_records;
create policy "admin insert import_records" on import_records for insert to authenticated with check (is_pintag_admin(auth.uid()));

drop policy if exists "admin read import_images"    on import_images;
create policy "admin read import_images"    on import_images for select to authenticated using (is_pintag_admin(auth.uid()));
drop policy if exists "admin insert import_images"  on import_images;
create policy "admin insert import_images"  on import_images for insert to authenticated with check (is_pintag_admin(auth.uid()));

-- ── Recovery affordance: rebuild a listing's gallery from provenance alone,
--    even if the properties row was deleted. Returns a jsonb array of URLs,
--    directly assignable to properties.images.
create or replace function rebuild_gallery(p_listing uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_pintag_admin(auth.uid()) then
    raise exception 'admin only';
  end if;
  return (
    select coalesce(jsonb_agg(storage_url order by image_order), '[]'::jsonb)
    from import_images
    where listing_id = p_listing and storage_url is not null
  );
end;
$$;
grant execute on function rebuild_gallery(uuid) to authenticated;

comment on function rebuild_gallery is
  'Recovery: rebuild a listing''s ordered image URL array from import_images provenance, independent of the properties row. Admin only.';

-- ============================================================================
-- RECOVERY QUERIES (for the future — provenance answers these forever)
-- ============================================================================
--  Which Facebook post created this listing?
--    select source_platform, source_url, source_post_id, imported_at
--    from import_records where listing_id = :id order by imported_at;
--
--  Which storage objects / original URLs belong to this listing?
--    select image_order, original_url, storage_path, storage_url, sha256
--    from import_images where listing_id = :id order by image_order;
--
--  Which import batch created it?
--    select distinct batch_id from import_records where listing_id = :id;
--
--  Rebuild the gallery if the listing row is lost:
--    select rebuild_gallery(:id);          -- → jsonb array of image URLs
-- ============================================================================
