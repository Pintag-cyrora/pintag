# Pintag Marketing AI — Architecture & Roadmap (v2.2, approved)

*This is the canonical, version-controlled copy of the approved architecture. Read this before touching anything else in this directory — it explains why the folders below are shaped the way they are.*

## Context

Pintag (pintag.io) is a solo-founder, flat static HTML site backed by Supabase (Postgres + Auth + Storage + Deno Edge Functions), with Google Gemini already wired into two admin-only edge functions (`generate-listing-content`, `smart-listing-importer`) for trilingual listing copy.

The founder (Keomany) wants an internal, Claude-Code-driven "AI marketing department" that researches, writes, designs, produces video, schedules, publishes, and analyzes content continuously against Year-1 targets (300 educational posts, 200 neighborhood guides, 150 market updates, 500 property videos, daily cadence, one consistent brand voice), under $100/month, publishing to Facebook + Instagram first (TikTok in a later phase), with a new isolated Supabase project.

**v1** established: a separate `pintag-studio` repo, a git-based folder structure, 8 AI employees, an 8-stage content pipeline, a markdown knowledge base, a bootstrapped tech stack (Claude Code + FFmpeg + Canva + Meta Graph API + Supabase + GitHub Actions), and multi-tenant-ready design principles.

**v2** incorporated ten founder refinements, all in service of one stated goal: *reduce founder workload while continuously improving content quality and brand consistency.* The biggest shift: **the founder never manages this system through git or markdown.** A Dashboard is the daily interface; git is the engine room and permanent archive; Supabase is the live operational "control plane."

**v2.1 is frozen.** Architectural changes are out of scope unless implementation exposes a genuine limitation — the working assumption from here forward is "can this be done with what already exists," not "what else could we add."

**v2.2** adds one explicitly-justified extension on top of the frozen v2.1 base: the **Knowledge Layer** (§5A) — a lifecycle-managed, retrievable, agent-writable fourth Archive-plane component, distinct from the existing curated `knowledge-base/`. Everything else in this document is unchanged and still frozen on the same terms as v2.1.

---

## 1. System Architecture

Separate private repo **`pintag-studio`**, new isolated Supabase project, one read-only listings-feed edge function added to the main `pintag` repo as the sole hybrid touchpoint (`supabase/functions/public-listings-feed` in the main repo).

Three planes:

| Plane | What lives there | Who touches it |
|---|---|---|
| **Archive plane** (git) | `content-vault/`, `brain/`, `knowledge-base/`, `brand-assets/`, agent definitions, pipeline code | AI employees (read/write), founder rarely — only `brain/ceo.md` |
| **Control plane** (Supabase Postgres) | Content calendar, approval queue, quality scores, performance metrics, campaigns, Memory/embeddings index, `org_settings` | AI employees and the Dashboard (read/write) |
| **Interface plane** (Dashboard) | The founder's daily homepage | Founder only |

The founder should never need to open the repo. Every "what needs my attention" question is answered by the Dashboard — including whether the department itself is functioning. A dedicated **Department Health** widget shows one row per AI employee (🟢 healthy / 🟡 degraded / 🔴 down / ⚪ not yet run), backed by a control-plane `agent_health` table that each pipeline stage upserts on every run (`pipeline/lib/health.ts`). This is additive to the existing three-plane design, not a new plane: it's one more control-plane table and one more Dashboard card, following the same "AI employees write, Dashboard reads" pattern as everything else.

**Implementation note (post-freeze):** the tooling available in this session is scoped to the `pintag-cyrora/pintag` GitHub repository only. `pintag-studio/` is therefore scaffolded as a top-level directory inside that same repo rather than a second GitHub repository. It deliberately shares no code or dependencies with the main site (own `package.json`, own folder tree) so it can be extracted into its own repository later (e.g. `git subtree split`) with no rework — the separation is logical, not yet physical.

---

## 2. Folder Structure

