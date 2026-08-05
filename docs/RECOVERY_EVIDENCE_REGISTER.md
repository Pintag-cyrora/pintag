# Pintag Recovery Evidence Register — SINGLE SOURCE OF TRUTH

**Purpose:** the authoritative catalogue of every source that can recover data for
the 91 listings deleted in the 2026-08-03 incident. No recovery `UPDATE` is
proposed except against a source recorded here with its confidence and coverage.

**Last updated:** 2026-08-05 · **Status:** **INTERNAL AUDIT CLOSED** — titles COMPLETE
(91/91 Lao, 73/91 English); price **0/91 internal → external-only**; photos/owner
external-only. Now in **external recovery** (Wayback → Facebook → Storage clustering).
DR system built + applied to production. No `UPDATE`s written yet.

> **The 91 kept their ORIGINAL UUIDs.** The re-created draft rows share the same
> `id` as their `properties_removal_log` entry (measured: **91/91 match**), so every
> surviving database source joins the 91 **cleanly by `properties.id`** — no
> title/slug bridging. This is what makes the internal metadata backbone below
> directly applicable.

## Governing principles (apply to every entry)
1. Never overwrite existing recovered data (fill-only-when-empty).
2. Every recovery operation idempotent; every batch reversible (txn + pre-COMMIT diff).
3. Evidence before UPDATEs.
4. Prefer **authoritative** sources (production data, Storage, Facebook, Wayback) over inference.
5. **Timestamp correlation is supporting evidence only** — never the sole basis for auto-attaching images (flag "Needs Review").

Confidence: **High** = restorable without guessing · **Medium** = authoritative but partial/needs a match · **Needs Review** = inference, human confirmation required.

---

## Production measurements & current assessment (2026-08-05)
- **Titles — COMPLETE.** `title_lo` **91/91** (removal_log) + `title_en` **73/91**
  (analytics BI snapshots). The 18 without an English analytics title all carry a
  rich descriptive `title_lo`. **100% of the 91 have at least a Lao title; 73 are bilingual.**
- **Core facts — COMPLETE.** `property_type` **91/91**, `transaction_type` **91/91**
  (removal_log); `district` **~90/91**. All HIGH, join-clean by `id`.
- **Agents:** **16/91** listings have a recoverable agent via `lead_events` —
  **Keomany 10 (operator/self)**, **Tik 3 (has `facebook_url`)**, **Pee 2**, **Sivone 1**.
  Only the **3 Tik** listings have a Facebook source. 75 agent-unknown (Pending Evidence).
- **Owners:** **12 owner records, 100% WhatsApp-reachable**, 0 email, 0 party-linked; **0 of 91 drafts** retain `owner_id`; **Beta Xin is a duplicate**. Identities survived — owner→listing relationships lost (outreach only).
- **Contacts / parties:** high-reference identities survived. What was lost is the **person↔property relationship**, not the people.
- **Photos:** **0/91 galleries** attached; **no surviving DB link** photo→listing — the biggest remaining technical blocker.
- **Price:** **0/91 internal — CONFIRMED external-only (audit closed 2026-08-05).**
  Exhaustive search (scalar price cols + every JSONB payload + schema-wide name scan)
  found no per-listing price: the 91's `rental_terms` are all `{"version":1}`; every
  price/deposit value (200 USD, 100 USD) belongs to **non-91 survivors**; JSONB hits
  were aggregates (`asking_price: null`) or sort-values (`price_asc`); `listings` and
  `unit_types` tables are **empty (0 rows)**. Price → **Wayback OG / Facebook only**.

