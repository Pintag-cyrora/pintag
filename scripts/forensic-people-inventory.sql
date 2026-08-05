-- ============================================================================
-- forensic-people-inventory.sql — READ-ONLY people & ownership forensics
-- ============================================================================
-- Produces the data for Reports 1–6 + the executive summary. Every statement is
-- a SELECT. Do NOT run any UPDATE/INSERT/DELETE/DDL. Column names are the real
-- ones confirmed from the schema (parties has whatsapp/email/facebook_url but NO
-- phone; contacts/owners hold phone; lead_events.agent_id is mixed → OR join).
-- Run each block and paste results; the narrative reports are compiled from them.
-- ============================================================================

-- ── DISCOVERY ───────────────────────────────────────────────────────────────
-- D1: every table (catches any archive/backup/import/history/cache/snapshot)
select table_name, table_type from information_schema.tables
where table_schema='public' order by table_name;

-- D2: every column that could hold a person or a person-reference
select table_name, column_name, data_type from information_schema.columns
where table_schema='public'
  and (column_name ~* 'party|agent|owner|contact|created_by|auth_user|phone|whatsapp|email|facebook|instagram|tiktok|name|slug|customer'
       or data_type='uuid')
order by table_name, column_name;

-- D3: the unknown `listings` table
select count(*) as listings_rows from listings;
select * from listings limit 10;

-- ============================================================================
-- REPORT 1 — PEOPLE INVENTORY (unified, every person found)
-- ============================================================================
with party_people as (
  select case p.type when 'staff' then 'Internal' when 'owner' then 'Owner'
                     when 'agent' then 'Agent' else coalesce(p.type,'Unknown') end as classification,
         coalesce(p.name_en,p.name_lo,p.slug) as name,
         null::text as phone, p.whatsapp, p.email, p.facebook_url,
         p.id as party_id, null::uuid as contact_id, null::uuid as owner_id, p.auth_user_id
  from parties p
),
contact_people as (
  select 'Contact', c.name, c.phone, c.whatsapp, null, null,
         c.party_id, c.id, null::uuid, null::uuid
  from contacts c
),
owner_people as (
  select 'Owner', o.name, o.phone, o.whatsapp, o.email, null,
         o.party_id, null::uuid, o.id, null::uuid
  from owners o
)
select * from party_people
union all select * from contact_people
union all select * from owner_people
order by classification, name;

-- Reference count per party (how many places each identity appears)
select coalesce(p.name_en,p.name_lo,p.slug) as name, p.type, p.id as party_id,
  (select count(*) from properties where managed_by_party_id=p.id)                    as as_agent_on_properties,
  (select count(*) from contacts where party_id=p.id)                                 as contact_cards,
  (select count(*) from owners   where party_id=p.id)                                 as owner_cards,
  (select count(*) from leads    where party_id=p.id)                                 as leads,
  (select count(*) from lead_events le where le.agent_id=p.id or le.agent_id=p.auth_user_id) as lead_events
from parties p order by name;

-- ============================================================================
-- REPORT 2 — MISSING PEOPLE (referenced but absent, or dangling links)
-- ============================================================================
-- 2a: lead_events agent_ids that resolve to NO party (missing agent identities)
select distinct le.agent_id, count(*) over (partition by le.agent_id) as events
from lead_events le
where le.agent_id is not null
  and not exists (select 1 from parties p where p.id=le.agent_id or p.auth_user_id=le.agent_id);

-- 2b: contacts/owners whose party_id points to a non-existent party (unlinked)
select 'contact' src, c.id, c.name, c.party_id from contacts c
  where c.party_id is not null and not exists (select 1 from parties p where p.id=c.party_id)
union all
select 'owner', o.id, o.name, o.party_id from owners o
  where o.party_id is not null and not exists (select 1 from parties p where p.id=o.party_id);

-- 2c: agent parties with NO reachable contact info at all (present but thin)
select id, coalesce(name_en,name_lo,slug) name, whatsapp, email, facebook_url
from parties where type='agent'
  and whatsapp is null and email is null and facebook_url is null;

