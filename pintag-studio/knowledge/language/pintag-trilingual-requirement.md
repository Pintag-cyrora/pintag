---
id: language-pintag-trilingual-requirement-seed1
category: language
title: "Pintag content operates in three languages: Lao, English, Chinese — with one voice"
status: verified
confidence: 0.9
tags: [language, lo, en, zh, translation]
source:
  type: file
  reference: brain/org-config.json
contributedBy: seed
created: 2026-07-07
updated: 2026-07-07
relatedIds: [brands-pintag-brand-voice-summary-seed1]
---

Pintag's configured languages are Lao (`lo`), English (`en`), and Chinese (`zh`) — see `brain/org-config.json` → `org.languages`. This isn't incidental: the Investor persona (`knowledge-base/company/audience-personas.md`) is frequently Chinese-speaking, and Lao is the market's primary language, so all three are first-class, not "English plus translations."

**The constraint that matters for content generation:** brand-voice restraint must not vary by language. Per `brain/brand-voice.md`'s Multilingual Note, tone should not become more promotional or more formal simply because of a language switch — idiom and phrasing adapt naturally per language, but the underlying restraint (no unsourced superlatives, no manufactured urgency) does not. A common failure mode worth watching for: translations that "loosen up" in a second-pass language because the strict phrasing didn't translate cleanly — that's a brand-voice violation, not an acceptable localization tradeoff.

This entry is a placeholder for what should become the real payload of `knowledge/language/` over time: specific Lao spelling/grammar/terminology notes as they're identified by the Researcher or Writer (via `proposeKnowledgeEntry()`), not general policy restatements like this one.
