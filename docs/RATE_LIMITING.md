# Abuse protection and rate limiting

Covers audit findings **F-08** (analytics limits keyed on a client-supplied
value) and **F-09** (unbounded anonymous view-count inflation).

---

## The core problem: there is no trustworthy key inside Postgres

Every anonymous write path in Pintag goes browser → PostgREST → RLS policy. The
policy can see only what the client sent. Today's limits key on `session_id`,
which `session.js` generates in the browser with `crypto.randomUUID()`:

```js
var id = crypto.randomUUID();          // attacker-chosen, per request if they like
sessionStorage.setItem('pintag_session_id', id);
```

An attacker sends a fresh UUID with every request and **every window resets**.
The effective limit is infinity. This is not a bug in the check — the checks
were written to stop a real visitor's double-click, and they do that well — it
is a limit of where they live.

PostgREST *may* expose a client address via the `request.headers` GUC, but
whether it is present and trustworthy depends on the deployed proxy chain
(Cloudflare → Kong → PostgREST) and cannot be determined from this repository.
`pintag_client_network_probe()` (admin-only, read-only, added in migration
`20260817010000`) reports exactly what the database can see, so the question can
be **settled against production** instead of guessed at:

```sql
select pintag_client_network_probe();
```

Until that returns a usable, non-spoofable address, **the primary rate limit
belongs at the edge**, and the database layer is a damage ceiling only.

---

## Layer 1 (primary) — Cloudflare rate limiting

**Status: NOT configured. Requires dashboard access this repository does not
have.** These are the exact rules to create.

Pintag's browser traffic goes directly to `*.supabase.co`, which is **not**
behind the pintag.io Cloudflare zone. So one of two setups is needed:

- **(a) Preferred** — put the Supabase REST origin behind a Cloudflare hostname
  (e.g. `api.pintag.io` proxied to the project) and point `window.PINTAG.supabaseUrl`
  at it. Every rule below then applies, and you also gain a WAF and bot
  management in front of the database API.
- **(b) Interim** — if the direct Supabase origin stays, use Supabase's own
  platform-level protections (Dashboard → Settings → API → rate limits, and the
  Auth rate limits already configured in `supabase/config.toml`), and accept
  that per-endpoint analytics limits are enforced only by Layer 2.

### Rules (setup (a))

Cloudflare → zone → **Security → WAF → Rate limiting rules**.

| # | Rule | Match | Counting key | Limit | Action |
|---|---|---|---|---|---|
| 1 | Analytics writes | `http.request.method eq "POST"` and `http.request.uri.path in {"/rest/v1/lead_events" "/rest/v1/listing_events" "/rest/v1/page_views" "/rest/v1/search_events" "/rest/v1/ui_events"}` | client IP | **60 / min** | Managed Challenge |
| 2 | View counter | `http.request.uri.path eq "/rest/v1/rpc/increment_listing_view"` | client IP | **60 / min** | Managed Challenge |
| 3 | Lead submission | `http.request.uri.path eq "/rest/v1/lead_events"` | client IP | **10 / min** | Block (60 s) |
| 4 | Auth endpoints | `starts_with(http.request.uri.path, "/auth/v1/")` | client IP | **20 / 5 min** | Block (300 s) |
| 5 | Open Edge Functions | `http.request.uri.path in {"/functions/v1/resolve-map-url" "/functions/v1/public-listings-feed"}` | client IP | **30 / min** | Block (60 s) |

### Why these numbers, and why not `/rest/v1/*`

**Do not rate-limit `/rest/v1/*` as a whole.** A single listings.html page load
issues a burst of legitimate reads (properties, parties, contacts, unit_types,
plus an impression event per rendered card). A blanket limit would throttle one
real visitor browsing normally. Only the **mutation** endpoints above are
limited; reads are left alone and are protected by RLS, not by rate.

- **60/min for analytics (rule 1)** — a real visitor generates a handful of
  events per minute. 60 is roughly 10× the busiest genuine session and still
  reduces a single attacking IP from unbounded to 86k/day.
- **10/min for leads (rule 3)** — a lead is a WhatsApp/call/contact click. No
  human produces ten in a minute; fake leads are the most commercially damaging
  abuse, so this one **blocks** rather than challenges.