-- ============================================================================
-- REPORT 3 — LISTING RECOVERY PER PERSON (parties)
-- ============================================================================
select coalesce(p.name_en,p.name_lo,p.slug) as name, p.id as party_id,
  count(pr.id)                                                                          as total_linked,
  count(pr.id) filter (where pr.status='draft' or pr.workflow_status='draft')           as drafts,
  count(pr.id) filter (where pr.status in ('active','available'))                       as published,
  count(pr.id) filter (where pr.images is null
                        or jsonb_typeof(pr.images)<>'array'
                        or jsonb_array_length(pr.images)=0)                             as missing_photos,
  count(pr.id) filter (where pr.contact_id is null and pr.owner_id is null)             as missing_contact_owner,
  (select count(distinct le.listing_id) from lead_events le
     where (le.agent_id=p.id or le.agent_id=p.auth_user_id)
       and le.listing_id in (select id from properties where workflow_status='draft')) as recoverable_if_restored
from parties p
left join properties pr on pr.managed_by_party_id=p.id
group by p.id, name
order by recoverable_if_restored desc, total_linked desc;

-- ============================================================================
-- REPORT 4 — DATABASE FORENSICS (duplicates = probably the same person)
-- ============================================================================
-- WhatsApp across all three tables
with allw as (
  select 'party' t, id::text, whatsapp from parties  where whatsapp is not null
  union all select 'contact', id::text, whatsapp from contacts where whatsapp is not null
  union all select 'owner',   id::text, whatsapp from owners   where whatsapp is not null)
select whatsapp, count(*) n, array_agg(t||':'||id) refs from allw group by whatsapp having count(*)>1;
-- Phone (contacts + owners)
with allp as (
  select 'contact' t, id::text, phone from contacts where phone is not null
  union all select 'owner', id::text, phone from owners where phone is not null)
select phone, count(*) n, array_agg(t||':'||id) refs from allp group by phone having count(*)>1;
-- Email (parties + owners)
with alle as (
  select 'party' t, id::text, lower(email) email from parties where email is not null
  union all select 'owner', id::text, lower(email) from owners where email is not null)
select email, count(*) n, array_agg(t||':'||id) refs from alle group by email having count(*)>1;
-- Facebook URL (parties)
select facebook_url, count(*) n, array_agg(id) from parties where facebook_url is not null group by facebook_url having count(*)>1;
-- Name (all three, normalized)
with alln as (
  select 'party' t, id::text, lower(trim(coalesce(name_en,name_lo))) nm from parties
  union all select 'contact', id::text, lower(trim(name)) from contacts
  union all select 'owner', id::text, lower(trim(name)) from owners)
select nm, count(*) n, array_agg(t||':'||id) refs from alln where nm<>'' group by nm having count(*)>1;

-- ============================================================================
-- REPORT 5 — UNKNOWN LISTINGS (recovery-path classification, DB sources only)
-- Wayback/Facebook/Storage are external (pending) — a 🔴 here is NOT "lost",
-- only "no DB path yet"; external sources can still promote it.
-- ============================================================================
select
  count(*) filter (where has_agent_link or has_contact or has_owner)                      as green_high,      -- live identity link
  count(*) filter (where not (has_agent_link or has_contact or has_owner) and has_agent_event) as yellow_evidence, -- lead_events agent → outreach
  count(*) filter (where not (has_agent_link or has_contact or has_owner) and not has_agent_event and has_removal_meta) as orange_human, -- metadata only → Wayback/FB/manual
  count(*) filter (where not (has_agent_link or has_contact or has_owner) and not has_agent_event and not has_removal_meta) as red_none
from (
  select pr.id,
    pr.managed_by_party_id is not null as has_agent_link,
    pr.contact_id is not null          as has_contact,
    pr.owner_id  is not null           as has_owner,
    exists(select 1 from lead_events le where le.listing_id=pr.id and le.agent_id is not null) as has_agent_event,
    exists(select 1 from properties_removal_log rl where rl.property_id=pr.id and rl.title_lo is not null) as has_removal_meta
  from properties pr where pr.workflow_status='draft'
) x;

