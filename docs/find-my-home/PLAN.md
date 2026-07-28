# Find My Home — Product & Technical Design

> **Revision 2 — decisions incorporated. DESIGN ONLY, no implementation.**
> Revision 1 raised six open questions; all are now resolved (§1). This revision
> is for final review before development begins. §15 lists what still needs a
> decision — it is deliberately short.

---

## 1. Decisions locked

| # | Decision | Resolution |
|---|---|---|
| 1 | Customer accounts | **No consumer auth in MVP.** High-entropy per-request token portal. Forward-compatible with future accounts (§5.1, §5.10). |
| 2 | Viewings | **No customer booking system.** All language becomes *"Coordinate Viewings with Your Assigned Agent."* (§4, §6.2) |
| 3 | Notifications | **Not built.** Domain-event log + subscription registry + intent records, no delivery mechanism (§9). |
| 4 | Refund policy | **Commission-triggered model removed.** Replaced with an objectively verifiable Service Delivery Guarantee, versioned (§11). |
| 5 | Payment timing | **Pay after assignment.** Customer sees their named agent before paying (§4.1, §6). |
| 6 | Status architecture | **Three independent axes**: `payment_status`, `fulfilment_status`, `review_status` (§5.1, §6). |
| 7 | Marketplace growth | Off-platform properties become a tracked **listing-acquisition pipeline** (§10). |
| 8 | Analytics & Intelligence | **Extends the existing platform.** No parallel system; reuses the event spine, Metrics Engine, and Insight Engine (§8). |
| 9 | Legal | Lao-specific considerations documented for professional review; non-blocking (§13). |

---

## 2. Codebase ground truth

Verified before designing. Find My Home builds on these; nothing here is assumed.

**Exists and is reused:**
`parties` (agents; `type`, `is_verified`, `auth_user_id`) · `properties` ·
`is_pintag_staff()` / `owned_party_ids()` RLS helpers · SECURITY DEFINER RPC
pattern (`analytics_*`) · private + public Supabase Storage buckets ·
`session.js`'s `getOrCreateSessionId()` · the behavioural event spine
(`page_views`, `search_events`, `listing_events`, `ui_events`, `lead_events`) ·
`intelligence_daily_metrics()` + `intelligence_insights` + the Insight Engine's
generalized detector interface · terminology registries (`PROPERTY_TYPES`,
districts, `FURNISHED_OPTIONS`, `RENTAL_CURRENCIES`).

**Does not exist (confirmed, must not be assumed):**

- **No consumer authentication.** Auth covers staff and agents only. Resolved by decision 1.
- **No viewing/booking feature.** The only match is `viewing_scheduled`, an agent-side CRM *lead status* (`dashboard.html:748`). Resolved by decision 2.
- **No email/SMS/WhatsApp delivery of any kind.** Resolved by decision 3.
- **No agent payout or clawback rail.** Reinforces decision 4.

---

## 3. Remaining risks

The largest risks from Revision 1 (unenforceable refund, prepayment trust
paradox, conflated status enum) are resolved by decisions 4, 5 and 6. What
survives:

### 3.1 Agent disintermediation — medium, structural, unfixable by code
The agent necessarily receives the customer's phone number and can complete a
deal privately. Inherent to any marketplace connecting two humans. Defenses, in
order of real effectiveness: steady request flow as the actual lock-in;
reputation and suspension with consequence; cross-checking reported outcomes
against on-platform `leads`/`listing_events` for proposed properties; periodic
staff spot-checks. **Monitor the rate; do not pretend it is zero.**

Note that decision 4 materially reduces the *incentive* here: with refunds no
longer tied to outcome self-reports, an agent gains nothing financially from
misreporting the outcome (§11.3).

### 3.2 Capacity vs. the guarantee — medium
The Service Delivery Guarantee (§11) is only affordable if Pintag can actually
staff the requests it accepts. Forty requests against six agents means mass
refunds. **Mitigation:** per-agent concurrent-request cap and a global intake
cap that shows a waitlist rather than accepting money Pintag can't service. This
is now load-bearing, not optional — it is what makes the guarantee safe.

### 3.3 Manual payment verification latency — medium
Customer pays at 21:00, admin verifies next morning. Mitigations: a published
SLA, on-screen acknowledgement, and an oldest-first verification queue (§12.1).
Acceptable at MVP volume, but it is now inside a guarantee window, so the SLA
clock must be visible to staff.

### 3.4 Outcome-survey non-response — low (downgraded)
Still expect silence from satisfied customers. `no_response` remains a
first-class value distinct from `no`, resolving to `unresolved` and reported
separately. Downgraded from Revision 1 because outcome data no longer gates
money — bias now affects reporting accuracy only, not refunds.

### 3.5 Token link exposure — low, accepted
A token URL shared or leaked exposes one request's brief (name, phone, budget,
requirements). Equivalent to a password-reset link. Mitigations in §5.10.
Accepted as a deliberate trade for zero signup friction.

