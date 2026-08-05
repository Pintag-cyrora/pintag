-- ============================================================================
-- Provenance — Storage Snapshots + Import Payload + Recovery Report
-- ============================================================================
-- Three additive, backward-compatible capabilities on top of
-- import_records / import_images (20260805000000) and listing_provenance
-- (20260805010000):
--
--   1. STORAGE OBJECT SNAPSHOT  — listing_image_snapshots: every image
--      attached to a listing, captured at each create/gallery-change, keyed
--      to the provenance event. Lets us rebuild properties.images purely from
--      provenance if it is ever lost again — no external recovery needed.
--   2. IMPORT PAYLOAD SNAPSHOT  — explicit columns on import_records so the
--      original Smart Import payload (raw JSON, FB URL, original image URLs,
--      extracted metadata, parser version) is first-class and queryable, so a
--      future parser can re-process historical imports.
--   3. RECOVERY REPORT          — listing_recovery_status(uuid): one read-only
--      query answering "what survives for this listing and what can still be
--      reconstructed?" — forever.
--
-- Contract: append-only (no UPDATE/DELETE policies), admin-read only, no FK to
-- properties (plain listing_id → survives deletion), zero impact on normal
-- listing reads (separate table + on-demand functions).
-- ============================================================================

-- ── 1. STORAGE OBJECT SNAPSHOT ──────────────────────────────────────────────
-- One row per image, per snapshot. A snapshot is taken when a listing is
-- created and whenever its gallery changes; each snapshot's rows share one
-- provenance_event_id so "the gallery as of event X" is a single group.
create table if not exists listing_image_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  listing_id          uuid,                    -- PLAIN uuid, NO FK → survives deletion
  provenance_event_id uuid,                    -- listing_provenance.id (plain link)
  storage_bucket      text not null default 'property-images',
  storage_path        text,                    -- storage.objects.name (durable key)
  storage_url         text,                    -- exact URL string on the listing (direct rebuild)
  storage_object_id   uuid,                    -- storage.objects.id, if known
  image_order         int,
  sha256              text,                    -- content checksum, if available
  created_at          timestamptz not null default now()
);
create index if not exists idx_lis_snap_listing on listing_image_snapshots(listing_id, created_at desc);
create index if not exists idx_lis_snap_event   on listing_image_snapshots(provenance_event_id);
create index if not exists idx_lis_snap_path    on listing_image_snapshots(storage_path);
create index if not exists idx_lis_snap_sha     on listing_image_snapshots(sha256);

comment on table listing_image_snapshots is
  'Append-only per-image gallery snapshot taken at listing create + each gallery change, keyed to a listing_provenance event. Plain listing_id (no FK) so it survives listing deletion. rebuild_gallery_snapshot() reconstructs properties.images from the latest snapshot without any external recovery.';

alter table listing_image_snapshots enable row level security;
drop policy if exists "admin read listing_image_snapshots"   on listing_image_snapshots;
create policy "admin read listing_image_snapshots"   on listing_image_snapshots for select to authenticated using (is_pintag_admin(auth.uid()));
drop policy if exists "admin insert listing_image_snapshots" on listing_image_snapshots;
create policy "admin insert listing_image_snapshots" on listing_image_snapshots for insert to authenticated with check (is_pintag_admin(auth.uid()));

