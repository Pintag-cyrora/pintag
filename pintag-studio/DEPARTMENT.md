# Pintag Marketing Department — Operations Manual

*This is the department-level view: why it exists, how it's organized, and how success is measured. For system architecture (planes, tech stack, pipeline shape), see [`ARCHITECTURE.md`](./ARCHITECTURE.md). For any single employee's full job description, see its file in [`.claude/agents/`](./.claude/agents/) — that file is the one source of truth for that employee's Purpose, Responsibilities, Inputs, Outputs, Handoff, and KPIs. This document only holds what doesn't belong inside any single agent's file.*

---

## 1. North Star

**Pintag becomes the most trusted real estate brand in Laos.**

That is the purpose the department exists to serve — not the volume of content it produces. Content is the instrument; trust is the goal. Every number in this document (300 educational posts, 200 neighborhood guides, 150 market updates, 500 property videos) measures whether the instrument is being played consistently. None of them measure whether the goal is being reached.

This ordering has a direct consequence: whenever a choice would trade trust for output — publishing something unverified to hit a cadence target, letting a promotional line slip past Brand Guardian to make a deadline, repeating a claim that hasn't been re-checked against current facts — **trust wins, every time, no exceptions.**

This isn't a new rule invented for this document. It's why `brain/ceo.md` already states that educational value outranks promotional language as a non-negotiable principle, and it's why Brand Guardian's revision loop exists as a structural gate rather than an optional QA step. Guardian doesn't slow the department down — it protects the one thing the department is actually for.

## 2. Founder Promise

This is a **non-negotiable architectural principle**, not an aspiration: **this department exists to buy back the founder's time.**

Keomany's role in this system is:
- **Strategic direction** — maintained through `brain/ceo.md`, read by every agent before it does anything else.
- **Major campaign approval** — the CMO proposes, the founder signs off, via Founder Mode's Campaign setting.
- **Analytics review** — the Dashboard and the Marketing Analyst's reports, read at the founder's own pace.
- **Maintaining the Brand Brain** — keeping `brain/` current as priorities shift.

Keomany's role is explicitly **not**:
- Daily content creation, editing, scheduling, or publishing.

This isn't left as a promise to keep — it's built into mechanisms that already exist: the <30 minute/week target in `brain/mission.md`, the Dashboard as the only founder-facing surface (never git, never markdown, never a raw draft file), the Approval Autonomy Model's explicit purpose of earning the right to remove the founder from routine decisions phase by phase, and Founder Mode's job of making the system adapt to the founder's availability instead of the other way around.

**Any future employee, feature, or workflow that adds a *routine* task back onto the founder's plate is, by this principle, a regression** — not a trade-off to weigh, a defect to fix.

## 3. Marketing Principles

Values-level principles — the mechanics that implement them already live in `brain/style-guide.md` and `brain/posting-rules.md`. Each one below is grounded in something the system already does, not left as an aspiration:

- **Educate before you promote.** Every piece must leave the reader better informed about Laos real estate, not just aware a listing exists. *Mechanism:* Educational Value is the highest-weighted Content Quality Score dimension (`brain/org-config.json`).
- **Never trade accuracy for engagement.** An eye-catching claim that isn't verifiable is a liability, not a win. *Mechanism:* Researcher's source-traceability requirement; Brand Guardian's fact cross-check against `knowledge-base/`.
- **Consistency compounds.** Showing up daily in one recognizable voice matters more than any single standout piece. *Mechanism:* the daily cadence target plus a single shared `brand-voice.md` read by every writing and design employee.
- **Trust is earned slowly and lost quickly.** One factual error or one pushy pitch does more damage than ten quiet, useful posts do good. *Mechanism:* zero-tolerance handling of legally or factually sensitive claims — e.g. `knowledge-base/guides/foreign-ownership-rules.md` requires founder/counsel sign-off before any new claim, regardless of Approval Phase.
- **Reuse and deepen rather than repeat.** Pintag's knowledge should compound, not restart every week. *Mechanism:* the Content Vault's permanence plus the Memory layer's dedupe/repurpose check before any new brief.
- **Protect the founder's time, don't spend it.** Every automation decision should reduce, not add to, what Keomany personally manages. *Mechanism:* the Founder Promise (Section 2), the Dashboard as the single interface, and the phased Approval Autonomy Model.

## 4. Mission & Year-1 Objectives

Full detail lives in `brain/mission.md`; summarized here for context. Mission: grow Pintag into the most trusted real estate brand in Laos through consistent, educational content, with minimal founder involvement. Year-1 targets: 300 educational posts, 200 neighborhood guides, 150 market updates, 500 property videos, daily posting cadence, one consistent brand voice, founder time budget under 30 minutes/week.