---

## 4. UX flow

### 4.1 Customer — revised payment order (decision 5)

```
Marketplace nav → "Find My Home" (find-my-home.html)
   │  Explainer: what it is · price by tier · Service Delivery Guarantee ·
   │  what "Verified Agent" means · what we do NOT promise
   ▼
Request form — FREE, no account, no payment
   property type · budget + currency · districts · beds · baths · furnished ·
   pets · move-in date · requirements · name · phone/WhatsApp · language
   ▼
Submitted → reference code (FMH-2607-A3K9) + private portal link
            fulfilment_status = submitted   payment_status = not_required
   ▼
Pintag reviews (capacity + serviceability) and assigns a Verified Agent
   ▼
┌─────────────────────────────────────────────────────────────┐
│ PORTAL: "Your agent: [photo] Somchai P. — Verified          │
│          [N] completed searches · responds within [X]"      │
│          → Activate your search — US$50                     │
└─────────────────────────────────────────────────────────────┘
            fulfilment_status = assigned    payment_status = awaiting_payment
   ▼
BCEL QR shown → customer pays → uploads receipt
            payment_status = pending_verification   (SLA stated on screen)
   ▼
Admin verifies → payment_status = verified → AGENT BEGINS WORK
            fulfilment_status = searching
   ▼
Portal (token link) shows throughout:
   assigned agent card · current status · proposed properties (accept/decline) ·
   progress notes · "Coordinate viewings with your agent" · guarantee status
   ▼
Completion → "Did you rent a property?" YES / NO  +  feedback (rating + comment)
```

The customer knows exactly who they are working with before any money moves.

### 4.2 Viewing language (decision 2)

Pintag does not schedule anything. Everywhere the product previously implied
booking, it now reads:

| Context | Wording |
|---|---|
| Portal status | **Coordinating Viewings with Your Assigned Agent** |
| Explainer | "Your agent arranges viewings directly with you by phone or WhatsApp." |
| Agent action | "Mark as coordinating viewings" |
| Status value | `viewing` (fulfilment axis) |

No calendar, no time slots, no availability, no reminders — none of it exists and
none is being built.

---

## 5. Database design

All tables `fmh_`-prefixed. Repo conventions: idempotent DDL
(`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`),
RLS enabled everywhere, `is_pintag_staff()` / `owned_party_ids()` reused.

### 5.1 `fmh_requests`

```sql
id                  uuid PK default gen_random_uuid()
reference_code      text UNIQUE NOT NULL      -- 'FMH-2607-A3K9', human-quotable
access_token        text UNIQUE NOT NULL      -- 32-byte base64url, portal access
token_expires_at    timestamptz

-- Customer. No account today; phone is the durable identity (§5.10).
customer_account_id uuid NULL                 -- FORWARD-COMPAT: always NULL in MVP
customer_name       text NOT NULL
customer_phone      text NOT NULL
customer_whatsapp   text
customer_email      text
preferred_language  text                      -- lo|en|zh

-- Analytics spine link (§8.2) — the anonymous browsing session that led here
session_id          text
visitor_id          text

-- The brief. Vocabulary reused from terminology.js / rental-terms.js.
property_type       text
transaction_type    text default 'for_rent'
budget_min          numeric
budget_max          numeric
budget_currency     text default 'USD'
districts           text[]
bedrooms_min        integer
bathrooms_min       integer
furnished           text
pets_required       boolean
move_in_date        date
requirements        text

-- THREE INDEPENDENT AXES (decision 6)
payment_status      text NOT NULL default 'not_required'
                    CHECK IN ('not_required','awaiting_payment','pending_verification',
                              'verified','failed','refunded')
fulfilment_status   text NOT NULL default 'submitted'
                    CHECK IN ('submitted','assigned','searching','viewing',
                              'completed','closed','cancelled')
review_status       text NOT NULL default 'none'
                    CHECK IN ('none','needs_review','disputed','resolved')

-- Commercial
service_tier        text CHECK IN ('apartment_condo','house','row_house')
quoted_amount       numeric
quoted_currency     text default 'USD'
refund_policy_version text NOT NULL default 'sdg_v1'   -- §11.4
fee_disposition     text NOT NULL default 'retained'
                    CHECK IN ('retained','refund_due','refunded','credited','waived')
cancellation_reason text

created_at, updated_at, assigned_at, activated_at, completed_at, closed_at
```

**Two refinements to the proposed vocabulary, flagged rather than applied silently:**

1. **`payment_status` has six values, not five.** The proposal's single `pending`
   cannot distinguish *waiting on the customer to pay* from *waiting on staff to
   verify* — but those are different queues with different owners and different
   SLA clocks, and the admin verification queue (§12.1) cannot be built without
   the distinction. Split into `awaiting_payment` and `pending_verification`.
   If the five-value vocabulary is preferred, the same distinction can be derived
   from whether an `fmh_payments` row exists in `pending` state — but storing it
   is simpler and indexable. `failed` is retained for rejected/abandoned payments.