```
pintag-studio/
├── ARCHITECTURE.md                  # this file
├── CLAUDE.md
├── SETUP.md                         # manual steps: Supabase project, Meta app, Canva, TTS
├── package.json / tsconfig.json
├── .claude/
│   ├── settings.json
│   └── agents/                      # each AI "employee" = one subagent definition
│       ├── cmo.md
│       ├── content-strategist.md
│       ├── researcher.md
│       ├── writer.md
│       ├── graphic-designer.md
│       ├── video-producer.md
│       ├── brand-guardian.md
│       ├── trend-hunter.md
│       ├── competitor-watch.md
│       ├── publisher.md
│       └── marketing-analyst.md
│
├── brain/
│   ├── ceo.md                       # read first, by every agent, every run
│   ├── mission.md                   # stable Year-1 targets/KPIs
│   ├── brand-voice.md
│   ├── style-guide.md
│   ├── posting-rules.md
│   ├── content-pillars.md
│   └── org-config.json              # static structural config — see Section 10
│
├── knowledge-base/                  # company/market/neighborhoods/guides
├── knowledge/                       # Knowledge Layer — lifecycle-managed, retrievable, agent-writable (§5A)
├── brand-assets/                    # logo/fonts/colors/canva-templates/voice
├── templates/                       # structural templates per content type
├── generated-content/               # staging, pre-Guardian / pre-approval
├── content-vault/                   # permanent archive — nothing ever deleted
│   ├── educational-posts/ ├── neighborhood-guides/ ├── market-updates/
│   ├── property-videos/   ├── carousel-graphics/   ├── checklists/
│   └── buying-guides/ / selling-guides/ / investor-guides/ / faqs/
│
├── video/                           # ffmpeg-templates/, music/, voiceover-cache/
│
├── pipeline/
│   ├── stages/
│   │   ├── 00-sense.ts              # Trend Hunter + Competitor Watch, continuous
│   │   ├── 01-plan.ts               # Memory dedupe check before briefing
│   │   ├── 02-research.ts
│   │   ├── 03-write.ts
│   │   ├── 04-design.ts
│   │   ├── 05-video.ts
│   │   ├── 06-guardian-review.ts    # scoring + auto-revise loop
│   │   ├── 07-schedule.ts
│   │   ├── 08-publish.ts            # phase- and mode-aware
│   │   ├── 09-analyze.ts
│   │   └── 10-memory-update.ts
│   ├── lib/                         # config.ts, supabase.ts, types.ts, health.ts, knowledge.ts
│   └── run.ts                       # CLI entry, invoked headlessly by GitHub Actions
│
├── dashboard/
│   └── index.html                   # the founder's daily homepage
│
├── supabase/
│   ├── migrations/                  # control-plane schema
│   └── functions/
│
└── .github/workflows/
    ├── daily-content-pipeline.yml
    ├── trend-scan.yml
    ├── competitor-scan.yml
    ├── publish-queue.yml
    └── weekly-analytics-report.yml
```

---

## 3. AI Employee Design (11 employees)

Planning hierarchy: **Annual goals → Monthly strategy (CMO) → Weekly planning (Content Strategist) → Daily execution.**

Full purpose/responsibilities/inputs/outputs/dependencies/future-improvements for every employee live in their own `.claude/agents/*.md` file — that file is both the technical subagent config and the human-readable job description, kept as one source of truth. Roster: **CMO, Content Strategist, Researcher, Writer, Graphic Designer, Video Producer, Brand Guardian, Trend Hunter, Competitor Watch, Publisher, Marketing Analyst.**

---

## 4. Content Pipeline

```
0. Sense (Trend Hunter + Competitor Watch — continuous, feeds Planning)
        ↓
1. Plan (Memory dedupe check: new / update / repurpose)  →  2. Research
        ↓
3. Write  →  4. Design  →  5. Video (as applicable)
        ↓
6. Brand Guardian Review & Score  ──(fail)──▶  back to 3/4/5 with revision notes (bounded retries)
        ↓ (pass)
7. Schedule
        ↓
8. Publish  ──phase/mode-aware──▶  auto-publish  OR  Dashboard approval queue → founder approves → publish
        ↓
9. Analyze
        ↓
10. Memory Update (embeddings + performance outcome written back)
```

The founder's **only** touchpoint anywhere in this pipeline is the Dashboard's approval queue.

---

## 5. Knowledge Base, Memory & the Content Vault