These targets are **output metrics that keep the department running — not the definition of success.** Section 12 (Department Success Framework) makes that distinction operational.

## 5. Architectural Principle

*"This is a marketing department, not a set of isolated AI tools. Every employee has exactly one clearly defined responsibility, and no two employees' responsibilities overlap."*

Concretely, per employee:

| Employee | The one thing only this employee does |
|---|---|
| CMO | Sets monthly strategy and is the founder's single point of contact |
| Content Strategist | Decides new vs. update vs. repurpose, and what gets scheduled this week |
| Researcher | Grounds a brief in verifiable facts |
| Writer | Produces the copy |
| Graphic Designer | Produces the static visuals |
| Video Producer | Produces the videos |
| Brand Guardian | Scores quality and is the only employee with veto power over publishing |
| Trend Hunter | Surfaces timely opportunities (never decides on them) |
| Competitor Watch | Surfaces market gaps (never imitates) |
| Publisher | Decides publish timing and channel, and executes it |
| Marketing Analyst | Measures what happened and feeds it back |

## 6. Org Chart

```
                         Founder (Keomany)
                               |
                       brain/ceo.md (priorities)
                               |
                              CMO  ◄── Trend Hunter (trend_signals)
                               |   ◄── Competitor Watch (competitor_notes)
                               |   ◄── Marketing Analyst (monthly rollup)
                       Content Strategist
                               |
                          Researcher
                               |
                            Writer
                            /    \
                Graphic Designer  Video Producer
                            \    /
                       Brand Guardian  (editorial gate — reports quality, doesn't report to Strategist)
                               |
                           Publisher
                               |
                     Marketing Analyst  (closes the loop back to CMO + Content Strategist)
```

Trend Hunter and Competitor Watch are advisory roles feeding the CMO directly (Stage 00 — Sense). They sit outside the linear execution chain and never block it.

## 7. Full Roster