2. **`fulfilment_status` adds `cancelled`.** The proposed list has no terminal
   state for abandonment. Expiry is modelled as a cancellation *reason*
   (`cancellation_reason`) rather than a separate status, keeping the axis tight.

Indexes: each status column, `customer_phone`, `session_id`, `created_at DESC`.

### 5.2 `fmh_payments` — append-only attempts

```sql
id, request_id FK
method              text default 'bcel_qr'
quoted_amount       numeric, quoted_currency  text   -- e.g. 50 USD
observed_amount     numeric, observed_currency text  -- e.g. 1,080,000 LAK (§13.5)
fx_rate             numeric                          -- rate applied, if converted
receipt_path        text                             -- private bucket 'fmh-receipts'
receipt_sha256      text UNIQUE                      -- anti-reuse (§3, fraud)
submitted_at
verification_status text CHECK IN ('pending','verified','rejected')
verified_by         uuid FK parties, verified_at
rejection_reason, admin_note
```

Separate from the request because customers resubmit wrong receipts and the
attempt history is dispute evidence. `observed_*` and `fx_rate` exist because
pricing is quoted in USD while BCEL settles in LAK (§13.5).

### 5.3 `fmh_assignments` — offer/response history

```sql
id, request_id FK, party_id FK parties
state          text CHECK IN ('offered','accepted','rejected','withdrawn','expired')
offered_by     uuid FK parties, offered_at, responded_at, reject_reason
```
Partial unique index: at most one `accepted` assignment per request. Keeping
assignments as history (not a column on the request) is what makes agent
response-rate and reliability metrics a query rather than a re-architecture.

### 5.4 `fmh_proposals` — properties put to the customer

```sql
id, request_id FK
property_id        uuid FK properties NULL     -- on-platform
external_title     text                        -- OFF-platform (§10)
external_url       text
external_district  text
external_price     numeric, external_currency text
external_note      text
acquisition_status text NOT NULL default 'none'
                   CHECK IN ('none','candidate','contacted','permission_granted',
                             'declined','listed')
acquired_property_id uuid FK properties NULL   -- set when it becomes a listing
proposed_by        uuid FK parties, proposed_at
customer_response  text CHECK IN ('pending','interested','declined','viewed')
responded_at
```
CHECK: exactly one of `property_id` / `external_title` present. The
`acquisition_*` fields are decision 7 — see §10.

### 5.5 `fmh_outcomes` — dual confirmation

```sql
id, request_id FK UNIQUE
customer_response   text CHECK IN ('yes','no','no_response')
customer_responded_at
agent_response      text CHECK IN ('yes','no','no_response')
agent_responded_at
resolution          text CHECK IN ('converted','not_converted','needs_review','unresolved')
property_id         uuid FK properties NULL
external_property   text                 -- rented something off-platform
resolved_by, resolved_at, admin_note
```

**`commission_reported` is deliberately removed** (Revision 1 had it). With
decision 4, commission has no bearing on any Pintag process, and collecting a
number nobody acts on invites the exact misreporting incentive the decision
eliminates. If commission analytics are wanted later, add it then, with a stated
purpose.

### 5.6 `fmh_feedback` — customer feedback (decision 1)

```sql
id, request_id FK UNIQUE
rating          integer CHECK (rating BETWEEN 1 AND 5)
comment         text
would_recommend boolean
submitted_at
is_public       boolean NOT NULL default false   -- staff-gated before any display
moderated_by    uuid FK parties, moderated_at
```
Separate from `fmh_outcomes` because "did you rent?" (a fact, feeding conversion
metrics) and "how did we do?" (an opinion, feeding agent quality) are different
questions with different audiences and different response rates. `is_public`
defaults false — no customer comment surfaces anywhere without staff moderation.

### 5.7 `fmh_request_events` — the single domain event log

```sql
id bigserial, request_id FK
event_type    text NOT NULL          -- see §9.1 registry
actor_role    text CHECK IN ('customer','agent','staff','system')
actor_party_id uuid NULL             -- null for customer (no account) and system
from_value, to_value jsonb
note text, created_at
```

**This one table has three consumers** — audit trail (§12), notification source
(§9), and analytics milestone source (§8.3). Append-only: no updates, no deletes.
Every status transition, payment action, assignment, proposal and outcome write
appends here.

### 5.8 `fmh_notification_intents` — see §9

### 5.9 Storage

New **private** bucket `fmh-receipts` — no anon SELECT, no anon INSERT. Uploads
go through an edge function that validates the token, hashes the file, and writes
with the service role (§7.1). Contrast with the public `property-images` /
`agent-photos` buckets: receipts are financial records.

### 5.10 Forward-compatibility with future customer accounts (decision 1)

