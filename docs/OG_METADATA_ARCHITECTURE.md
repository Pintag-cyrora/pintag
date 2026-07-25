# Open Graph Metadata Architecture — Design (not yet implemented)

Status: **design only**. Nothing in this document changes runtime behavior. It exists so that
when edge/server-side prerendering is eventually built, there is one metadata system to extend,
not four separate ones to reconcile.

## Problem this solves

Today `listings.html` has one dedicated, hand-written OG/meta block, plus a client-side function
(`updateListingsMetaForFilters()`) that updates the live DOM for type/transaction filters —
helpful for the visitor's own tab and JS-executing crawlers, but invisible to WhatsApp, Facebook,
Messenger, Telegram, Discord, LinkedIn, and X, which fetch raw HTML once and never run JavaScript.
`listing.html` separately hand-builds its own per-property title/description from `properties`
row data. If districts pages, property-type pages, and filtered-search pages are each built the
same ad hoc way later, Pintag ends up with five near-identical, independently-maintained
implementations of "turn a subject into a title/description/image" — the exact duplication
problem this codebase has already paid down once (`terminology.js`, `rental-terms.js`,
`components.js`) for other cross-page concerns.

## Core idea: one resolver, many callers

A single pure function, **`resolveOgMetadata(subject)`**, is the only place "what a page is
about" turns into "what a crawler should see." Every delivery mechanism — today's client-side DOM
update, a future static-page generator, a future edge function — calls the same resolver instead
of re-deriving title/description logic independently.

```
subject descriptor  →  resolveOgMetadata()  →  { title, description, canonicalUrl, image, imageAlt }
```

### Subject shape

A `subject` is a plain object describing what the page is about, not how it's delivered:

```js
{
  page: 'listings' | 'listing' | 'district' | 'propertyType' | 'search',
  propertyType: 'house' | 'apartment' | ... | null,   // key from terminology.js PROPERTY_TYPES
  transactionType: 'for_rent' | 'for_sale' | null,
  district: 'Sisattanak' | ... | null,                 // key from listings.html's DISTRICT_COORDS
  listing: { id, title_en, price, cover_photo_url, ... } | null   // only for page:'listing'
}
```

This directly covers every example in the request — "Houses for Sale in Xaysettha" is
`{page:'search', propertyType:'house', transactionType:'for_sale', district:'Xaysettha'}`;
"Apartments for Rent in Sisattanak" swaps type/district; "Commercial Property for Rent" omits
`district`; "Land for Sale in Laos" omits `district` and reads as the whole-country default,
matching how `listings.html`'s current filters already compose type + transaction with no
district dimension yet.

### Title/description composition rule

One deterministic template, not one string per combination:

```
subject phrase = [propertyLabel, districtPhrase].filter(Boolean).join(' in ')
                  where propertyLabel = [PROPERTY_TYPES[type].en, txWord].filter(Boolean).join(' for ')
title       = subject phrase ? subject phrase + ' in Laos | Pintag' : LISTINGS_DEFAULT_TITLE
description = subject phrase ? 'Browse verified ' + lower(subject phrase) + ' listings across Laos...' : LISTINGS_DEFAULT_DESCRIPTION
```

This is exactly `updateListingsMetaForFilters()`'s existing logic in `listings.html`, generalized
with one more optional dimension (`district`) — not a new algorithm. The district vocabulary
reuses the 7 keys already canonical in `listings.html`'s `DISTRICT_COORDS` object rather than a
second district list; the property-type vocabulary reuses `terminology.js`'s `PROPERTY_TYPES`,
already shared by `admin.html`/`listing.html`/`listings.html`/`index.html`. `resolveOgMetadata()`
introduces no new vocabulary of its own — it only composes vocabularies that already exist in
exactly one place each.

### Image strategy

Hand-authoring a unique branded collage image per subject (the way `og-preview-listings-gen.html`
was built) does not scale to districts × types × transactions. Proposed tiering, cheapest first:

1. **`page:'listing'`** — use the listing's own `cover_photo_url`. It's real, specific, already
   stored, and more useful to a buyer than any generic branded image.
2. **`page:'propertyType'` / `page:'search'` with a `propertyType`** — one pre-made branded image
   per property type (7 total: house, townhouse, villa, apartment, condo, commercial, land),
   generated once via the same canvas-generator pattern as `og-preview-listings-gen.html`, reused
   across every transaction/district combination of that type. Seven images, not hundreds.
