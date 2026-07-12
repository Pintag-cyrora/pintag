---
id: language-terminology-consistency-rule
category: language/terminology
title: "Reuse canonical terminology — never invent a translation when one already exists"
status: verified
confidence: 0.95
tags: [terminology, lao, translation, editorial-process]
source:
  type: founder
  reference: founder-specified Lao Language Knowledge System policy
contributedBy: founder
created: 2026-07-09
updated: 2026-07-09
relatedIds: [language-writing-principles-natural-lao-over-literal-translation]
---

**The rule:** consistency is more important than creativity. Before introducing any Lao terminology, check `brain/lao/dictionary.md` (the canonical dictionary — see `brain/lao/README.md`) first. If a term already exists there, reuse it exactly rather than writing a fresh translation.

**If a better translation is discovered:**
- Do **not** silently replace the existing canonical term.
- Recommend updating the canonical dictionary entry instead — via `proposeSuggestion()` (`pipeline/lib/suggestions.ts`, `kind: 'wording-improvement'`, `suggestedCategory: 'language/terminology'` or pointing at the specific `brain/lao/dictionary.md` entry it would improve), so a human reviews the change before it becomes the new standard. The dictionary itself stays under `brain/lao/` per the existing Phase 1 decision (`knowledge/README.md` → "Relationship to `brain/lao/`") — this rule governs how it evolves, not where it lives.

**Why this matters:** inconsistent terminology is one of the fastest ways Lao content starts to read as generated-by-committee rather than written by one consistent voice — the same "one recognizable voice" principle `DEPARTMENT.md` already applies to brand voice generally, applied here specifically to word choice.
