# Pintag Recovery Evidence Register — SINGLE SOURCE OF TRUTH

**Purpose:** the authoritative catalogue of every source that can recover data for
the 91 listings deleted in the 2026-08-03 incident. No recovery `UPDATE` is
proposed except against a source recorded here with its confidence and coverage.

**Last updated:** 2026-08-05 · **Status:** investigation (recovery paused until the
DR restore drill passes).

## Governing principles (apply to every entry)
1. Never overwrite existing recovered data (fill-only-when-empty).
2. Every recovery operation idempotent; every batch reversible (txn + pre-COMMIT diff).
3. Evidence before UPDATEs.
4. Prefer **authoritative** sources (production data, Storage, Facebook, Wayback) over inference.
5. **Timestamp correlation is supporting evidence only** — never the sole basis for auto-attaching images (flag "Needs Review").

Confidence: **High** = restorable without guessing · **Medium** = authoritative but partial/needs a match · **Needs Review** = inference, human confirmation required.

---

## Production measurements & current assessment (2026-08-05)
- **Agents:** 12/91 listings have a recoverable agent — **10 = operator (Keomany) self-restore**, **6 external** (Tik 3, Pee 2, Sivone 1); 79 agent-unknown.
- **Owners:** **12 owner records, 100% WhatsApp-reachable**, 0 email, 0 party-linked; only **1 draft** retains `owner_id`; **Beta Xin is a duplicate**. Identities survived — owner→listing relationships lost.
- **Contacts / parties:** high-reference identities survived (Keomany, Pee Malaisone, Sivone, Daeng Xayalert, Mo Siliphong, Viengkhone Phomthavong). What was lost is the **person↔property relationship**, not the people.
- **Photos:** **no surviving DB link** photo→listing — the biggest technical blocker.

**Executive assessment**
- **Listings with ≥1 credible recovery path:** **12 / 91 (~13%) confirmed**; **79 pending** (Wayback covers + owner/agent outreach); **0 exhausted**.
- **Biggest blocker to reopening:** the **photo→listing relationship** (0 galleries attached; no surviving DB link).
- **Highest-impact technical action:** run **E9 Wayback CDX** — the only automatic cover source.
- **Highest-impact business action:** **contact the 12 reachable owners** to identify + re-supply galleries.

---

## Register