**`brain/ceo.md`** — read first, every run, by every agent: founder vision, current priorities, active campaigns, strategic direction, non-negotiable principles. Founder-maintained prose, not config.

**Static knowledge base** (`knowledge-base/`) — brand voice, audience, Laos real estate, neighborhoods, guides, FAQs, visual identity. Curated, human-authored, slowly changing.

**Content Vault** (`content-vault/`) — permanent, append-only home for every piece of content ever produced. Nothing is deleted; superseded content is marked `superseded_by`. Treated as long-term IP.

**Memory layer** — Supabase **pgvector** index over every Vault item, plus `performance_metrics` and `campaigns`. Before the Content Strategist drafts a new brief, it runs a similarity search; a close match becomes a candidate for **update** or **repurpose** instead of a duplicate. Lineage tracked via `derived_from` / `repurposed_into`.

---

## 5A. Knowledge Layer *(approved post-freeze extension)*

**This section extends the frozen v2.1 architecture.** It's called out explicitly, per `CLAUDE.md`'s instruction to only extend the frozen docs "if implementation genuinely can't proceed without a new concept, and say so explicitly." The concept it adds: none of `brain/`, `knowledge-base/`, or the Memory layer above has a *lifecycle* (draft vs. reviewed) or a *retrieval API* — every stage reads a hardcoded set of whole files. The founder's stated long-term goal — Marketing OS as a shared intelligence layer that will eventually power more than one tenant app (Pintag today; Houluebor, Mamieii, Tien as future products) — genuinely needs both, and neither fits cleanly into the three existing Archive-plane folders without conflating "curated company facts" with "continuously accumulating, reviewable knowledge."

**`knowledge/`** — a fourth Archive-plane component, git-native like the other three (same "logical not yet physical separation" precedent as `pintag-studio/` itself, §1). Structured by category (`language/`, `culture/`, `psychology/`, `marketing/`, `research/`, `prompts/`, `industries/<vertical>/`, `brands/<tenant>/`) rather than by content type, because its job is cross-cutting: the same Lao-terminology or objection-handling entry is relevant to every content type, not scoped to one.

Every entry is a markdown file with a frontmatter lifecycle: `status` (`draft → verified → expert_reviewed`, or `deprecated`), `confidence`, structured `source`, `contributedBy` (provenance), and `relatedIds` (lineage, same idea as `derived_from`/`repurposed_into` above). Nothing enters above `draft` automatically — promotion is a deliberate review step, matching the zero-tolerance-on-unverified-claims principle already enforced for published content (`DEPARTMENT.md` §12 Tier 2).

**Retrieval and capture** go through one small library, `pipeline/lib/knowledge.ts` — `retrieveKnowledge()` and `proposeKnowledgeEntry()` — deliberately agent-agnostic so any current or future employee can call the same two functions. Today this is a tag/category-filtered file scan; the functions are shaped so a future Supabase pgvector store (following the same `org_id text not null default 'pintag'` pattern every control-plane table already uses) can replace the internals without changing a single call site — the same "stub now, TODO(M2) marks the real thing" pattern already used for Memory-layer dedupe (`findSimilarByTitle()` in `pipeline/stages/01-plan.ts`).

**Current scope: proof-of-concept only.** Stage 02 (Research) is the sole integration point — it retrieves `verified`+ entries to enrich its prompt, and converts every `knowledgeGaps` entry it would otherwise only log into a structured `draft` entry under `knowledge/research/`. No other stage is wired in yet; doing so is calling the same two functions from a new call site, not a redesign. Full schema, category guide, and future upgrade path: `knowledge/README.md`.