-- Per-listing detail for the classification (join to Wayback/Storage later)
select pr.id, pr.title_lo, pr.district_en, pr.property_type,
  pr.managed_by_party_id is not null as has_agent_link,
  exists(select 1 from lead_events le where le.listing_id=pr.id and le.agent_id is not null) as has_agent_event
from properties pr where pr.workflow_status='draft'
order by has_agent_event desc, pr.district_en;

-- ============================================================================
-- REPORT 6 — RECOVERY IMPACT (rank people by recoverable listings)
-- ============================================================================
with le as (
  select distinct listing_id, agent_id from lead_events
  where listing_id in (select id from properties where workflow_status='draft') and agent_id is not null)
select coalesce(p.name_en,p.name_lo,p.slug) as name,
       count(distinct le.listing_id) as recoverable_listings,
       p.whatsapp, p.email, p.facebook_url,
       case when p.facebook_url is not null then 'High (FB + WhatsApp)'
            when p.whatsapp is not null then 'Medium (WhatsApp outreach)'
            else 'Low (no reachable channel)' end as recovery_confidence
from le join parties p on (p.id=le.agent_id or p.auth_user_id=le.agent_id)
group by p.id, name, p.whatsapp, p.email, p.facebook_url
order by recoverable_listings desc;

-- ============================================================================
-- EXECUTIVE SUMMARY counts
-- ============================================================================
select
 (select count(*) from parties where type='agent')                            as agents,
 (select count(*) from parties where type='owner')                            as owner_parties,
 (select count(*) from owners)                                                as owners,
 (select count(*) from contacts)                                              as contacts,
 (select count(*) from parties where type='staff')                            as internal,
 (select count(*) from properties where managed_by_party_id is not null)      as listings_agent_linked,
 (select count(*) from properties where workflow_status='draft')              as recovered_drafts,
 (select count(distinct le.listing_id) from lead_events le
    join parties p on (p.id=le.agent_id or p.auth_user_id=le.agent_id)
    where le.listing_id in (select id from properties where workflow_status='draft')) as drafts_with_agent_path;

-- ============================================================================
-- REPORT 7 — INDIRECT RECOVERY & PRIORITY MATRIX (read-only)
-- "If I contact this person today, how many could realistically be restored?"
-- = direct (hard link) + indirect (same district/type they operate in — soft,
--   the agent confirms on contact). Facebook/photos widen it further.
-- ============================================================================

-- 7a: Per reachable agent — DIRECT recoverable + INDIRECT candidates among the 79
with agent_scope as (
  select p.id party_id, coalesce(p.name_en,p.name_lo,p.slug) name, p.whatsapp, p.facebook_url,
         array_agg(distinct pr.district_en) filter (where pr.district_en is not null) districts,
         array_agg(distinct pr.property_type) filter (where pr.property_type is not null) types,
         count(distinct le.listing_id) direct_recoverable
  from lead_events le
  join parties p on (p.id=le.agent_id or p.auth_user_id=le.agent_id)
  join properties pr on pr.id=le.listing_id
  where le.listing_id in (select id from properties where workflow_status='draft')
  group by p.id, name, p.whatsapp, p.facebook_url
),
unknowns as (
  select pr.id, pr.district_en, pr.property_type from properties pr
  where pr.workflow_status='draft'
    and not exists (select 1 from lead_events le where le.listing_id=pr.id and le.agent_id is not null)
)
select s.name, s.whatsapp, s.facebook_url, s.direct_recoverable,
  (select count(*) from unknowns u where u.district_en = any(s.districts)) as indirect_same_district,
  (select count(*) from unknowns u where u.district_en = any(s.districts)
                                      and u.property_type = any(s.types))   as indirect_same_district_and_type
from agent_scope s
order by s.direct_recoverable desc, indirect_same_district_and_type desc;

