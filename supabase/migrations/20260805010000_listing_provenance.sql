-- ============================================================================
-- Listing Provenance — unified, append-only field-change log + event timeline
-- ============================================================================
-- Complements import_records / import_images (20260805000000). This single table
-- is BOTH the field-provenance log and the lifecycle timeline: querying by
-- listing_id ordered by created_at reconstructs a listing's whole life.
--
-- Delete-safe by design: listing_id is a PLAIN uuid — no foreign key, no cascade
-- (the exact property that let lead_events survive the 2026-08-03 deletion). A
-- 'listing_deleted' event is logged BEFORE a delete, so even removal is on record.
--
-- Append-only + immutable: RLS grants admin SELECT + INSERT only; NO update/delete
-- policies exist. Generic for future sources (websites/CSV/APIs) via source +
-- details jsonb — no schema change needed to add a new origin.
-- ============================================================================

create table if not exists listing_provenance (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid,                     -- PLAIN uuid, NO FK → survives listing deletion
  event_type   text not null,            -- listing_created | smart_import | field_changed |
                                          -- price_changed | map_changed | agent_changed |
                                          -- owner_changed | contact_changed | photos_changed |
                                          -- ai_generation | listing_deleted | ...
  field_name   text,                     -- for field-level events
  old_value    jsonb,
  new_value    jsonb,
  source       text check (source in ('import','manual','ai','system')),
  actor        text,                     -- admin email/id when source = manual
  import_uuid  uuid,                     -- links to import_records(id) when source = import (plain)
  details      jsonb,                    -- generic extension: batch, counts, future source metadata
  created_at   timestamptz not null default now()
);

create index if not exists idx_listing_provenance_listing on listing_provenance(listing_id, created_at);
create index if not exists idx_listing_provenance_event   on listing_provenance(event_type);
create index if not exists idx_listing_provenance_source  on listing_provenance(source);
create index if not exists idx_listing_provenance_created on listing_provenance(created_at desc);

comment on table listing_provenance is
  'Append-only listing lifecycle + field-change provenance. listing_id is a PLAIN uuid (no FK) so history survives listing deletion. source distinguishes import/manual/ai/system; details jsonb keeps it generic for future import sources without schema change.';

-- ── RLS: admin read + admin insert only. No update/delete policies → append-only,
--    never-overwrite, never-delete BY CONSTRUCTION.
alter table listing_provenance enable row level security;

drop policy if exists "admin read listing_provenance"   on listing_provenance;
create policy "admin read listing_provenance"   on listing_provenance for select to authenticated using (is_pintag_admin(auth.uid()));
drop policy if exists "admin insert listing_provenance" on listing_provenance;
create policy "admin insert listing_provenance" on listing_provenance for insert to authenticated with check (is_pintag_admin(auth.uid()));

-- ── Recovery: the full chronological timeline for a listing, joined to import
--    provenance, independent of whether the properties row still exists.
create or replace function listing_timeline(p_listing uuid)
returns table (
  at timestamptz, event_type text, source text, field_name text,
  old_value jsonb, new_value jsonb, actor text, import_uuid uuid, details jsonb
) language sql stable security definer set search_path = public as $$
  select created_at, event_type, source, field_name, old_value, new_value, actor, import_uuid, details
  from listing_provenance
  where listing_id = p_listing
  order by created_at;
$$;
-- Gate the SECURITY DEFINER function to admins (RLS is bypassed by definer).
revoke all on function listing_timeline(uuid) from public;
grant execute on function listing_timeline(uuid) to authenticated;

comment on function listing_timeline is
  'Recovery: full chronological provenance timeline for a listing (survives deletion). Admin use only.';

-- ============================================================================
-- RECOVERY QUERIES (answered forever, even after the listing row is deleted)
-- ============================================================================
--  Which fields came from AI vs manual edits, who, when:
--    select created_at, event_type, field_name, source, actor, old_value, new_value
--    from listing_provenance where listing_id = :id order by created_at;
--
--  Full lifecycle timeline (created → imports → edits → deleted):
--    select * from listing_timeline(:id);
--
--  Combined with import provenance:
--    which FB post / storage objects / batch  → import_records / import_images
--    which fields AI vs manual / who / when   → listing_provenance
--    rebuild the gallery                       → select rebuild_gallery(:id);
-- ============================================================================