**Relationship to `brain/lao/`:** `brain/lao/` (Keomany's hand-built Lao real estate dictionary/language corpus, established the same week as this section) is treated as the seed of this layer's future Language module, not a competing system. `retrieveKnowledge()` reads it via a source adapter (`pipeline/lib/knowledge-sources/lao-brain.ts`) and merges its entries transparently into `category: 'language'` results alongside `knowledge/language/` — callers never see which directory an entry came from, and `brain/lao/` itself is untouched (read-only from this layer, `proposeKnowledgeEntry()` never writes there). A controlled migration is a deliberate future step once this layer's schema has proven itself, not done now. Full detail: `knowledge/README.md` → "Relationship to `brain/lao/`".

---

## 6. Technology Recommendations

| Concern | Choice | Why |
|---|---|---|
| Agent runtime | Claude Code, headless (`claude -p`) mode, one subagent per employee | Already the tool in use; rides on existing plan/API usage. |
| Research grounding | Claude Code WebSearch/WebFetch + the read-only Pintag listings feed | No extra service. |
| Graphic design | Canva Connect API via Brand Templates | Already available; structurally enforces visual consistency. |
| Raw image gen (fallback) | Gemini image generation | Matches existing integration pattern in the main repo. |
| Video assembly | FFmpeg | Zero marginal cost; the only realistic path to 500 videos/year under budget. |
| Voiceover / TTS | Google Cloud TTS free tier by default | $0 at this volume; upgrade path to a signature paid voice later. |
| Memory / dedupe index | Supabase pgvector | First-class Postgres extension, no new service. |
| Dashboard | Static HTML + Supabase JS client (see Section 1 note + `dashboard/index.html`) | Matches the main repo's existing pattern; zero new deploy tooling; $0. |
| Database | New, separate Supabase project | Isolation from the production project's security surface. |
| Scheduling/cron | GitHub Actions scheduled workflows | Free at this volume. |
| Publishing | Meta Graph API directly (Facebook Pages API + Instagram Graph API) | Free; avoids paid scheduler subscriptions. |
| Trend/Competitor sourcing | RSS + scheduled web search + curated public-page fetches | Free; commercial social-listening tooling is honestly out of budget for now. |

---

## 7. Content Quality Score

8 dimensions, computed by Brand Guardian: **Educational Value (weighted highest), Trustworthiness, Brand Voice, Originality, Visual Quality, Shareability, Promotion Level, Confidence.** Any dimension below its threshold (`brain/org-config.json`) triggers automatic revision — bounded by `max_revision_cycles` — before the item ever reaches the founder or auto-publishes. Composite Confidence is what the Dashboard surfaces and what the Approval Autonomy Model keys off.

---

## 8. Monthly Strategy Layer

```
Annual goals (brain/mission.md)
      ↓
Monthly strategy (CMO — themes, campaigns, quota allocation)
      ↓
Weekly planning (Content Strategist — Memory-checked slate)
      ↓
Daily execution (Research → Write → Design/Video → Guardian → Publish)
```

The founder's one clean intervention point: edit `brain/ceo.md` and/or approve the CMO's monthly brief on the Dashboard.

---

## 9. Approval & Autonomy Model

- **Phase 1:** founder approves every item, regardless of type or confidence.
- **Phase 2:** routine educational posts and templated property videos auto-publish above a per-type confidence threshold (`brain/org-config.json`); everything else queues.
- **Phase 3:** founder reviews only market updates, major announcements, new formats, and low-confidence items.

Phase and thresholds are Dashboard-visible and Dashboard-adjustable per content type.

---

## 10. Founder Mode

Single flag (`normal | busy | campaign | vacation | manual`) implemented as **named config presets merged over base config**, not branching logic. Structural defaults live in `brain/org-config.json`; the *currently active* mode is runtime state in Supabase (`org_settings` table), because a Dashboard click needs database latency, not a git commit.

| Mode | Behavior | Reads it |
|---|---|---|
| 🟢 Normal | Follows current Approval Phase as-is | baseline |
| 🟡 Busy | Auto-publish bar lowers for low-risk types only; notifications reduced; new/experimental ideas deprioritized | Publisher, Content Strategist, Dashboard |
| 🔵 Campaign | Monthly strategy pins to one active campaign; campaign content up-weighted | CMO, Content Strategist, Dashboard |
| 🟣 Vacation | No new strategy initiated; already-approved content keeps publishing; notifications drop to exceptions only | CMO, Content Strategist, Publisher, Dashboard |
| 🔴 Manual | Hard override — nothing publishes without explicit approval, regardless of anything else | Publisher |

Precedence: **Manual > (Busy / Campaign / Vacation) > Normal-follows-Approval-Phase.**

**Implementation note (post-freeze):** `brain/org-config.json` holds the five mode *definitions* (structural, reviewed like code). The Supabase `org_settings` table holds which mode is *currently active*, plus `approval_phase` and `pinned_campaign_id` — this is what the Dashboard's one-click switcher actually writes to. `pipeline/lib/config.ts` merges the two into one `RuntimeConfig` every stage reads from.

---

## 11. Development Roadmap

Each milestone ships something usable.

- **M0 — Foundation + Dashboard + Schema (current milestone):** repo scaffold, `brain/`/`knowledge-base/` seed docs, full control-plane Supabase schema (calendar, approvals, scores, memory/embeddings, campaigns, trend/competitor tables, `org_settings`), Dashboard skeleton (approval queue + weekly progress, wired to the schema but not yet live data), pipeline stage stubs with settled interfaces, CMO/Strategist/Researcher/Writer/Brand Guardian agent definitions, the read-only listings-feed edge function in the main repo. **No live Supabase project or Meta app yet — those require the founder's own accounts, see `SETUP.md`.**
- **M1 — First content type through the Guardian gate:** Educational Posts flow Research → Plan → Write → Guardian score → Dashboard approval queue → manual publish. Founder approves everything via the Dashboard. Goal: 10 posts published, brand voice proven consistent.
- **M2 — Auto-design + auto-publish + Memory:** Graphic Designer (Canva) and Publisher (Meta API) go live; Memory/pgvector dedupe check activates in Planning. Daily cadence begins for educational posts.
- **M3 — Scale content types + Trend Hunter/Competitor Watch:** Neighborhood Guides and Market Updates added. Trend Hunter and Competitor Watch come online, feeding the CMO's monthly strategy.
- **M4 — Video Producer:** FFmpeg + TTS pipeline live; property videos at volume, sourced from the listings feed.
- **M5 — Analyst + full feedback loop + Dashboard v2:** Marketing Analyst live; weekly reports feed the Strategist and Memory; Dashboard adds AI Confidence + Today's Recommendation as real (not placeholder) data.
- **M6 — Approval Phase 2:** Once Guardian's scoring has a track record, routine educational posts and templated property videos auto-publish above threshold. TikTok added as a platform.
- **M7 — Approval Phase 3 + Year-1 close-out:** Founder review narrows to market updates, major announcements, new formats, and low-confidence items. Hit Year-1 numeric targets. Prepare for "Pintag Studio" extraction (Section 12).

**Knowledge Layer track (K0+, parallel to M0–M7 — see §5A):** the Knowledge Layer evolves on its own schedule, independent of the execution-pipeline milestones above, since it's cross-cutting infrastructure rather than a content-type capability.
- **K0 (current):** file-based `knowledge/`, category-scoped retrieval, Researcher-only integration (proof-of-concept).
- **K1 (future, trigger: Writer/Guardian want to call it too):** wire retrieval/capture into additional stages; no library redesign needed, per §5A.
- **K2 (future, trigger: entry volume or a second tenant app):** Supabase-backed storage (`knowledge_entries`, `org_id`-scoped) + pgvector semantic retrieval, replacing the file scan behind the same `retrieveKnowledge()`/`proposeKnowledgeEntry()` signatures.
- **K3 (future, trigger: a second consuming application beyond this pipeline):** an API surface over the Knowledge Layer.

---

## 12. Future Expansion ("Pintag Studio")

- **Agents as data, not code** — `.claude/agents/*.md` files; a second tenant gets new agent files and a new `knowledge-base/`, not new pipeline code.
- **Tenant config isolated to `brain/org-config.json`** — `pipeline/` code never hardcodes "Vientiane"/"Laos"/"Pintag".
- **Pipeline stages are independent and composable** — individual capabilities can be lifted out and reused/sold independently later.
- **Content Vault is a portable archive** — plain files + metadata, not a proprietary CMS schema.
- **Supabase schema namespaced from day one** — `org_id` on every table, even with a single tenant today.
- **Dashboard built with the same discipline** — no hardcoded "Pintag"/"Keomany" strings; founder/org identity pulled from config, so a second tenant gets their own dashboard instance from the same codebase.
