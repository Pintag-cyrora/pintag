# Execution Architecture — where Marketing OS pipelines actually run

**Status:** Phase 1 shipped (deployed Founder Workspace, `SETUP.md` §10). Part II (autonomy roadmap) step 1 in progress; everything else is a proposal.

**The question this document answers:** every department (Morning, Research, Content, Video, Analytics, Publisher) should be triggerable from the web UI on any device, without a local `npm` command. What should execute them?

**And the larger question, in Part II:** how does Marketing OS get from *"the CEO presses Generate"* to *"departments operate continuously and the Morning Brief is the CEO's interface to work already completed"*?

> **Read §0 of `ARCHITECTURE.md` first (v2.6).** Operating Marketing OS from a phone and departments running unattended are **core**, not deployment adapters. An earlier revision classified them as optional, which contradicted the product — that correction is what makes this document's direction legitimate rather than scope creep.

---

## 0. Where we are now

| | |
|---|---|
| **Trigger** | Founder taps a button in the browser, or runs a CLI command |
| **Execution** | One always-on Node process (`pipeline/founder-server.ts`) |
| **State** | Supabase (durable) + container filesystem (ephemeral) |
| **Auth** | Supabase Auth token, verified on every route, single founder |
| **Cost** | ~$5–6/mo hosting + Anthropic API usage |

Phase 1 works and is the right call for today. Its limits are real but not yet painful:

1. **One process, one job slot.** `morningJob` is a single in-memory slot. Two departments can't run concurrently in a controlled way, and there's no queue — a second request either joins the first or is refused.
2. **Job state dies with the process.** A deploy or crash mid-generation loses the "running" status (the Supabase row survives, but the client is left guessing).
3. **Paying for idle.** The machine runs 24/7 to serve a handful of taps a day. At $5/mo this is irrelevant; at 50 tenants × several departments it is not.
4. **No retries, no history, no per-run logs** beyond stdout.
5. **Local filesystem as an input.** `brain/`, `knowledge/`, `knowledge-base/` are read from disk, so "deploying" means shipping the whole repo. Fine for one tenant; it's the main thing standing between us and multi-tenancy, because a second company's knowledge base can't live in the same checkout.

Point 5 is the one worth internalizing: **the deepest constraint isn't hosting, it's that knowledge lives on a filesystem.** Any option below inherits that problem until it's fixed, and fixing it is more valuable than changing hosts.

---

## 1. Options compared

### A. Dedicated worker/server (what Phase 1 is, extended)

Keep the always-on process; add a real job table in Supabase and a worker loop.

| | |
|---|---|
| **Cost** | $5–25/mo depending on size; flat regardless of usage |
| **Scalability** | Vertical only, until you add a second machine + real locking. Fine to ~dozens of runs/day |
| **Security** | One perimeter to defend; secrets in host env; already implemented and tested |
| **DX** | Best of any option — `npm run founder-ui` locally *is* production. One codebase, one runtime, `tsx` directly, no bundling, no cold starts |
| **Long-running work** | Unlimited. A 10-minute video pipeline is no different from a 30-second one |
| **Migration effort** | Low — add a `pipeline_runs` table and a poll loop |

**Best for:** everything up to the point where you have real tenants or genuinely parallel workloads.

### B. Supabase Edge Functions (Deno)

Each department becomes an edge function in the project already holding the data.

| | |
|---|---|
| **Cost** | Effectively $0 at our volume (generous free tier, then per-invocation) |
| **Scalability** | Excellent horizontally; automatic |
| **Security** | Strongest story — secrets never leave Supabase, auth/RLS already native, no separate host to patch |
| **DX** | Worst of the serious options: Deno not Node, so `tsx`/npm assumptions break; no filesystem, so `brain/`+`knowledge/` must move to Postgres or Storage first; local dev diverges from production |
| **Long-running work** | **The blocker.** Wall-clock limits (single-digit minutes) are incompatible with a full campaign run — M3 alone is 7+ sequential LLM calls |
| **Migration effort** | High — port the runtime AND move knowledge off the filesystem |

**Verdict:** genuinely attractive for *short* work (scoring, publishing an already-generated artifact, webhooks). Wrong shape for multi-minute AI pipelines. Do not force it.

### C. GitHub Actions

