# Intelligence Department — Playbook

*This is the specification the Intelligence Department's software is built from — not a description of it after the fact. Every section below is either true today (and says so plainly) or is explicitly marked as not yet built. See `../_TEMPLATE.md` for how every future department playbook should be structured, and `../../DEPARTMENTS.md` for the Department-Driven Development methodology this playbook is the first real instance of.*

---

## 1. Mission

The Intelligence Department owns and grows Marketing OS's actual proprietary asset: verified, structured, permanent knowledge about the Lao language, Lao culture, Lao consumers, and every industry Marketing OS operates in.

The business problem it solves: without it, every workflow — every research pass, every draft, every review — starts from zero and throws away whatever it learned the moment it finishes. `FOUNDING_PRINCIPLES.md` states the reasoning this department exists to serve: *software is temporary, intelligence is permanent* — this department is the concrete mechanism that makes that true rather than aspirational.

## 2. Customer

**Every department.** Unlike a department in the linear Research → Strategy → Creation → Distribution → Performance → Learning chain, Intelligence isn't one step that hands off to the next — it's the shared substrate every other department reads from before it acts and should write back to after it acts. Today, in practice, it has exactly one real customer: the Research department (via the Researcher agent, Stage 02). Every other department is a customer in waiting, not yet integrated (see §13, §16).

## 3. Vision

World-class looks like this: no agent in Marketing OS ever re-derives a fact, a phrase, or a pattern that's already been verified once. Every workflow, across every current and future brand, retrieves relevant knowledge before it generates anything and leaves behind something reusable after it finishes — automatically, not as an afterthought a human has to remember to trigger. The system is source-transparent (callers never know or care whether an entry lives in `knowledge/`, `brain/lao/`, or a future Postgres store) and the Lao-language and Lao-market portion of that knowledge (Phase 3 of `MARKETING_OS_ROADMAP.md`) becomes deep enough that no competitor could plausibly rebuild it quickly.

## 4. Responsibilities

**Owns:**
- `knowledge/` — the lifecycle-managed knowledge store (`draft → verified → expert_reviewed`, or `deprecated`).
- The retrieval/capture API: `retrieveKnowledge()` and `proposeKnowledgeEntry()` (`pipeline/lib/knowledge.ts`).
- Read access to `brain/lao/` via a source adapter (`pipeline/lib/knowledge-sources/lao-brain.ts`) — merged transparently into retrieval, per the Phase 1 reconciliation decision recorded in `knowledge/README.md`.
- The category taxonomy (language, culture, psychology, marketing, research, prompts, industries/`<vertical>`, brands/`<tenant>`) and the entry lifecycle/review model.

**Explicitly NOT responsible for:**
- Generating content itself — that's Creation's job; Intelligence supplies what Creation grounds itself in, nothing more.
- Deciding *what* to research or prioritize — that's Research's and Strategy's job.
- Granting legal or foreign-ownership sign-off. Intelligence can store a `Legal Verification: Pending` status on an entry (as `brain/lao/dictionary.md` already does) but cannot itself confer verification — that still requires founder/counsel per `CLAUDE.md`'s foreign-ownership rule, regardless of what status a knowledge entry carries.
- Writing to `brain/lao/` — that directory is read-only from this department's perspective during Phase 1 of the reconciliation plan; nothing here duplicates or rewrites it.

**Memory-layer boundary** (`../../MEMORY_MODEL.md`):
- **Intelligence Layer** — this department *is* it. Everything it owns (above) must stay free of customer-specific information.
- **Organizational Memory** — reads none, owns none. `brain/`, `knowledge-base/`, and `content-vault/` (Pintag's Organizational Memory today) are untouched by this department.
- **Operational Memory** — reads it (transiently) but doesn't own it. `retrieveKnowledge()` is called with a `ContentBrief` in flight (Stage 02's operational state) but this department tracks no per-workflow state of its own — it's stateless with respect to any single pipeline run.
- **Integrations** — touches none directly. No external platform call originates from this department's own code.
- **Known exception, not fixed:** `knowledge/brands/<tenant>/` is owned by this department but holds Organizational-Memory-shaped content (see `knowledge/README.md` → "Relationship to Organizational Memory"). This department's own Responsibilities list above is, strictly, slightly wrong until that's resolved — named here rather than quietly corrected, per the same "flag, don't silently fix" standard this Playbook has held to throughout.

## 5. Inputs

- Knowledge gaps flagged by the Researcher agent while grounding a content brief (`packet.knowledgeGaps`, Stage 02).
- `brain/lao/dictionary.md`'s hand-authored entries (read-only source).
- Future, not yet real: performance data from Marketing Analyst, human review decisions, trend signals from Trend Hunter/Competitor Watch.

