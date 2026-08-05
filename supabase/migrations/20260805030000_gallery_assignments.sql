-- ============================================================================
-- Gallery Assignment Register — append-only audit trail for Phase 2 photo recovery
-- ============================================================================
-- Every gallery assign and unassign performed in gallery-recovery.html is logged
-- here: which photos went to (or came off) which listing, by whom, when, and at
-- what confidence. This is the PERMANENT provenance for photo→listing
-- reconnection — independent of properties.images, so the reconstruction remains
-- fully traceable even if a listing's images array is later changed or the row
-- is deleted (plain listing_id, no FK — the delete-safe pattern used throughout).
--
-- Append-only + immutable: admin SELECT + INSERT only, NO update/delete policies.
-- An "undo" is a NEW 'unassign' row (never a mutation of the assign row).
-- ============================================================================

create table if not exists gallery_assignments (
  id           uuid primary key default gen_random_uuid(),
  op           text not null check (op in ('assign','unassign')),
  listing_id   uuid,                     -- PLAIN uuid, NO FK → survives listing deletion
  cluster_id   text,                     -- upload-burst id (first photo of the burst); assign only
  photo_paths  jsonb not null,           -- storage object paths assigned / removed (NOT the URLs on the row)
  photo_count  int,
  confidence   text check (confidence in ('high','medium','low')),  -- assign only
  method       text default 'manual',    -- assignment type
  operator     text,                     -- admin email who performed it
  created_at   timestamptz not null default now()
);

create index if not exists idx_gallery_assign_listing on gallery_assignments(listing_id, created_at);
create index if not exists idx_gallery_assign_op       on gallery_assignments(op);
create index if not exists idx_gallery_assign_conf     on gallery_assignments(confidence);
create index if not exists idx_gallery_assign_created  on gallery_assignments(created_at desc);

comment on table gallery_assignments is
  'Append-only audit trail of Phase 2 gallery recovery. Every assign/unassign is logged with photo paths, operator, confidence — the permanent provenance for photo→listing reconnection, independent of properties.images. Plain listing_id (no FK) survives listing deletion. Undo = a new unassign row, never a mutation.';

alter table gallery_assignments enable row level security;
drop policy if exists "admin read gallery_assignments"   on gallery_assignments;
create policy "admin read gallery_assignments"   on gallery_assignments for select to authenticated using (is_pintag_admin(auth.uid()));
drop policy if exists "admin insert gallery_assignments" on gallery_assignments;
create policy "admin insert gallery_assignments" on gallery_assignments for insert to authenticated with check (is_pintag_admin(auth.uid()));

-- ============================================================================
-- AUDIT QUERIES
-- ============================================================================
--  Full history for a listing (assigns + undos, chronological):
--    select created_at, op, cluster_id, photo_count, confidence, operator, photo_paths
--    from gallery_assignments where listing_id = :id order by created_at;
--
--  Everything still low-confidence (to revisit):
--    select ga.listing_id, ga.created_at, ga.photo_count
--    from gallery_assignments ga
--    where ga.op='assign' and ga.confidence='low'
--    order by ga.created_at desc;
--
--  Reconstruct the current intended gallery from provenance (assigns minus later
--  unassigns) — independent of properties.images.
-- ============================================================================