### Internal metadata backbone (HIGH-confidence, UUID-joined, zero external/manual)
| Field | Source | Coverage | Confidence |
|---|---|---|---|
| `title_lo` | `properties_removal_log` | 91/91 | HIGH |
| `title_en` | analytics (`intelligence_reports` + `daily_metrics_snapshot`) | 73/91 | HIGH |
| `property_type` | `properties_removal_log` | 91/91 | HIGH |
| `transaction_type` | `properties_removal_log` | 91/91 | HIGH |
| `district` | removal_log / current draft | ~90/91 | HIGH |
| agent identity | `lead_events` → `parties` | 16/91 (3 w/ FB) | HIGH |
| beds / baths / village / landmarks | **parse the titles** | most | MEDIUM (semi-auto) |
| price · owner · photos · EN description | — none internal — | 0/91 | External (Wayback / Facebook / outreach) |

**Executive assessment**
- **~73/91 can reach a titled, typed, districted draft (16 also agented) with ZERO
  external work and ZERO manual effort** — internal, HIGH-confidence, fill-only.
- **Biggest remaining blocker:** the **photo→listing relationship** (0 galleries; no surviving DB link).
- **Highest-impact next technical action:** **Wayback CDX** (covers) after the internal price audit closes.
- **Highest-impact business action:** contact the reachable owners + the 3 Tik/FB listings for full-gallery reconstruction.

---

## Register

| # | Source | Fields it can recover | Confidence | Authoritative | Auto / Manual | Est. coverage (of 91) | Status |
|---|--------|-----------------------|------------|---------------|---------------|-----------------------|--------|
| 1 | **`properties_removal_log`** | `id`, `title_lo`, `property_type`, `district_en`, `transaction_type`; also `status_at_removal` (orig status), `listed_at` (orig `created_at`) | High | ✅ Yes (prod) | Auto | **91/91** (defines the recoverable set) | ✅ 5 fields applied (P8); `status_at_removal` + `listed_at` still available |
| 2 | **Storage `property-images` (files)** | the edited photo **assets** themselves (cover + full galleries) — *files only, not the listing link* | High (files exist) | ✅ Yes (prod) | Auto (files) | **~100% of files physically exist** | ⬜ confirm count via storage query; **back up first (Priority Zero)** |
| 3 | ~~**OG-worker capture via Wayback**~~ | ~~cover + OG price/title/district~~ | — | — | — | **0/91** | ❌ **RULED OUT 2026-08-05 — Wayback has NO coverage.** CDX empty for `pintag.io*`, `pintag.io/listing*`, `www.pintag.io*`, `pintag-cyrora.github.io*` (availability API rate-limited, but CDX prefix enumeration is authoritative). 2026 site behind Cloudflare, never crawled. No cover, no OG price from Wayback. |
| 4 | **Facebook source posts** | **full image gallery (≤10)**, title, description, `price_display`, **poster = owner/agent** | High (if post matched) | ✅ Yes | Manual/semi-auto (FB→listing link was not stored) | unknown subset (FB-originated + still live) | ⬜ pending; **only authoritative full-gallery source**. ⚠️ unauthenticated fetch exposes **≤1 photo** — the full gallery sits behind FB's login wall, so it needs authenticated access (more manual) |
| 5 | **`lead_events`** (survived — `listing_id`/`agent_id` have **no FK**) | **agent only**, per listing via `lead_events.agent_id` → **`parties.id` OR `parties.auth_user_id`** (agent_id is **mixed** — always use an OR join) | Medium–High | ✅ Yes (prod) | Auto | **16/91** — Keomany 10 (operator/self), Tik 3 (**`facebook_url`**), Pee 2, Sivone 1; **only the 3 Tik listings have a FB source**. Other **75 = agent relationship Pending Evidence**, NOT orphans | ✅ measured 2026-08-05; **`leads` CASCADED — see below** |
| 6 | **`parties` / `contacts` / `owners` tables** | agent/owner/contact **identities**: name, phone, WhatsApp, email, party relationship | High (identities intact) | ✅ Yes (prod) | Auto (identity) / Manual (per-listing link) | identities **100% present**; per-listing assignment partial | ✅ tables survived; link via #5/#4 |
| 7 | **Analytics BI snapshots** — `intelligence_reports.metrics_snapshot` + `daily_metrics_snapshot.metrics` (JSONB) | **`title_en`** (English), keyed by `property_id`, from `top_listings_by_ctr` / `top_listings_by_views` / `impressions_no_leads` arrays `{property_id, title, impressions, ctr}` | **High** | ✅ Yes (prod) | Auto (UUID join) | **73/91** English titles (all currently empty → fills gaps). **No** price/photos/owner/agent in these payloads | ✅ **CONFIRMED authoritative internal title source 2026-08-05** — extracted, coverage measured |
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
| **Smart Import artifacts** (FB URL / original image URLs / import payload / logs) | Pipeline is **stateless** — `facebook-listing-fetcher` + `smart-listing-importer` write **no DB table**; FB source URL + `originalUrl`s are returned to the browser and discarded; `properties.images` stores only storage-URL strings; **no import/staging/queue/cache table**; no `import_id`/`source_url`/payload column. *(Correction: `properties` DOES have listing-**media** URL columns — `video_url`, `video_embed_url`, `facebook_video_url`, `map_embed_url`, `download_url`, `agent_photo_url` — but these are listing content, not import provenance, were on the deleted rows. **Media check 2026-08-05: `facebook_video_url` = 0 (no FB lead), and only 1 stray `map_embed_url` survives** (coordinates for that one listing) — everything else NULL.)* Functions don't log the mapping; no import Worker. **0/91 recoverable via import metadata.** | ✅ code-proven 2026-08-05 |

