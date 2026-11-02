# Viewing requests — product decisions, privacy and access (V1)

**Status: DECISIONS RECORDED; NOTHING BUILT.** No table, function, form, flag or migration exists for this feature.
This page records what the owner decided on 2026-11-02 so the build starts from agreed rules, and lists what is
still open. The detailed technical specification lives with the engineering plan; this page is the decision record
and the privacy/access reference. Where counsel or a native speaker must review something it says so — nothing here
asserts what Lao law requires.

## Decisions (owner, 2026-11-02)
| Topic | Decision |
|---|---|
| Tenant contact | Phone **required**; email optional |
| Preferred times | Up to **3** date + time-window choices |
| Time zone | **Asia/Vientiane** (UTC+7, no daylight saving) |
| Windows | Morning 09:00–12:00 · Afternoon 12:00–17:00 · Evening 17:00–19:00 |
| Booking window | From **tomorrow** through **30 days** ahead |
| Unanswered requests | **Expire after 7 days** |
| Closed requests | Retained **12 months**, then personal information is **anonymized** (deleted or irreversibly de-identified), subject to any legitimate legal retention requirement (see "Legal review") |
| Who coordinates | **Administrator** (no owner login in V1); owner confirms, declines or proposes another time via the administrator |
| Owner portal | **Deferred** until a proper authentication and authorization design exists |
| Availability (decided 2026-11-02, restored 2026-11-03) | **Default:** a property is eligible only when it is available AND at least one relevant unit type is available; tenants may select only eligible unit types; requests for unavailable or occupied units are **rejected server-side**. **Exception:** an administrator may deliberately enable viewings for an otherwise unavailable or occupied listing through `viewing_policy` (see "Eligibility and unit selection"). The exception is never automatic |
| Notifications | No paid APIs. Admin dashboard + manual WhatsApp. Automation is proposed separately |
| Bot protection | Cloudflare Turnstile, validated server-side, with an accessible WhatsApp fallback (`docs/TURNSTILE_SETUP.md`) |
| Initial limits (configurable defaults) | 5 submissions per IP per hour · 3 open requests per phone · 20 open requests per property. IP limits are **never the only control** (shared mobile IPs in Laos): combine with per-phone/property caps, honeypot, Turnstile and expiry |
| Link to existing data | Every request is linked to the property and to the existing lead (through the tracked-event path) |

## Launch gate (owner decision, 2026-11-02)
The public viewing-request form does not launch until each of these items in `docs/SECURITY_BACKUP_EVIDENCE_2026-11-02.md` is
**completed** (with evidence) or **explicitly risk-accepted in writing by the owner** (recorded in that document with date and reason):
**O1** storage restore · **O2** point-in-time recovery · **O3** authenticated admin lockdown matrix · **O9** Cloudflare rate limiting / WAF.
**O4** (live security-header / XSS proof), **O7** (alert delivery) and **O8** (backup decryption) are tracked in the same document and do not
block launch by themselves. **L1 Production Safe remains PENDING** until its full certification criteria are met; accepting a risk for the
viewing-request launch does not certify L1. Exact location exposure is a separate gate (`docs/LOCATION_PRIVACY_AUDIT_AND_SPEC.md`).

## Eligibility and unit selection (owner decision, 2026-11-02; exception restored 2026-11-03)

### Default rule (applies to every listing unless the exception below is on)
1. **Eligible property:** the property's market status is *available* (canonical rule in `property-availability.js`, ported to SQL for the
   server check) **and** at least one relevant unit type is available (canonical rule in `unit-availability.js`). A single-unit listing
   counts as its own unit.
2. **Unit choice:** the tenant may select **only eligible (available) unit types**. When only *some* unit types are available, the tenant chooses which
   available one to view. On a multi-unit listing the unit is always required (the WhatsApp flow already requires a unit selection).
   Unavailable and occupied unit types are not offered in the form.