-- 7b: Strongest recovery path per draft listing (DB sources; external layers on top)
select pr.id, pr.title_lo, pr.district_en, pr.property_type,
  case
    when pr.managed_by_party_id is not null then 'Agent (direct link)'
    when pr.owner_id  is not null then 'Owner'
    when pr.contact_id is not null then 'Contact'
    when exists(select 1 from lead_events le where le.listing_id=pr.id and le.agent_id is not null) then 'Agent (lead_events)'
    when exists(select 1 from properties_removal_log rl where rl.property_id=pr.id and rl.title_lo is not null)
         then 'Removal-log metadata only (needs Facebook/Wayback/Storage)'
    else 'None in DB (external pending)'
  end as strongest_db_path
from properties pr where pr.workflow_status='draft'
order by strongest_db_path, pr.district_en;

-- 7c: Credible paths per listing (agent/owner/contact/lead-event = path to photos+identity;
--     removal-log metadata is NOT counted as a credible identity/photo path)
select
  count(*)                                                            as recovered_drafts,
  count(*) filter (where credible >= 1)                              as at_least_one_credible_path,
  count(*) filter (where credible >= 2)                              as multiple_credible_paths
from (
  select pr.id,
    (case when pr.managed_by_party_id is not null then 1 else 0 end
    +case when pr.owner_id  is not null then 1 else 0 end
    +case when pr.contact_id is not null then 1 else 0 end
    +case when exists(select 1 from lead_events le where le.listing_id=pr.id and le.agent_id is not null) then 1 else 0 end
    ) as credible
  from properties pr where pr.workflow_status='draft'
) x;

-- ============================================================================
-- REPORT 8 — OWNER RECOVERY (read-only)  [priority pivot: owners, not agents]
-- The owner->listing link for the 91 was destroyed (owner_id was on the deleted
-- rows; removal_log has no owner; leads cascaded). owners survives as a contact
-- list only. 8b confirms how many of the 91 still carry an owner link (expect ~0).
-- ============================================================================

-- 8a: Every owner — contact info, Facebook via linked party, current links + notes
select o.id as owner_id, o.name, o.phone, o.whatsapp, o.email, p.facebook_url,
  (select count(*) from properties pr where pr.owner_id=o.id)                              as current_listings,
  (select count(*) from properties pr where pr.owner_id=o.id
     and (pr.status='draft' or pr.workflow_status='draft'))                                as draft_listings,
  o.notes
from owners o
left join parties p on p.id=o.party_id
order by current_listings desc, o.name;

-- 8b: How many of the 91 still have a surviving owner link (expected ~0)
select count(*) as drafts_with_owner_link
from properties where workflow_status='draft' and owner_id is not null;

-- 8c: Owner totals + reachability
select count(*)                                                        as total_owners,
       count(*) filter (where phone is not null or whatsapp is not null) as reachable,
       count(*) filter (where email is not null)                        as with_email,
       count(*) filter (where party_id is not null)                     as linked_to_party
from owners;

-- 8d: Same-person merge candidates across owners + contacts + parties
with w as (
  select 'owner' t, id::text, whatsapp v from owners   where whatsapp is not null
  union all select 'contact', id::text, whatsapp from contacts where whatsapp is not null
  union all select 'party',   id::text, whatsapp from parties  where whatsapp is not null)
select 'whatsapp' kind, v, count(*) n, array_agg(t||':'||id) refs from w group by v having count(*)>1
union all
select 'phone', phone, count(*), array_agg(t||':'||id) from (
  select 'owner' t, id::text, phone from owners where phone is not null
  union all select 'contact', id::text, phone from contacts where phone is not null) z
  group by phone having count(*)>1
union all
select 'name', nm, count(*), array_agg(t||':'||id) from (
  select 'owner' t, id::text, lower(trim(name)) nm from owners
  union all select 'contact', id::text, lower(trim(name)) from contacts
  union all select 'party', id::text, lower(trim(coalesce(name_en,name_lo))) from parties) z
  where nm<>'' group by nm having count(*)>1;

-- 8e: Owner info that may be hidden/unlinked in free text
select id, name, phone, whatsapp, notes from owners where notes is not null and notes<>'';
