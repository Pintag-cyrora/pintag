# Pintag Architecture

> **Status: Baseline established.** Rental Terms v2, Unit Availability, the
> Shared UI Component System, Lead/Inquiry Analytics, Similar Properties,
> shared design tokens, shared formatters, and the canonical resolvers
> below are all considered stable. Pintag is now in an **architecture
> freeze**: new work should extend these systems (see §2 Canonical APIs
> and §5 Extension Guide) rather than introduce a new pattern for a
> problem one of them already solves, unless there is a compelling
> technical reason to do otherwise. The next phase prioritizes
> user-facing features built on this foundation over further core
> refactoring. §6 Known Debt remains the authoritative cleanup backlog —
> avoid growing it unless new debt is genuinely introduced.

This is the canonical architectural reference for Pintag. It exists because
this codebase has, on more than one occasion, let concepts that were
deliberately kept separate get silently recoupled under time pressure —
authentication implying identity, a page inventing its own copy of a
formatter, an analytics table getting filtered down to one channel because
that's what shipped first. Every rule in this document was written in
response to a real instance of that happening.

**If you are about to add a page, a table, a resolver, or a formatter, read
this first.** The default move for new work is to extend what's here, not
to add a parallel implementation next to it. Future contributors —
including AI assistants — should treat this document as the first thing to
check when making an architectural decision, and should update it when a
decision here changes.

Subsystem-specific documents live alongside their code and go deeper than
this file does:
- `supabase/functions/generate-intelligence-report/INTELLIGENCE_ARCHITECTURE.md` —
  the Intelligence Layer's own invariants (Metrics Engine / Insight Engine /
  Report Composer / Gemini boundaries).
- `docs/intelligence/` — the Intelligence page's UX/design decisions and
  phased rollout plan.
- `PREVIEW.md` — the dev/prod environment split and how to preview a branch.
- `SECURITY.md` — the security test suite (`tests/security/`).

This file is the map; those are the territory for their one subsystem.

---

## 1. System Overview

Pintag is a static, build-step-free HTML/JS site (no bundler, no
framework — plain `<script>` tags loading plain global functions/vars, one
Supabase Postgres project as the only backend) plus a handful of Deno edge
functions for anything that needs a server (AI calls, scheduled reports, a
Google Maps resolver). Nine domains, described below, cover everything the
product does today. Each domain has exactly one place its logic lives —
that's the point of this document.

### Property Domain
The core listing entity (`properties` table) and its typed, per-category
fields (bedrooms, bathrooms, sqm, sqm_land, land-specific fields, etc.).
Owned by `terminology.js` (`PROPERTY_TYPES`, `PROPERTY_TYPE_FIELDS`,
`PROPERTY_TYPE_DISPLAY` — see §2) and rendered everywhere through
`components.js` (see Shared UI Component System below). A property can
optionally have **Unit Types** (`unit_types` table, one property → many
unit types, for apartment buildings/serviced residences/hotels with
multiple configurations) — see `resolveUnitType()`/`isMultiUnitBuilding()`
in `terminology.js`, which is the sole inheritance resolver between a
building's own fields and a specific unit type's overrides.