3. **Server-side enforcement:** the submission function re-evaluates availability at the moment of the request and **rejects** (with a clear,
   translated message and the WhatsApp alternative) any request for: an unavailable or occupied property; a unit type that is not available;
   a unit type that does not belong to the property; a missing unit on a multi-unit listing. The client's view of availability is never trusted.
4. **Race handling:** if a unit becomes unavailable after submission but before the administrator responds, the request stays on record and the
   administrator declines or proposes another unit; eligibility is checked again when the administrator confirms.
5. **Stored with the request:** the unit type requested and the availability state and `viewing_policy` seen at submission, for audit.

### Exception: `viewing_policy` (explicit, administrator-only)
* `properties.viewing_policy` has three values: *default* (NULL; the rule above), `allow_when_unavailable` (the exception) and `disabled`
  (no requests for this listing at all). Only the administrator can change it.
* **Intentional:** turning the exception on is a deliberate action in the admin console, never inferred from a status, a date, a lead or an
  import. Availability changes never switch it on, and it is not on by default for any listing.
* **Auditable:** every change writes an append-only event (who, when, old value, new value, a **required short reason**) in the existing
  provenance/audit trail, with no personal data. The admin list shows which listings currently have the exception and when each expires.
* **Expires after 30 days (decided 2026-11-03):** `allow_when_unavailable` carries an expiry timestamp, set to 30 days from the moment the
  administrator enables it. After that moment the listing automatically reverts to *default* (a scheduled job and, as a backstop, a check at every
  request). An administrator can **renew** it only deliberately, again for 30 days from the renewal, and each renewal is its own logged event with
  a **required reason**. Expiry and renewal are enforced by the database, not the page.
* **Listing-level scope (decided 2026-11-03):** the exception applies to the listing as a whole, not to named unit types.
* **Validated server-side:** the submission function reads `viewing_policy` (and its expiry) from the database at the moment of the request;
  the client is never trusted. It is read again when the administrator confirms. A request on an exception listing records that the exception was
  in force.
* **Unit selection under the exception (decided 2026-11-03):** even when the exception is on, the tenant must still select a unit type on a multi-unit
  listing, and the selected unit type must itself be **explicitly eligible**: the listing-level exception makes the *listing* eligible but never
  makes an arbitrary unit selectable. A unit type is explicitly eligible when it is available under the default rule, or when the administrator has
  explicitly marked that unit type viewable as part of enabling the exception (recorded in the same audit event). The server rejects any other unit
  type. Open question: the exact control for marking an otherwise unavailable unit type viewable (a per-unit checkbox in the admin console is suggested).
* A listing with the exception on still follows every other rule: rate limits, Turnstile, 7-day expiry, privacy, address protection.