## Confirmed from code (2026-08-05)
- **Analytics = authoritative internal TITLE source (title recovery COMPLETE).**
  A full forensic audit of every analytics table + every JSONB column found that
  `intelligence_reports.metrics_snapshot` and `daily_metrics_snapshot.metrics`
  embed per-listing `{property_id, title}` arrays. Extracted: **`title_en` for
  73/91** (join-clean by UUID; all 73 currently empty, so pure gap-fill). Combined
  with `removal_log.title_lo` (**91/91 Lao**), **every one of the 91 has a title;
  73 are bilingual.** These payloads contain **no** price, image URL, storage path,
  owner, agent, phone or WhatsApp — analytics recovers **title only** (plus
  parseable beds/baths/type/district/village/landmarks *inside* the title string).
  Analytics is therefore used **ahead of Wayback for titles**, but Wayback/Facebook
  remain mandatory for photos + price.
- **Analytics content sources EXHAUSTED besides titles.** `ui_events` (1,841 rows —
  only `click`/`scroll` UI telemetry; **3** rows carry a `property_id`, **0** in the
  91), `search_events` (search filters, no listing link), `listing_events.search_filters`
  (`{tx,sort,type,avail}` search context), `intelligence_insights.evidence`
  (`{z,mean,stddev}` anomaly stats), and `page_views` (`page` = `listing.html` /
  `listings.html` pathname only — **no slug/query**, cannot identify a listing) —
  **none carry listing content.**
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

## External recovery queue (internal audit CLOSED 2026-08-05 — nothing left inside the DB)
- **`listings` table = EMPTY (0 rows)** — inspected; created out-of-band, never populated. Ruled out.
- **`unit_types` = EMPTY (0 rows)** — cascaded. Ruled out.
- **Wayback = NO coverage** (CDX empty across all hosts, 2026-08-05). **RULED OUT** — no cover, no OG price.
- Remaining external recovery, in priority order:
  1. **Storage gallery reconstruction — PRIMARY photo path.** ~1,230 image files physically survive in `property-images`. Reconnect clusters → listings via `gallery-recovery` (timestamp-burst clustering + operator assign). ⚠️ **Back up the 1,230 files first (Priority Zero) — they are the only surviving copy.**
  2. **Facebook — price + photo cross-check.** Full galleries + price + owner/agent. Start with the **3 Tik listings** (`facebook_url`); others need locating posts by title (manual).
  3. **Price has no automatic source left** — Facebook (manual) only.

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
