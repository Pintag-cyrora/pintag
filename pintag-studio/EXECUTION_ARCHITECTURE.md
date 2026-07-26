# Execution Architecture — where Marketing OS pipelines actually run

**Status:** Phase 1 shipped (deployed Founder Workspace, `SETUP.md` §10). Phase 2 is a proposal — nothing below the "Recommendation" section is built.

**The question this document answers:** every department (Morning, Research, Content, Video, Analytics, Publisher) should be triggerable from the web UI on any device, without a local `npm` command. What should execute them?

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
