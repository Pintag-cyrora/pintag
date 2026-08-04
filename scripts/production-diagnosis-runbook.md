# Production Diagnosis Runbook — Missing Listings / Corrupted Price

For whoever has production database access. Every block is copy-paste-ready.
Run in order; stop as soon as a step tells you what's wrong. Target: under
10 minutes.

Prerequisites: a `psql` connection to production (Settings → Database →
Connection string in the Supabase dashboard), or the SQL Editor in the
Supabase dashboard for the SELECT-only steps (steps 1, 5, 6). Steps 2–3 need
nothing but a browser/curl. Step 7 writes data — run it in `psql` so you get
an interactive transaction, not the dashboard's auto-commit editor.

---

## Step 1 — Baseline counts (run first, ~30s)

```sql
-- 1a. Total rows
SELECT count(*) AS total_properties FROM properties;

-- 1b. By workflow_status (draft/active/archived — internal editorial state)
SELECT workflow_status, count(*)
FROM properties
GROUP BY workflow_status
ORDER BY count(*) DESC;

-- 1c. By market_status (public-facing availability)
SELECT market_status, count(*)
FROM properties
GROUP BY market_status
ORDER BY count(*) DESC;

-- 1d. By owner / managing agent (NULL = unassigned)
SELECT
  managed_by_party_id,
  (SELECT name_en FROM parties WHERE id = properties.managed_by_party_id) AS agent_name,
  owner_id,
  (SELECT name FROM owners WHERE id = properties.owner_id) AS owner_name,
  count(*)
FROM properties
GROUP BY managed_by_party_id, owner_id
ORDER BY count(*) DESC
LIMIT 50;
```

**Write down `total_properties` from 1a — every later step compares against it.**

---

## Step 2 — Admin page's exact REST request

This is the literal request `admin.html`'s `loadListings()` sends (from
`admin.html:2869`, current `main`):

```
GET {SUPABASE_URL}/rest/v1/properties?order=created_at.desc&select=id,slug,title_en,price_display,property_type,transaction_type,status,workflow_status,market_status,is_featured,managed_by_party_id,district_en,view_count,contacts(role,name,phone),owner_id,owners(id,name,phone,whatsapp)

Headers:
  apikey: <anon key, from config.prod.js>
  Authorization: Bearer <the logged-in staff member's session access_token>
```

No `limit=`, no `range=`, no filter of any kind — every row RLS permits for
that bearer token comes back.

To run it yourself: open `pintag.io/admin.html`, log in, open DevTools →
Network tab, find the `properties?order=created_at.desc...` request, and
read its **Response** tab row count directly — that is exactly what the
page received. Compare that number to `total_properties` from Step 1a.

---

## Step 3 — Public Listings page's exact REST request

From `listings.html:1018`, current `main`:

```
GET {SUPABASE_URL}/rest/v1/properties?or=(status.neq.draft,status.is.null)&order=is_featured.desc,created_at.desc&select=*,contacts(role,name),parties(type,name_en,photo_url)

Headers:
  apikey: <anon key, from config.prod.js>
  Authorization: Bearer <anon key>   (same value in both headers — public page, no session)
```

Or directly:

```bash
curl -s -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  "$SUPABASE_URL/rest/v1/properties?or=(status.neq.draft,status.is.null)&select=id" \
  -H "Prefer: count=exact" -H "Range: 0-0" -D - -o /dev/null | grep -i content-range
```

`Content-Range: 0-0/<N>` — `N` is the true row count this query matches,
independent of how many rows actually got fetched/rendered.

---

## Step 4 — Expected row counts

| Page | Query filter | Expected count |
|---|---|---|
| Admin (staff session) | none | `total_properties` (Step 1a), if the session truly resolves as staff — see Step 5 if not |
| Admin (non-staff/expired session) | `managed_by_party_id IN (their own owned_party_ids)` | however many listings that specific `parties` row manages — can legitimately be 1 or 0 |
| Public Listings | `status != 'draft' OR status IS NULL` | `total_properties` minus the `workflow_status = 'draft'` count from Step 1b (since `status` mirrors `workflow_status`, collapsed to `'active'` for any non-draft/archived row) |

