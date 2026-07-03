-- Marks a published item as simulated (posted through the Publisher's logic
-- and decision-making for real, but no live Meta API call was made because
-- credentials don't exist yet — see brain/org-config.json and
-- pipeline/lib/... META_PUBLISH_MODE). A small, permanent capability, not a
-- throwaway M1 hack: useful for testing the pipeline even after real Meta
-- credentials exist.

alter table content_calendar add column if not exists simulated boolean not null default false;
