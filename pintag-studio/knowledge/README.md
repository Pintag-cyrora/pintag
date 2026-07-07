# Knowledge Layer

*This is the fourth Archive-plane component, alongside `brain/`, `knowledge-base/`, and `content-vault/` — see `ARCHITECTURE.md` §5A for how it fits the three-plane design. It's a post-freeze approved extension to the v2.1 architecture, not a routine folder.*

## What this is

Everything Marketing OS learns that's worth keeping past a single workflow run: better Lao wording, industry terminology, marketing hooks, customer objections, FAQs, cultural insights, brand-voice notes, high-performing content patterns. The founder's stated principle: **training AI for the Lao language and Lao market is the actual proprietary asset here** — this folder is where that asset accumulates, structured and reviewable, instead of disappearing into chat history or a log line.

`knowledge-base/` (curated, human-authored, slowly-changing company/market facts) and `brain/` (operating rules, brand voice, org config) are untouched by this addition — they keep doing exactly what they do today. `knowledge/` is additive: a lifecycle-managed layer for knowledge that's produced continuously by workflows, not just curated by hand.

## Relationship to `brain/lao/`

`brain/lao/` (Keomany's hand-built Lao real estate dictionary and language/culture corpus) is **not** a competing knowledge system — it's the seed of this layer's future Language module, kept exactly as-is for now:

- **Phase 1 (current):** `brain/lao/` is the authoritative source for Lao dictionary/language content. Nothing here duplicates it. `retrieveKnowledge()` reads it transparently via a source adapter (`pipeline/lib/knowledge-sources/lao-brain.ts`) and merges its entries into the same `category: 'language'` results `knowledge/language/` entries return — callers never know (or need to know) which directory an entry actually lives in. `knowledge/language/` itself stays sparse: only content that isn't dictionary material belongs there (see the seed entry already in it).
- **Phase 2 (future, once this layer's schema has proven itself):** a controlled migration of `brain/lao/`'s content into this layer, preserving every entry and its richer per-term template (Lao term, English equivalent, definition, when to use/not use, common mistakes, legal-verification status, preferred wording, related knowledge) — that template is more sophisticated for terminology than this layer's generic frontmatter and should inform how `knowledge/language/` entries are shaped once merged, not be flattened away.
- **Long-term:** one Intelligence Layer, not two parallel language systems — `Language` (dictionary/grammar/spelling/style), `Culture`, `Marketing`, `Psychology`, `Industries`, `Brands`, `Research`, `Trends`, `Performance`, all behind the same `retrieveKnowledge()`/`proposeKnowledgeEntry()` API regardless of what's storing them underneath (today: markdown files across two directories; tomorrow: Postgres + embeddings + semantic search). `brain/lao/`'s current content is the beginning of that future `Language` module, not a separate thing to reconcile away later.

## Category guide

| Folder | Holds |
|---|---|
| `language/` | Lao spelling, grammar, terminology, translation notes |
| `culture/` | Cultural norms, communication style, what lands / what doesn't |
| `psychology/` | Consumer psychology, persuasion patterns, objection handling |
| `marketing/` | Frameworks, hooks, copywriting patterns, campaign playbooks |
| `research/` | Market research, competitive intel, trend findings — including knowledge gaps the Researcher flags mid-pipeline (see "Where this plugs in" below) |
| `prompts/` | Reusable, tested prompt fragments per agent role |
| `industries/<vertical>/` | Vertical-specific knowledge, e.g. `industries/real-estate/`. New verticals (education, parenting, jewelry, ...) get sibling folders as new tenant apps come online. |
| `brands/<tenant>/` | Brand-specific voice/facts, e.g. `brands/pintag/`. New tenants (Houluebor, Mamieii, Tien, ...) get sibling folders — this is the "same knowledge layer powers every app" folder. |

## Entry format

One markdown file per entry, with a frontmatter block. This is a small, self-authored frontmatter subset (parsed by `pipeline/lib/knowledge.ts`) — not general YAML — so keep to the shape shown in `_template.md`:

```
---
id: language-lo-property-terms-a1b2c
category: language
title: Lao terminology for property listings
status: draft
confidence: 0.6
tags: [language, real-estate, terminology]
source:
  type: file
  reference: knowledge-base/guides/buying-guide.md
contributedBy: researcher
created: 2026-07-07
updated: 2026-07-07
relatedIds: []
---

Body markdown — the actual knowledge content.
```

**Fields:**

- `id` — stable slug, independent of file path (so an entry can move between categories without breaking `relatedIds` references elsewhere).
- `category` — folder path relative to `knowledge/`.
- `status` — `draft` → `verified` → `expert_reviewed`, or `deprecated`. Nothing is created above `draft` — see "Lifecycle" below.
- `confidence` — 0–1, same convention as `org-config.json` / `quality_scores`.
- `source` — `{ type, reference }`. `type` is one of `file | url | agent-inference | founder | external-research`. This is structured (not a free string) specifically so a future ingestion/RAG pipeline can distinguish "grounded in this document" from "the model inferred this" without re-parsing prose.
- `contributedBy` — which agent or person produced *this entry*. Distinct from `source`: `source` is what the underlying claim is grounded in, `contributedBy` is who wrote it up.
- `relatedIds` — links to other entries' `id`s. Same lineage idea as `content_items.derived_from` / `repurposed_into`.
- `supersededBy` — set when a better entry replaces this one. **Never delete a file** — mirrors the Content Vault's `superseded_by` permanence guarantee (`DEPARTMENT.md` §11).

No bespoke version field — git history *is* the version history, same principle already used for the Content Vault.

## Lifecycle

`draft` → `verified` → `expert_reviewed`, with `deprecated` reachable from any of those. Every entry is created as `draft` — including everything `proposeKnowledgeEntry()` writes. Promotion to `verified`/`expert_reviewed` is a deliberate human review step today (edit the file, change `status:`), matching the zero-tolerance-on-unverified-claims principle already enforced for published content (`DEPARTMENT.md` §12 Tier 2). Retrieval callers can set `minStatus` to exclude unreviewed drafts from anything that feeds founder-review-exempt (auto-publish-eligible) content.

## Retrieval and capture: `pipeline/lib/knowledge.ts`

Two functions, callable by any agent, current or future:

- **`retrieveKnowledge({ categories?, tags?, minStatus?, limit? })`** — filtered, status/confidence-sorted read. Example lookups matching the founder's stated long-term vision (only Pintag exists today; the others illustrate how a future tenant would use the *same* function):
  - Pintag → `retrieveKnowledge({ categories: ['industries/real-estate', 'brands/pintag', 'language', 'culture'] })`
  - Houluebor (future) → `retrieveKnowledge({ categories: ['psychology', 'industries/education', 'brands/houluebor'] })`
  - Mamieii (future) → `retrieveKnowledge({ categories: ['industries/parenting', 'brands/mamieii'] })`
  - Tien (future) → `retrieveKnowledge({ categories: ['industries/luxury-goods', 'brands/tien'] })`
- **`proposeKnowledgeEntry({ category, title, body, tags, source, contributedBy, confidence?, relatedIds? })`** — writes a new `status: 'draft'` entry and returns it.

Both are storage-agnostic by design: today `retrieveKnowledge()` merges markdown files under `knowledge/` with `brain/lao/dictionary.md` (via the source adapter described above) into one list before filtering/sorting; later it can be backed by Supabase pgvector (see "Future upgrade path") without changing a single call site or exposing which source an entry came from — the same way `01-plan.ts`'s `findSimilarByTitle()` stub is written to be replaced by a real vector query (`TODO(M2)`) without touching its callers. `proposeKnowledgeEntry()` only ever writes to `knowledge/` — per the Phase 1 decision above, `brain/lao/` is read-only from this layer's perspective until the Phase 2 migration.

## Where this plugs in today

Only `pipeline/stages/02-research.ts` (Researcher) calls this API right now — a deliberate proof-of-concept scope, not the ceiling. It:
1. Calls `retrieveKnowledge()` to enrich its research prompt alongside the existing `knowledge-base/` reads.
2. Calls `proposeKnowledgeEntry()` once per flagged `knowledgeGap` — turning "a fact the reference material doesn't cover" into a structured `knowledge/research/` draft instead of just a console log line.

Writer, Brand Guardian, and Marketing Analyst are natural next callers (better wording → `language/`, an objection surfaced during review → `psychology/`, a high-performing pattern from analytics → `marketing/`) — wiring them in later is calling the same two functions from a new call site, not a redesign.

## Future upgrade path (not built yet, deliberately)

- **Storage:** a `knowledge_entries` Supabase table, same `org_id text not null default 'pintag'` pattern every control-plane table already uses (`0001_init_control_plane.sql`) — moving multi-tenant knowledge into one shared, queryable store.
- **Retrieval:** pgvector embeddings + semantic search, replacing the current tag/category file scan behind the same `retrieveKnowledge()` signature.
- **API:** an HTTP surface, once a second consuming application (not just this pipeline) needs to read/write the layer.
- **Validation:** a lint script over frontmatter shape/required fields, once entry volume makes manual review of malformed entries impractical.

None of these are needed at today's volume — the file-based version is intentionally the whole system until it isn't.