If Admin's actual response count doesn't match either row of that table,
something is wrong beyond RLS scoping — go straight to Step 5's last query.

---

## Step 5 — Why would only one row come back?

Run each in order; the first one that returns something meaningful is your answer.

```sql
-- 5a. Is the logged-in admin actually recognized as staff? Replace
-- <auth_uid> with the real value: Supabase Dashboard → Authentication →
-- Users → find the admin's email → copy their User UID.
SELECT id, type, auth_user_id, name_en
FROM parties
WHERE auth_user_id = '<auth_uid>';
-- Expect exactly one row with type = 'staff'. Zero rows, or type != 'staff',
-- means this session is NOT covered by the "Staff full access properties"
-- RLS policy, and instead falls through to "Party select own properties"
-- (scoped to only listings THIS party manages) -- this alone fully explains
-- "Admin shows only 1 (or a handful of) listings."

-- 5b. If 5a came back empty or non-staff: how many listings does that
-- party actually manage? This is the count Admin would legitimately show
-- under the fallback policy -- if it's 1, that's your root cause, no bug.
SELECT count(*) FROM properties
WHERE managed_by_party_id = (SELECT id FROM parties WHERE auth_user_id = '<auth_uid>');

-- 5c. Does RLS itself, independent of any specific user, actually gate to
-- one row? Run this AS THE ANON ROLE (via the REST API / curl in Step 3,
-- not psql -- psql as the table owner bypasses RLS entirely and will
-- always show every row, which would falsely look "fine"). If Step 3's
-- Content-Range is anything other than
-- total_properties - draft_count, RLS's anon policy itself is the culprit:
SELECT count(*) FROM properties WHERE status IN ('active','available');
-- compare this number to Step 3's Content-Range result. They must match --
-- if they don't, `status` is out of sync with what the trigger should be
-- maintaining; check the trigger:
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'properties'::regclass AND tgname = 'trg_properties_status_sync';
-- tgenabled should be 'O' (origin, i.e. enabled). 'D' means it's disabled --
-- that alone would explain `status` silently drifting from workflow_status
-- and RLS narrowing to almost nothing.

-- 5d. Sanity check completely independent of RLS and of any specific
-- policy: does the table itself actually contain more than one row with a
-- sane workflow_status? (Run as table owner / service role -- bypasses RLS,
-- so this isolates "is it really a data problem" from "is it an access
-- problem.")
SELECT count(*) FROM properties WHERE workflow_status = 'active';
-- If THIS is 1, nothing above matters -- the data itself only has one
-- active listing, and no RLS/query change will ever produce more than 1.
```

---

## Step 6 — Find every corrupted `price_amount` (e.g. `400450` from `"$400-450"`)

Read-only. Reconstructs the exact digit-concatenation bug from
`20260731000000_structured_pricing.sql`'s one-time backfill (stripped `-`
from a range like `"$400-450"` before casting, producing `400450`) and only
flags a row when the current stored number is an EXACT reconstruction of
its own legacy text's two range numbers glued together — never a guess
based on "this number looks too big."