3. **`page:'district'`** or any subject with no clear property-type image (e.g. "Land for Sale in
   Laos" has a type but "Property in Sisattanak" might not) — fall back to the existing
   `og-preview-listings.jpg`. A generic-but-correct image beats blocking the whole feature on
   commissioning per-district photography.

This keeps the asset count small and reuses the exact generation tool already built, rather than
inventing a new image pipeline.

## Delivery mechanisms — same resolver, different callers

The resolver is delivery-agnostic on purpose. Three callers, built in this order as the need
grows:

1. **Client-side DOM update (exists today, would be refactored to call the shared resolver)** —
   `listings.html`'s `updateListingsMetaForFilters()` becomes a thin wrapper: build a `subject`
   from `currentTypeFilter`/`currentTxFilter`, call `resolveOgMetadata()`, write the result to
   `document.title` and the `og:`/`twitter:` tags. Same visitor-tab/Googlebot benefit as today,
   zero behavior change, but the title logic now lives in one shared file instead of being
   duplicated if a second page needs it.
2. **Static pre-rendered pages (recommended first real crawler-visible step)** — a small build
   script (Node, no new runtime dependency — matches this repo's existing zero-build-step
   convention, run manually or via a GitHub Action similar to `deploy-prod.yml`) enumerates a
   curated, high-traffic subject list (7 property types × 2 transaction types × 7 districts is
   98 combinations — too many to hand-write, cheap to generate), calls `resolveOgMetadata()` for
   each, and emits a static HTML file per subject (e.g. `houses-for-sale-in-sisattanak.html`)
   containing only the right `<head>` tags plus a redirect/canonical pointer into
   `listings.html`'s real filtered view — the same "one static file per shareable subject"
   pattern `listing.html`'s per-property pages already use. This requires no new infrastructure
   beyond what GitHub Pages already serves.
3. **Edge/server-side prerendering (the heavier, more complete future option)** — a
   crawler-user-agent-detecting edge function (Cloudflare Workers, or a Supabase Edge Function
   sitting in front of the static site) calls `resolveOgMetadata()` at request time for *any*
   subject, including combinations too long-tail to pre-render statically. Worth building once the
   popular-combination list from (2) demonstrably isn't enough — not before, since it's real new
   infrastructure this repo doesn't have today (no existing request-time compute in front of
   GitHub Pages).

Either (2) or (3) reads `resolveOgMetadata()`'s output and writes it into real `<head>` tags a
non-JS crawler will actually see — that's the part today's client-side-only update structurally
cannot do, as already documented in `listings.html`.

## File boundaries (for when this is built)

- **New `og-metadata.js`** (repo root, alongside `terminology.js`/`rental-terms.js`) — pure data +
  `resolveOgMetadata(subject)`. No DOM code, no fetch calls, importable by a browser `<script>` tag
  today and by a Node build script or edge function later without modification — the same
  "shared logic file, framework-agnostic" convention already established by this repo's other
  registries.
- `listings.html` — refactor `updateListingsMetaForFilters()` to build a `subject` and call the
  shared resolver, dropping its inline duplicate of the composition logic.
- `listing.html` — same refactor for its own per-property title/description building, which today
  is a second, independent implementation of "subject → title" worth consolidating once this
  exists, not before.
- Future, only when a delivery mechanism from above is actually built: a build script or edge
  function file that imports `og-metadata.js` — not a redesign of it.

## What this explicitly does not do yet

- No static pages are generated.
- No edge function is deployed.
- No new images beyond the already-shipped `og-preview-listings.jpg` are created.
- `listings.html`/`listing.html` are not refactored to call a shared resolver in this pass — that
  refactor is low-risk and mechanical once `og-metadata.js` exists, but is deliberately deferred
  until a real delivery mechanism (2 or 3 above) needs it, so this doesn't become unused
  indirection sitting in production HTML today.

## Verification (once implementation is approved)

- Unit tests for `resolveOgMetadata()` covering every example subject in this document plus edge
  cases (no type, no district, no transaction, all three present).
- For the static-page approach: confirm each generated file's `<head>` matches
  `resolveOgMetadata()`'s output exactly, and that its canonical URL points at the real filtered
  `listings.html` view a human visitor should land on.
- For the edge-function approach: confirm crawler-UA detection doesn't accidentally serve
  pre-rendered HTML to real visitors (verified via both a spoofed crawler UA and a normal browser
  UA hitting the same URL).
