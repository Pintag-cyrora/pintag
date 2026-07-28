# Find My Home — Product & Technical Design

> **Status: DESIGN ONLY. No implementation has begun.** This document is for review
> and approval. Section 12 lists the decisions needed before any code is written.

---

## 0. What I verified in the codebase first

Three claims in the brief don't match what Pintag actually has today. They change
the shape of the plan, so they're stated up front rather than buried.

| Brief says | Reality in the repo | Consequence |
|---|---|---|
| Customers can "book viewings" free today | **No booking feature exists.** The only match is `viewing_scheduled` — an *agent-side CRM lead status* in `dashboard.html:748`. A buyer has never been able to book anything. | "Nothing changes in the marketplace" is true, but viewing-booking isn't an existing thing being preserved. Find My Home's `viewing_scheduled` status is agent-reported, same as today. |
| Customer Dashboard showing assigned agent, status, notes, history | **Pintag has no customer accounts at all.** Auth exists only for staff (`admin@pintag.io`) and agents (`parties.auth_user_id`). Buyers are fully anonymous — `visitor_id` in localStorage, nothing more. | Find My Home would be Pintag's **first consumer identity system**. This is the largest unstated scope item in the brief. See §3.1. |
| Customer/agent receive completion surveys; statuses update | **No email, SMS, or WhatsApp API infrastructure exists.** Nothing in the repo sends a message to anyone, ever. | Every "customer receives…" step is currently a human on WhatsApp. Must be designed as such. See §5.7. |

Everything else in the brief maps cleanly onto existing infrastructure:
`parties` (agents, with `type` and `is_verified`), `properties`, private Supabase
Storage, `is_pintag_staff()` / `owned_party_ids()` RLS helpers, SECURITY DEFINER
RPCs, and the terminology registries (`PROPERTY_TYPES`, districts, `FURNISHED_OPTIONS`,
`RENTAL_CURRENCIES`) that the request form should reuse rather than re-declare.

---

## 1. Product review

**The core strategic instinct is right.** Agents in Vientiane already sell this
service informally over Facebook. The value Pintag adds isn't the search — it's
*trust and recourse*. A customer paying a stranger on Facebook has no protection;
a customer paying Pintag has a verified agent, an audit trail, and someone to
complain to. That is a real, defensible product, and it's genuinely separable
from the marketplace.

**Keeping the marketplace free and untouched is correct and non-negotiable.**
Any drift toward "pay to see listings" would destroy the top of the funnel that
makes Find My Home viable in the first place. The plan is right to firewall them.
Worth stating as an explicit architectural invariant (§5.9) so a future
contributor can't erode it by accident.

**The two products genuinely complement each other**, and there's a compounding
effect the brief doesn't mention: when an agent proposes an off-platform property
to a Find My Home customer, that's a **listing-acquisition signal**. Every
off-market property surfaced through a paid search is a property Pintag now knows
exists and can recruit. Designing `fmh_proposals` to capture off-platform
properties (§5.4) turns the premium service into a supply-side growth engine.
This may end up worth more than the fee revenue.