Three provisions, all costing nothing now:

1. **`customer_account_id uuid NULL`** exists from day one, always NULL in MVP.
   When accounts arrive it becomes a FK — an `ALTER TABLE ... ADD CONSTRAINT`,
   not a schema redesign.
2. **`customer_phone` is mandatory on every request.** Phone is the identity
   anchor in this market. A future phone-OTP signup back-fills
   `customer_account_id` by matching phone — existing requests join a new account
   retroactively with zero migration of request data.
3. **All customer-facing access already goes through RPCs** (§7.1), not direct
   table reads. Adding account-based auth means adding a second authorization
   path inside those same functions; no client rewrite, no new endpoints.

Token hygiene: 32-byte base64url (not brute-forceable), rotatable on request,
expiring N days after `closed_at`, never carrying credentials or payment
instruments, rate-limited lookup, and every access appended to
`fmh_request_events`.

### 5.11 Marketplace isolation invariant

> **No `fmh_*` table may be joined into, or queried by, any public marketplace
> page (`index.html`, `listings.html`, `listing.html`, `agent.html`). Find My
> Home must never add a query, a script, or a blocking call to the browse path.**

Recommend recording this in `ARCHITECTURE.md` beside the existing Platform
Identity / Buyer Contact / Authentication invariants so it is enforceable at
review time.

---

## 6. State machine

### 6.1 `payment_status`

```
not_required ──agent assigned & accepted──> awaiting_payment
                                                   │
                                          receipt uploaded
                                                   ▼
                                          pending_verification
                                            │            │
                                      verify│            │reject
                                            ▼            ▼
                                        verified      failed ──resubmit──> pending_verification
                                            │
                                   guarantee triggered (§11)
                                            ▼
                                        refunded

not_required ──staff waiver / promotional──> (stays not_required, fee_disposition='waived')
```

### 6.2 `fulfilment_status`

```
submitted ──assign──> assigned ──payment verified──> searching ──> viewing ──> completed ──> closed
    ▲                     │                                                         │
    └──agent declines─────┘                                                          └──> closed
                          
any non-terminal ──> cancelled   (reason: customer_withdrew | capacity | unserviceable | expired)
```

**Hard gate:** `fulfilment_status` cannot advance beyond `assigned` unless
`payment_status IN ('verified','not_required')`. Enforced inside the transition
RPC, not left to UI discipline. This is the mechanism that makes "agent begins
work only after payment is verified" true.

`viewing` means *coordinating viewings with the assigned agent* (decision 2) —
it records that a real-world viewing is being arranged, not that Pintag scheduled
anything.

### 6.3 `review_status`

Fully orthogonal — settable at any point on either other axis without changing
them.

```
none ──outcome mismatch / customer or agent raises──> needs_review
                                                          │
                                            staff escalates│
                                                          ▼
                                                      disputed
                                                          │
                                            staff adjudicates
                                                          ▼
                                                      resolved
```
A request can be `completed` + `disputed`, or `searching` + `needs_review` —
combinations a single enum could never express.

### 6.4 Outcome resolution

| Customer | Agent | `resolution` | Effect |
|---|---|---|---|
| yes | yes | `converted` | Counted as a conversion |
| no | no | `not_converted` | Counted as non-conversion |
| yes/no mismatch | | `needs_review` | `review_status` → `needs_review`, staff adjudicates |
| any | `no_response` (timeout) | `unresolved` | Reported separately; **never** counted as failure |

---

## 7. API design

Existing conventions: PostgREST for RLS-scoped access, SECURITY DEFINER RPCs for
trust-boundary crossings, edge functions where secrets or file processing are
involved.

### 7.1 Public (anon) — RPC and edge function only, zero table access

Customers have no account, so RLS cannot identify them. `fmh_requests` gets **no
anon policy at all** — the same default-deny posture as `owners`. Token-bearing
RPCs are the entire public surface.

| Endpoint | Type | Purpose |
|---|---|---|
| `fmh_create_request(payload jsonb)` | RPC | Create request, mint code + token. Rate-limited by phone + IP. Accepts `session_id` for spine linkage (§8.2). |
| `fmh_get_request(p_token)` | RPC | Portal view: request, agent card, proposals, notes, payment + guarantee state. |
| `fmh_submit_receipt` | **Edge fn** | Validates token → hashes file → private-bucket write with service role → inserts `fmh_payments`. Storage never exposed to anon. |
| `fmh_respond_proposal(p_token, p_proposal_id, p_response)` | RPC | Interested / declined / viewed. |
| `fmh_customer_outcome(p_token, p_response)` | RPC | Completion survey. |
| `fmh_submit_feedback(p_token, p_rating, p_comment)` | RPC | Rating + comment (§5.6). |

Every token RPC appends to `fmh_request_events` and is rate-limited.

### 7.2 Agent (authenticated, RLS-scoped)