**Property photos and unit photos are separate concepts, each with its
own independent gallery.** `properties.images` is the Property Gallery —
building exterior, lobby, shared amenities, never unit-specific.
`unit_types.images` is that one unit's own gallery, uploaded and managed
completely independently (its own uploader, its own storage-upload calls
— see `uploadImageFileToStorage()` in `admin.html`, reused by both
galleries so there is one upload implementation, not two). A unit with no
photos of its own falls back to the Property Gallery for display
(`resolveUnitType()`'s `images` field) rather than showing an empty
gallery — this is the *only* place the two collections blend, and only at
render time, never in storage. On the public listing page
(`listing.html`), selecting a unit in the Available Units section
(`selectUnitType()`) swaps the hero gallery/price/specs/availability/
description/features/amenities/WhatsApp CTA to that unit's own resolved
values, Booking.com-style room selection — implemented as a full
re-render of the existing `buildMockupLayout()` (the same function used
for every other render), not a second render path. A persistent Building
Photos / Shared Amenities strip renders directly below the hero
*whenever* a unit is selected (never the building's default view, where
it would just repeat the hero) — deliberately always the building's own
`images`/`amenities`, independent of whichever unit is selected, so a
visitor can browse the chosen unit while still one glance from the
building itself. Deep linking (`listing.html?slug=...&unit=<slugified-name-or-id>`)
auto-selects a unit on load; a clean path (`/listing/x?unit=y`) is not
achievable on this project's static GitHub Pages hosting, so the existing
query-param convention is used instead. The selected unit's own WhatsApp
message is a full sentence (`buildUnitWhatsAppMessage()`) — property
name, unit name, price, and a real availability line — not the base
inquiry template with a unit name appended.

**A `unit_types` row is a unit TYPE (a floor plan / product), never one
specific physical apartment — this must never change as new fields are
added.** `total_units`/`available_count` already model "this type has N
physical units" without assuming N=1. Every new unit-level field added so
far (images, price, bedrooms/bathrooms/sqm, availability, description,
features/amenities, furnishing, floor plan/virtual tour/video links,
floor number, orientation — see `resolveUnitType()`) describes the *type*,
never a single occupant/lease/room-number. A future Phase 3 `units` child
table (Property → Unit Type → Individual Unit, e.g. Studio → Room 203/305/501)
is what will track individual physical units and occupancy — it FKs to
`unit_types.id` without requiring changes to any field listed above. Never
add a field to `unit_types` that only makes sense for one physical unit
(a room number, a single lease, a single tenant); that belongs on the
future Individual Unit table.

Deposit, Advance Rent, Utilities (electricity/water/internet), Lease
Length, Pet Policy, and Parking are all Rental Terms fields
(`rental-terms.js`'s `RENTAL_TERMS_FIELDS`), not `unit_types` columns —
already unit-overridable via the existing `rental_terms_overrides`
mechanism (§3, "Never read Rental Terms JSON directly"), so a unit-level
override for any of these needs no schema change, only a registry entry.

### Contact Domain
**Platform Identity, Buyer Contact, and Authentication are three separate
concepts.** This is the single most load-bearing rule in the schema and is
documented in full in §7 below — read it before touching `parties`,
`contacts`, or anything that joins through `auth.users`.

- **Platform Identity** (`parties` table) — who owns/manages a listing
  *inside* Pintag: permissions, attribution, CRM ownership, analytics.
- **Buyer Contact** (`contacts` table) — who the buyer actually reaches
  when they click WhatsApp or Call on a listing.
- **Authentication** (`auth.users`, linked via `parties.auth_user_id`) —
  how someone logs in. Evidence that can later be linked to a Platform
  Identity, never a prerequisite for one existing.

### Lead / Inquiry Domain
A **Lead** is any user-initiated contact click from a listing —
WhatsApp, Call, or any future channel — regardless of who receives it.
`lead_events` is the raw, anonymous, rate-limited click log; `leads` is
the CRM-managed entity it auto-creates one row into via
`create_lead_from_event()` (see §2). The recipient (`recipient_type`,
`recipient_verified`, snapshotted from `contacts.role`/`is_verified` at
creation time) is **metadata on the lead, not what defines it** — see §3's
"Recipient type is metadata, not the Lead itself." `search_events` and the
`listing_events` `impression`/`click` types extend this into a full
buyer-journey chain (search → impression → click → detail view → lead),
joinable end to end via the shared `session_id` (`session.js`).

### Rental Terms
Building-level defaults + per-unit-type overrides for deposit, utilities,
service frequency, policies, and fees. JSONB-based
(`properties.rental_terms` / `unit_types.rental_terms_overrides`), owned
entirely by `rental-terms.js` — see §2 (`resolveRentalTerms()`) and §3
("Never read Rental Terms JSON directly"). Deliberately scoped to
configuration/policy data only, never operational/transactional data (see
Unit Availability below for the boundary).

### Unit Availability
"Available Now" / "Fully Occupied — Available from {date}" / "Currently
Unavailable" for a unit type, plus available/total unit counts. Flat
columns on `unit_types` (`available_count`, `total_units`,
`next_available_date`, `availability_note`) — deliberately *not* JSONB,
because this is operational/occupancy state, not policy. Owned entirely by
`unit-availability.js` — see §2 (`resolveUnitAvailability()`). Completely
independent from Rental Terms by design (see §3): neither file imports the
other, and each owns its own registry/resolver/formatter.

### Shared UI Component System
`components.js` + `shared-components.css` are the **only** supported
implementations of a property card, property preview, agent card, agent
preview, and transaction badge, site-wide. No page may define its own
copy. See §2 for the five public entry points and §4 for the file split
(rendering logic vs. design tokens/styling).

### Analytics
Three layers, each with a narrower job than the one below it:
1. **Collection** — `search_events`, `listing_events`, `lead_events`,
   `ui_events` (raw, high-volume, anonymous-writable event tables).
2. **Aggregation** — `leads` (the CRM entity, see Lead/Inquiry Domain
   above), plus `admin.html`/`dashboard.html`'s client-side rollups
   (Total Leads, recipient breakdown, conversion funnel, per-property
   stats) and `analytics-inspector.html` (raw per-session event trace).
3. **Intelligence** — `generate-intelligence-report`'s three-layer
   pipeline (Metrics Engine → Insight Engine → Report Composer → Gemini),
   which turns the raw event tables into daily/weekly/monthly narrated
   reports and persistent, tracked insights (`intelligence_insights`).
   Full detail in that function's own `INTELLIGENCE_ARCHITECTURE.md`.

New analytics must build on the Lead model (§3) — a new recipient type or
contact channel must work without touching aggregation code, because the
recipient is metadata, not a filter condition baked into a query.

### AI Helpers
`generate-listing-content` (Gemini-backed multilingual description
generation, called from `admin.html`) and Gemini's narration role inside
`generate-intelligence-report` (see Analytics above — narration only,
never discovery/ranking, see that function's own architecture doc). Any
AI-generated copy that references Rental Terms or Unit Availability
**must** consume `resolveRentalTerms()`/`resolveUnitAvailability()`'s
output, never raw columns — both files are written portable
(no `document`/`window`) specifically so they're callable from a Deno AI
context unchanged.

### Smart Import
A pipeline, not a single function: **Source → Adapter → ImportResult → AI
Enrichment → Validation → Populate Form.** `facebook-listing-fetcher` is
one Adapter (Facebook Marketplace URL → raw title/description/price/
images); manual paste is another (no fetch needed, description text is
already in hand). Both feed `smart-listing-importer`, the AI Enrichment
stage, which is adapter-agnostic — it only ever sees
`{ description, image_urls }` and returns a confidence-tagged
`ImportResult`. `admin.html` owns Validation + Populate Form (low-
confidence fields get flagged, staff confirms before save — nothing is
silently auto-saved).

### Future Inventory / Availability
The deliberately-reserved extension point for connecting Unit Availability
to real lease data instead of manually-entered counts.
`resolveUnitAvailability(unitType, computedNextAvailableDate)`'s second
parameter exists today, unused, for exactly this: a future caller computes
`computedNextAvailableDate` from lease/move-out records and passes it in;
the manually-entered `unit_types.next_available_date` continues to take
precedence when staff has set it (an explicit human correction always
wins over automation). No resolver contract change is needed when this
phase arrives — see §5.

---

## 2. Canonical APIs

Every one of these is the **single source of truth** for what it owns.
Bypassing one to re-derive its logic elsewhere is the #1 way this codebase
has accumulated drift in the past (see §3) — check here before writing a
new formatter, filter, or query.

| API | File | Owns | Use it when... |
|---|---|---|---|
| `resolveRentalTerms(property, unitType)` | `rental-terms.js` | Merging building-level Rental Terms defaults with a unit type's overrides. Returns the frozen `{version, values, overriddenKeys}` contract. | You need any Rental Terms value for display, AI copy, or an edge function. Never read `properties.rental_terms` / `unit_types.rental_terms_overrides` directly. |
| `resolveUnitAvailability(unitType, computedNextAvailableDate?)` | `unit-availability.js` | Turning `available_count`/`total_units`/`next_available_date`/`availability_note` into one of the 3 frozen public statuses. | You need to display or reason about a unit type's availability. Never read the 4 raw columns directly. |
| `resolveUnitType(property, unitType)` | `terminology.js` | Merging a building's own fields with one unit type's overrides for every *other* typed field (price, name, specs — not Rental Terms or Availability, which have their own resolvers above). | Rendering a specific unit type variant anywhere (admin preview, listing page, future search). |
| `resolvePartyDisplay(party, listingCount, lang)` | `components.js` | Deriving a party's display name/photo/agency/verified-badge/bio with graceful placeholders and language-aware name precedence (Lao-first vs. English-first). | Any UI that shows an agent/owner/party, in any card, preview, or profile. |
| `renderPropertyCard(property, opts)` | `components.js` | The one property card implementation. `opts` controls page-specific behavior (link vs. div, which sections show) — never a parallel card. | Search results, homepage, dashboard listings grid — anywhere a compact property card appears. |
| `renderPropertyPreview(property, opts)` | `components.js` | The one property *preview* (mini-card) implementation — Similar Properties, future Favorites. | Anywhere a smaller, secondary property reference is shown. |
| `renderAgentCard(party, opts)` | `components.js` | The one agent card implementation, including the `layout:'row'` roster variant. | Agent directories, roster lists. |
| `renderAgentPreview(party, opts)` | `components.js` | The one agent preview implementation (photo/name/agency/verified badge/listing count/bio/CTA buttons, with graceful placeholders when data is missing). | Listing detail pages, anywhere a single agent needs a fuller preview than a card. |
| `renderTransactionBadge(transactionType, lang)` | `components.js` | The one Sale/Rent/Rent & Sale badge — identical radius/padding/typography/shadow everywhere, color is the only thing that varies. | Any badge indicating a listing's transaction type. Never a page-local badge implementation. |
| `formatPropertyPrice(property, lang)` | `components.js` | The one price-formatting implementation (currency, "/month" suffix, language). | Anywhere a price is displayed. Never format a price in page-specific code (§3). |
| `getCardFacts(typeKey, row, lang)` / `getDetailFacts(typeKey, row, lang)` | `terminology.js` | Which typed fields (bed/bath/sqm/etc.) show on a card vs. a detail page for a given property type, in what order, with what icon. | Anywhere a property's spec facts are rendered — replaces four previously-duplicated, inconsistent icon sets. |
| `trackLead(listingId, agentId, eventType, contactId?)` | `listing.html` (pattern reused inline in `agent.html`) | Firing a `lead_events` insert for a contact-initiating click. | Any new contact CTA (WhatsApp, Call, and any future channel) must call this — a channel that doesn't is invisible to every downstream analytics number. |
| `create_lead_from_event()` | Postgres trigger, `supabase/migrations/20260722000000_leads_recipient_model.sql` | The **only** path that creates a `leads` CRM row from a `lead_events` insert. Fires on every `event_type`, snapshots `recipient_type`/`recipient_verified` from `contacts`/`parties` at creation time. | Never insert into `leads` directly from application code — a lead is always a byproduct of a tracked click, not a manually-created row (except staff editing status/notes on an existing lead). |
| `getOrCreateSessionId()` | `session.js` | The one client-side session id, shared by `search_events`/`listing_events`/`lead_events` so a buyer journey is joinable end to end. | Any new event table that needs to correlate with the rest of the buyer-journey chain. |
| `sbCount(path)` | `admin.html` (pattern to replicate, not yet extracted to a shared file — see §6 debt note) | An exact row count via `Prefer: count=exact`, immune to a row-fetch `limit` truncating a headline number. | Any KPI/total that must be exact rather than "however many rows happened to be fetched." |
| `ptGetSavedSet()` / `ptToggleSave(slug, e)` | `components.js` | The one localStorage-backed saved/favorited-listing store. | The heart/save button on any card — also the exact substrate a future Favorites page reads from (§5). |

---

## 3. Architectural Principles

These are the rules this codebase has learned the hard way. Each one maps
to a real bug or a real duplication this project has already paid for —
they are not hypothetical.

- **Never bypass resolvers.** `resolveRentalTerms()`,
  `resolveUnitAvailability()`, `resolveUnitType()`, `resolvePartyDisplay()`
  are each the *only* public read API for what they own. A hypothetical
  helper like `getEffectiveDeposit()` must itself call `resolveRentalTerms()`
  internally — it may never re-open the raw columns as a shortcut.
- **Never duplicate renderers.** Before this was fixed, four independent,
  inconsistent implementations of "bed/bath/sqm" existed across
  `listing.html`/`listings.html`/`index.html`, each with its own hand-drawn
  icon set. `components.js`/`terminology.js`'s `getCardFacts()` are what
  replaced all four. If a page's need doesn't fit an existing render
  function's `opts`, add the opt — don't fork a new implementation.
- **Never duplicate formatters.** Price formatting had a real bug
  (`/mo` matched before `/month` in a regex, leaving `"$650nth"` on
  screen) that existed in more than one copy before `formatPropertyPrice()`
  centralized it. One bug fix now fixes every page at once, forever.
- **Never read Rental Terms JSON directly.** `properties.rental_terms` /
  `unit_types.rental_terms_overrides` are opaque outside
  `resolveRentalTerms()`. The `{"version":1}` marker inside the JSON is a
  serialization/schema-version marker only — never a business concept.
- **Never format prices in page-specific code.** See "Never duplicate
  formatters" above — this is the same rule stated for the one field most
  likely to tempt a one-off `.replace()`.
- **New pages must consume shared components.** `components.js` +
  `shared-components.css` are the only supported implementations of a
  property card, property preview, agent card, agent preview, or
  transaction badge. A new page composes these with documented `opts`; it
  does not keep a parallel implementation "just for this one case."
- **New analytics must build on the Lead model.** A lead's recipient is
  metadata (`recipient_type`/`recipient_verified`), not a filter baked
  into how the lead was created. `create_lead_from_event()` fires on every
  `lead_events.event_type`, not just WhatsApp — a query that filters to
  one channel undercounts by construction. See §1 Lead/Inquiry Domain.
- **Recipient type is metadata, not the Lead itself.** The primary KPI
  ("how many property inquiries did Pintag generate") must always
  aggregate every inquiry regardless of who received it. Recipient-type
  breakdowns are secondary views over the same underlying `leads` table,
  never a separate counting mechanism.
- **Future contact methods should automatically generate Leads.** Adding
  a new value to `lead_events.event_type`'s CHECK constraint is
  sufficient — `create_lead_from_event()` has no `event_type` branching
  logic to update, because it was deliberately written to fire on the
  presence of `listing_id`, not on which channel was used.
- **Property Category is the primary Similar Properties constraint.**
  `property_type` is a hard filter, never a relaxable tier and never a
  scored signal, in `fetchSimilarProperties()` (`listing.html`). Every
  other signal (transaction type, district, price, bedrooms, bathrooms,
  building size, land size) may be relaxed or weighted; property category
  never is, including in the final "not enough matches" case, which
  returns fewer results rather than crossing categories.
- **JSONB is for configuration/policy data only, never
  operational/transactional data.** Rental Terms (policy) is JSONB; Unit
  Availability (occupancy state, connects to future lease data) is flat
  columns. This split is deliberate, not incidental — see §1.
- **Modules stay independent where their doc says so.**
  `rental-terms.js` and `unit-availability.js` never import or reference
  each other, by explicit rule stated in both files' headers. If a future
  feature seems to need both, it composes their two resolvers at the call
  site — it does not create a dependency between the files.
- **Snapshot-at-creation-time for anything used in historical reporting.**
  `leads.party_id` ("managing agent at creation time"),
  `leads.recipient_type`/`recipient_verified` (snapshotted from
  `contacts`/`parties` at insert time) — a report generated today must
  read the same way if the underlying contact's role or verification
  changes tomorrow.
- **Additive-only migrations.** A historical backfill INSERTs missing
  rows or fills newly-added NULL columns; it never mutates or deletes a
  pre-existing, previously-meaningful value. When backfilling rows that
  represent a past event (e.g. leads created from historical
  `lead_events`), their `created_at`/`updated_at` are set to the original
  event's timestamp, not migration-run time — otherwise a one-time backfill
  corrupts every historical trend count and the Intelligence Layer's daily
  metrics on whichever day the migration happens to run.
- **Platform Identity never implies Buyer Contact; Authentication never
  implies Identity.** See §7 in full — this is the rule that makes
  "claim your account later" possible without any listing or contact data
  changing shape.
- **The AI never decides what is important.** Inside the Intelligence
  Layer specifically: Gemini explains and connects insights the
  deterministic Insight Engine already decided were significant — it never
  discovers anomalies, ranks their importance, or invents a number not
  present in its structured input. Full statement of this rule in
  `INTELLIGENCE_ARCHITECTURE.md`.

---

## 4. Folder / File Responsibilities

| File | Responsibility |
|---|---|
| `components.js` | ALL shared rendering logic for property cards, property previews, agent cards, agent previews, and the transaction badge, plus the shared saved-listing store. No page may define its own copy of any of these. |
| `shared-components.css` | ALL shared styling for the above — design tokens (`--pt-*` custom properties: color, radius, shadow, spacing, type scale, transitions) plus the `.pt-*` class families. Page-specific CSS may reference these tokens; it may not redefine badge/card/preview structure. |
| `terminology.js` | `PROPERTY_TYPES` (the 7-category vocabulary), `PROPERTY_TYPE_FIELDS` (schema-driven form fields per category), `PROPERTY_TYPE_DISPLAY` + `getCardFacts()`/`getDetailFacts()` (what's shown where), `resolveUnitType()`/`isMultiUnitBuilding()` (Multi-Unit Building resolver). |
| `amenities.js` | `AMENITIES`/`AMENITY_PRIORITY` registry + `resolveAmenityData()`/`topAmenities()` — the single amenities source of truth. (Note: `listing.html` still keeps its own small page-local `FEATURES` registry for `checkbox_ref` fields like pool/garden/balcony — a known, minor inconsistency with the "one registry" pattern amenities.js otherwise establishes; not yet consolidated.) |
| `rental-terms.js` | Rental Terms registry, resolver, formatters, admin save/load. Portable (no `document`/`window`), so it's callable unchanged from a Deno edge function. |
| `unit-availability.js` | Unit Availability resolver, formatter, and `compareUnitTypesForDisplay()` ordering comparator. Same portability requirement as `rental-terms.js`, deliberately no shared code between the two. |
| `session.js` | `getOrCreateSessionId()` — the one client-side session id generator, shared by every behavioral event table. |
| `tracking.js` | `data-track="..."` delegated UI-interaction analytics (`ui_events`) — a distinct, lower-level layer from the business-intelligence event stream (search/listing/lead events), answering "does anyone use this control" rather than "how many inquiries." |
| `intelligence.js` | `intelligence.html`'s page logic (auth, report rendering, Insights Archive/Timeline) — extracted from an inline script to give the Intelligence page's own JS a home, same convention as the cross-page libraries above but scoped to one page. |
| `config.js` / `config.dev.js` / `config.prod.js` / `dev-banner.js` | Environment selection (`window.PINTAG`) and the visible DEV-environment safety banner. See `PREVIEW.md`. |
| `supabase/migrations/` | The append-only schema history. Every schema change is a new timestamped file; nothing is edited in place once applied. See `scripts/bootstrap-dev-db.sh` for why the very earliest tables (created by hand, pre-dating tracked migrations) need a schema-dump bootstrap rather than a clean replay. |
| `supabase/functions/smart-listing-importer/` | Smart Import's AI Enrichment stage — adapter-agnostic, turns raw `{description, image_urls}` into a confidence-tagged `ImportResult`. |
| `supabase/functions/facebook-listing-fetcher/` | One Smart Import Adapter — Facebook Marketplace URL → raw material for the Enrichment stage above. |
| `supabase/functions/generate-listing-content/` | AI Helper — Gemini-backed multilingual listing description generation, called from `admin.html`. |
| `supabase/functions/generate-intelligence-report/` | The Intelligence Layer pipeline (Metrics Engine SQL function → `insight-engine.js` → `report-composer.js` → `gemini-client.js`). Own architecture doc: `INTELLIGENCE_ARCHITECTURE.md`. |
| `supabase/functions/resolve-map-url/` | Small utility — resolves a Google Maps short link server-side (domain-allowlisted, was previously an open SSRF proxy without the allowlist). |
| `supabase/functions/public-listings-feed/` | Read-only aggregated feed for the separate Pintag Marketing AI system (`pintag-studio`) — the one intentional touchpoint between the two systems, exposing nothing not already public via `listings.html`. |
| `tests/security/` | The security regression suite (RLS, auth, XSS, SQLi, rate limiting, secret scanning, etc.) — see `SECURITY.md`. |
| `tests/intelligence/` | Playwright + mocked-Supabase test harness for `intelligence.html`, reused as the pattern for other pages' scratchpad verification scripts (see e.g. commit history for the Analytics Lead Model refactor and Similar Properties verification). |

---

## 5. Extension Guide

Future development should **extend** what's below, not stand up a parallel
system next to it. For each of these, the "existing hooks" are the actual,
already-built seams to build on.

**Favorites** — `ptGetSavedSet()`/`ptToggleSave()` in `components.js` are
already the real, live localStorage-backed store the heart button on every
card writes to today. A Favorites page is "read this store, render the
result with `renderPropertyCard()`/`renderPropertyPreview()`" — no new
storage layer, no new card rendering.

**Saved Searches** — `search_events` already records every filter
combination used, with `result_count`. A Saved Search feature's "did this
search change" check is a diff against a stored filter set that already
has this exact same shape; store the filter set, don't invent a second
representation of what a search's parameters are.

**Notifications** — Would key off the same events already flowing:
a new listing matching a Saved Search, a lead's status changing (`leads`
already has `updated_at` + a status enum), a Unit Availability status
crossing into "Available Now" (`resolveUnitAvailability()`'s status enum
already has the exact 4-value internal state a notification trigger would
read). Don't add parallel "did X happen" polling — hook into the resolver
or table that already knows.

**CRM** — `leads` (recipient-agnostic, one row per real inquiry, `status`
lifecycle, `notes`/`customer_name`/`customer_phone`) is already the CRM
entity. Deepening it (call logs, appointment scheduling, a lost-reason
field) extends this table and its RLS — it does not introduce a second
"contact record" concept alongside `contacts`/`parties`, which serve
identity/routing, not pipeline state.

**Owner Dashboard** — `dashboard.html` already resolves the logged-in
user's own `parties` row via `auth_user_id` and scopes `properties`/
`leads` to `managed_by_party_id ∈ owned_party_ids(uid)`. An Owner
Dashboard is the same pattern for `parties.type = 'owner'` rather than
`'agent'` — the RLS helpers (`owned_party_ids()`, `is_pintag_staff()`)
and the query shape are already type-agnostic.

**Agent Dashboard** — Already built (`dashboard.html`); future work here
(richer pipeline views, more Property/Agent Analytics) extends its
existing `leads`-sourced queries per §3's "New analytics must build on the
Lead model," not a second dashboard data path.

**AI-generated descriptions** — Must consume `resolveRentalTerms()` and
`resolveUnitAvailability()` for any Rental Terms or Availability fact they
reference, exactly like the public listing page does — never re-derive
those facts from raw `properties`/`unit_types` columns. This is precisely
why both resolvers are written portable (no `document`/`window`): the
same function is callable unchanged from a Deno AI context.

**Recommendation Engine** — The Similar Properties matcher
(`fetchSimilarProperties()` in `listing.html`) is deliberately built as
two small, independently-extensible registries: `SIMILAR_TIERS`
(categorical relaxation — property category, always required, then
transaction type, then district) and `SIMILAR_RANK_SIGNALS` (continuous
closeness scoring — price, bedrooms, bathrooms, building size, land size,
each weighted to dominate the sum of every lower-priority signal). A
future signal — neighborhood score, amenities overlap, furnished status,
pet policy, availability, verified-listing boost, a learned
behavioral/AI ranking — is one more entry in `SIMILAR_RANK_SIGNALS` (or
`SIMILAR_TIERS`, if it's categorical). Nothing else in the function
changes. The one rule that never bends regardless of what's added:
property category stays a hard filter, never a scored signal (§3).

---

## 6. Known Debt (disclosed, not hidden)

Documenting these here rather than letting them go undiscovered:

- `listing.html`'s `FEATURES` registry (pool/garden/balcony/elevator
  checkbox labels) is page-local, not centralized in `amenities.js` the
  way the rest of the amenity system is — see §4.
- `sbCount()` (exact-count via `Prefer: count=exact`, see §2) currently
  lives inline in `admin.html`. It's a genuinely reusable pattern (any
  future headline KPI needs the same exact-count guarantee) and is a
  good candidate for extraction into a small shared file the next time a
  second page needs it — not extracted preemptively per this codebase's
  own "don't build for hypothetical future requirements" convention.
- The very earliest tables (`properties`, the original `agents` table
  before it became `parties`, etc.) predate tracked migrations entirely
  and were created by hand in the Supabase dashboard — `supabase db push`
  alone cannot recreate the schema from nothing. `scripts/bootstrap-dev-db.sh`
  works around this with a schema-only dump from production. A tracked
  baseline migration would remove this workaround entirely; tracked as a
  follow-up, not yet done.
- Per-unit AI-generated description ("AI description" from the "Unit
  Types as first-class objects" phase) is deliberately deferred, not
  built. `generate-listing-content` (the existing Gemini-backed
  description generator) is the likely reuse target, but it currently
  takes property-shaped input — scoping it per-unit needs a parameter-shape
  change and admin UI wiring, sized as its own pass rather than folded
  into this one.

---

## 7. Platform Identity, Buyer Contact, and Authentication are three separate concepts

*(Preserved from this document's original scope — the invariant that
motivated writing an ARCHITECTURE.md in the first place.)*

These are independent axes, not a hierarchy. Authentication never defines
identity, and identity never defines buyer contact.

- **Platform Identity** (`parties` table) — who owns/manages a listing
  *inside Pintag*: permissions, attribution, CRM ownership, analytics. A
  `parties` row can exist with `auth_user_id = NULL` — staff can
  pre-register an agent, developer, or agency before that person or
  organization ever logs in. Platform Identity does not require
  authentication to exist.
- **Buyer Contact** (`contacts` table) — who the buyer actually reaches
  when they click WhatsApp or Call on a listing. A `contacts` row can
  exist forever with `party_id = NULL` — an owner, a reception desk, a
  sales office that never signs up for Pintag. Buyer Contact does not
  require a Platform Identity to exist, and in the manual-onboarding era
  most contacts never will have one.
- **Authentication** (`auth.users`, linked via `parties.auth_user_id`) —
  how someone logs into Pintag. A login is *evidence* that can later be
  linked to a Platform Identity (`parties.auth_user_id` gets set) and,
  through it, to a Buyer Contact (`contacts.party_id` gets set) — but
  authentication itself defines neither.

### Why this separation is load-bearing, not incidental

The nullable, decoupled foreign keys are what make "claim your account
later" possible without any listing or contact data changing shape:

- `properties.managed_by_party_id` — nullable FK to `parties`. A listing
  can be staff-managed with no Platform Identity attached at all.
- `contacts.party_id` — nullable FK to `parties`. When an unregistered
  contact signs up, this gets set; every listing already pointing at that
  `contacts` row instantly "sees" the claimed identity with zero listing
  migration.
- `parties.auth_user_id` — nullable FK to `auth.users`, decoupled from
  `parties.id`. A Platform Identity can be pre-created by staff and
  claimed by a real login later, in either order.

Because these three axes are independent, **multiple Platform Identities
can eventually manage the same Buyer Contact** — an agency, a developer's
branch office, an assistant covering for an agent — without the schema
needing to change. This is why `properties.managed_by_party_id` and
`contacts.party_id` are two separate nullable FKs into the same `parties`
table, rather than one column trying to serve both purposes: a design
that conflated them would need a redesign the first time a listing's
manager and its buyer contact needed to be different Platform Identities,
or the same contact needed multiple managing identities over time.

### The rule

Never make one of these three axes a prerequisite for another:

- Don't require a login to create a Platform Identity (pre-registration
  must keep working).
- Don't require a Platform Identity to create a Buyer Contact (most
  contacts in the manual-onboarding era will never have one).
- Don't infer a Buyer Contact's identity from who's logged in, or a
  Platform Identity's permissions from a Buyer Contact record.

If a future feature (self-service agency accounts, developer branch
offices, an assistant role) seems to need coupling two of these axes,
that's a signal the feature needs its own explicit relationship — not a
reason to make one axis stand in for another.

---

## Long-term Goal

This document is the canonical architectural reference for Pintag. Every
resolver, every shared renderer, every table relationship listed above was
built to be the one and only way to do its job — not a convenience that
happens to be first. As new features arrive (self-service accounts,
agencies, CRM depth, an owner dashboard, a recommendation engine, whatever
comes after that), the default posture is to extend the domains, APIs, and
principles documented here, not to introduce a parallel implementation
next to them. When a genuine architectural decision needs to be made —
by a human or an AI assistant — this is the document to consult first, and
the document to update once the decision is made.
