# Working in pintag-studio

This directory is Pintag's internal AI marketing department. Read `ARCHITECTURE.md` in full before making structural changes — the design is frozen (v2.1, approved); only extend it if implementation genuinely can't proceed without a new concept, and say so explicitly when you do.

## Before doing anything else

Every agent run (yours included, in this session or a future one) should read, in order:
1. `brain/ceo.md` — founder's current priorities and non-negotiable principles
2. `brain/org-config.json` — structural config (thresholds, weights, Founder Mode definitions)
3. The relevant `.claude/agents/*.md` file for whichever employee role you're acting as

## Ground rules

- **Educational value outranks promotional language, always.** This is a hard rule, not a style preference — see `brain/ceo.md`.
- **Never state a fact not traceable to `knowledge-base/` or the read-only Pintag listings feed.** No invented statistics, prices, or legal claims.
- **Foreign land-ownership content requires explicit founder/counsel sign-off** before publishing any new claim — see `knowledge-base/guides/foreign-ownership-rules.md`.
- **Nothing in `content-vault/` is ever deleted.** Superseded items get `superseded_by`, not removal.
- **Check Memory before creating anything new.** The Content Strategist's job (`pipeline/stages/02-plan.ts`) is to prefer update/repurpose over from-scratch duplication.
- **`pipeline/` code must stay config-driven, never hardcode Pintag specifics** — district names, languages, thresholds all come from `brain/org-config.json`, not inline constants. This is what keeps the engine reusable if it ever becomes "Pintag Studio" for other tenants.

## Current state (M0)

Pipeline stages in `pipeline/stages/*.ts` are typed stubs with `TODO(Mx)` markers pointing at the roadmap milestone that implements them for real (see `ARCHITECTURE.md` Section 11). Don't fill in a TODO out of sequence without checking whether its milestone's prerequisites (credentials, upstream stages) actually exist yet — see `SETUP.md`.

## Where things live

See the "Layout at a glance" table in `README.md`, and the full folder-structure diagram in `ARCHITECTURE.md` Section 2.