PostgREST reads on `fmh_requests`/`fmh_proposals` **only** where an `accepted`
assignment exists for a party in `owned_party_ids(auth.uid())`. **Customer
contact details are withheld until acceptance** — the offer view shows the brief,
not the phone number.

`fmh_agent_respond_assignment` · `fmh_agent_set_status` (validates transition and
the payment gate) · `fmh_agent_propose` · `fmh_agent_outcome`.

### 7.3 Staff

Full access via `is_pintag_staff()`, plus `fmh_verify_payment` ·
`fmh_reject_payment` · `fmh_assign_agent` · `fmh_set_status` ·
`fmh_resolve_outcome` · `fmh_set_fee_disposition` · `fmh_moderate_feedback` ·
`fmh_set_acquisition_status` (§10).

### 7.4 Permissions matrix

| Table | anon | agent (assigned) | agent (other) | staff |
|---|---|---|---|---|
| `fmh_requests` | none (RPC only) | SELECT own-assigned | none | ALL |
| `fmh_payments` | none (edge fn only) | **none** | none | ALL |
| `fmh_assignments` | none | SELECT own | none | ALL |
| `fmh_proposals` | none (RPC only) | SELECT/INSERT own-assigned | none | ALL |
| `fmh_outcomes` | none (RPC only) | SELECT/UPDATE own-assigned | none | ALL |
| `fmh_feedback` | none (RPC only) | **none** | none | ALL |
| `fmh_request_events` | none | SELECT own-assigned | none | SELECT |
| `fmh_notification_intents` | none | none | none | ALL |

Agents never see other agents' requests, never see payment data (no business
seeing what a customer paid), and never see raw feedback (staff moderate first,
then surface aggregates).

---

## 8. Analytics & Intelligence integration (decision 8)

**No parallel analytics system.** Find My Home emits into the existing spine and
extends the existing Metrics Engine and Insight Engine. Three distinct layers,
matching the boundaries already documented in `INTELLIGENCE_ARCHITECTURE.md`.

### 8.1 Funnel behaviour — zero new infrastructure

`find-my-home.html` and the portal are ordinary pages. They load
`analytics-tracking.js` and `tracking.js` exactly like every other page, emitting
`page_views` and `ui_events` with the shared `getOrCreateSessionId()`. This gives
the top-of-funnel for free:

> FMH page view → form start → form submit → assigned → paid → completed

No new table, no new tracking code, and it appears in the existing Analytics
Behavior/Traffic tabs automatically.

### 8.2 The spine link — `fmh_requests.session_id`

This is the highest-value integration point in the whole feature.

Storing the originating `session_id` (and `visitor_id`) on the request joins the
paid product into the **existing continuous buyer-journey chain**:

```
search_events → listing_events (impression/click/view) → [gave up] → fmh_requests
```

That makes a previously unanswerable question answerable: *what did this customer
search for, and fail to find, immediately before paying us to find it for them?*
Every Find My Home request is a **labelled supply-gap signal with a budget
attached** — the highest-intent demand data Pintag has ever had.

### 8.3 Metrics Engine — additive keys only

Per the architecture's additive-versioning invariant, `intelligence_daily_metrics()`
gains new keys; nothing existing changes meaning:

```jsonc
"fmh": {
  "requests_created":       n,
  "requests_assigned":      n,
  "payments_verified":      n,
  "requests_completed":     n,
  "conversion_rate":        0.0,   // converted ÷ resolved outcomes
  "median_hours_to_assign": n,
  "median_hours_to_verify": n,     // the §3.3 SLA, measured
  "guarantee_triggered":    n,     // §11
  "by_district":            { ... },
  "by_property_type":       { ... },
  "by_budget_band":         { ... },
  "unmet_demand_ratio":     { "by_district": {...}, "by_property_type": {...} }
}
```

All derived from `fmh_requests` + `fmh_request_events` + `fmh_outcomes` — the
same way `intelligence_daily_metrics()` already reads `leads` directly. No
separate FMH event feed exists or is needed.

### 8.4 Insight Engine — one registry entry per metric, no new machinery

The detector interface was generalized during the hardening pass specifically so
new signals are a one-file plugin. Find My Home adds entries to the existing
`TRACKED_SCALAR_METRICS` / `TRACKED_BREAKDOWN_METRICS` arrays and reuses the
existing z-score-vs-30-day-baseline detector unchanged:

| Metric key | Existing insight type | What it detects |
|---|---|---|
| `fmh.requests_created` | `demand_spike` | Paid-demand volume moving off its own baseline |
| `fmh.unmet_demand_ratio.by_district` | **`supply_shortage`** | Districts where paid demand outruns inventory |
| `fmh.unmet_demand_ratio.by_property_type` | `supply_shortage` | Same, by type |
| `fmh.conversion_rate` | `conversion_anomaly` | Service effectiveness drifting |
| `fmh.median_hours_to_verify` | `ux_anomaly` | Payment-verification SLA slipping |