| # | Source | Fields it can recover | Confidence | Authoritative | Auto / Manual | Est. coverage (of 91) | Status |
|---|--------|-----------------------|------------|---------------|---------------|-----------------------|--------|
| 1 | **`properties_removal_log`** | `id`, `title_lo`, `property_type`, `district_en`, `transaction_type`; also `status_at_removal` (orig status), `listed_at` (orig `created_at`) | High | ✅ Yes (prod) | Auto | **91/91** (defines the recoverable set) | ✅ 5 fields applied (P8); `status_at_removal` + `listed_at` still available |
| 2 | **Storage `property-images` (files)** | the edited photo **assets** themselves (cover + full galleries) — *files only, not the listing link* | High (files exist) | ✅ Yes (prod) | Auto (files) | **~100% of files physically exist** | ⬜ confirm count via storage query; **back up first (Priority Zero)** |
| 3 | **OG-worker capture** via Wayback / OG / WhatsApp / FB link-preview | `slug`, `title`(per lang), `price`(formatted), `currency`, `district`, description **snippet**, `market_status`, **cover image (`images[0]`) only** | High (per captured listing) | ✅ Yes | Auto (parse OG tags) | **= W/91** (W = # slugs archived; unknown until CDX) | ⬜ pending Wayback CDX run |
| 4 | **Facebook source posts** | **full image gallery (≤10)**, title, description, `price_display`, **poster = owner/agent** | High (if post matched) | ✅ Yes | Manual/semi-auto (FB→listing link was not stored) | unknown subset (FB-originated + still live) | ⬜ pending; **only authoritative full-gallery source**. ⚠️ unauthenticated fetch exposes **≤1 photo** — the full gallery sits behind FB's login wall, so it needs authenticated access (more manual) |
| 5 | **`lead_events`** (survived — `listing_id`/`agent_id` have **no FK**) | **agent only**, per listing via `lead_events.agent_id` → **`parties.id` OR `parties.auth_user_id`** (agent_id is **mixed**: 29 rows match party_id, 20 auth_user_id — always use an OR join) | Medium–High | ✅ Yes (prod) | Auto | **12/91** (16 links; 4 agents — Keomany 10, Tik 3, Pee 2, Sivone 1; **only Tik has `facebook_url`**). Other **79 = agent relationship currently unknown (Pending Evidence)**, NOT orphans | ✅ measured 2026-08-05; **`leads` CASCADED — see correction below** |
| 6 | **`parties` / `contacts` / `owners` tables** | agent/owner/contact **identities**: name, phone, WhatsApp, email, party relationship | High (identities intact) | ✅ Yes (prod) | Auto (identity) / Manual (per-listing link) | identities **100% present**; per-listing assignment partial | ✅ tables survived; link via #5/#4 |
| 7 | **`daily_metrics_snapshot.metrics`** (JSONB) | `{property_id, title}` for top-viewed / top-CTR listings → `title_en` for a few | Medium | ✅ Yes (prod) | Auto | small subset (popular listings) | ⬜ pending extract query |
| 8 | **Storage filename epoch ↔ `removal_log.listed_at`** | probable **gallery grouping** (which photos ≈ which listing by upload time) | **Needs Review** | ❌ No (inference) | Flag-only (single unambiguous ⇒ Review; never auto-attach) | candidate clusters for many, low certainty | ⬜ supporting evidence only |
| 9 | **Admin browser cache / localStorage** (the machine used for `admin.html`) | possibly cached listing pages / images / draft state | Needs Review | ❌ No | Manual | unknown, likely small | ⬜ opportunistic |

## Ruled out (do not revisit)
| Source | Why | Verified |
|---|---|---|
| **`pintag-dev` database** | contains no copy of the listings | ✅ user-confirmed 2026-08-05 |
| **`unit_types`** (per-unit specs) | `ON DELETE CASCADE` — deleted with the properties | ✅ from schema |
| **Git history** | listings are DB data, never committed | ✅ |
| **Google cache** | Google retired cached pages (2024) | ✅ (low/none) |
| **Cloudflare cache** | edge TTL won't hold week-old pages | ✅ (low) |
| **Wayback `listings.html` grid** | OG worker sets only generic meta — no per-listing data | ✅ from `og-listing-preview.js` |
| **Smart Import artifacts** (FB URL / original image URLs / import payload / logs) | Pipeline is **stateless** — `facebook-listing-fetcher` + `smart-listing-importer` write **no DB table**; FB source URL + `originalUrl`s are returned to the browser and discarded; `properties.images` stores only storage-URL strings; **no import/staging/queue/cache table**; no `import_id`/`source_url`/payload column. *(Correction: `properties` DOES have listing-**media** URL columns — `video_url`, `video_embed_url`, `facebook_video_url`, `map_embed_url`, `download_url`, `agent_photo_url` — but these are listing content, not import provenance, were on the deleted rows, and are NULL for the 91 unless the media check says otherwise. **`facebook_video_url` is worth a direct check** — a survivor there would be a real FB-source lead.)* Functions don't log the mapping; no import Worker. **0/91 recoverable via import metadata.** | ✅ code-proven 2026-08-05 |

## Confirmed from code (2026-08-05)
- **`leads` is NOT a recovery source for the 91.** `leads.property_id … ON DELETE
  CASCADE` (`20260715000000_leads_crm.sql`) deleted every lead — with its
  `customer_name`/`customer_phone` — when the properties were deleted. Buyer
  **contact** per listing therefore has **no automatic source** (Facebook/manual only).
  `lead_events` (plain `listing_id`/`agent_id`, no FK) **survived** and yields the
  **agent** (`agent_id` → `parties.auth_user_id`) only. This corrects source #5.
- **Owner recovery has no surviving DB link — it is a pure outreach campaign.**
  `owner_id` was on the deleted rows; `properties_removal_log` has no owner column;
  `leads` cascaded; and **owner-name-in-title matching returned 0** (after guarding
  for name length + word boundaries) — that indirect path is **exhausted**. The
  `owners` table survives only as a *contact list* (who to call). Recoverability is
  quantifiable only via Report 8 (reachable owners) + owner responses on outreach.
- **Full-database scan (2026-08-05) — photo→listing search EXHAUSTED.** Scanned every table for `property-images`/`/storage/v1/`: only `properties` (5 survivors) and `parties` (5 agent profile photos) match; **zero references to the 91's photos**. **1,230 photo files survive** (~1,200 orphaned = the 91's galleries). Reconnection is external-only (Wayback / Facebook / owner-agent recognition).
- **No surviving DB column links a photo to a listing.** The only photo↔listing
  links were `properties.images` (JSONB) and `unit_types.images` (`text[]`) — both
  lived *on the deleted rows*, so both are gone. Reconnection MUST come from source
  #3 (cover, authoritative), #4 (full gallery, authoritative), or #8 (Needs Review).
  No separate `listing_images`/gallery table exists.
- **The `listings` table is undefined anywhere in the repo/migrations** — created
  out-of-band in production. It is therefore an unknown that must be inspected
  directly: it could hold legacy listing data (a real source) or be empty/unused.

## Still to inspect (may add rows)
- **`listings` table** — undefined in repo (see above); inspect for surviving rows (`Q-REF-2`). **High priority** — potential legacy source.
- Any table that surfaces in the schema-wide `property-images` string scan (`I6`).
- Wayback **CDX coverage** (fixes source #3's `W`) and any **Facebook** post inventory (fixes #4).

## How this maps to the recovery priorities
- **P1 Edited galleries:** source #4 (authoritative full set) → else #8 (Needs Review) → else #3 (cover only).
- **P2 Owner/agent/contact:** #5 (auto, partial) + #6 (identities) → #4 (FB poster) → manual.
- **P3 Reconnect photos ↔ listings (high confidence):** #3 (cover, High) + #4 (full, High) — never #8 alone.
- **P4 Remaining metadata:** #3 (title/price/district/slug) + #4 → manual for specs (beds/baths/sizes/village/coords/amenities).

## Maintenance
Add a row whenever a new source is discovered; update coverage as the pending
queries (storage count, leads coverage, snapshot extract) and the Wayback CDX /
Facebook inventory produce real numbers. This file is the roadmap we resume from
once the DR drill passes.
