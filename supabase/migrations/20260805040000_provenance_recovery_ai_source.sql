-- ============================================================================
-- Provenance: allow source = 'recovery_ai_generated'
-- ============================================================================
-- Recovery AI titles (generated to make a listing publishable, NOT to reproduce
-- the historical wording) are logged to listing_provenance with a distinct
-- source so they are always auditable and never mistaken for the original.
-- Additive: widens the existing CHECK; no data changes.
-- ============================================================================

alter table listing_provenance drop constraint if exists listing_provenance_source_check;
alter table listing_provenance add constraint listing_provenance_source_check
  check (source in ('import','manual','ai','system','recovery_ai_generated'));
