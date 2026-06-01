# Backlog

## Slug Uniqueness Migration

**Status:** Proposed — do not implement yet.

### Problem

Slugs for new listings are generated in `admin.html` using a 6-digit suffix derived from the current timestamp:

```js
const suffix = Date.now().toString().slice(-6);
const slug = `${slugBase}-${suffix}`;
```

This means:
- Only 1,000,000 possible suffix values, which may collide under bulk import or rapid sequential saves.
- Suffix values are predictable (time-based), making slug enumeration trivial.
- No database-level uniqueness constraint is enforced, so duplicate slugs can be silently inserted.
- A duplicate slug would cause the wrong property to be shown on `listing.html` (the first match wins).

### Options

**Option A — UUID-based suffix (client-side)**
Replace `Date.now().toString().slice(-6)` with `crypto.randomUUID().slice(0, 8)`.
- Pro: trivial one-line change; ~4.3 billion possible values.
- Con: still no guarantee of uniqueness; collision probability is low but nonzero.

**Option B — Database UNIQUE constraint + client-side retry**
Add a `UNIQUE` constraint on the `slug` column in Supabase (or a partial unique index on `slug` WHERE `slug IS NOT NULL`). The client catches a `23505` Postgres error code and retries with a fresh suffix.
- Pro: guaranteed uniqueness enforced at the database level.
- Con: requires a migration; admin.html needs error-handling for the retry loop.

**Option C — Server-side slug generation in an Edge Function**
Move slug generation to a Supabase Edge Function that queries for collisions and returns a guaranteed-unique slug before the listing is saved.
- Pro: cleanest separation of concerns; business logic off the client.
- Con: requires a new Edge Function and API call from admin.html.

### Acceptance Criteria (when implemented)

- [ ] Two listings saved within 1 ms of each other always get distinct slugs.
- [ ] Bulk-importing 10,000 listings produces 10,000 unique slugs.
- [ ] `listing.html?slug=X` always resolves to exactly one property.
- [ ] Existing slugs in the database are not affected (migration is additive).
