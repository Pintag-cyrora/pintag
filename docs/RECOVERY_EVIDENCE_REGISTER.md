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

## Register

| # | Source | Fields it can recover | Confidence | Authoritative | Auto / Manual | Est. coverage (of 91) | Status |
|---|--------|-----------------------|------------|---------------|---------------|-----------------------|--------|
| 1 | **`properties_removal_log`** | `id`, `title_lo`, `property_type`, `district_en`, `transaction_type`; also `status_at_removal` (orig status), `listed_at` (orig `created_at`) | High | ✅ Yes (prod) | Auto | **91/91** (defines the recoverable set) | ✅ 5 fields applied (P8); `status_at_removal` + `listed_at` still available |
| 2 | **Storage `property-images` (files)** | the edited photo **assets** themselves (cover + full galleries) — *files only, not the listing link* | High (files exist) | ✅ Yes (prod) | Auto (files) | **~100% of files physically exist** | ⬜ confirm count via storage query; **back up first (Priority Zero)** |
| 3 | **OG-worker capture** via Wayback / OG / WhatsApp / FB link-preview | `slug`, `title`(per lang), `price`(formatted), `currency`, `district`, description **snippet**, `market_status`, **cover image (`images[0]`) only** | High (per captured listing) | ✅ Yes | Auto (parse OG tags) | **= W/91** (W = # slugs archived; unknown until CDX) | ⬜ pending Wayback CDX run |
| 4 | **Facebook source posts** | **full image gallery (≤10)**, title, description, `price_display`, **poster = owner/agent** | High (if post matched) | ✅ Yes | Manual/semi-auto (FB→listing link was not stored) | unknown subset (FB-originated + still live) | ⬜ pending; **only authoritative full-gallery source** |
| 5 | **`lead_events` / `leads`** | **agent** (`managed_by_party_id` via `lead_events.agent_id`/`leads.party_id`), **contact** (`contact_id` → phone/WhatsApp via `leads.contact_id`) | High (exact FK links survived) | ✅ Yes (prod) | Auto | partial — only listings with ≥1 lead | ⬜ pending coverage query |
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

## Still to inspect (may add rows)
- **`listings` table** (separate from `properties`, has `created_by`) — inspect for surviving rows (`Q-REF-2`).
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