- **Managed Challenge, not Block, for rules 1–2** — analytics and view counting
  must never break for a real visitor. A challenge degrades gracefully; a block
  loses real data.
- **Auth (rule 4)** — credential stuffing and password-reset spam against the
  single administrator account. Supabase's own `sign_in_sign_ups = 30 / 5 min`
  already applies; this is defence in depth at a tighter bound.

### Shared IPs, IPv6, bots, proxies

- **Shared IPs are the real risk.** Vientiane mobile traffic is heavily CGNAT'd,
  so many genuine visitors share one address. This is why rules 1–2 use
  *Managed Challenge* rather than *Block*, and why the limits are set an order of
  magnitude above single-user behaviour. A shared-IP user meets a challenge, not
  a wall.
- **IPv6:** Cloudflare counts a /64 as one client by default, which is correct —
  a single device can otherwise rotate addresses within its own prefix freely.
- **Bots:** legitimate crawlers (WhatsApp/Facebook/Google link previews) only
  ever `GET`, so no rule above touches them. Add
  `and not cf.client.bot_management.verified_bot` to any rule you later extend
  to `GET` traffic.
- **Proxies/VPNs:** an attacker distributing across many IPs defeats any
  IP-keyed limit. That residual is accepted; Layer 2 is what bounds it.

---

## Layer 2 (in this repository) — per-target damage ceilings

Migration `20260817010000_authz_identity_and_abuse_bounds.sql`. These are keyed
on the **target** (the listing), which an attacker cannot rotate: forging a new
session id does not give them a new listing to inflate.

| Path | Ceiling | Rationale |
|---|---|---|
| `lead_events` INSERT | 30 / min per (listing, event_type) | An order of magnitude above the busiest real listing. |
| `listing_events` INSERT | 300 / min per (property, event_type) | High on purpose: listings.html fires an impression per rendered card, so a burst of genuine visitors must never be throttled. |
| `increment_listing_view()` | 120 / min per listing | Two views per second sustained on one property is not real traffic here. |

**Both ceilings fail OPEN.** If the bookkeeping errors, the event is recorded
anyway. These are analytics counters; silently losing real traffic is worse than
admitting some fake traffic, and nothing security-critical depends on them.

### What Layer 2 does and does not do

- **Does:** converts *unbounded* into *bounded per target per minute*. A single
  burst can no longer 100× a listing's popularity in seconds.
- **Does not:** bound the *lifetime* total. An attacker patient enough to spread
  requests across days still accumulates. Only an IP/edge limit fixes that,
  which is Layer 1.

That distinction is stated plainly because a ceiling that looks like a rate
limiter but is not one is worse than none.

---

## `session_id` after this change

`session_id` remains exactly where it is and keeps doing its real job —
correlating a visitor's events within one tab visit so `search_events`,
`listing_events` and `lead_events` can be joined per-visit. It stays useful for
**analytics identity**.

It is no longer the only thing standing between an attacker and unbounded
inserts, and it must never again be treated as an anti-abuse mechanism.
`tests/security/regression/rls_regression.sql` §H proves the point directly: it
rotates the session id on every one of 80 inserts — exactly what an attacker
does — and asserts the target ceiling still holds.

---

## Verification

```bash
# Layer 2, locally, no credentials, no production contact:
bash tests/security/regression/run-local-pg.sh      # sections H and I

# Layer 2, in production (read-only):
#   Actions → "Verify Production Security" → Run workflow
#   → checks the ceilings are wired into the live anon INSERT policies

# Can the database see a client IP at all (decides if Layer 1 could move in-DB)?
#   As the MFA-verified administrator:
select pintag_client_network_probe();

# Layer 1, once configured:
for i in $(seq 1 80); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST \
    "$SUPABASE_URL/rest/v1/rpc/increment_listing_view" \
    -H "apikey: $ANON" -H 'Content-Type: application/json' \
    -d '{"p_listing_id":"<a live listing uuid>"}'
done; echo
# EXPECT: 2xx up to the limit, then 429/403 from Cloudflare.
```