```sql
WITH sources AS (
  SELECT id AS row_id, id AS property_id, 'properties' AS tbl, 'price_amount' AS col,
         coalesce(title_en, title_lo, '(untitled)') AS title,
         price_display AS legacy_text, price_amount AS current_amount, price_currency AS currency
  FROM properties WHERE price_amount IS NOT NULL AND price_display IS NOT NULL
  UNION ALL
  SELECT id, id, 'properties', 'price_amount (sale leg)',
         coalesce(title_en, title_lo, '(untitled)'),
         sale_price, price_amount, price_currency
  FROM properties WHERE price_amount IS NOT NULL AND sale_price IS NOT NULL AND transaction_type = 'sale_or_rent'
  UNION ALL
  SELECT id, id, 'properties', 'rent_price_amount',
         coalesce(title_en, title_lo, '(untitled)'),
         rent_price, rent_price_amount, rent_price_currency
  FROM properties WHERE rent_price_amount IS NOT NULL AND rent_price IS NOT NULL
  UNION ALL
  SELECT ut.id, ut.property_id, 'unit_types', 'price_amount',
         coalesce(p.title_en, p.title_lo, '(untitled)') || ' — unit: ' || coalesce(ut.name_en, ut.id::text),
         ut.price_display, ut.price_amount, ut.price_currency
  FROM unit_types ut JOIN properties p ON p.id = ut.property_id
  WHERE ut.price_amount IS NOT NULL AND ut.price_display IS NOT NULL
),
range_candidates AS (
  SELECT s.*,
    (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[1] AS lower_text,
    (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[3] AS upper_text
  FROM sources s
  WHERE s.legacy_text ~ '[0-9][^0-9]{0,3}(-|–|—)[^0-9]{0,3}[0-9]'
),
parsed AS (
  SELECT rc.*,
    NULLIF(replace(rc.lower_text, ',', ''), '')::numeric AS lower_bound,
    NULLIF(replace(rc.upper_text, ',', ''), '')::numeric AS upper_bound
  FROM range_candidates rc
)
SELECT
  row_id, property_id, tbl, col, title, legacy_text,
  currency, current_amount,
  trunc(lower_bound) AS recommended_value,
  'HIGH' AS confidence
FROM parsed
WHERE lower_bound IS NOT NULL AND upper_bound IS NOT NULL
  AND lower_bound > 0 AND lower_bound < upper_bound
  AND current_amount::bigint = (trunc(lower_bound)::bigint::text || trunc(upper_bound)::bigint::text)::bigint
ORDER BY tbl, row_id;
```

**Read the output before running Step 7.** Every row listed here is a
*proven* reconstruction (the math only matches if the original text really
was a range and the stored number really is the two halves glued
together) — not a heuristic guess.

---

## Step 7 — Repair every HIGH-confidence row, in one transaction, with safeguards