## Address privacy (owner decision)
* **Public pages** show the **village and an approximate location only**.
* **Exact residential coordinates and unit addresses are never public.**
* **Administrators** keep full access to the complete address.
* **After a viewing is confirmed**, the exact address is given **privately to the confirmed tenant** (status page for
  that request and the administrator's WhatsApp message), never before.

> The full audit and implementation specification is in **`docs/LOCATION_PRIVACY_AUDIT_AND_SPEC.md`** (separate pull request, specification
> only). Viewing requests must not launch before that exposure is closed, or the owner explicitly risk-accepts it.

### What the current code actually exposed (finding, read-only inspection of `main` at 292e7ea; superseded in detail by the audit above)
This is a **gap versus the decision above**, recorded so it is fixed deliberately:
1. A listing's `map_embed_url` (the administrator-pasted Google Maps link) is the location source of truth
   (`map-location.js`, rule 4: "Nothing is rounded… 7 decimal places (~1 cm)").
2. `listing.html` loads the property with `select=*` using the public key, so **`map_embed_url` is readable by anyone**
   through the API, not only through the page.
3. The listing page puts the **full-precision latitude/longitude** into a Google embed (`maps.google.com/maps?q=<lat>,<lng>&z=16`)
   and into the "Open in Google Maps" link; `listings.html` plots an exact marker per listing.
4. `latitude`/`longitude` columns exist but are NULL; the link is the only source (`map-location.js` header).
5. No separate private-address field exists; `village_en` and the district fields are public.
6. The weekly catalogue report (separate PR) will count how many published listings carry coordinates with 5+ decimals
   (about 1 m) so the size of the exposure is measured, not guessed.

**Implication for the design:** protecting the exact address needs (a) a private location store readable only by the
administrator (a new admin-only table or column privileges — a public column cannot be hidden by the UI alone),
(b) a public approximate location (for example a deliberately reduced-precision point or the village/district centre,
labelled "approximate"), and (c) a change to how the listing page and map list embed and link. That is a larger,
user-visible change than the viewing form itself and needs its own specification and your sign-off. It is **not**
implemented by anything in the current PRs.

## Data collected and where it lives (planned)
| Data | Visibility |
|---|---|
| Tenant name (optional), phone (required), email (optional), note | Administrator only. Never in analytics, `ui_events`, logs, URLs, link previews or error messages |
| Preferred / proposed slots, status, timestamps | Administrator; the tenant sees their own request's status via an unguessable status link |
| Consent record (consent text version, timestamp) | Stored with each request |
| Exact address | Administrator always; the confirmed tenant only after confirmation |
| Owner/agent | Receive only what the administrator chooses to relay by WhatsApp in V1 |

**No user can see another user's phone number.** Anonymous visitors have no read access to any viewing table. Other
tenants, other owners and agents never see a tenant's phone through Pintag.

## Consent
* A required, unticked-by-default checkbox on the form, with plain-language text in Lao, English and Chinese stating:
  what is collected, why (to arrange a viewing), who sees it (Pintag administrators and the listing's owner or agent
  as relayed by the administrator), how long it is kept (7 days if unanswered; 12 months after the request closes, then
  anonymized), how to ask for deletion, and that Cloudflare Turnstile processes technical signals to prevent abuse.
* Each request stores the **consent version** and the time it was given. Changing the text creates a new version; old
  requests keep the version they accepted.
* The Lao and Chinese consent text is **drafted for native-speaker and legal review** and must not ship unreviewed.

## Retention and deletion (planned behaviour)
* Unanswered after 7 days → status `expired`.
* Closed (confirmed-then-completed, declined, expired, cancelled) → `closed_at` set; **12 months later** a scheduled job
  anonymizes name, phone, email, note, slots and messages, keeping only non-personal aggregates (property, status,
  dates, language, counts) for conversion statistics.
* A tenant can ask for earlier deletion; the administrator has an "anonymize now" action.

## Legal review (flagged, not assumed)
Counsel (or a qualified adviser in Laos) should confirm, **before launch**:
1. Whether Lao law on personal/electronic data protection, consumer protection or real-estate/brokerage activity imposes
   a **minimum or maximum retention** period for records of this kind, or record-keeping duties that override the
   12-month anonymization.
2. Whether **consent wording, notice and a deletion-request route** are mandated in a particular form or language, and
   whether registration or notification with an authority is required for collecting phone numbers.
3. Rules on **cross-border processing** (Cloudflare, Supabase hosting regions) and on **sharing a tenant's phone with an
   owner or agent**.
4. Whether processing technical signals through Turnstile needs separate notice.
Until answered, the defaults above stand, and they can be lengthened or shortened by configuration without a redesign.

## Still open (needs the owner)
* The admin control for marking a specific unit type explicitly viewable when the exception is enabled (see "Unit selection under the exception").
* The remaining location-privacy items in `docs/LOCATION_PRIVACY_AUDIT_AND_SPEC.md` §6.1.
* Consent/notice wording review (Lao, Chinese) and the counsel answers above.
* Who holds the Turnstile account (`docs/TURNSTILE_SETUP.md`).
