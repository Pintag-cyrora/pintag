# Pintag Architecture Invariants

This document records data-model invariants that must not be violated as
Pintag grows — self-service accounts, agencies, developers, CRM, and the
Intelligence Layer are all being built in parallel, and it's easy for
concepts that were deliberately kept separate to get silently recoupled
under time pressure. If you're about to make authentication imply
identity, or identity imply buyer contact, stop and re-read this first.

(Subsystem-specific architecture documents live alongside their code —
see `supabase/functions/generate-intelligence-report/INTELLIGENCE_ARCHITECTURE.md`
for the Intelligence Layer's own invariants.)

## Platform Identity, Buyer Contact, and Authentication are three separate concepts

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