Run this in `psql` (not the dashboard's auto-commit SQL editor) so you can
inspect the result and `ROLLBACK` if anything looks wrong before it's
permanent.

```sql
BEGIN;

-- Safeguard 1: the UPDATE only touches a row if its price_amount is STILL
-- exactly the value Step 6 observed (compare-and-swap) -- a row edited by
-- staff between Step 6 and now is left untouched, not overwritten blind.
-- Safeguard 2: only 'properties' rows are repaired here (the majority
-- case). unit_types rows flagged in Step 6 need the same UPDATE pattern
-- against the unit_types table -- run separately, listed after.

WITH sources AS (
  SELECT id AS row_id, 'price_amount' AS col, price_display AS legacy_text, price_amount AS current_amount
  FROM properties WHERE price_amount IS NOT NULL AND price_display IS NOT NULL
  UNION ALL
  SELECT id, 'rent_price_amount', rent_price, rent_price_amount
  FROM properties WHERE rent_price_amount IS NOT NULL AND rent_price IS NOT NULL
),
range_candidates AS (
  SELECT s.*,
    (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[1] AS lower_text,
    (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[3] AS upper_text
  FROM sources s
  WHERE s.legacy_text ~ '[0-9][^0-9]{0,3}(-|–|—)[^0-9]{0,3}[0-9]'
),
to_fix AS (
  SELECT row_id, col,
    NULLIF(replace(lower_text, ',', ''), '')::numeric AS lower_bound,
    NULLIF(replace(upper_text, ',', ''), '')::numeric AS upper_bound,
    current_amount
  FROM range_candidates
)
UPDATE properties p
SET price_amount = trunc(f.lower_bound)
FROM to_fix f
WHERE f.col = 'price_amount'
  AND p.id = f.row_id
  AND f.lower_bound IS NOT NULL AND f.upper_bound IS NOT NULL
  AND f.lower_bound > 0 AND f.lower_bound < f.upper_bound
  AND p.price_amount = f.current_amount   -- compare-and-swap guard
  AND p.price_amount::bigint = (trunc(f.lower_bound)::bigint::text || trunc(f.upper_bound)::bigint::text)::bigint;

-- Same pattern, rent leg:
WITH sources AS (
  SELECT id AS row_id, rent_price AS legacy_text, rent_price_amount AS current_amount
  FROM properties WHERE rent_price_amount IS NOT NULL AND rent_price IS NOT NULL
),
range_candidates AS (
  SELECT s.*,
    (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[1] AS lower_text,
    (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[3] AS upper_text
  FROM sources s
  WHERE s.legacy_text ~ '[0-9][^0-9]{0,3}(-|–|—)[^0-9]{0,3}[0-9]'
),
to_fix AS (
  SELECT row_id,
    NULLIF(replace(lower_text, ',', ''), '')::numeric AS lower_bound,
    NULLIF(replace(upper_text, ',', ''), '')::numeric AS upper_bound,
    current_amount
  FROM range_candidates
)
UPDATE properties p
SET rent_price_amount = trunc(f.lower_bound)
FROM to_fix f
WHERE p.id = f.row_id
  AND f.lower_bound IS NOT NULL AND f.upper_bound IS NOT NULL
  AND f.lower_bound > 0 AND f.lower_bound < f.upper_bound
  AND p.rent_price_amount = f.current_amount
  AND p.rent_price_amount::bigint = (trunc(f.lower_bound)::bigint::text || trunc(f.upper_bound)::bigint::text)::bigint;

-- unit_types leg (same guard, separate table):
WITH sources AS (
  SELECT id AS row_id, price_display AS legacy_text, price_amount AS current_amount
  FROM unit_types WHERE price_amount IS NOT NULL AND price_display IS NOT NULL
),
range_candidates AS (
  SELECT s.*,
    (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[1] AS lower_text,
    (regexp_match(s.legacy_text, '([0-9][0-9,]*(?:\.[0-9]+)?)[^0-9]{0,4}(-|–|—)[^0-9]{0,4}([0-9][0-9,]*(?:\.[0-9]+)?)'))[3] AS upper_text
  FROM sources s
  WHERE s.legacy_text ~ '[0-9][^0-9]{0,3}(-|–|—)[^0-9]{0,3}[0-9]'
),
to_fix AS (
  SELECT row_id,
    NULLIF(replace(lower_text, ',', ''), '')::numeric AS lower_bound,
    NULLIF(replace(upper_text, ',', ''), '')::numeric AS upper_bound,
    current_amount
  FROM range_candidates
)
UPDATE unit_types u
SET price_amount = trunc(f.lower_bound)
FROM to_fix f
WHERE u.id = f.row_id
  AND f.lower_bound IS NOT NULL AND f.upper_bound IS NOT NULL
  AND f.lower_bound > 0 AND f.lower_bound < f.upper_bound
  AND u.price_amount = f.current_amount
  AND u.price_amount::bigint = (trunc(f.lower_bound)::bigint::text || trunc(f.upper_bound)::bigint::text)::bigint;

-- Verify before committing: re-run Step 6's SELECT here -- it should
-- return ZERO rows now (everything it found is fixed, nothing new
-- introduced).

-- If the verify looks right:
COMMIT;
-- If anything looks wrong:
-- ROLLBACK;
```

---

## Summary table — what each outcome means

| Symptom after running Steps 1–5 | Conclusion |
|---|---|
| Step 1a `total_properties` is itself small (e.g. 1–5) | Not a bug at all — that's genuinely all the data that exists. Nothing to fix in code. |
| Step 5a returns 0 rows or `type != 'staff'` for the admin's `auth_uid` | Root cause found: that login isn't recognized as staff, so RLS silently scopes them to only their own listings. Fix: insert/correct their `parties` row (`type='staff'`, `auth_user_id` set correctly). |
| Step 5c's two counts don't match | `status` is out of sync with `workflow_status` — check the trigger (query included in 5c) and re-run the sync `UPDATE properties SET workflow_status = workflow_status;` from `20260729000000_listing_status_model.sql` if the trigger is disabled. |
| Step 5d is 1 but Step 1a is much higher | Almost every row has `workflow_status != 'active'` — a real, separate data problem (bulk edit gone wrong, bad import), not a code or RLS bug. |
| Everything above checks out fine | The issue is upstream of the database entirely — CDN/browser cache serving stale HTML/JS. Hard-refresh, check response headers for `cache-control`/`age`, and check the Cloudflare zone's cache rules for `/admin.html` specifically (the existing Worker hardening only covers `/listing.html`, `/listings.html`, `/`, `/index.html`). |