-- Rebuild the gallery from the most recent snapshot (mirror of rebuild_gallery,
-- but sourced from the full-gallery snapshot rather than import-only images).
create or replace function rebuild_gallery_snapshot(p_listing uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_pintag_admin(auth.uid()) then
    raise exception 'admin only';
  end if;
  return (
    with latest as (
      select provenance_event_id
      from listing_image_snapshots
      where listing_id = p_listing
      order by created_at desc
      limit 1
    )
    select coalesce(jsonb_agg(coalesce(s.storage_url, s.storage_path) order by s.image_order), '[]'::jsonb)
    from listing_image_snapshots s
    join latest l on l.provenance_event_id is not distinct from s.provenance_event_id
    where s.listing_id = p_listing
  );
end;
$$;
grant execute on function rebuild_gallery_snapshot(uuid) to authenticated;
comment on function rebuild_gallery_snapshot is
  'Recovery: rebuild a listing''s ordered image URL array from its latest gallery snapshot, independent of the properties row. Admin only.';

-- ── 2. IMPORT PAYLOAD SNAPSHOT ──────────────────────────────────────────────
-- Explicit, queryable columns for the original Smart Import payload. raw_payload
-- already holds the exact-as-received blob; these lift the key parts out so a
-- future parser can find/re-process them without digging through JSON. All
-- nullable → backward compatible with existing rows.
alter table import_records add column if not exists parser_version      text;
alter table import_records add column if not exists original_image_urls jsonb;   -- complete original source URL set (incl. images never saved)
alter table import_records add column if not exists extracted_metadata  jsonb;   -- the parser/AI structured output

comment on column import_records.parser_version      is 'Version of the fetch/parse adapter that produced this import (re-process historical imports when the parser improves).';
comment on column import_records.original_image_urls is 'Complete set of original source image URLs as received (superset of import_images.original_url, which is only the saved subset).';
comment on column import_records.extracted_metadata  is 'Parser/AI structured output (the parsed fields). raw_payload remains the exact-as-received blob; this is the parsed view kept alongside it.';

-- ── 3. RECOVERY REPORT ──────────────────────────────────────────────────────
-- One read-only query: what survives for this listing, and what can still be
-- reconstructed? Works even if the properties row is gone.
create or replace function listing_recovery_status(p_listing uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_exists          boolean := false;
  v_images_live     int := 0;
  v_contact_id      uuid;
  v_owner_id        uuid;
  v_contact_phone   text;
  v_events          int := 0;
  v_latest_import   jsonb;
  v_latest_manual   jsonb;
  v_latest_ai       jsonb;
  v_objects_known   int := 0;
  v_import_imgs     int := 0;
  v_snapshot_imgs   int := 0;
  v_missing_images  boolean;
  v_rebuildable     boolean;
  v_missing_contact boolean;
  v_missing_owner   boolean;
  v_photos_ok       boolean;
  v_identity_ok     boolean;
  v_data_ok         boolean;
  v_confidence      text;
begin
  if not is_pintag_admin(auth.uid()) then
    raise exception 'admin only';
  end if;

  -- Live listing row (may have been deleted).
  select true, coalesce(cardinality(p.images), 0), p.contact_id, p.owner_id
    into v_exists, v_images_live, v_contact_id, v_owner_id
  from properties p where p.id = p_listing;
  v_exists := coalesce(v_exists, false);
  v_images_live := coalesce(v_images_live, 0);
  if v_contact_id is not null then
    select nullif(trim(c.phone), '') into v_contact_phone from contacts c where c.id = v_contact_id;
  end if;

  -- Provenance events.
  select count(*) into v_events from listing_provenance where listing_id = p_listing;

  -- Latest import (with the explicit payload-snapshot columns).
  select to_jsonb(t) into v_latest_import from (
    select id, source_platform, source_url, source_post_id, ai_model,
           prompt_version, parser_version, success, imported_at,
           (original_image_urls is not null) as has_original_image_urls,
           (raw_payload is not null)         as has_raw_payload,
           (extracted_metadata is not null)  as has_extracted_metadata
    from import_records where listing_id = p_listing
    order by imported_at desc limit 1
  ) t;

  -- Latest manual edit (excludes create/delete lifecycle rows).
  select to_jsonb(t) into v_latest_manual from (
    select id, event_type, field_name, actor, created_at
    from listing_provenance
    where listing_id = p_listing and source = 'manual'
      and event_type not in ('listing_created','listing_deleted')
    order by created_at desc limit 1
  ) t;

  -- Latest AI generation.
  select to_jsonb(t) into v_latest_ai from (
    select id, event_type, field_name, created_at
    from listing_provenance
    where listing_id = p_listing
      and (source = 'ai' or event_type in ('ai_generation','smart_import'))
    order by created_at desc limit 1
  ) t;

  -- Storage objects known across BOTH provenance sources.
  select count(distinct storage_path) into v_objects_known from (
    select storage_path from listing_image_snapshots where listing_id = p_listing and storage_path is not null
    union
    select storage_path from import_images          where listing_id = p_listing and storage_path is not null
  ) s;
  select count(*) into v_import_imgs   from import_images          where listing_id = p_listing;
  select count(*) into v_snapshot_imgs from listing_image_snapshots where listing_id = p_listing;

  -- Derived flags.
  v_missing_images  := (v_images_live = 0);
  v_rebuildable     := (v_objects_known > 0);
  v_missing_contact := (v_contact_id is null) or (v_contact_phone is null);
  v_missing_owner   := (v_owner_id is null);

  v_photos_ok   := (v_images_live > 0) or v_rebuildable;
  v_identity_ok := (not v_missing_contact) or (not v_missing_owner)
                   or (v_latest_import is not null and (v_latest_import->>'source_url') is not null);
  v_data_ok     := (v_events > 0) or (v_latest_import is not null);

  -- Confidence: how completely could this listing be reconstructed today?
  if v_photos_ok and v_identity_ok and v_data_ok then
    v_confidence := 'high';
  elsif v_photos_ok and v_data_ok then
    v_confidence := 'medium';
  elsif v_photos_ok or v_data_ok then
    v_confidence := 'low';
  else
    v_confidence := 'none';
  end if;

  return jsonb_build_object(
    'listing_id',          p_listing,
    'listing_row_exists',  v_exists,
    'generated_at',        now(),
    'provenance_events',   v_events,
    'latest_import',       coalesce(v_latest_import, 'null'::jsonb),
    'latest_manual_edit',  coalesce(v_latest_manual, 'null'::jsonb),
    'latest_ai_generation',coalesce(v_latest_ai,     'null'::jsonb),
    'storage', jsonb_build_object(
      'objects_known',       v_objects_known,
      'import_image_rows',   v_import_imgs,
      'snapshot_image_rows', v_snapshot_imgs,
      'images_on_listing',   v_images_live
    ),
    'missing', jsonb_build_object(
      'images',              v_missing_images,
      'images_rebuildable',  v_rebuildable,
      'contact',             v_missing_contact,
      'owner',               v_missing_owner
    ),
    'recovery_confidence', v_confidence
  );
end;
$$;
revoke all on function listing_recovery_status(uuid) from public;
grant execute on function listing_recovery_status(uuid) to authenticated;
comment on function listing_recovery_status is
  'Recovery report: for a listing (even a deleted one), what provenance/imports/snapshots survive and how completely it can be reconstructed. Read-only, admin only.';

-- ============================================================================
-- RECOVERY QUERIES
-- ============================================================================
--  What survives + reconstruction outlook (one query):
--    select listing_recovery_status(:id);
--
--  Rebuild the gallery from the latest full snapshot:
--    select rebuild_gallery_snapshot(:id);      -- → jsonb array of image URLs
--
--  Re-process a historical import with an improved parser:
--    select id, parser_version, original_image_urls, extracted_metadata, raw_payload
--    from import_records where listing_id = :id order by imported_at desc;
-- ============================================================================