`workflow_dispatch` per department, triggered via the GitHub API.

| | |
|---|---|
| **Cost** | Free for a private repo at this volume (2000 min/mo included) |
| **Scalability** | Fine for scheduled/occasional work; concurrency limits bite when it becomes interactive |
| **Security** | Weakest fit: triggering needs a GitHub token with `actions:write` in the browser's reach, and secrets sit in repo settings where any workflow can read them. Also entangles *marketing operations* with *source control permissions* — a contractor with repo access shouldn't be able to spend LLM budget |
| **DX** | Poor for interactive use: 20–60s queue latency before anything starts, and progress means polling the Actions API. Excellent for cron |
| **Long-running work** | Up to 6h — plenty |
| **Migration effort** | Low — the repo already has the checkout |

**Verdict:** we already tried and removed this (commit `7c5415d`) for good reasons. It's a fine **scheduler** ("generate the brief at 6am daily") and a poor **interactive backend**. That distinction is the useful takeaway, not a blanket rejection.

### D. Queue + stateless workers

Supabase table (or a real broker) as the queue; N workers claim jobs; API only enqueues.

| | |
|---|---|
| **Cost** | Worker hosting (same as A) + negligible queue cost. Can scale workers to zero between jobs on some platforms |
| **Scalability** | The right answer at scale — add workers, get throughput; natural per-tenant fairness and rate limiting |
| **Security** | Good: the public API only enqueues, so nothing internet-facing ever executes AI code. Smallest blast radius of any option |
| **DX** | Moderate: one more moving part, and local dev needs the worker running too. But the *pipeline code itself doesn't change* — only who calls it |
| **Long-running work** | Unlimited |
| **Migration effort** | Moderate — job table, claim/heartbeat/retry semantics, worker loop |

**Verdict:** the correct destination. Also the natural evolution of A, not a rewrite of it — which is exactly what makes A a safe starting point rather than a dead end.

### E. Container jobs (Cloud Run Jobs / Fly Machines API / ECS tasks) — *the option not in the original list*

Same Docker image as Phase 1, but instead of one long-lived process, the API **starts a container per run** and it exits when done.

| | |
|---|---|
| **Cost** | Per-second billing, ~$0 when idle. A 3-minute run on a small machine is a fraction of a cent |
| **Scalability** | Excellent and automatic — each run is isolated, so concurrency is free |
| **Security** | Good: each run is a fresh sandbox; a compromised run can't affect the next |
| **DX** | **Very good, and the key advantage: it's the same image and the same code as Phase 1.** No Deno port, no filesystem removal, no bundler |
| **Long-running work** | Up to 24h (Cloud Run Jobs); no practical limit |
| **Migration effort** | Low-moderate — the Dockerfile already exists; you add a job-runner entry point and swap "call the function" for "start a machine" |

**Verdict:** this is the sweet spot the original five options miss. It gets serverless economics and isolation **without** giving up Node, the filesystem, or long runtimes — precisely the three things that make Edge Functions painful. It composes with D (workers become jobs) rather than competing with it.

---

## 2. Side by side

| | A. Server | B. Edge Fn | C. Actions | D. Queue+Worker | E. Container jobs |
|---|---|---|---|---|---|
| Idle cost | $5–25/mo | ~$0 | $0 | $5–25/mo | ~$0 |
| Multi-minute runs | ✅ | ❌ | ✅ | ✅ | ✅ |
| Reuses today's code | ✅ | ❌ | ✅ | ✅ | ✅ |
| Filesystem knowledge OK | ✅ | ❌ | ✅ | ✅ | ✅ |
| Interactive latency | best | good | poor | good | good (cold start s) |
| Horizontal scale | ❌ | ✅ | ~ | ✅ | ✅ |
| Multi-tenant ready | ❌ | ~ | ❌ | ✅ | ✅ |
| Security blast radius | medium | small | large | small | small |
| Effort from here | — | high | low | moderate | low-moderate |

---

## 3. Recommendation

**Do not migrate yet.** Phase 1 is correct for a single founder and one company. Migrate when a *specific* trigger fires, not on a schedule:

