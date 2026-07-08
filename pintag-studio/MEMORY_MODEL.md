# Memory Model

*This is not implementation documentation — `ARCHITECTURE.md` covers how the system is built. This is the canonical definition of Marketing OS's three memory layers and their responsibilities: what belongs where, who owns it, and how long it lives. Reference this whenever a new agent, department, or feature needs to decide where a piece of information belongs.*

## The three layers

| Layer | Purpose | Scope | Owner | Lifetime |
|---|---|---|---|---|
| **Intelligence Layer** | Shared reusable knowledge | Global | Marketing OS | Permanent |
| **Organizational Memory** | Customer knowledge | Organization | Customer | Long-term |
| **Operational Memory** | Active execution state | Workflow | AI Agents | Temporary |

### 1. Intelligence Layer (Global)

Marketing OS's proprietary asset — shared across every organization and every future application. Lao language, dictionary, grammar, culture, consumer psychology, marketing frameworks, industry knowledge, research methodologies, trend intelligence. Reusable examples: luxury marketing, educational marketing, real estate marketing, jewelry marketing, neuroscience communication, Lao writing patterns.

**Never contains customer-specific facts.** Its purpose is to make every customer smarter — not to remember any one of them.

Today: `knowledge/` + `brain/lao/` (see `ARCHITECTURE.md` §5A).

### 2. Organizational Memory (Private)

*Replaces the "Business Memory" mental model used before this document existed — same concept, clearer name: it isn't just about "the business," it's every organization's own long-term memory.*

Belongs to one organization: brand voice, products, services, campaign history, customer personas, FAQs, performance history, internal knowledge, organization-specific terminology. **Nothing from one organization ever leaks into another.**

Today, for Pintag (the only organization that exists): `brain/`, `knowledge-base/`, `content-vault/`, and the `org_id`-scoped Supabase control-plane tables (full contract in `DEPARTMENT.md` §11).

### 3. Operational Memory (Temporary)

The working memory for the current execution: current workflow, active campaign, research packet, draft content, pending approvals, pipeline state. It exists only while work is being performed.

Today, already present, just not previously named as one thing: `ContentBrief`, `ResearchPacket`, and `Draft` (`pipeline/lib/types.ts`) as they pass between pipeline stages within a single run; `content_items` rows while `status` is `draft`/`in_review`/`revising` (before they either publish into the permanent record or die as an abandoned attempt); `approvals_queue` rows before a decision is made; `generated-content/` as pre-Guardian, pre-approval staging. None of this is meant to persist as a lasting asset — a `content_items` row's operational life ends the moment it's published (at which point it's Organizational Memory, part of the Vault and content history) or discarded.

**One variant worth naming explicitly:** a pending Knowledge Suggestion (`knowledge-suggestions/`, `pipeline/lib/suggestions.ts`) is also Operational Memory — temporary, exists only until a human reviews it — but its graduation destination on approval is the **Intelligence Layer** (a `knowledge/` draft entry), not Organizational Memory. Most Operational Memory graduates "sideways" into the same organization's long-term record; a suggestion is the one case that graduates "up" into the shared layer, which is exactly why it needs a human checkpoint the ordinary Operational→Organizational path doesn't require.

## AI retrieval order

Every AI agent should conceptually think in this order:

```
Operational Memory
        ↓
Organizational Memory
        ↓
Intelligence Layer
        ↓
Foundation Model
```

Check what's actively being worked on first, then what this specific customer knows, then what every customer benefits from, and only then fall back to the model's own general knowledge. This ordering is what keeps a response grounded in the right context without mixing responsibilities — an agent that reached for general model knowledge before checking Organizational Memory would risk overriding something the customer already told it; one that skipped Operational Memory could contradict work already in progress this same run.

## The architectural correction: `knowledge/brands/<tenant>/`

`knowledge/brands/<tenant>/` (e.g. `knowledge/brands/pintag/`) was flagged in the prior documentation pass as misplaced — it holds customer-specific facts inside the Intelligence Layer. Under this memory model the correction is precise: **it belongs to Organizational Memory, not the Intelligence Layer.** The Intelligence Layer should hold *reusable marketing knowledge* (luxury marketing, educational marketing, real estate marketing, jewelry marketing, neuroscience communication, Lao writing patterns) — never Pintag-, Mamieii-, or Tien-specific knowledge itself.

**No structural change is made in this pass.** This document formalizes the correction; `knowledge/README.md` → "Relationship to Organizational Memory" still carries the practical guidance: don't add new organization-specific facts to `knowledge/brands/<tenant>/` going forward. A real migration remains a deliberate future step.

## Guiding principle

**Knowledge should live at the highest layer where it remains reusable.**

- If knowledge benefits every customer → **Intelligence Layer.**
- If it benefits only one organization → **Organizational Memory.**
- If it only matters during the current workflow → **Operational Memory.**

This is the test to apply whenever a new agent, department, or feature needs to decide where something belongs — including the retroactive one that produced the `knowledge/brands/<tenant>/` correction above. It's also the same test in reverse for cleanliness: don't let something migrate to a lower (more shared) layer than it's actually earned — an organization's private FAQ doesn't belong in the Intelligence Layer just because it's well-written; it earns that status only when it's been generalized into something genuinely reusable across customers (the same bar the Knowledge Layer's `draft → verified` lifecycle already applies to individual facts, applied here one layer up, to where a whole category of knowledge should live).

## Relationship to other documents

| Document | Answers |
|---|---|
| **`MEMORY_MODEL.md`** (this document) | Where does a piece of information belong — Intelligence Layer, Organizational Memory, or Operational Memory? |
| **`ARCHITECTURE.md`** §5B | How does today's actual system map onto these layers, plus the related (non-memory) Integrations concept — external platforms are transport, never source of truth. |
| **`DEPARTMENTS.md`** | How every department should apply this model, as part of Department-Driven Development. |
| **`DEPARTMENT.md`** §11 | The concrete read/write contract for Pintag's own Organizational Memory today. |