## 6. Outputs

- Structured knowledge entries (`.md` files with frontmatter) at every lifecycle stage.
- Retrieval results consumed by whichever agent calls `retrieveKnowledge()` — today, only the Researcher's prompt-enrichment call in Stage 02.
- An Intelligence scorecard/KPI snapshot and a human-facing browse/search view — `dashboard/intelligence.html`, generated by `npm run knowledge:dashboard` (built this sprint; regenerate on demand, not live-updating).
- Knowledge Suggestions (`knowledge-suggestions/*.md`, `pipeline/lib/suggestions.ts`) — raw candidates surfaced for human review, one step earlier than a knowledge/ draft entry. Not yet real knowledge; a human must approve one before it becomes a `draft` entry in `knowledge/`.

## 7. Daily Routine

**Software exists as of the Level 2→3 sprint; real daily use is now underway as of the operational validation period (see `OPERATION_LOG.md`).** Knowledge capture happens as a side effect of `daily-content-pipeline.yml` running Stage 02. The daily routine: morning — run `npm run knowledge:review` to work through anything captured overnight (approve/reject/merge); run `npm run knowledge:dashboard` to refresh the control-center snapshot; log the day's work in `OPERATION_LOG.md` (tasks, problems, improvements, actions, knowledge created, lessons). No dedicated evening routine. Whether this routine holds up for two real consecutive weeks — not whether it's possible — is what `OPERATION_LOG.md` and `../_GRADUATION_CHECKLIST.md` exist to establish.

## 8. Weekly Routine

Not yet real. Intended once tooling exists: review knowledge growth for the week (entries added, by category and source), spot-check a sample of `draft` entries against their cited source.

## 9. Monthly Routine

Not yet real. Intended: a knowledge-coverage review against `MARKETING_OS_ROADMAP.md` Phase 3's scope (which categories are still empty scaffolding vs. have real content), feeding into the CMO's monthly strategy cycle the way `DEPARTMENT.md` §8 already describes for other inputs.

## 10. Quarterly Routine

