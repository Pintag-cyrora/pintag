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

## 5. Inputs

- Knowledge gaps flagged by the Researcher agent while grounding a content brief (`packet.knowledgeGaps`, Stage 02).
- `brain/lao/dictionary.md`'s hand-authored entries (read-only source).
- Future, not yet real: performance data from Marketing Analyst, human review decisions, trend signals from Trend Hunter/Competitor Watch.

## 6. Outputs

- Structured knowledge entries (`.md` files with frontmatter) at every lifecycle stage.
- Retrieval results consumed by whichever agent calls `retrieveKnowledge()` — today, only the Researcher's prompt-enrichment call in Stage 02.
- Not yet real: an Intelligence scorecard feed, a human-facing browse/search view (Knowledge Explorer, §16).

## 7. Daily Routine

**Honestly: there is no dedicated daily routine yet.** Knowledge capture happens only as a side effect of `daily-content-pipeline.yml` running Stage 02 — when the Research stage runs, it retrieves and (for any flagged gap) captures; there is no standalone Intelligence-department job. Once the Knowledge Review Queue (§16) exists, the intended daily routine is: morning — review new `draft` entries produced overnight; no dedicated evening routine planned yet.

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

Today, the Researcher (Research department, once that department's playbook exists) is Intelligence's only real two-way integration: it retrieves `verified`+ entries to ground its research, and it writes `draft` entries back for every flagged gap.

Named next integrations (`ARCHITECTURE.md` §5A), none wired yet: Writer (capture better Lao/English/Chinese wording), Brand Guardian (capture objections and repetition patterns surfaced during review), Marketing Analyst (capture performance-driven learnings). The Intelligence Flywheel (`MARKETING_OS_ROADMAP.md`) describes the target shape once these exist: Marketing generated → Performance measured → Knowledge captured → Knowledge reviewed → Knowledge verified → Intelligence Layer improves → Better marketing.

## 14. AI Agents

**Current:** none dedicated. There is no agent named or scoped to "Intelligence" among the 11 defined in `.claude/agents/`. The Researcher is the only agent that calls into this department's API today, and it does so as part of its own (Research department's) job, not as an Intelligence-department employee.

**Open question, not decided here:** whether a dedicated "Knowledge Curator" agent should eventually own the Knowledge Review Queue (§16) once it exists — promoting drafts, flagging stale entries, maintaining the category taxonomy. Left open deliberately rather than speculatively defined.

## 15. Tools

External tools/services actually in use today, deliberately short:
- **Git / GitHub** — the only storage this department has. `knowledge/` and `brain/lao/` are both plain files in this repo; there is no database backing this department yet.
- **The configured LLM provider** (`pipeline/lib/llm.ts` — `claude-cli` or the Anthropic API) — not owned by this department, but every entry this department's API helps produce ultimately depends on it, since it's the reasoning engine behind the Researcher calls that populate `knowledge/research/`.

**Not yet adopted:** Supabase/pgvector (named as future tooling under the K2 roadmap track in `ARCHITECTURE.md` §11 — a storage upgrade, not a present-day dependency).

## 16. Required Software

This is the department's actual development backlog — reused directly from `ARCHITECTURE.md` §5A and `MARKETING_OS_ROADMAP.md` Phase 2, not reinvented:

1. **Continuous Knowledge Capture** — wire `proposeKnowledgeEntry()` into Writer, Brand Guardian, and Marketing Analyst. Highest priority: it's what turns capture from "one stage does it" into "every workflow does it."
2. **Knowledge Review Queue** — a Dashboard surface for the founder to promote `draft → verified` (today: a manual file edit). Without this, §7–§10's routines can't become real.
3. **Knowledge Explorer** — a human-facing way to browse/search `knowledge/` + `brain/lao/` together. Today the merged view only exists inside code (`retrieveKnowledge()` calls); nothing lets a person look at it directly.
4. **Intelligence Dashboard** — a Dashboard card surfacing §11's KPIs, the same way Department Health already surfaces per-employee status.
5. **Knowledge Relationships** — making `relatedIds` a navigable graph, not just a flat field.
6. **Brand Memory** — `brands/<tenant>/` becoming a first-class, continuously updated memory read directly by Writer and Guardian, not only seeded once.
7. **Performance Learning** — closing the loop from `performance_metrics` back into this layer, so Marketing Analyst becomes a knowledge *writer*, not just a metrics writer.

None of these exist yet. This list is the honest state of the backlog, not a claim of progress against it.

## 17. Standard Operating Procedures

**The one real SOP today** — the Researcher's retrieval + capture loop, `pipeline/stages/02-research.ts`:

```
Brief received (Stage 01 output)
        ↓
Retrieve verified+ knowledge (categories: industries/real-estate, brands/pintag, psychology, marketing, language)
        ↓
Merge into research prompt alongside knowledge-base/ reads
        ↓
LLM extracts facts + flags knowledgeGaps
        ↓
Each knowledgeGap → proposeKnowledgeEntry() → draft entry under knowledge/research/
        ↓
research.json written → hands off to Stage 03 (Write)
```

**The current (manual) promotion SOP**, contrasted with what §16's Knowledge Review Queue should eventually automate:

```
Today: founder or agent opens a draft .md file → edits status: field by hand → commits
Future: Knowledge Review Queue surfaces drafts on the Dashboard → founder approves/edits in place → status updated automatically
```

## 18. Intelligence Contribution

This section is necessarily a little different for this department than for any other, since Intelligence *is* the thing every other department contributes to — its own contribution is being the substrate that makes every other department's contribution mean something instead of disappearing.

Beyond that, its own meta-contributions: the category taxonomy and lifecycle schema (reusable by any future knowledge source), and the `brain/lao/` source-adapter pattern (`knowledge-sources/lao-brain.ts`) as a template for how a future source (a second hand-authored corpus, eventually Postgres) plugs in without changing any caller.

## 19. Definition of Done

Not yet met. Concrete, checkable criteria for "the Intelligence Department is operational" (Level 3+, see §20):

- [ ] Knowledge Review Queue (§16) is live and actually used at least weekly.
- [ ] Verified entries exist across at least 4 of the 8 top-level categories (currently: 1 has real depth).
- [ ] At least two departments beyond Research are actively calling `retrieveKnowledge()`/`proposeKnowledgeEntry()`.
- [ ] The `brain/lao/` Phase 2 migration has a made decision (go/no-go/timing) — not necessarily executed, but no longer an open question.
- [ ] Stage 02's knowledge-retrieval-augmented prompt has actually executed end-to-end through a real `runAgent()` call against a live LLM and Supabase project — as of this writing it's unit-verified via a standalone script exercising `knowledge.ts` directly, but has not yet run through the real pipeline.

## 20. Department Maturity

- **Level 0 — Not Defined**
- **Level 1 — Playbook Complete**
- **Level 2 — Software Exists** ← **current level**
- **Level 3 — Operated Daily**
- **Level 4 — Standardized**
- **Level 5 — Self-Improving**

**Current level: 2 — Software Exists.** Real, working code exists (`knowledge.ts`, the `brain/lao` adapter, Stage 02 wiring) and has been verified in isolation, but it has not yet been operated daily end-to-end (§19's last checkbox), so it isn't yet Level 3.