- **Trigger 1 — a second company's knowledge base.** Then do the filesystem work (§4, step 1). This is the real blocker and it's independent of hosting.
- **Trigger 2 — departments need to run concurrently, or a run being lost actually hurts.** Then do the job table (§4, step 2).
- **Trigger 3 — real tenants, or idle cost becomes visible.** Then move execution to container jobs (§4, step 3).

**Target architecture:** `browser → thin authenticated API (enqueue only) → job table in Postgres → container job per run → Supabase for results`. That is D and E combined, and every step toward it is independently useful.

**Explicitly reject:** porting multi-minute AI pipelines to Edge Functions. Use Edge Functions for the short work they're good at — scoring, publishing, webhooks — and never for a full campaign run.

---

## 4. Migration path

Each step ships value alone and none requires the next.

**Step 1 — Get knowledge off the filesystem.** *(The important one.)*
Move `brain/`, `knowledge/`, `knowledge-base/` behind the existing `retrieveKnowledge()` seam into Postgres/Storage. `pipeline/lib/knowledge.ts` was already built as a "storage-layer swap behind a stable API" (see `knowledge-sources/lao-brain.ts`) — this is the seam being used as designed. Unblocks multi-tenancy *and* every stateless execution option. Do this first regardless of hosting choice.

**Step 2 — A real job table.**
`pipeline_runs` (id, org_id, department, status, started_at, finished_at, error, progress jsonb, requested_by). Replace `morningJob` and `activeCampaigns` (both in-memory today) with rows. Immediately fixes: progress surviving restarts, run history, a second device seeing the same state, and audit ("who spent this money"). Still one process — no new infrastructure.

**Step 3 — One entry point per department, run as a container job.**
`pipeline/run-department.ts <department> <run-id>` reading its input from the job row. The API stops executing and starts *dispatching*. Same image, same code. Add retries with backoff, and per-org concurrency caps.