| # | Employee | One-line purpose | Primary KPI | Full spec |
|---|---|---|---|---|
| 1 | CMO | Monthly strategy + founder's single point of contact | On-time monthly brief; low founder escalations | [`cmo.md`](./.claude/agents/cmo.md) |
| 2 | Content Strategist | Weekly execution planning + dedupe gate | Pacing accuracy vs. Year-1 targets | [`content-strategist.md`](./.claude/agents/content-strategist.md) |
| 3 | Researcher | Facts grounding for every brief | % of facts traceable to source | [`researcher.md`](./.claude/agents/researcher.md) |
| 4 | Writer | Copy for every content type | First-pass Guardian approval rate | [`writer.md`](./.claude/agents/writer.md) |
| 5 | Graphic Designer | On-brand static visuals | Visual Quality score (Guardian) | [`graphic-designer.md`](./.claude/agents/graphic-designer.md) |
| 6 | Video Producer | Property videos, FFmpeg-first | Videos/week vs. 500/year pace | [`video-producer.md`](./.claude/agents/video-producer.md) |
| 7 | Brand Guardian | Final editorial gate + quality scoring | Revision-cycle rate | [`brand-guardian.md`](./.claude/agents/brand-guardian.md) |
| 8 | Trend Hunter | Proactive opportunity discovery | Signal-to-action ratio | [`trend-hunter.md`](./.claude/agents/trend-hunter.md) |
| 9 | Competitor Watch | Strategic gap analysis (observe, don't copy) | Gaps actioned/month | [`competitor-watch.md`](./.claude/agents/competitor-watch.md) |
| 10 | Publisher | Scheduled publishing to Facebook/Instagram | Publish success rate | [`publisher.md`](./.claude/agents/publisher.md) |
| 11 | Marketing Analyst | Performance feedback loop | Coverage within 48h | [`marketing-analyst.md`](./.claude/agents/marketing-analyst.md) |

## 8. End-to-End Handoff Chain

| Stage | Employee | Upstream trigger | Downstream handoff |
|---|---|---|---|
| 00 — Sense | Trend Hunter, Competitor Watch | Own schedules (`trend-scan.yml`, `competitor-scan.yml`) | `trend_signals` / `competitor_notes` → CMO (monthly), Content Strategist (weekly reactive) |
| Monthly (no stage file — own cadence, not the daily pipeline) | CMO | `brain/ceo.md` + `mission.md` + Stage 00 feeds + Analyst rollup | Monthly strategy doc + `campaigns` row → Content Strategist |
| 01 — Plan | Content Strategist | Monthly brief + Memory dedupe check (`findSimilarExistingContent`) | `content_items` row (`status=draft`, tagged new/update/repurpose) → Stage 02 |
| 02 — Research | Researcher | `content_items(draft)` | Research packet attached → Stage 03 |
| 03 — Write | Writer | Brief + research packet, or a Guardian `revise` verdict with notes | `draft.md`, `content_items(status=in_review)` → Stages 04 & 05 (parallel) → Stage 06 |
| 04 — Design | Graphic Designer | `draft.md` (`in_review`); skipped for `property_video` | Image assets → Stage 06 |
| 05 — Video | Video Producer | Approved script + `listing_id` (`property_video` only) | `render.mp4` + `metadata.json` → Stage 06 |
| 06 — Guardian Review | Brand Guardian | `content_items(in_review)` | `quality_scores` row + verdict — **pass** → Stage 07; **revise** → `content_items(status=revising)`, back to Stage 03/04/05, bounded by `max_revision_cycles` |
| 07 — Schedule | Content Strategist / CMO | Guardian pass | `content_calendar` row (`publish_status=queued`) → Stage 08 |
| 08 — Publish | Publisher | `content_calendar(queued)` at `scheduled_at`, or `approvals_queue.decision=approved` | `content_calendar(publish_status=published)`, `post_id` → Stage 09 |
| 09 — Analyze | Marketing Analyst | `content_calendar(published)`, ~48h delay | `performance_metrics` rows + `analytics/reports/{week}.md` → Stage 01 (next cycle), Stage 06 (future threshold tuning), CMO (monthly rollup) |
| 10 — Memory Update | (infra step, not a named employee) | Finished `content_items` row | `content_items.embedding` written → feeds Stage 01's dedupe check |

**Note:** `content_items.status` has a `revising` value in the schema (`0001_init_control_plane.sql`) — this table is the first place that's made explicit as the correct transition on a Guardian `revise` verdict. M1 should set it accordingly.

## 9. Approval Workflow

This section is a *reading guide* to what's already implemented in `brain/org-config.json` and `pipeline/lib/config.ts` — not new policy.

**The three phases** (`org-config.json` → `approval_phase_notes`):
- **Phase 1:** founder approves every item via the Dashboard queue, regardless of content type or confidence.
- **Phase 2:** content types listed in `auto_publish_eligible` auto-publish once Guardian's confidence exceeds their threshold. Everything else queues.
- **Phase 3:** only market updates, major announcements, new content formats, and low-confidence items reach the founder.

**Auto-publish eligibility** (`org-config.json` → `auto_publish_eligible`, exact current values):

| Content type | Min. confidence | Eligible from phase |
|---|---|---|
| Educational posts | 0.90 | Phase 2 |
| Property videos | 0.90 | Phase 2 |
| Neighborhood guides | 0.92 | Phase 3 |
| Market updates | — | Never (always founder-reviewed) |

**Founder Mode precedence** (`shouldAutoPublish()` in `pipeline/lib/config.ts`): **Manual > (Busy / Campaign / Vacation) > Normal-follows-phase.** Manual mode always forces hold-for-approval, regardless of confidence or phase.

**The actual runtime path:** Guardian pass (Stage 06) → Publisher's `shouldAutoPublish()` check (Stage 08) → **true:** publish directly → **false:** insert an `approvals_queue` row with a `reason` → founder sees it on the Dashboard queue → decision → (approved) `publishApprovedItem()`.

## 10. Knowledge Source Matrix

Who reads what, drawn from each agent file's `## Inputs` section:

| Employee | `ceo.md` | `mission.md` | `brand-voice.md` | `style-guide.md` | `posting-rules.md` | `content-pillars.md` | `org-config.json` | Knowledge base | Listings feed | `brand-assets/` | Memory (Vault/metrics/signals) | Knowledge Layer (`knowledge/`) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CMO | ✓ | ✓ | | | | | ✓ | | | | ✓ (trend_signals, competitor_notes, analyst reports) | — not yet wired |
| Content Strategist | | | | | | ✓ | ✓ | ✓ | | | ✓ (dedupe check, trend_signals) | — not yet wired |
| Researcher | | | | | | | | ✓ | ✓ | | | ✓ read (retrieve) + write (capture knowledge gaps) |
| Writer | | | ✓ | ✓ | | | | | | | | — not yet wired |
| Graphic Designer | | | | | | | | | | ✓ | | — not yet wired |
| Video Producer | | | | | | | | | ✓ | ✓ | | — not yet wired |
| Brand Guardian | | | ✓ | | ✓ | | ✓ | ✓ | | | ✓ (repetition check) | — not yet wired |
| Trend Hunter | | | | | | | | | | | (external: RSS, web search) | — not yet wired |
| Competitor Watch | | | | | | | ✓ (watchlist) | | | | (external: public pages) | — not yet wired |
| Publisher | | | | | | | ✓ | | | | | — not yet wired |
| Marketing Analyst | | | | | | | | | | | ✓ (writes performance_metrics) | — not yet wired |

**Knowledge Layer column, added with `ARCHITECTURE.md` §5A:** Researcher is the only employee integrated today — a deliberate proof-of-concept scope, not a ceiling. "Not yet wired" means the capability exists (`retrieveKnowledge()`/`proposeKnowledgeEntry()` in `pipeline/lib/knowledge.ts` are generic, agent-agnostic functions any employee can call) but no call site has been added for that employee yet. See `knowledge/README.md` → "Where this plugs in today."

**Gap flagged, not fixed now:** Researcher today reads the listings feed and knowledge base but not Memory directly — it could check "has this exact fact already been researched" before re-deriving it. Noted as a future-improvement candidate in `researcher.md`, not changed as part of this document.

## 11. Shared Brand Memory (the Memory layer contract)

Formalizes what's implicit in `ARCHITECTURE.md` Section 5 into an explicit write/read contract.

**What's stored:** Vault item embeddings and lineage (`content_items.embedding`, `derived_from`, `repurposed_into`), performance outcomes (`performance_metrics`), campaign state (`campaigns`), trend and competitor signals (`trend_signals`, `competitor_notes`).

**Write contract:**
- Content Strategist creates draft `content_items` rows.
- Writer, Graphic Designer, and Video Producer attach assets.
- Stage 10 (Memory Update) writes embeddings.
- Marketing Analyst writes `performance_metrics`.
- CMO / Content Strategist write `campaigns`.
- Trend Hunter and Competitor Watch write their own tables.

**Read contract:**
- Content Strategist reads embeddings (dedupe/repurpose check) and `performance_metrics` (what worked).
- Brand Guardian reads embeddings (repetition check).
- CMO reads `trend_signals`, `competitor_notes`, and performance rollups for monthly strategy.

**Permanence guarantee:** nothing in the Content Vault or `content_items` is ever deleted. Superseded content gets `superseded_by`, never removed. This is what lets the department accumulate institutional memory instead of eleven employees each starting from zero every time.

## 12. Department Success Framework

Closes the loop back to the North Star. Three tiers, deliberately separating "the department is running" from "the department is building trust" so the Year-1 output targets are never mistaken for the goal itself.

**Tier 1 — Operational Health** *(is the department running?)*
- Department Health uptime per employee (`agent_health` — already implemented).
- Posting-cadence consistency against `brain/mission.md`'s daily target.
- Brand Guardian revision-cycle rate.

Necessary, not sufficient. A department that publishes on schedule but erodes trust has failed regardless of this tier.

**Tier 2 — Content Integrity** *(is what we publish trustworthy?)*
- Average `quality_scores.trustworthiness` and `.educational_value` on published content.
- Zero tolerance: no sensitive claim (e.g. foreign-ownership content) reaches publish without founder/counsel sign-off, regardless of Approval Phase.
- Zero uncorrected factual errors.

This tier has **veto power** over the other two. No volume or engagement number justifies a Tier 2 failure.

**Tier 3 — Brand Trust** *(is the market actually trusting Pintag more?)*

The real goal, measured honestly with the proxies available at this budget rather than pretending to measure something the current tooling can't:
- **Engagement quality** — comments and shares relative to reach, weighted above raw impressions. Vanity reach isn't trust.
- **Content longevity / reuse rate** — a piece from the Content Vault still being referenced or repurposed months later is a stronger trust signal than one forgotten in a day.
- **Leads attributable to content** — the strongest available signal, once the Marketing Analyst correlates published content against the main site's existing `lead_events` tracking. This is a genuine business-outcome tie, not a social-media vanity metric — and it's a capability to build once M5 lands, not something to fake now.

Direct brand-trust measurement (recall surveys, sentiment panels) is out of reach at this budget. That's named plainly as a future upgrade, not approximated with something misleading.

**Bottom line:** the Year-1 numeric targets (300 / 200 / 150 / 500) measure Tier 1. They are the floor, not the finish line. **The department has succeeded only if Tier 2 holds at zero violations and Tier 3 is moving in the right direction.**
