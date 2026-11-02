# Location privacy — read-only audit and implementation specification

**Status: AUDIT + SPECIFICATION ONLY. Nothing here is implemented.** No migration, code change, production query or
deployment was made to produce it. It contains **no real coordinates, addresses, map links or listing identifiers**;
examples are placeholders. Basis: the repository at `main` 292e7ea (after PR #167), plus the completed CI runs cited in
`docs/SECURITY_BACKUP_EVIDENCE_2026-11-02.md`. What could not be verified from the repository is marked **UNVERIFIED**.

Owner decision (2026-11-02): public listings show the **village and an approximate location only**; exact residential
coordinates and unit addresses are never public; administrators keep the complete address; the exact address is given
privately to a tenant only after a viewing is confirmed. **Protect the underlying data — not browser-side rounding or
hiding links.**

### Decisions recorded by the owner (2026-11-03) — these override any alternative below
1. **Approximate public location = the centre of a 0.01° grid cell** (about 1.1 km), computed in the database.
2. **Display an approximate area, not a precise pin.** Zoom **14 or lower** only.
3. **No precise-public-pin exception in V1**, including commercial buildings. May be reconsidered later.
4. **If a map link cannot be parsed safely, show village/district information only** and do not invent a map point.
5. **The backfill is an administrator/operator-controlled process**: dry-run and aggregate report first; **never guess or silently discard** an
   unparseable location (it is kept, flagged and listed for the administrator — see M2).
6. **Before any owner notification:** document the exposure and obtain appropriate legal advice on notification obligations.
7. **Implementation is not authorized.** This is audit and specification only.

---------------------------------------------------------------------------------------------------
## 1. Audit

### 1.1 Where exact location is stored
| Store | Holds | Who can read it today |
|---|---|---|
| `properties.map_embed_url` | The Google Maps link the administrator pastes. It is the **only** source of a listing's location (`map-location.js` header). Short links are resolved to a long link with coordinates before saving (`resolve-map-url`, `admin.html`) | **Anyone with the public key** — see 1.2 |
| `properties.latitude`, `properties.longitude` | Code comments say they exist but are NULL for every row and nothing writes them. **UNVERIFIED** (the columns pre-date tracked migrations; confirm with a catalog query) | Same as above if they exist |
| `properties.village_en`, `district_*`, `province` | Deliberately public place names | Public by design (owner decision) |
| `properties_row_snapshots.row_data` | Full-row JSON of a property written on soft/hard delete — includes the link | Administrator only (policy `admin read properties_row_snapshots`; the weekly drift check shows anonymous reads return no rows) |
| `listing_provenance` (`map_changed` events carry old/new link) | History of edits | Administrator only (policies are `is_pintag_admin`) |
| `import_records.raw_payload`, `import_images` | Smart-import raw material (may include a pasted location or address text) | Administrator only by policy (`admin read import_records` / `import_images`, `is_pintag_admin`); not among the tables the weekly anonymous probe reads, so confirm it there |
| Encrypted weekly backups, off-platform | Everything | Holder of the offline private key |
| Free text: `description_*`, `title_*`, `neighborhood_*`, `nearby_places`, AI-generated copy | Could contain a street, house number or building name | Public. **UNVERIFIED** how often; needs an aggregate pattern count (see 6.2) |
| Photos (storage bucket, public CDN) | Possible embedded GPS metadata and identifying content (house numbers, signage). No code in the repository strips or inspects metadata explicitly; whether the watermark step re-encodes and drops it is **UNVERIFIED** | Public |

### 1.2 Can anonymous users retrieve exact locations directly through Supabase with the public key? — **Yes, by design (high confidence from code and policy; not re-proved against production)**
* Policy `public read active properties` is `FOR SELECT TO public USING (status IN ('active','available') AND deleted_at IS NULL)`
  (migration `20260806020000`). It is a **row** filter. Row-level security cannot hide a column.
* No migration revokes or restricts column-level `SELECT` on `properties` (searched: none), and the weekly drift report checks
  only that anonymous holds no INSERT/UPDATE/DELETE. The public pages themselves read these columns with the public key, so
  the privilege must exist.
* Therefore `GET /rest/v1/properties?select=map_embed_url,latitude,longitude` with only the public key returns them for every
  listing visible to the public. The same applies to `/graphql/v1` if pg_graphql is enabled (same privilege model;
  **UNVERIFIED** whether it is), and to the OpenAPI document at `/rest/v1/`.
* A read-only production proof that reveals **no values**: `GET /rest/v1/properties?select=id&map_embed_url=not.is.null&limit=1`
  with header `Prefer: count=exact`, reading only the `Content-Range` count. (Not run; production queries are not authorized.)

### 1.3 Public surfaces that carry exact location
| Surface | What it does with the exact link | Exposure |
|---|---|---|
| `listing.html` detail page | `select=*` with the public key; `map-location.js` parses the link; builds an iframe `maps.google.com/maps?q=<lat>,<lng>&z=16&output=embed` and an "Open in Google Maps" link `…/maps?q=<lat>,<lng>` | Full-precision (~1 cm) coordinates in the **page source, the iframe URL, the outbound link, and the network response**; also sent to Google |
| `listing.html` for a *place* link (no coordinates) | Uses the original stored link as the outbound destination | The stored link itself is exposed |
| `listings.html` map view | `select=*`; plots one exact Leaflet marker per listing | Exact coordinates for every listing, in JS memory and the network response |
| `index.html` homepage | `select=*` for cards | The column is **delivered to the browser** even though the cards do not render it |
| `agent.html`, `agents.html`, `for-agents.html` | Explicit column lists | No location column (verified) |
| `components.js` cards | Do not read location | None |
| `cloudflare-worker/og-listing-preview.js` (link preview) | Explicit column list | No location (verified) |
| `public-listings-feed` edge function | Explicit `PUBLIC_FIELDS` allowlist | No map link or coordinates; exposes `village` and district only (verified) |
| OG / Twitter / meta description, share text | Built from title, price, district | No coordinates (verified by reading the builders) |
| JSON-LD / sitemap | Do not exist | None today; **any future `geo` must use the approximate point only** |
| `tracking.js` / `ui_events` | Record element ids and labels, not hrefs | None found |
| `resolve-map-url` edge function | Expands a pasted short link; allow-listed hosts; has CORS `*` | Does not read stored data; not a leak of stored locations |
| Legacy owner pages (`add-property`, `edit-listing`, `dashboard`) | Read/write the link | **Pruned from the production artifact**; admin-only in effect |
| `admin.html` | Reads/writes the link | Admin only, keep |
| **GitHub Pages artifact** | `deploy-prod.yml` uploads the whole repository root (`path: .`) after removing only five legacy pages | Repository docs, scripts and tests are served as static files on the production domain. No real coordinates or listing identifiers were found in tracked files, but this is a standing disclosure path worth a separate review (6.3) |

### 1.4 Other observations
* Realtime: **UNVERIFIED** whether `properties` is in the `supabase_realtime` publication. If it is, row changes (all columns) are
  broadcast to subscribers allowed by the row policy, so a column cannot be protected there either.
* Cached copies: responses from the data API are not cached by the site, but anything already harvested (scrapers, browser
  caches, Google's embed logs) cannot be recalled. This is a **risk to record**, see 6.4.
* The mass-delete guard blocks hard deletes of ≥10 rows; an UPDATE that clears many rows is not blocked by it (it is a delete
  guard) — the backfill/clear steps need their own safeguards (section 4).

---------------------------------------------------------------------------------------------------
## 2. Design principle
**Exact data must live where anonymous cannot read it — a different table with no anonymous privilege at all — and the
public record must contain only a coarse value derived on the server.** Specifically *not*: rounding in the browser, hiding the
link in the UI, or relying on `select=*` not being used. Row-level security hides rows; to hide data we move it.

## 3. Target design

### 3.1 Private exact location (new table, administrator only)
`property_private_locations`
* `property_id uuid PRIMARY KEY` (plain uuid, no cascading FK — the L1 rule; integrity enforced by the admin RPC and a check query),
* `map_link text` (what the administrator pasted, normalized), `exact_lat numeric`, `exact_lng numeric` (parsed server-side),
  `address_text text` (house number / unit / street, the thing the tenant is eventually told), `access_notes text`,
* `source text`, `created_at`, `updated_at`, `updated_by uuid`.
* **Privileges:** `REVOKE ALL ON TABLE … FROM PUBLIC, anon, authenticated;` then `GRANT SELECT, INSERT, UPDATE ON … TO authenticated;`
  with RLS **enabled and FORCEd** and a single policy `USING/WITH CHECK (is_pintag_admin(auth.uid()))`. Rationale: Supabase's
  default privileges grant new tables to `anon` and `authenticated`; the revoke is mandatory, and `anon` must receive a
  **permission-denied (42501)**, not merely an empty result, so the control is the privilege and the policy is a second lock.
  No `anon` policy of any kind. No delete privilege (soft retention; removal by RPC only).
* **No foreign key to `properties`**, so PostgREST cannot offer `properties?select=*,property_private_locations(*)` as an embedding.
* Not exposed through any view, any `SECURITY DEFINER` function callable by `anon`, any feed allowlist, Realtime publication or
  analytics table. Added to the drift check as "anon has no privilege on this table".
* Writes only through an admin RPC `admin_set_property_location(p_property_id, p_map_link, p_address_text, …)` (`SECURITY DEFINER`,
  `SET search_path`, first statement `IF NOT is_pintag_admin(auth.uid()) THEN RAISE`, `REVOKE EXECUTE … FROM PUBLIC, anon`), which
  (a) validates and parses the link with the same rules as `map-location.js` ported to SQL, (b) stores the exact data, (c) computes and
  stores the **public approximate point** (3.2) in the same transaction, (d) writes a provenance event without the value.

### 3.2 Public approximate location (new columns on `properties`)
`public_location_lat`, `public_location_lng` (numeric), `public_location_precision` (`'area'` | `'village'` | `'district'` | `'none'`),
`public_location_label` (optional place name). Public by design; contains nothing derived reversibly.
* **Computed in the database by the admin RPC, never in the browser.** The point is the **centre of a fixed grid cell**
  (**decided: 0.01° ≈ 1.1 km**). Every listing in a cell shows the same point, so
  there is no per-listing offset to average away or reverse, no random seed to discover, and the exact position can be
  anywhere in the cell. (Rejected: random jitter — repeated reads or a known seed let an attacker triangulate; plain rounding of
  the exact value to few decimals — same as the grid but leaks the cell boundary pattern less well; offsetting by a fixed vector — reversible.)
* **Fallback when the link cannot be parsed safely** (place-only link, short link that cannot be expanded, out-of-bounds or reversed pair, no link):
  `public_location_precision = 'none'` — the page shows the village/district names only; **no map and no point are invented**, and no district
  centroid is substituted. The listing stays in the administrator's "needs attention" list until a safe link is supplied.
* **Map rendering (decided):** an **approximate area** (a circle or the grid cell, labelled "approximate area"), **not a pin**; zoom **14 or lower**, so
  the base map cannot resolve buildings; no street-level imagery or Street View link. The outbound link opens the approximate point at that zoom,
  labelled approximate. No page reads `map_embed_url`, `latitude` or `longitude`.
* **No precise-public-pin exception in V1** (including commercial buildings). `public_location_precision` therefore has only `'area'`, `'village'`,
  `'district'` and `'none'`; there is no value that publishes an exact point.

### 3.3 Administrator access
Administrators (single MFA-gated admin, `is_pintag_admin`) read and edit exact data through the private table/RPC. `admin.html`'s
map field loads and saves through the RPC; the admin list shows only "has exact location: yes/no". Exports and backups continue to
contain the private table (encrypted).

### 3.4 Confirmed tenants (later, with viewing requests)
After a viewing is **confirmed**, a `SECURITY DEFINER` RPC returns the address text and exact point **only** for that request:
requires the request's unguessable token (hash compared), status `confirmed`, within a window (from confirmation to the viewing time
plus a grace period), rate-limited and audited. It is the only non-admin path to the private table. Not part of this phase.

### 3.5 Old location data
`properties.map_embed_url`, `latitude`, `longitude` are **emptied (set NULL) after verification (section 4)**, not hidden. The columns may
stay (nullable, empty) for rollback until a later cleanup migration drops them. Old copies that remain **admin-only**: row snapshots,
provenance events, import payloads, encrypted backups — listed and verified private (section 5).

## 4. Migration plan for existing listings (each step separately authorized; dev first)
| Step | Action | Gate / verification |
|---|---|---|
| M0 | Preconditions: a **fresh verified backup** and PITR confirmed (evidence record O1, O2); grid size (0.01°), area display and no-exception rule are decided; legal advice on owner notification is obtained or scheduled | Owner sign-off |
| M1 | **Additive migration**: private table (revoked/RLS/FORCE), public columns, admin RPC, read-only check functions. No data moved, no behaviour change | DB regression tests (section 5) pass on a throwaway Postgres; apply to **dev** first |
| M2 | **Operator-controlled backfill** (a one-off script run by the administrator/operator, **never automatic**). Step 1 is a **dry-run that writes nothing** and produces an **aggregate report**: listings with a link; parseable safely; place-only; short link not expanded; out of bounds; reversed or implausible pair; no link. Only after the operator approves the dry-run is the real run executed. Each parseable link is copied to the private table and its public point computed. **Every unparseable or ambiguous link is kept (raw, in the private table, flagged `parse_status`), shown to the administrator as a counted "needs attention" list, and the listing falls back to village/district only — it is never guessed, rounded to a "best" point, or silently discarded** | Aggregate report only (no values); operator sign-off on the dry-run |
| M3 | **Verification before anything is removed** (read-only, aggregate): (a) private rows = properties that had a link; (b) a hash of each stored link equals the hash of the private copy (lossless copy); (c) every public point is a grid-cell centre and differs from the exact point; (d) every parseable listing has a public point; (e) `anon` cannot read the private table (42501) and `properties` public columns hold no exact value in the new columns; (f) a second backup taken after the copy | All pass, recorded in an evidence note |
| M4 | **Deploy public pages that read only the approximate fields** (listing detail, map view, homepage no longer needs the column). Pages must not fall back to `map_embed_url` | Browser tests (section 5); deploy only after M3 |
| M5 | **Clear** `map_embed_url`, `latitude`, `longitude` on `properties` (single transaction, batch-size-limited, row count asserted equal to M3, ops alert noted beforehand) | Backup <30 min old; abort on any count mismatch |
| M6 | **Production proof** with the public key (read-only): the count probe from 1.2 returns 0 non-null; `/rest/v1/property_private_locations` is denied; OpenAPI does not list it; no response from any public page contains a coordinate pair with more than the approximate precision | Recorded |
| M7 | Later cleanup migration: drop the three old columns; remove the old parsing from public pages | Separate authorization |
**Rollback:** until M7, restore any listing from the private table with the admin RPC; M5 is reversible from the private copy and the post-M3 backup.
**Exposure that already happened** cannot be undone (section 6.4).

## 5. Tests that must exist before M4
1. **Throwaway-Postgres regression (like `tests/security/regression/`)**: as role `anon` and as an `authenticated` non-admin, `SELECT` on
   `property_private_locations` fails with `42501`; `INSERT/UPDATE/DELETE` fail; as admin they succeed; RPCs refuse non-admin and `anon`;
   `has_table_privilege`/`has_column_privilege` for `anon` is false on every private column; no function executable by `anon` has the private
   table in its source (catalog scan); no view references it; it is not in any publication; the migration is idempotent.
2. **Public data contains no exact value**: after the backfill on a synthetic dataset, every public point is a grid centre, equals no exact
   point, and re-running the backfill with a different insertion order yields the same public points (no seed to recover).
3. **Static code tests**: no public page, `components.js`, the Worker or an edge-function allowlist references `map_embed_url`, `latitude`,
   `longitude` or the private table; no URL is built from an exact pair; `select=*` on `properties` remains safe because the table holds no exact value.
4. **Browser tests (Playwright, mocked Supabase)**: the listing page and map view render an approximate area; the page source, iframe URL and
   outbound link contain only approximate coordinates; a listing with no safe point shows no map and no broken link.
5. **Production anon proof workflow** (manual, read-only, GET only, no values printed): the probes in M6, added to `verify-production-http.sh`
   as permanent weekly checks so a regression is caught.
6. **Drift check additions** in `scripts/verify-production-security.sql`: anon privilege on the private table = none; `properties` columns visible to anon exclude any exact-location column.

## 6. Risks, decisions and related findings
### 6.1 Decisions
Decided (2026-11-03): grid 0.01°; area not pin; zoom ≤ 14; no exact-public exception in V1; village/district only when unparseable; operator-controlled
dry-run-first backfill; never guess or silently discard; legal advice before owner notification.
Still open: who performs the backfill and reviews the "needs attention" list; the wording of the "approximate area" label in Lao, English and Chinese
(native-speaker review); the interim handling of listings whose only location is the exposed link (see 6.4).

### 6.2 Further read-only checks to add (aggregate counts only, no values)
Count listings whose description/title/neighborhood text matches address-like patterns; count public photos with embedded location
metadata (sample by an administrator); confirm Realtime publication and GraphQL status; confirm the `latitude`/`longitude` columns exist.
The catalogue report (PR #170) already counts listings by map-link precision class.
### 6.3 Separate finding — repository files are published on the production domain
`deploy-prod.yml` publishes the whole repository root. Documentation, migrations, scripts and tests are therefore web-reachable
on the production domain. No real location data was found in tracked files, but this exposes security documentation and internals
and deserves its own decision (publish only the site files).
### 6.4 Accepted-risk record (to be signed by the owner)
Until M5 completes, exact locations remain retrievable by the public key. Data retrieved before M5 cannot be recalled. This is a
known, documented exposure; the spec shortens it by ordering M4 (public code) before M5 (clearing) and by not blocking on optional work.
### 6.4a Owner notification (decided: document first, advice first)
Before any owner is told, (1) document the exposure (what was retrievable, since when, how many listings by aggregate count, what evidence shows
whether it was accessed — the data API's access logs may or may not exist), and (2) obtain appropriate legal advice on any notification obligation to
owners and authorities and on wording. No notification is sent by engineering.

### 6.5 Complexity and dependencies
Large; split into four PRs (M1 DB + tests; admin RPC use in `admin.html` + backfill tool; public pages + tests; production proof workflow).
Dependencies: M0 backup/PITR evidence; independent of viewing requests, but the confirmed-tenant address release (3.4) depends on it, so
**viewing requests must not launch before M5 is complete or the exposure is explicitly risk-accepted.**

---------------------------------------------------------------------------------------------------
## 7. Indirect location identification (assessment)
Protecting the coordinates does not by itself prevent a person from working out where a home is. Public content can narrow a 1.1 km cell to a building.
Assessment, ordered by how much each source narrows the location (rating = my judgement, not measured; **UNVERIFIED** against real listings — the
catalogue report and an administrator review would measure it):

| Source | How it identifies | Rating | Control |
|---|---|---|---|
| **Photos** | Visible house numbers, signage, shop names, street names; distinctive buildings, rooflines, views from windows; reverse-image search of public photos; embedded GPS metadata (EXIF) if the pipeline keeps it (UNVERIFIED) | **High** | Strip all metadata server-side at upload and verify on a sample; administrator photo checklist (no house numbers/signs/license plates; limit exterior and window-view shots); optional blurring tool; re-check existing galleries |
| **Building / project / condo names** in titles, descriptions, tags | A named building is an exact location | **High** where used | House style: residential listings use a neutral description (type, size, area) rather than the building name; decide the policy for named buildings (V1 has no exact-pin exception, so names should not reintroduce one) |
| **Descriptions and AI-generated copy** | Street names, house numbers, "behind X", "opposite Y", lane/soi numbers | **High** | Aggregate pattern scan (counts only) of descriptions/titles; admin edit pass; make the content generator and Smart Import prompts exclude addresses and landmarks; review on publish |
| **Nearby places** (`nearby_places`, neighbourhood text) with names and distances | Two or three named landmarks with distances triangulate a point | **Medium–High** | Show categories and distance bands, not named landmarks with exact distances, or cap to one landmark at ≥ 500 m |
| **Village + district + province** (public by decision) | Narrows to the village; in a small village this is nearly the street | **Medium** | Accepted by the owner; measure listings per village in the aggregate report so tiny villages can be treated as district-level |
| **Listing attributes** (floor, unit number, floor plan, view, price, size, availability date) | A distinctive combination plus public floor plans identifies the building | **Medium** | Do not publish unit numbers; floor ranges only |
| **Third-party links** (`facebook_video_url`, `video_url`, imported source posts) | The original social post often carries an address, tagged place, owner name and comments | **High** where present | Public pages should not link to or embed the original post; keep `source_url`/raw payload admin-only; review existing video links |
| **Agent / contact information** | An office address or the owner's own number can resolve to a place | **Low–Medium** | Contact-routing decision already separates identity from buyer contact; review agents whose public profile is the owner |
| **Map tiles at zoom ≤ 14** | Show main roads and districts only | **Low** | Decided cap |
| **Time and change history** | Repeated edits of the public point would reveal movement; the grid makes it constant | **Low** | Grid cell is deterministic; no jitter to average |
| **Combination with other sites** | Facebook groups, other portals, Google reverse image search | Outside our control | Reduces with photo hygiene and neutral descriptions |

**Residual risk:** this cannot be driven to zero. The design target is that a casual visitor, scraper or bulk harvester cannot obtain a street address
from the platform's data, and that a determined individual needs substantial independent effort. The owner should accept this explicitly.
**Measurements to add (aggregate counts only):** descriptions/titles matching address-like patterns; listings with named landmarks in `nearby_places`; listings
per village (small-cell check); listings with a third-party video/post link; a sampled count of photos with metadata or visible text (administrator).