**Step 4 — Scheduling, properly separated.**
Cron (Supabase `pg_cron` or the platform's scheduler) inserts job rows; workers don't care who enqueued them. This is where GitHub Actions could legitimately live if preferred — as a *scheduler that enqueues*, never as the executor.

**Step 5 — Multi-tenancy.**
With steps 1–3 done, this is mostly RLS plus per-org budget accounting, not a re-architecture.

---

## 5. Things worth deciding before scale, not after

- **Budget enforcement is currently per-call, not per-run or per-org.** `maxBudgetUsd: 0.3` caps one LLM call. Nothing caps a day, and `brain/org-config.json`'s `monthly_ceiling_usd: 100` is documentation, not enforcement. With a phone button and an API key, that's now a real exposure: repeated taps spend real money with no ceiling. **Worth fixing before tenants, and arguably before heavy personal use.**
- **The LLM provider differs between local and deployed** (`claude-cli` vs `anthropic-api`) because the CLI needs interactive auth. Deployed output is therefore not byte-identical to local output. Standardizing on the API provider everywhere would remove a real source of "works locally, differs in production."
- **Ephemeral filesystem means local artifacts are lost** on restart (`daily-briefing/*.md`, `content-vault/campaigns/*`). Supabase holds the published brief, but campaigns and the learning records derived from them currently live only on disk — **on a container host, M4's learning data would not survive a redeploy.** Step 1 fixes this; until then, a mounted volume is the stopgap.
- **One founder is hardcoded** (`MARKETING_OS_FOUNDER_EMAIL`). Correct today, but "team members with roles" is a different auth model, not a bigger allowlist.

---
---

# Part II — The Autonomy Roadmap

*From "the CEO presses Generate" to "the departments already did the work."*

## 6. The reframe: scheduling is the easy part

A cron job is a day's work. The transition has three distinct pieces and only one of them is infrastructure:

1. **Inverting who initiates** — pull (you press, it runs) → push (it ran, you read).
2. **Inverting what the Morning Brief *is*** — from a thing that *orchestrates* work into a thing that *reports* work. **This is the actual product change.**
3. **Graduating trust** — deciding what departments may do unattended, from evidence rather than a switch.

Phase 1's Generate button is genuinely useful and you'll use it daily. But be clear about what it is: **tapping Generate at 7am and waiting ninety seconds is still an on-demand report.** It is step 0 of the autonomous organization, not the destination.

## 7. The Morning Brief inverts: orchestrator → reporter

Today `generateMorningBrief()` reads *live state* and summarizes it — pending approvals, `agent_health` rows, recent observations, knowledge entries. It structurally **cannot** say "Research discovered X overnight," because nothing runs overnight.

In the autonomous model it becomes a reporter over the run ledger:

| | Today | Autonomous |
|---|---|---|
| Reads | current state | completed runs since the last brief |
| Sections answer | "what exists" | "what happened, and what it produced" |
| Cost | several LLM calls to *think* | mostly deterministic aggregation, ≤1 LLM call to *narrate finished work* |
| `daily-briefing.ts` | the entry point that triggers everything | the **last step** of the nightly cycle |

This is a real rewrite of `services/morning/collect.ts`, not a config change — and it's the piece that makes the vision real rather than cosmetic. It also gets *cheaper and faster*, which matters when it runs every day unattended.

The brief's new sections map directly onto what the CEO asked for: what each department accomplished · what knowledge was discovered · what content is ready · what opportunities and risks were found · **what failed** · what needs approval · what the organization is *asking* you.

## 8. Three substrates that must exist first

### 8.1 A run ledger in Postgres — *step 1, in progress*

`morningJob` (`founder-server.ts`) and `activeCampaigns` are in-memory `Map`s. They die with the process. Nothing autonomous can be built on that: no history, no "what happened at 3am," no second device seeing the same state, and **nothing for the brief to report over**.

`pipeline_runs` (org, department, status, started/finished, cost, error, output refs, and *who triggered it* — schedule vs. founder) is the substrate for everything else in Part II. It is independently useful with zero autonomy: run history, progress that survives a restart, and an audit trail for spend.

### 8.2 Knowledge off the filesystem

`loadAgentSystemPrompt()` reads `brain/ceo.md` **and** the agent's spec from disk on *every single agent call*. There are 11 `readFileSync` sites in the hot path and 73 markdown files across `brain/`, `knowledge/`, `knowledge-base/`.

Fine for one process on one machine. Fatal for: multiple workers, container-per-run, a second business, or surviving a redeploy — which is also why M4's learning records currently wouldn't survive a container restart. `retrieveKnowledge()` was built as a storage-swap seam (see `knowledge-sources/lao-brain.ts`); this is that seam being used as designed.

### 8.3 Enforced budget — *hard prerequisite, not a nice-to-have*

`brain/org-config.json`'s `monthly_ceiling_usd: 100` is **documentation**. `maxBudgetUsd: 0.3` caps a single call. Nothing caps a day.

> **Unattended loop + API key + unenforced ceiling is the single most dangerous combination in this plan.** A retry storm at 3am is a real bill and nobody is watching. Per-run and per-day ceilings, checked *before* spending, must land before the first scheduled producer run.

## 9. Graduate trust with the ladder that already exists

**Do not invent an autonomy mechanism.** `brain/org-config.json` already encodes a three-stage ladder and `shouldAutoPublish()` (`lib/config.ts`) already implements it:

| Stage | Behavior |
|---|---|
| `phase_1` *(current)* | Founder approves everything |
| `phase_2` | `educational_posts`, `property_videos` auto-publish above 0.90 confidence |
| `phase_3` | `neighborhood_guides` join at 0.92 |
| `market_updates` | `eligible_from_phase: "never"` — permanently the founder's |

Plus `founder_modes`: **`vacation`** already pauses new strategy generation and **`manual`** is a hard override that beats every other setting. *The pause button and the kill switch are already designed.*

So autonomy arrives as: **the nightly cycle runs, and `shouldAutoPublish()` decides what reaches the founder.**

**Separate two kinds of autonomy, and treat them very differently:**

- **Autonomy to *produce*** — low risk. Worst case is wasted tokens and a draft that gets rejected.
- **Autonomy to *publish*** — the real risk. Brand damage is not recoverable the way a bad draft is.

Run **generation** unattended at `phase_1` for a long time: departments work all night, the founder approves every morning. **That alone delivers most of the vision.**

**Graduating phases should be evidence-driven, using M4.** `deriveFounderLearning()` already computes approval rates by kind. "Educational posts approved 14 of 15 times over six weeks" is the argument for `phase_2` — the same discipline this system applies everywhere else, now applied to the founder's own trust. Never graduate on a hunch.

## 10. What actually runs overnight

The five `pintag-studio/.github/workflows/*.yml` files (`trend-scan`, `competitor-scan`, `daily-content-pipeline`, `publish-queue`, `weekly-analytics-report`) were written for exactly this and **never ran** — GitHub only reads the true repo-root `.github/workflows/`. They're a reasonable description of the intended cycle.

Split departments by rhythm:

| Kind | Departments | Cadence | Risk |
|---|---|---|---|
| **Observers** | Trend Hunter, Competitor Watch, Analytics, Pintag business-data research | hourly / continuous | Low — they only write observations |
| **Producers** | Strategist → Researcher → Writer / Designer / Video → Brand Guardian | once per cycle | High — expensive, gated |
| **Reporter** | Morning Brief | last, after the cycle | None |

**Departments collaborate by enqueueing work for each other**, not by one script calling them in order. Research finishing inserts a Strategy job; Strategy inserts Content jobs. That is what makes it an organization rather than a pipeline, and it's what lets M4's Analytics→learning loop close without a rewrite.

### A decision autonomy will force

There are currently **two overlapping orchestrations**: `pipeline/run.ts` (stages 00–10, the daily content pipeline) and `pipeline/services/campaign/generate.ts` (the M2/M3 campaign orchestrator). Scheduling requires picking one canonical work cycle.

**Recommendation:** make the campaign orchestrator canonical — M3/M4/M5 investment (scoring, research caching, parallel departments, incremental regeneration, language strategy, learning) all lives there — and reduce `run.ts`'s stages to department entry points the queue calls.

## 11. Rails that must precede the first unattended run

- **Idempotency.** A scheduler that retries must not produce three campaigns for one opportunity. Needs a natural key per run: `(org, department, cycle_date)`, unique.
- **Circuit breaker.** N consecutive failures for a department → stop scheduling it and report that in the brief. Otherwise a broken agent quietly burns budget every night.
- **Failure is a first-class brief item.** A failed run currently logs to stdout that nobody reads. Unattended work must surface its own failures, or **"quiet morning" becomes indistinguishable from "everything is broken."**
- **Spend visibility.** The brief should say what last night cost, from day one.
- **A kill switch that's already there.** `founder_mode: vacation` / `manual` — make sure the scheduler actually honors them.

## 12. Departments need to be able to ask the CEO things

The CEO wants to "answer questions from the AI organization." Nothing today lets a department raise a question and wait for an answer.

The mechanism exists in embryo: `proposeSuggestion()` → `knowledge-suggestions/` → founder approves or rejects, with reasons. That generalizes into a **CEO decision queue** — any department enqueues a question with context and options; the brief surfaces them; the answer feeds M4. Build on that rather than inventing a parallel concept.

## 13. Sequence

| Step | What | Why now |
|---|---|---|
| **1** | **Run ledger** (`pipeline_runs`) | Replaces in-memory state. Useful immediately, no autonomy yet |
| **2** | **Budget enforcement** (per-run, per-day) | Hard gate before anything unattended spends money |
| **3** | **Morning Brief becomes a reporter** over the ledger | Still founder-triggered — but now reports *history*, so the autonomous product becomes visible |
| **4** | **Knowledge into Postgres** | Unblocks workers, containers, second business, durable learning |
| **5** | **Schedule the observers only** | Cheap, idempotent, zero approval risk. First real autonomy, lowest stakes |
| **6** | **Schedule the producers at `phase_1`** | Departments work overnight; founder approves everything. **This is the morning the CEO described** |
| **7** | **Graduate to `phase_2`** per content type | Using M4's approval track record as the evidence |

Steps 1–3 deliver the visible product change and need **no new infrastructure**. Step 6 is the milestone; steps 1–5 are what make it safe rather than merely exciting.

## 14. What should never be automated

Already encoded in this repo's rules, and autonomy should make these gates *more* visible, not quietly erode them:

- **Foreign land-ownership claims** require explicit founder/counsel sign-off (`CLAUDE.md` hard rule, `knowledge-base/guides/foreign-ownership-rules.md`).
- **`market_updates`** are `eligible_from_phase: "never"`.
- **Any claim not traceable** to `knowledge-base/` or the listings feed. Autonomy raises the stakes on this, it doesn't relax it.

An organization that knows what it must ask about is more trustworthy than one that decides everything.