Not yet real. Intended: review category coverage and the Intelligence Layer's roadmap position against `ARCHITECTURE.md` §11's K0–K3 track, and reassess the `brain/lao/` Phase 2 migration decision (see `brain/lao/metadata.md`'s Future Notes).

## 11. KPIs

Same metrics already named in `MARKETING_OS_ROADMAP.md`'s Company Scorecard, Intelligence column — not reinvented here:
- Verified knowledge entries (count, currently low single digits across `knowledge/` + `brain/lao/` combined).
- Draft → verified promotion rate (currently 0 — no entry has been promoted since creation; the review step is manual and hasn't been exercised yet).
- Category coverage — how many of the 8 top-level categories have real (non-seed, non-scaffold) content. Currently: 1 (`language`, via `brain/lao/dictionary.md`'s 7 real entries) has meaningful depth; the rest have at most one seed/example entry.
- Source mix — entries from `knowledge/` vs. `brain/lao/` (currently 5 vs. 7).
- Knowledge-gap capture rate — the share of Researcher-flagged gaps that become structured entries. Designed to be 100% by construction (every gap is captured automatically in Stage 02); not yet observed in a real run (§14).

## 12. Decision Authority

- **Independent:** any agent may create a `draft` entry — `proposeKnowledgeEntry()` is deliberately generic and requires no approval to write at `draft` status.
- **Requires human review:** promotion from `draft` to `verified` or `expert_reviewed`. Today this is a manual frontmatter edit; there is no review workflow or queue yet (§16).
- **Requires founder/counsel, regardless of knowledge status:** any foreign land-ownership claim or other legally sensitive content, per `CLAUDE.md`. A `verified` knowledge entry about land law is not, by itself, sufficient authorization to publish a new claim derived from it.
- **Requires a deliberate decision, not yet made:** the `brain/lao/` Phase 2 migration — see §19.

## 13. Collaboration

Today, the Researcher (Research department, once that department's playbook exists) is Intelligence's only real two-way integration: it retrieves `verified`+ entries to ground its research, and it drops a suggestion in the mailbox for every flagged gap — which only becomes a `draft` entry once a human approves it (see §17 SOP 1/1b).

Named next integrations (`ARCHITECTURE.md` §5A), none wired yet: Writer (capture better Lao/English/Chinese wording), Brand Guardian (capture objections and repetition patterns surfaced during review), Marketing Analyst (capture performance-driven learnings). The Intelligence Flywheel (`MARKETING_OS_ROADMAP.md`) describes the target shape once these exist: Marketing generated → Performance measured → Knowledge captured → Knowledge reviewed → Knowledge verified → Intelligence Layer improves → Better marketing.

## 14. AI Agents

**Current:** none dedicated. There is no agent named or scoped to "Intelligence" among the 11 defined in `.claude/agents/`. The Researcher is the only agent that calls into this department's API today, and it does so as part of its own (Research department's) job, not as an Intelligence-department employee.

**Open question, not decided here:** whether a dedicated "Knowledge Curator" agent should eventually own both queues (Suggestions and the draft→verified Review Queue, §16) — promoting drafts, flagging stale entries, maintaining the category taxonomy. Left open deliberately rather than speculatively defined.

## 15. Tools

External tools/services actually in use today, deliberately short:
- **Git / GitHub** — the only storage this department has. `knowledge/` and `brain/lao/` are both plain files in this repo; there is no database backing this department yet.
- **The configured LLM provider** (`pipeline/lib/llm.ts` — `claude-cli` or the Anthropic API) — not owned by this department, but every entry this department's API helps produce ultimately depends on it, since it's the reasoning engine behind the Researcher calls that populate `knowledge/research/`.

**Not yet adopted:** Supabase/pgvector (named as future tooling under the K2 roadmap track in `ARCHITECTURE.md` §11 — a storage upgrade, not a present-day dependency).

## 16. Required Software

This is the department's actual development backlog — reused directly from `ARCHITECTURE.md` §5A and `MARKETING_OS_ROADMAP.md` Phase 2. Three of seven items were built in the Level 2→3 sprint; the rest remain open:

1. **Continuous Knowledge Capture** — partially superseded by item 8. Writer and Brand Guardian still aren't wired to propose anything (that part is still open); Researcher's path now goes through the Suggestion System's curated gate rather than capturing directly, per the founder's explicit "curated, not autonomous" decision. Wiring more agents means calling `proposeSuggestion()`, not `proposeKnowledgeEntry()` directly, going forward.
2. **Knowledge Review Queue** — ✅ built. `pipeline/knowledge-review.ts` (`npm run knowledge:review`). Interactive: approve → `verified`, reject → `deprecated` (reason required), merge-as-duplicate → `deprecated` + `supersededBy` (canonical id required), or skip. No automatic promotion — every status change requires a reviewer name, recorded via `reviewedBy` on the entry. brain/lao/-sourced entries are shown for reference but can't be changed through this tool (see `knowledge/README.md`).
3. **Knowledge Explorer** — ✅ built. The "Explore" tab of `dashboard/intelligence.html` (search, category/status filters, related entries, source visibility, per-entry git history).
4. **Intelligence Dashboard** — ✅ built. The "Overview" tab of the same generated file (`npm run knowledge:dashboard`) — entry counts by status/category/source, pending-review count, recently approved, current Department Maturity line (parsed live from §20 below).
5. **Knowledge Relationships** — not yet built. Making `relatedIds` a navigable graph, not just a flat field.
6. **Brand Memory** — not yet built. `brands/<tenant>/` becoming a first-class, continuously updated memory read directly by Writer and Guardian, not only seeded once.
7. **Performance Learning** — not yet built. Closing the loop from `performance_metrics` back into this layer, so Marketing Analyst becomes a knowledge *writer*, not just a metrics writer.
8. **Knowledge Suggestion System (backend)** — ✅ built. `pipeline/lib/suggestions.ts`: `proposeSuggestion()` (agent-agnostic mailbox, dedupes recurring observations into a growing `occurrences` list instead of duplicate files), `approveSuggestion()` (creates a real `knowledge/` draft via the existing `proposeKnowledgeEntry()` — feeds the existing Review Queue rather than skipping it), `rejectSuggestion()` (reason required, never deletes). Storage: `knowledge-suggestions/`, deliberately outside `knowledge/` since a suggestion isn't yet knowledge. Wired to one real source: Stage 02's `knowledgeGaps` now propose a suggestion instead of a draft entry directly.
9. **Knowledge Suggestions review screen (UI)** — not yet built, deliberately deferred. The founder's own framing: build the mailbox before the mailbox door. `listPendingSuggestions()` already returns everything a review screen needs; nothing in the backend should need to change to add one.

## 17. Standard Operating Procedures

**SOP 1 — Researcher's retrieval + suggestion loop** (`pipeline/stages/02-research.ts`, **changed** — a knowledge gap no longer becomes a `knowledge/` draft directly):

```
Brief received (Stage 01 output)
        ↓
Retrieve verified+ knowledge (categories: industries/real-estate, brands/pintag, psychology, marketing, language)
        ↓
Merge into research prompt alongside knowledge-base/ reads
        ↓
LLM extracts facts + flags knowledgeGaps
        ↓
Each knowledgeGap → proposeSuggestion() → knowledge-suggestions/*.md (pending, NOT yet in knowledge/)
        ↓
research.json written → hands off to Stage 03 (Write)
```

**SOP 1b — Suggestion review (backend only — no UI yet)**, `pipeline/lib/suggestions.ts`:

```
listPendingSuggestions() — oldest first
        ↓
Human reviews what/why/where/confidence + occurrence history
        ↓
approveSuggestion() → creates a real knowledge/ draft entry (feeds SOP 2 below)
   or rejectSuggestion() (+reason, required) → rejected, file kept, nothing enters knowledge/
```

**SOP 2 — Knowledge Review (now real, no longer manual-only)**, `npm run knowledge:review`:

```
List all knowledge/-sourced draft entries (oldest first; brain/lao/ shown read-only)
        ↓
Reviewer name recorded once for the session
        ↓
Per entry: approve → verified · reject (+reason) → deprecated · merge (+canonical id) → deprecated, supersededBy · skip
        ↓
Every change writes reviewedBy/reviewNotes and rewrites the file in place — nothing is deleted
        ↓
Summary printed; founder commits the resulting diff manually (the tool never auto-commits)
```

Mechanically verified end-to-end during this sprint (create draft → list in queue → approve/reject/merge → re-`retrieveKnowledge()` confirms the promoted entry is retrievable) using disposable, clearly-labeled test entries, deleted afterward — not left as real knowledge. This proves the *software* works. It does not, by itself, satisfy the Graduation Checklist's daily-use criterion (see §19).

## 18. Intelligence Contribution

This section is necessarily a little different for this department than for any other, since Intelligence *is* the thing every other department contributes to — its own contribution is being the substrate that makes every other department's contribution mean something instead of disappearing.

Beyond that, its own meta-contributions: the category taxonomy and lifecycle schema (reusable by any future knowledge source), and the `brain/lao/` source-adapter pattern (`knowledge-sources/lao-brain.ts`) as a template for how a future source (a second hand-authored corpus, eventually Postgres) plugs in without changing any caller.

## 19. Definition of Done

Tracked against `../_GRADUATION_CHECKLIST.md`, the same checklist every department uses:

- [x] **Playbook approved.** This document.
- [x] **Required software implemented** *for the Level 2→3 sprint's scope* (Knowledge Review Queue, Explorer, Dashboard — §16). Continuous Knowledge Capture, Knowledge Relationships, Brand Memory, and Performance Learning remain open and are not required for Level 3.
- [x] **End-to-end workflow operational**, mechanically: draft created → listed in the review queue → approved/rejected/merged with a `reviewedBy` recorded → re-retrievable via `retrieveKnowledge()`. Verified this sprint with disposable test entries (deleted afterward, not left as real knowledge).
- [ ] **Used daily for at least two consecutive weeks.** Not started — this is real elapsed time, not something a build sprint can satisfy. The observation window begins the first real day `npm run knowledge:review` / `npm run knowledge:dashboard` are run as part of actual operation, not verification.
- [ ] **At least one improvement made based on real-world usage.** Can't be claimed yet — no real usage has happened.
- [ ] **KPIs actively tracked.** §11's KPIs are now *measurable* (the Dashboard computes them), but "actively tracked" means someone is actually looking at them on a cadence — not yet true.
- [ ] **Founder sign-off** that the department is ready to be relied on daily.

Additional department-specific criteria, also not yet met: verified entries across at least 4 of the 8 top-level categories (currently 1 has real depth); at least two departments beyond Research actively calling the API; a made decision (not necessarily executed) on the `brain/lao/` Phase 2 migration; Stage 02's knowledge-augmented prompt actually executing end-to-end through a real `runAgent()`/LLM/Supabase pipeline run (still only unit-verified in isolation, as of this writing).

## 20. Department Maturity

- **Level 0 — Not Defined**
- **Level 1 — Playbook Complete**
- **Level 2 — Software Exists** ← **current level**
- **Level 3 — Operated Daily**
- **Level 4 — Standardized**
- **Level 5 — Self-Improving**

**Current level: 2 — Software Exists.** As of the Level 2→3 sprint, every piece of software required now exists and its mechanism has been verified end-to-end (`knowledge.ts`, the `brain/lao` adapter, Stage 02 wiring, plus the Knowledge Review Queue and the Dashboard/Explorer). That made the department **ready to operate**, not **operated** — per `../_GRADUATION_CHECKLIST.md`, maturity is measured by operation, not implementation. The department has now entered its two-week operational validation period; `OPERATION_LOG.md` is the evidence trail that decides when — and whether, without further changes first — it actually earns Level 3. **Level stays at 2 until that log shows two real consecutive weeks of daily use, not before.**