**Correction to Revision 1:** I previously implied `supply_shortage` had no
detector. It does — wired to `new_listings_added`, `listings_removed` and
`active_inventory` by `20260725000000_intelligence_bi_metrics.sql`. Those measure
*inventory* movement. What they cannot see is **demand against that inventory**.
`fmh.unmet_demand_ratio` (paid requests per district ÷ active inventory there) is
exactly that missing input, feeding the *same* insight type through the *same*
detector. This is extension in the precise sense decision 8 asks for: one array
entry each, zero new machinery.

No new insight `type` values are required — a migration to the `type` CHECK is
only needed if a genuinely new *category* emerges later.

### 8.5 Analytics vs. Intelligence boundary

The separation established earlier holds without exception:

- **Analytics** (`analytics.html`): raw verifiable facts — request counts,
  conversion rates, SLA timings, revenue. Delivered by a new
  `analytics_fmh_breakdown(p_start, p_end)` RPC following the aggregate-in-SQL
  pattern the analytics tabs were just rebuilt on. **No client-side row
  aggregation.**
- **Intelligence** (`intelligence.html`): interpretation only, and every number
  it cites must be verifiable in Analytics.
- **Marketing OS** consumes the same metrics — it reads the Metrics Engine
  output, so it inherits FMH data with no FMH-specific integration.

---

## 9. Notification architecture (decision 3)

**Nothing is delivered in the MVP.** What is built is the *interface*, so a
future WhatsApp/SMS/email/push integration subscribes without touching business
logic.

### 9.1 Domain events are the contract

Business logic emits domain events into `fmh_request_events` (§5.7) and **knows
nothing about notification**. A data-only registry maps event types to intended
audiences:

```js
// find-my-home.js — pure data, no delivery code
const FMH_NOTIFIABLE_EVENTS = {
  'request.submitted':   { audience: ['customer','staff'], template: 'fmh_submitted' },
  'agent.assigned':      { audience: ['customer','agent'], template: 'fmh_assigned' },
  'payment.submitted':   { audience: ['staff'],            template: 'fmh_receipt_received' },
  'payment.verified':    { audience: ['customer','agent'], template: 'fmh_activated' },
  'payment.rejected':    { audience: ['customer'],         template: 'fmh_receipt_problem' },
  'proposal.created':    { audience: ['customer'],         template: 'fmh_new_proposal' },
  'status.changed':      { audience: ['customer'],         template: 'fmh_status_update' },
  'request.completed':   { audience: ['customer','agent'], template: 'fmh_outcome_survey' },
  'guarantee.triggered': { audience: ['customer','staff'], template: 'fmh_guarantee' }
};
```

### 9.2 `fmh_notification_intents` — recorded, not sent

A trigger on `fmh_request_events` writes one intent row per audience member for
notifiable events:

```sql
id, request_id FK, event_id FK fmh_request_events
audience     text CHECK IN ('customer','agent','staff')
template_key text
payload      jsonb                    -- rendered context, channel-agnostic
channel      text NULL                -- NULL in MVP: no channel decided yet
state        text NOT NULL default 'pending'
             CHECK IN ('pending','sent','skipped','failed')
sent_at, sent_by uuid NULL, sent_via text NULL, error text
```

**MVP:** intents accumulate as `pending`. Staff see them as a checklist in the
admin module, message the customer over WhatsApp by hand, and mark them
`sent` (recording `sent_via='whatsapp_manual'`, `sent_by`). Nothing is lost, and
the manual work is measured from day one.

**Future:** a dispatcher consumes `state='pending'` and fills the same columns.
**No business-logic call site changes** — the emit path is already correct. That
is precisely what decision 3 asks for.

---

## 10. Marketplace growth: listing acquisition (decision 7)

When an agent proposes a property not on Pintag, that is a supply-side lead.

**Pipeline** (`fmh_proposals.acquisition_status`, §5.4):

```
none → candidate → contacted → permission_granted → listed
                            ↘ declined
```

- **`candidate`** — staff triage flags it worth pursuing.
- **`contacted`** — staff or agent has approached the owner.
- **`permission_granted`** — owner consents to listing. **This gate is mandatory:
  no off-platform property is ever added without explicit owner permission**
  (a legal and trust requirement, §13.4 — not merely a workflow nicety).
- **`listed`** — created on Pintag; `acquired_property_id` links back, closing
  the loop and making acquisition attributable.

**Integration, not a separate system** (decision 7 + 8):
- Surfaced as an **Acquisition queue in the existing admin module**, not a new tool.
- Counted in the Metrics Engine as `fmh.acquisition.{candidates,granted,listed}`.
- Feeds the existing `supply_shortage` insight type: off-platform proposals
  concentrated in a district are corroborating evidence of the same inventory gap
  `fmh.unmet_demand_ratio` detects (§8.4).
