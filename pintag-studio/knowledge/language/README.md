# Language — Lao Editorial Corpus

*This is the Intelligence Layer's home for reusable Lao writing craft: how to write natural, modern, consistent Lao content — shared across every organization and brand Marketing OS ever serves. See `../README.md` for the Knowledge Layer's overall schema/lifecycle, and `MEMORY_MODEL.md` for why this content belongs here (global, shared) rather than in Organizational Memory (brand-specific).*

## Relationship to `brain/lao/` (read this first)

**`brain/lao/dictionary.md` remains the single canonical source for Lao terminology** — this directory does not duplicate it, replace it, or compete with it. That reconciliation decision was made explicitly (`knowledge/README.md` → "Relationship to `brain/lao/`") and still holds: `brain/lao/` stays authoritative for terminology (Phase 1); a controlled migration is a deliberate future step (Phase 2), not done here.

**The division of concerns:**
- **`brain/lao/`** — *what words mean and which term to use*: the dictionary, land/legal terminology, district-specific language notes.
- **`knowledge/language/`** (this directory) — *how to write well in Lao once the words are chosen*: writing principles, hooks and social-style patterns, cultural notes, phrase library, common mistakes, tone examples, gold examples, editorial decisions. This is genuinely new scope `brain/lao/` was never meant to cover — general Lao-craft knowledge reusable across every brand (Pintag, Houluebor, Mamieii, Tien, and beyond), not real-estate-specific.

**Never invent a translation when the dictionary already has one.** If a better term is found, recommend updating `brain/lao/dictionary.md` via `proposeSuggestion()` rather than silently introducing a competing word — see `terminology/terminology-consistency-rule.md`.

## What belongs here vs. what doesn't

**Belongs here (global, brand-agnostic):** writing principles, terminology-consistency policy, English-loanword conventions, hook/attention/social-style patterns, cultural framing notes, reusable phrases, documented common mistakes, tone examples, gold-standard writing samples, editorial decisions — anything that makes Lao writing better *for any brand*, per `MEMORY_MODEL.md`'s guiding principle ("knowledge lives at the highest layer where it remains reusable").

**Does not belong here:** any brand's specific voice, products, or facts (Pintag's, Houluebor's, Mamieii's, or any future organization's). That's Organizational Memory — for Pintag today, `brain/brand-voice.md` and `brain/lao/`'s real-estate-specific content. Putting brand voice inside this shared layer was already flagged once as a mistake (`knowledge/brands/pintag/` — see `knowledge/README.md`'s "Relationship to Organizational Memory") and is not being repeated here.

## Current structure

| Folder | Status | What goes here |
|---|---|---|
| `writing-principles/` | Real content | Core Lao writing philosophy — natural over literal, tone, readability. |
| `terminology/` | Real content | Terminology-consistency policy and the English-loanword list. Not the dictionary itself (`brain/lao/dictionary.md`). |
| `hooks-and-social-style/` | Seed content, low confidence | Hook-writing and short-form/social-media attention patterns. Currently general/hedged, awaiting real Lao examples. |
| `cultural-notes/` | Empty scaffold | Cultural framing relevant to how content lands, not just how it translates. |
| `phrase-library/` | Empty scaffold | Reusable, proven Lao phrases and constructions. |
| `common-mistakes/` | Empty scaffold | Documented bad examples — see "Capturing negative and gold examples" below. |
| `tone-examples/` | Empty scaffold | Short example sentences illustrating brand-agnostic Lao tone (distinct from `gold/` — smaller-grained, illustrative rather than complete pieces). |
| `gold/` | Empty scaffold | Complete, exceptional Lao writing samples requiring little or no future editing — the primary reference dataset for future generation. See capture workflow below. |
| `editorial-decisions/` | Empty scaffold | Judgment calls worth never re-litigating — see capture workflow below. |

Several folders are deliberately empty right now rather than pre-filled with invented examples: genuine Lao-language authority (real phrase examples, real cultural notes, real gold-standard samples) has to come from actual native-speaker review or real content that's actually been produced and judged — fabricating them from outside the language would be exactly the kind of unverified claim `CLAUDE.md`'s ground rules already prohibit for factual content, applied here to linguistic content.

## Capturing negative and gold examples (the workflow, not a new mechanism)

This directory doesn't need new infrastructure — it reuses the Knowledge Suggestion System (`pipeline/lib/suggestions.ts`) already built for exactly this purpose:

- **Bad/translated-sounding wording noticed during any workflow** → `proposeSuggestion({ kind: 'wording-improvement', suggestedCategory: 'language/common-mistakes', ... })`, including the bad version, a better version, and why — the same BAD/Better/Explanation shape the founder specified. A human reviews and approves it into `common-mistakes/` via the existing Review Queue (`npm run knowledge:review`), exactly like any other suggestion.
- **Exceptional Lao writing that required little or no editing** → the same path, `suggestedCategory: 'language/gold'`.
- **A wording judgment call worth never re-solving** → the same path, `suggestedCategory: 'language/editorial-decisions'`.

No agent currently calls `proposeSuggestion()` for these cases yet (Writer and Brand Guardian aren't wired into the Knowledge Layer at all today — see `departments/intelligence/PLAYBOOK.md` §16, "Continuous Knowledge Capture," still open). This README documents the intended workflow so wiring it in later is calling an existing function from a new call site, not inventing a new pattern — the same "mailbox before the door" discipline used everywhere else in this system.

## Retrieval

Standard `retrieveKnowledge({ categories: ['language'], minStatus: 'verified' })` reaches everything in this directory (and, transparently, `brain/lao/dictionary.md` via the existing source adapter) — no special-casing needed. Stage 03 (Write) is the natural next real caller, the same way Stage 02 (Research) already is.