**Where the plan is weakest:** it treats payment as a solved step ("customer pays,
uploads receipt, admin verifies") when payment is actually the highest-risk part
of the funnel, and it specifies a refund rule that cannot be enforced (§2.1, §2.2).

---

## 2. Risks and weaknesses

Ordered by severity.

### 2.1 The commission-linked refund is structurally unenforceable — **critical**

> *"If a participating agent earns a commission from the completed rental, that
> agent refunds the customer's Find My Home service fee."*

Every incentive points the wrong way:

- **The agent is the only party who knows** whether commission was paid. It
  happens off-platform, between agent and landlord, in cash. Pintag has zero
  visibility.
- **The agent is financially punished for honesty.** Report commission → refund
  $50. Stay quiet → keep $50 *and* the commission. The rule taxes truth-telling.
- **The customer is incentivised to allege commission** whether or not it
  occurred, because it returns their money.
- **Pintag has no adjudication evidence** — only two self-interested claims.

This converts the (manageable) outcome-mismatch problem into a *monetary*
dispute, which is far worse: it generates support load, damages agent
relationships, and produces exactly the trust erosion the product exists to fix.

There is also a mechanical gap: refunding "from the agent" requires an agent
payout/clawback rail. None exists, and building one is a large regulated project.

**Alternatives (ranked):**

| Option | How it works | Assessment |
|---|---|---|
| **A. Outcome-based guarantee** *(recommended)* | "If we don't find you a home within N days, full refund from Pintag." Trigger is **outcome**, which Pintag can observe, not **commission**, which it can't. | Verifiable, marketable, aligns everyone: agent wants to succeed, customer is protected, Pintag controls the promise. Cost is bounded and forecastable. |
| **B. Service credit, not cash** | Unsuccessful search converts the fee into credit toward a future search or a partner service. | No money movement, no payout rail, softer than a refund. Weaker trust signal than A. |
| **C. Platform commission share** | Fee stays low/non-refundable; Pintag takes a share of agent commission instead. | Cleanest long-run economics but requires commission visibility Pintag doesn't have — same enforcement problem, moved. |
| **D. As briefed** | Agent refunds on commission. | Not recommended. Unenforceable and incentive-inverted. |

**Recommendation: adopt A**, keep the schema neutral (a `fee_disposition` field —
`retained` / `refund_due` / `refunded` / `credited` / `waived`) so B or C remain
possible without migration. Do not encode "commission triggers refund" anywhere.

### 2.2 Prepaid fee vs. scam anxiety — a trust paradox — **high**

The stated reason customers want this service is *"worried about scams."* The MVP
flow then asks them to: scan a QR, send $50 to an account, photograph a receipt,
upload it, and wait for a human to maybe confirm — all **before** anything of
value is delivered, and before they know which agent they get.

That is the exact shape of the interaction they're afraid of.

**Recommendation: pay-on-assignment, not pay-on-submit.** Customer submits the
brief free → Pintag assigns and *names* a verified agent (with photo, profile,
verification badge, track record) → *then* the customer pays to activate.

This is a small state-machine change with disproportionate benefits:
- Removes the leap of faith. They're paying a named, visible professional.
- Kills the worst support case ("I paid and nothing happened").
- Free submission raises top-of-funnel volume, giving demand data even from
  non-converters — valuable for the Intelligence layer regardless.
- Lets Pintag decline requests it can't service *before* taking money.

Cost: a request can sit assigned-but-unpaid, so agents need "don't start work
until activated" discipline, and unpaid requests need auto-expiry. Both cheap.

### 2.3 The status list conflates three independent axes — **high**

The briefed statuses — *Payment Pending, Payment Verified, New, Assigned,
Searching, Viewing Scheduled, Completed, Needs Review, Closed* — mix three
things that vary independently:

- **Payment state** (unpaid / awaiting verification / verified / refunded)
- **Fulfilment state** (new / assigned / searching / viewing / completed / closed)
- **Exception state** (needs review / disputed)

A single flat enum can't express "payment verified **and** searching," or
"completed **and** needs review" — both of which are normal, everyday states.

This is the *same* mistake `properties.status` made, which we split into
`workflow_status` + `market_status` in `20260729000000_listing_status_model.sql`
last week. The precedent, the reasoning, and the migration pattern all exist in
this repo already.

**Recommendation: three axes** — `payment_status`, `request_status`, and a
separate `needs_review` flag with a linked dispute record. Cheap now; a painful
migration once dashboards, filters, and analytics are built on top.

### 2.4 Manual payment verification creates a latency hole — **medium**

Customer pays at 21:00; admin verifies the next morning. For a *premium* product
whose entire pitch is professionalism, a 12-hour silent gap is a bad first
impression and a support-ticket generator.

Mitigations (all cheap): publish an explicit SLA ("verified within N working
hours"), auto-acknowledge submission on-screen and via WhatsApp, and give admins
a dedicated, sorted verification queue with the oldest-waiting first. Acceptable
for MVP volume — but it must be *designed* as a queue with a promise attached,
not an afterthought.

### 2.5 Dual-confirmation surveys will suffer non-response bias — **medium**

Satisfied customers disappear; dissatisfied ones reply. Treating silence as a
failure state will systematically understate conversion; treating it as success
will overstate it.

**Recommendation:** make `no_response` a first-class outcome value distinct from
`no`, never infer, and never let a missing *customer* response block the agent's
closure or (future) payout indefinitely — use a timeout that resolves to
`unresolved` and reports it separately from genuine `not_converted`.

### 2.6 Agent disintermediation ("poaching") — **medium, structural**

The agent necessarily receives the customer's phone number. Nothing technically
stops them completing the deal privately and reporting `no`. This is inherent to
any marketplace that connects two humans — it cannot be engineered away.

Realistic defenses, in order of effectiveness: (1) make continued platform access
worth more than one poached deal — steady request flow is the actual lock-in;
(2) reputation and suspension with real consequence; (3) cross-check reported
outcomes against on-platform signals (`leads`, `listing_events`) for the proposed
properties; (4) periodic customer spot-checks by staff. Accept residual leakage
as a cost of doing business and monitor its rate rather than pretending it's zero.

### 2.7 Legal, tax, and consumer-protection exposure — **medium, non-engineering**

Taking money for a service (as opposed to running a free listings board) creates
obligations Pintag doesn't have today: VAT/invoicing treatment of service fees,
refund terms as published consumer commitments, business-registration scope, and
retention rules for customer PII (name, phone, budget, requirements) now held for
paying customers. **This needs a real answer from someone qualified in Lao law
before launch — it is not an engineering task and should not be discovered late.**

### 2.8 Capacity and expectation risk — **medium**

The service promises human effort. If 40 requests arrive in a week and there are
six verified agents, quality collapses and refunds spike. There is no throttle in
the brief.

**Recommendation:** a simple capacity gate — max concurrent active requests per
agent, and a global intake cap that shows "we're at capacity, join the waitlist"
rather than accepting money Pintag can't service. Cheap, and protects the
guarantee in §2.1.

### 2.9 Receipt fraud — **low but trivially preventable**

Same receipt image submitted for two requests; edited screenshots; wrong amount
for the tier. Hash every uploaded receipt (SHA-256) with a unique index, record
the amount admin actually observed vs. the amount quoted, and keep the file
immutable in a private bucket. Effectively free to add now.

---

## 3. Suggested improvements

### 3.1 Customer identity: token link, not accounts *(the key decision)*

Pintag has no consumer auth. Three options:

| Option | Friction | Fit for Laos | Effort |
|---|---|---|---|
| **A. Signed access token in a URL** *(recommended)* | None — no signup | Excellent: link delivered over WhatsApp, where users already are | Low |
| B. Phone + SMS OTP | Moderate | Good identity model, but needs an SMS provider; Lao deliverability unproven; per-message cost | High |
| C. Email + password | High — email is not the primary identity here | Poor | Medium |

**Recommendation: A for MVP, designed to upgrade to B later.**

Each request mints a long random `access_token`. The customer's dashboard is
`find-my-home-status.html?t=<token>`, delivered by WhatsApp. No signup, no
password, no forgotten-credentials support load — at the exact moment the
customer is deciding whether to trust Pintag with money.

Security posture: equivalent to a password-reset link or an unlisted document
URL. A 32-byte random token is not brute-forceable. Because the data behind it is
moderately sensitive (name, phone, budget) but not catastrophic, this is a
reasonable trade — **stated explicitly so it's a decision, not an accident.**
Mitigations: token rotation on request, expiry N days after closure, no
credentials or payment instruments ever behind the link, and rate limiting on
token lookup.

Upgrade path: `customer_phone` is stored on every request from day one, so when
phone-OTP arrives, existing requests group into real accounts retroactively with
no migration of the request data itself.

### 3.2 Capture off-platform proposals as a supply funnel

When an agent proposes a property that isn't on Pintag, record it (`external_url`,
free-text). This costs nothing at design time and creates a continuously
refreshing list of known-real, off-market properties to recruit — from the mouths
of the agents who found them. Recommend surfacing this as an admin view
("properties proposed but not listed") in a later phase.

### 3.3 Reuse existing registries in the request form

Property type, districts, furnished state, and currency should all come from
`terminology.js` / `rental-terms.js`, not be re-declared. This keeps the
customer's brief in the same vocabulary as the listings it will be matched
against — otherwise matching degrades into fuzzy string comparison later.

### 3.4 Model assignments as history, not a column

`assigned_agent_id` as a single column loses the record of who declined and when
— precisely the data needed later for response-rate and reliability scoring. An
`fmh_assignments` table costs nothing extra now and makes agent performance
metrics a query rather than a re-architecture.

### 3.5 Notifications: build the outbox, not the sender

No messaging infrastructure exists. Rather than bolting on email nobody in this
market reads, write every outbound message into an `fmh_notifications` outbox
table that staff work manually via WhatsApp in MVP. When WhatsApp Business API
(or SMS) is adopted, the sender becomes a consumer of a table that already has
the full message history — no retrofit of every call site.

### 3.6 Keep Find My Home out of the marketplace's hot path

Zero new queries, scripts, or blocking calls on `index.html`, `listings.html`, or
`listing.html`. Entry point is a separate page (`find-my-home.html`) reached from
navigation. This makes "the marketplace is unaffected" mechanically true rather
than a promise, and keeps the analytics work just completed uncontaminated.

---

## 4. UX flow

### 4.1 Customer

```
Marketplace nav → "Find My Home" (find-my-home.html)
   │
   ├─ Explainer: what it is, price by tier, guarantee, verified-agent promise
   │
   ▼
Request form (free, no account)
   property type · budget+currency · districts · beds · baths ·
   furnished · pets · move-in date · requirements · name · phone/WhatsApp · language
   │
   ▼
Submitted  →  reference code shown (FMH-2607-A3K9) + status link
              status link also sent by WhatsApp
   │
   ▼
[RECOMMENDED ORDER — see §2.2]
Pintag reviews & assigns a NAMED verified agent
   │
   ▼
Customer sees: agent name, photo, verification badge → "Activate — US$50"
   │
   ▼
BCEL QR displayed  →  customer pays  →  uploads receipt
   │
   ▼
"Payment received — verifying"   (SLA stated on screen)
   │
   ▼
Verified → Active. Agent begins searching.
   │
   ▼
Status page (token link): agent card · current status · proposed properties ·
                          progress notes · [chat placeholder — not built]
   │
   ▼
Completion → "Did you rent a property?" YES / NO
```

### 4.2 Agent

```
dashboard.html → new "Find My Home" section
   │
   ├─ Offered requests → Accept / Decline (with reason)
   │
   ▼
Accepted → full brief visible (contact details revealed only on accept)
   │
   ├─ Propose properties (on-platform picker OR off-platform URL/note)
   ├─ Update status: searching → viewing scheduled → completed
   ├─ Add progress notes (customer-visible) and internal notes (staff-visible)
   │
   ▼
Mark complete → "Did this customer successfully rent?" YES / NO
                (+ which property, + commission earned? — recorded, not acted on)
```

### 4.3 Staff

```
admin.html → new "Find My Home" tab
   │
   ├─ Verification queue (oldest first)  — verify / reject payment
   ├─ Unassigned requests                — assign verified agent
   ├─ Active requests                    — monitor, reassign, note
   ├─ Needs review                       — outcome mismatches, disputes
   └─ Closed / archive                   — history, exports
```

---

## 5. Database design

All tables prefixed `fmh_`. Migration follows repo conventions: idempotent
(`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`),
RLS enabled on every table, `is_pintag_staff()` / `owned_party_ids()` reused.

### 5.1 `fmh_requests` — the search mandate

```sql
id                  uuid PK default gen_random_uuid()
reference_code      text UNIQUE NOT NULL     -- 'FMH-2607-A3K9', human-quotable
access_token        text UNIQUE NOT NULL     -- customer dashboard access (§3.1)
token_expires_at    timestamptz

-- Customer (no auth account today; phone is the durable identity)
customer_name       text NOT NULL
customer_phone      text NOT NULL
customer_whatsapp   text
customer_email      text
preferred_language  text                     -- lo|en|zh, reuse site languages

-- The brief (vocabulary reused from terminology.js / rental-terms.js)
property_type       text
transaction_type    text default 'for_rent'
budget_min          numeric
budget_max          numeric
budget_currency     text default 'USD'       -- RENTAL_CURRENCIES
districts           text[]                   -- the 7 Vientiane districts
bedrooms_min        integer
bathrooms_min       integer
furnished           text                     -- FURNISHED_OPTIONS
pets_required       boolean
move_in_date        date
requirements        text

-- THREE INDEPENDENT AXES (§2.3)
payment_status      text NOT NULL default 'unpaid'
                    CHECK IN ('unpaid','awaiting_verification','verified',
                              'rejected','refunded','waived')
request_status      text NOT NULL default 'new'
                    CHECK IN ('new','assigned','awaiting_activation','searching',
                              'viewing_scheduled','completed','closed','cancelled','expired')
needs_review        boolean NOT NULL default false

-- Commercial
service_tier        text CHECK IN ('apartment_condo','house','row_house')
quoted_amount       numeric
quoted_currency     text default 'USD'
fee_disposition     text default 'retained'  -- §2.1: retained|refund_due|refunded|credited|waived

created_at, updated_at, assigned_at, activated_at, completed_at, closed_at
```

Indexes: `payment_status`, `request_status`, `needs_review`, `customer_phone`,
`created_at DESC`, and `access_token` (already unique).

### 5.2 `fmh_payments` — append-only attempts

Separate from the request because customers resubmit wrong receipts and the
history matters for disputes.

```sql
id, request_id FK
method              text default 'bcel_qr'
amount, currency
receipt_path        text          -- private bucket 'fmh-receipts'
receipt_sha256      text UNIQUE   -- §2.9 anti-reuse
submitted_at
verification_status text CHECK IN ('pending','verified','rejected')
verified_by         uuid FK parties
verified_at, rejection_reason, admin_note
observed_amount     numeric       -- what admin actually saw vs. quoted
```

### 5.3 `fmh_assignments` — offer/accept history (§3.4)

```sql
id, request_id FK, party_id FK parties
state          text CHECK IN ('offered','accepted','rejected','withdrawn','expired')
offered_by     uuid FK parties, offered_at, responded_at, reject_reason
```
Partial unique index: at most one `accepted` assignment per request.

### 5.4 `fmh_proposals` — properties put to the customer (§3.2)

```sql
id, request_id FK
property_id       uuid FK properties NULL   -- on-platform
external_url      text                       -- OFF-platform: supply funnel
external_note     text
proposed_by       uuid FK parties, proposed_at
customer_response text CHECK IN ('pending','interested','rejected','viewed')
responded_at
```
CHECK: exactly one of `property_id` / `external_url` present.

### 5.5 `fmh_outcomes` — dual confirmation (§2.5)

```sql
id, request_id FK UNIQUE
customer_response   text CHECK IN ('yes','no','no_response')
customer_responded_at
agent_response      text CHECK IN ('yes','no','no_response')
agent_responded_at
resolution          text CHECK IN ('converted','not_converted','needs_review','unresolved')
property_id         uuid FK properties NULL
commission_reported boolean          -- agent self-report; RECORDED, NOT ACTED ON (§2.1)
resolved_by, resolved_at, admin_note
```

### 5.6 `fmh_events` — append-only audit log

```sql
id bigserial, request_id FK
actor_role   text CHECK IN ('customer','agent','staff','system')
actor_party_id uuid NULL           -- null for customer (no account) and system
event_type   text
from_value, to_value jsonb
note text, created_at
```
Every status change, payment action, assignment, and outcome write appends here.
No updates, no deletes — this is the dispute-resolution evidence base.

### 5.7 `fmh_notifications` — outbox (§3.5)

```sql
id, request_id FK
channel      text CHECK IN ('whatsapp','sms','email','none')
recipient    text
template_key text, payload jsonb
state        text CHECK IN ('queued','sent','failed','manual_sent')
queued_at, sent_at, sent_by uuid NULL, error text
```
MVP: staff work the queue by hand and mark `manual_sent`. Automation later
replaces the worker, not the call sites.

### 5.8 Storage

New **private** bucket `fmh-receipts` (contrast with the public `property-images`
/ `agent-photos` buckets). No anon SELECT, no anon INSERT — uploads go through an
edge function that validates the token, hashes the file, and writes with the
service role (§6.1). Receipts are financial records: immutable, staff-readable.

### 5.9 Marketplace isolation invariant

> **No `fmh_*` table may be joined into, or queried by, any public marketplace
> page (`index.html`, `listings.html`, `listing.html`, `agent.html`). Find My
> Home must never add a query, a script, or a blocking call to the browse path.**

Recommend recording this in `ARCHITECTURE.md` alongside the existing Platform
Identity / Buyer Contact / Authentication invariants, so it's enforceable in
review rather than remembered.

---

## 6. API design

Follows existing conventions: PostgREST for RLS-scoped table access, SECURITY
DEFINER RPCs (staff-gated internally, mirroring the `analytics_*` functions) for
anything crossing trust boundaries, edge functions where secrets or file
processing are involved.

### 6.1 Public (anon) — RPC and edge function only, **zero table access**

Customers have no account, so RLS cannot identify them. Token-bearing RPCs are
the entire public surface; `fmh_requests` itself gets **no anon policy at all**
(same default-deny posture as the `owners` table).

| Endpoint | Type | Purpose |
|---|---|---|
| `fmh_create_request(payload jsonb)` | RPC | Create request, mint reference code + token, return them. Rate-limited by phone + IP. |
| `fmh_get_request(p_token)` | RPC | Full status view: request, agent card, proposals, notes, payment state. |
| `fmh_submit_receipt` | **Edge function** | Validates token → hashes file → writes to private bucket with service role → inserts `fmh_payments`. Never exposes storage to anon. |
| `fmh_respond_proposal(p_token, p_proposal_id, p_response)` | RPC | Customer marks interested / rejected. |
| `fmh_customer_outcome(p_token, p_response)` | RPC | Completion survey answer. |

All token RPCs: constant-time-ish lookup on the unique index, rate limited, and
every call appends to `fmh_events`.

### 6.2 Agent (authenticated, RLS-scoped)

Direct PostgREST reads on `fmh_requests` / `fmh_proposals` **only** where an
`accepted` assignment exists for a party in `owned_party_ids(auth.uid())`.
Critically: **customer contact details are withheld until acceptance** — the
offer view exposes the brief, not the phone number.

| Endpoint | Type |
|---|---|
| `fmh_agent_respond_assignment(p_assignment_id, p_state, p_reason)` | RPC |
| `fmh_agent_set_status(p_request_id, p_status, p_note)` | RPC (validates transition) |
| `fmh_agent_propose(p_request_id, ...)` | RPC |
| `fmh_agent_outcome(p_request_id, p_response, p_property_id, p_commission)` | RPC |

### 6.3 Staff

Full PostgREST access on all `fmh_*` tables via `is_pintag_staff()`, plus:
`fmh_verify_payment`, `fmh_reject_payment`, `fmh_assign_agent`,
`fmh_set_status`, `fmh_resolve_outcome`, `fmh_set_fee_disposition`.

### 6.4 Permissions matrix

| Table | anon | agent (assigned) | agent (other) | staff |
|---|---|---|---|---|
| `fmh_requests` | none (RPC only) | SELECT own-assigned | none | ALL |
| `fmh_payments` | none (edge fn only) | none | none | ALL |
| `fmh_assignments` | none | SELECT own | none | ALL |
| `fmh_proposals` | none (RPC only) | SELECT/INSERT own-assigned | none | ALL |
| `fmh_outcomes` | none (RPC only) | SELECT/UPDATE own-assigned | none | ALL |
| `fmh_events` | none | SELECT own-assigned | none | SELECT |
| `fmh_notifications` | none | none | none | ALL |

Agents never see other agents' requests. Payment data is staff-only throughout —
an agent has no business seeing what a customer paid.

---

## 7. State machine

### 7.1 `payment_status`

```
unpaid ──submit receipt──> awaiting_verification ──verify──> verified
                                    │                            │
                                    └──reject──> rejected         └──(future)──> refunded
                                          │                                    
                                          └──resubmit──> awaiting_verification
unpaid ──staff waiver──> waived
```

### 7.2 `request_status` (recommended pay-on-assignment ordering, §2.2)

```
new ──assign──> assigned ──agent accepts──> awaiting_activation
                    │                              │
                    │                        payment verified
                    │                              ▼
                    │                          searching ──> viewing_scheduled ──> completed ──> closed
                    │                              
                    └──agent declines──> new (reassign)

any non-terminal ──> cancelled          awaiting_activation ──timeout──> expired
```

**Gate:** `request_status` cannot advance past `awaiting_activation` unless
`payment_status = 'verified'` (or `'waived'`). Enforced in the transition RPC,
not left to UI discipline.

`needs_review` is orthogonal — it can be raised at any point (typically on
outcome mismatch) without changing either status axis.

### 7.3 Outcome resolution

| Customer | Agent | `resolution` |
|---|---|---|
| yes | yes | `converted` |
| no | no | `not_converted` |
| yes | no *or* no | yes | `needs_review` → staff adjudicates |
| any | no_response (timeout) | `unresolved` — reported separately, never counted as failure (§2.5) |

---

## 8. Admin workflow

New **Find My Home** tab in `admin.html`, alongside Listings / Analytics /
Intelligence. Five queues:

1. **Verify payments** — oldest first, receipt image side by side with quoted
   amount; verify / reject with reason. The SLA queue from §2.4.
2. **Assign agent** — request brief + verified-agent picker filtered to those
   with FMH enabled and spare capacity (§2.8).
3. **Active** — monitor status, add internal notes, reassign, cancel.
4. **Needs review** — outcome mismatches and disputes, with the full
   `fmh_events` timeline as evidence.
5. **Closed** — history and CSV export.

Every action appends to `fmh_events` with the acting staff party recorded.

---

## 9. Agent workflow

New section in `dashboard.html` (the existing self-service agent portal):

- **Offers** — brief *without* contact details; Accept / Decline with reason,
  and an expiry so unanswered offers return to the pool.
- **Active requests** — full brief with contact details; propose properties
  (on-platform picker or off-platform URL); update status; add
  customer-visible progress notes and staff-only internal notes.
- **Complete** — outcome survey (rented? which property? commission earned?).

Only agents with `type='agent'`, `is_verified = true`, and an explicit FMH opt-in
capability receive offers. Recommend a boolean capability flag on `parties`
rather than a separate agent table — verification already lives there.

---

## 10. Customer workflow

Covered in §4.1. Two implementation notes:

- **Trilingual from day one.** The request form and status page must support
  lo/en/zh like every other Pintag surface. A premium paid product that only
  speaks one language is a worse experience than the free marketplace.
- **The status page is the product's trust surface.** For a customer who has
  paid $50 and is waiting, this page *is* Pintag. It should show the agent's
  face, the last update timestamp, and what happens next — never an empty state.

---

## 11. Roadmap and implementation phases

### Phase 0 — Decisions (no code) 
Resolve §12. Blocks everything.

### Phase 1 — Manual-operations MVP *(the recommended first shippable unit)*
Migration (all `fmh_*` tables, RLS, RPCs) · `find-my-home.html` request form ·
token status page · receipt-upload edge function · admin module (all five
queues). **No agent portal yet** — staff relay to agents over WhatsApp exactly
as listings are onboarded manually today.

This is a *complete, sellable product*. It proves demand and price before any
agent-facing engineering. Recommend running 10–20 real requests through it
before Phase 2.

### Phase 2 — Agent self-service
Agent section in `dashboard.html`, offer/accept, proposals, status, outcome
survey. Removes staff from the middle of the fulfilment loop.

### Phase 3 — Conversion reporting
Dual-outcome resolution UI, conversion metrics, agent performance (response
rate, acceptance rate, completion rate) fed from `fmh_assignments` +
`fmh_outcomes`. Integrate into the existing Analytics page — as *facts*, kept
separate from Intelligence's interpretation, per the established boundary.

### Phase 4 — Trust and scale
Verification tiers, ratings, trust score, capacity-aware auto-assignment,
notification automation (WhatsApp Business API consuming the outbox),
off-platform proposal → listing recruitment view (§3.2).

### Phase 5 — Deferred by design, not forgotten
Online payment gateway · agent payouts and any refund automation · in-app chat ·
sale-side Find My Home · buyer accounts via phone OTP (§3.1 upgrade path).

---

## 12. Recommendation: what to change before development begins

Six decisions. The first three are consequential; the rest are cheap-now,
expensive-later.

| # | Decision | Recommendation | Why it can't wait |
|---|---|---|---|
| 1 | **Customer identity model** | Token link, no accounts (§3.1) | Determines the entire public API surface, the RLS posture, and the status page. Nothing can be built before this is settled. |
| 2 | **Payment timing** | Pay-on-**assignment**, not on submit (§2.2) | Changes the state machine and, more importantly, is the single biggest lever on conversion and trust. Cheap now, structural later. |
| 3 | **Refund model** | Drop commission-linked refund. Adopt an outcome-based Pintag guarantee; keep `fee_disposition` neutral (§2.1) | Unenforceable as briefed and incentive-inverted. Also shapes what the completion survey must capture. |
| 4 | **Status model** | Three axes, not one enum (§2.3) | Exactly the `properties.status` mistake we just spent a migration undoing. |
| 5 | **Notification reality** | Outbox table + manual WhatsApp for MVP (§3.5) | Every "customer receives…" step in the brief currently has no delivery mechanism. |
| 6 | **Capacity gate** | Per-agent concurrent cap + global intake cap (§2.8) | Protects the guarantee in #3 and prevents selling work that can't be delivered. |

**Also required before launch, and not an engineering task:** a qualified answer
on Lao consumer-protection, invoicing/VAT, and PII-retention obligations for paid
services (§2.7).

**One correction to the brief for the record:** viewing-booking is not an
existing free marketplace feature — it doesn't exist anywhere in the product
today (§0). If customer-facing viewing booking is wanted, it's a separate piece
of work that should be scoped on its own merits, for the free marketplace,
independent of Find My Home.

---

*Prepared for review. No implementation will begin until this plan is approved.*