- Once `listed`, the property is an ordinary listing — no FMH-specific fields
  leak into `properties`, preserving §5.11.

**Why this matters commercially:** every paid search surfaces real, verified,
off-market inventory found by professionals who know the market. The premium
service quietly becomes a supply funnel for the free marketplace. That may prove
worth more than the fee revenue.

---

## 11. Refund policy (decision 4)

### 11.1 Principle

> **Refund eligibility depends only on facts recorded in Pintag's own database.**

No trigger may depend on off-platform events (commission), self-reports (did you
rent?), or subjective judgement (did the agent try hard?). Every condition below
is computable in SQL from `fmh_request_events`, `fmh_assignments` and
`fmh_proposals`.

### 11.2 Service Delivery Guarantee v1 (`sdg_v1`)

Pintag guarantees the **search effort**, not the market outcome — stated plainly
to the customer, because promising a home Pintag cannot control is exactly the
overpromise that destroys trust.

| # | Trigger (objectively verifiable) | Outcome |
|---|---|---|
| G1 | No agent accepts within **N days** of `payment_status='verified'` | Full refund |
| G2 | Fewer than **M proposals** delivered within **P days** of activation | Full refund |
| G3 | Agent inactive **Q consecutive days** while `fulfilment_status='searching'` (no proposal, no status change, no note) | Reassign, or full refund at customer's choice |
| G4 | Customer cancels **before** `payment_status='verified'` | No charge |
| G5 | Pintag cancels (capacity, unserviceable) | Full refund |

N/M/P/Q are policy parameters, not code constants — stored with the policy
version so historical requests keep the terms they were sold under.

### 11.3 The consequence worth noting

Decoupling refunds from outcomes **removes every financial incentive to
misreport the outcome survey.** Neither agent nor customer gains money from
answering "did you rent?" either way. The conversion data in §8 therefore becomes
substantially more trustworthy — a reporting-quality benefit, not just a fraud
fix. Under the original commission-linked model, the single most
business-critical metric would have been the one everyone had a reason to
corrupt.

### 11.4 Schema flexibility without redesign

`fmh_requests.refund_policy_version text` (default `'sdg_v1'`) plus a SQL
function:

```sql
fmh_check_refund_eligibility(p_request_id uuid) → jsonb
  -- { eligible: bool, policy: 'sdg_v1', triggered: ['G2'], evidence: {...} }
```

