# Lao Brain

The language and cultural-context layer for communicating in Lao about Vientiane real estate. Distinct from `knowledge-base/` (facts — listings, guides, market data) and the top-level `brain/*.md` files (Pintag's own brand voice, org config, priorities). This directory holds *how to say things in Lao and why*, not the facts themselves — factual claims still must trace back to `knowledge-base/` per `CLAUDE.md`'s ground rules.

Kept organization-agnostic on purpose: nothing Pintag-specific belongs here. If a future tenant needed this same engine for a different market, `brain/lao/` should be reusable as-is — Pintag-specific voice/config stays in `org-config.json`, `brand-voice.md`, etc., one level up.

## What belongs where

| Path | Contents |
|---|---|
| `dictionary.md`, `slang.md`, `abbreviations.md` | Core vocabulary layer — formal terms, informal/spoken usage, shorthand. |
| `districts/` | One file per Vientiane district (must match `knowledge-base/neighborhoods/` spelling exactly). Language and framing notes for that district — not listing data, which lives in `knowledge-base/`. |
| `land/` | Lao terminology and explanatory framing for land topics: `title-types.md`, `transfer.md`, `taxes.md`, `ownership.md`, `disputes.md`, `boundaries.md`. |
| `legal-process.md` | Language/framing for the legal and transaction process. |
| `buyer-psychology.md`, `seller-psychology.md` | Audience mental models — concerns, priorities, trust signals. |
| `buyer-journey.md` | Stage-by-stage framing of the buyer's journey. |
| `market/` | Market-communication language. Currently one `overview.md`; split into subtopics (trends, pricing, comparables, etc.) once there's enough real content to warrant it. |
| `culture/` | Cultural context relevant to property decisions. Currently one `overview.md`, same expansion path as `market/`. |
| `listings/` | Listing-specific terminology and phrasing. Currently one `overview.md`, same expansion path as `market/`. |
| `writing-style.md` | Lao-specific style rules — the Lao companion to `brain/style-guide.md`. |
| `forbidden-phrases.md` | Lao-specific banned/risky phrasing — the Lao companion to `brand-voice.md`'s "Vocabulary — Don't" and `posting-rules.md`'s banned claims. |
| `common-questions.md` | Real buyer/renter FAQs, in Lao framing. |
| `negotiation.md` | Negotiation language and norms. |
| `examples/` | One file per content type (matching the `ContentType` enum in `pipeline/lib/types.ts`) — worked examples of Lao-language content for that type. |

## How AI agents should use this

- Read the specific file(s) relevant to the task at hand before drafting or reviewing Lao-language content — the same way `brain/brand-voice.md` and `brain/style-guide.md` are read today (see `pipeline/lib/agent.ts`).
- Prefer the narrowest applicable file. A Saysettha post reads `districts/saysettha.md`, not every district file.
- This directory supplements `knowledge-base/` for language and framing — it is never itself a source for facts, prices, or legal claims. Check `metadata.md`'s review status before treating anything here as settled; draft/unreviewed content should be flagged, not stated as fact.

## Naming conventions

- Filenames: kebab-case, lowercase, `.md` extension — except `examples/`, whose filenames match the `content_type` enum exactly (snake_case) so they can be looked up programmatically.
- District filenames must match `knowledge-base/neighborhoods/` exactly — this is a hard rule (see `CLAUDE.md`), not a style preference.

## New file vs. expanding an existing one

- **Expand** an existing file when new material is a natural subsection of its current scope and the file is still comfortably readable in one sitting.
- **Split** into a new file, or promote a flat file into a directory (as `market/`, `culture/`, and `listings/` are already set up to do), once a section is consistently the only part of the file being read, or needs its own review/confidence tracking separate from the rest.
- Never duplicate the same fact or framing across two files — put it in one and have the other reference it.