Adding a future model — outcome-based, credit-based, commission-share — means a
**new policy version** and a new branch in that one function. Historical requests
keep evaluating under the version they were sold, matching the Intelligence
layer's additive-versioning invariant ("never change the meaning of historical
data"). `fee_disposition` already spans `retained | refund_due | refunded |
credited | waived`, so a credit model needs no new column.

**MVP scope:** eligibility is *computed and surfaced to staff*; the refund itself
is executed manually by bank transfer and recorded. No payout automation — none
exists to build on.

---

## 12. Workflows

### 12.1 Admin — new "Find My Home" tab in `admin.html`

| Queue | Purpose |
|---|---|
| **Triage** | New submissions: serviceable? capacity available? → assign or decline |
| **Verify payments** | Oldest-first, receipt image beside quoted vs. observed amount; verify/reject. SLA clock visible (§3.3) |
| **Active** | Monitor, reassign, note, cancel |
| **Guarantee watch** | Requests approaching or breaching G1–G3 (§11.2) — proactive, before the customer complains |
| **Needs review** | Outcome mismatches and disputes, with the full `fmh_request_events` timeline as evidence |
| **Acquisition** | Off-platform proposals through the §10 pipeline |
| **Notifications** | Pending intents to send manually (§9.2) |

Every action appends to `fmh_request_events` with the acting staff party recorded.

### 12.2 Agent — new section in `dashboard.html`

- **Offers** — brief *without* contact details; Accept / Decline with reason; expiry returns the offer to the pool.
- **Active** — full brief (contact details revealed on acceptance); propose properties (on-platform picker or off-platform details); update status; customer-visible progress notes and staff-only internal notes. **Work must not begin until `payment_status='verified'`** — enforced by the §6.2 gate, and shown in the UI as a locked state.
- **Complete** — outcome survey (rented? which property?).

Only agents with `type='agent'`, `is_verified=true`, and an explicit FMH opt-in
capability receive offers. Recommend a capability flag on `parties` rather than a
new agent table — verification already lives there.

### 12.3 Customer

Covered in §4.1. Two requirements:

- **Trilingual (lo/en/zh) from day one**, like every other Pintag surface. A paid product speaking fewer languages than the free one is indefensible.
- **The portal is the trust surface.** For someone who has paid and is waiting, this page *is* Pintag: agent's face, last-updated timestamp, what happens next, guarantee status. Never an empty state.

---

## 13. Lao-specific legal and accounting considerations (decision 9)

**Not legal advice.** This is a question list for a qualified Lao lawyer and
accountant. Charging for a service moves Pintag from operating a free listings
board into regulated commercial territory. Non-blocking for design; **blocking
for launch.**

### 13.1 Business scope and licensing
Does Pintag's current registration cover **paid service fees** and **real-estate
intermediation**? Does acting as a paid search intermediary trigger brokerage or
agency licensing? Does introducing customers to agents for a fee create
obligations regarding those agents' own licensing status?

### 13.2 Tax, VAT and invoicing
Is a service fee VATable in Laos, and is Pintag over the registration threshold?
What constitutes a valid tax invoice — required format, sequential numbering,
Lao-language requirement, physical vs. electronic? Must an invoice be issued at
payment or at service completion? Retention period for financial records
(receipts are stored in `fmh-receipts`, §5.9 — retention must match the legal
requirement, not an arbitrary default).

### 13.3 Consumer protection
The Service Delivery Guarantee (§11) is a **published consumer commitment** and
likely enforceable as offered — its terms must be reviewed before publication.
Requirements for refund/cancellation terms, mandatory complaint handling, and
whether terms must be presented in Lao. **"Verified Agent" is an advertising
claim** — what Pintag must actually verify to make it lawfully, and the liability
if a Verified Agent misbehaves.

### 13.4 Data protection and privacy
Paying customers' PII (name, phone, budget, requirements) is more sensitive than
anything Pintag holds today. Questions: lawful basis and consent wording;
retention and deletion periods; **cross-border data storage** — Supabase hosts
outside Laos, which may carry residency or disclosure obligations; customer
rights of access/erasure; and, for §10, the **owner-permission requirement before
listing an off-platform property**, which is a privacy and property-rights matter
as much as a workflow gate.

### 13.5 Payments and currency
BCEL merchant account terms for receiving business payments; any AML/KYC
thresholds; whether commercial pricing must be **quoted in LAK** given USD
pricing settling in kip (the `observed_amount` / `fx_rate` fields in §5.2 exist
for this); who bears FX variance; refund mechanics and timelines for bank
transfers.

### 13.6 Agent relationship
Are Verified Agents independent contractors or something closer to employees or
sub-agents under Lao law? Withholding-tax implications for any future payout
model. Pintag's liability for agent conduct toward a customer who paid *Pintag*.

### 13.7 Recommended sequence
Design and Phase 1 build can proceed now. Obtain advice on §13.1–13.3 **before
taking the first real payment**, and on §13.4 before storing production customer
data at volume. Budget for terms-of-service and privacy-policy drafting as a real
line item, not an afterthought.

---

## 14. Implementation phases

### Phase 0 — Approval
This document. No code.

### Phase 1 — Manual-operations MVP *(recommended first shippable unit)*
Migration (all `fmh_*` tables, RLS, RPCs, the notification-intent trigger) ·
`find-my-home.html` request form · token portal · receipt-upload edge function ·
admin module (all seven queues) · `analytics_fmh_breakdown` RPC.
**No agent portal** — staff relay to agents over WhatsApp, exactly as listings
are onboarded manually today.

This is a complete, sellable product. It proves demand and price before any
agent-facing engineering. Recommend 10–20 real requests through it before Phase 2.

### Phase 2 — Agent self-service
Agent section in `dashboard.html`: offers, accept/decline, proposals, status,
outcome survey. Removes staff from the fulfilment loop.

### Phase 3 — Intelligence integration
`intelligence_daily_metrics()` FMH keys · Insight Engine registry entries (§8.4) ·
Analytics FMH section · acquisition metrics · agent performance from
`fmh_assignments` + `fmh_outcomes`.

### Phase 4 — Trust and scale
Verification tiers · ratings from moderated `fmh_feedback` · capacity-aware
assignment · notification dispatcher consuming the existing intent table ·
acquisition pipeline surfaced to Marketing OS.

### Phase 5 — Deferred by design
Online payment gateway · agent payouts and refund automation · in-app chat ·
sale-side Find My Home · customer accounts via phone OTP (§5.10 upgrade path).

---

## 15. Open items

Everything material is now decided. Four parameters need values before Phase 1
ships, none of which block starting:

1. **Guarantee parameters** — N/M/P/Q in §11.2. Suggested starting point: assign
   within **3 days**, **3 proposals** within **7 days**, inactivity threshold
   **5 days**. Needs a commercial judgement on what Pintag can consistently meet.
2. **Capacity caps** (§3.2) — max concurrent requests per agent, and global
   intake cap. Needs the real count of FMH-enabled verified agents.
3. **Payment-verification SLA** (§3.3) — the number published to customers.
4. **`payment_status` vocabulary** — confirm the six-value split in §5.1, or
   direct that the proposed five-value list be kept with the queue distinction
   derived from `fmh_payments`.

**Pre-launch, non-engineering:** §13.1–13.3 legal advice before the first real
payment.

---

*Revision 2 — prepared for approval. No implementation will begin until approved.*
