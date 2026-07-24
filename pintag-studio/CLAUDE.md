# Working in pintag-studio

This directory is Pintag's internal AI marketing department. Read `ARCHITECTURE.md` (system design) and `DEPARTMENT.md` (why the department exists, org chart, handoffs, KPIs, approval workflow) in full before making structural changes — both are frozen and approved; only extend them if implementation genuinely can't proceed without a new concept, and say so explicitly when you do.

## Before doing anything else

Every agent run (yours included, in this session or a future one) should read, in order:
1. `brain/ceo.md` — founder's current priorities and non-negotiable principles
2. `brain/org-config.json` — structural config (thresholds, weights, Founder Mode definitions)
3. The relevant `.claude/agents/*.md` file for whichever employee role you're acting as

## Ground rules

- **Business-first architecture.** Marketing OS exists to run our own businesses first, not as a SaaS product — see `ARCHITECTURE.md` §0 and `brain/ceo.md`'s Non-Negotiable Principles. Before adding cloud infrastructure, unattended automation, authentication for external users, or multi-tenant capability, confirm it's solving a problem this business actually has today — not one a future customer might have. Local, founder-triggered execution via the Claude Code CLI is the default and the core product; cloud/unattended execution is an optional, separately-triggered **deployment adapter** (§0), not baseline. When in doubt about which bucket something falls in, ask rather than build it into the core.
- **Educational value outranks promotional language, always.** This is a hard rule, not a style preference — see `brain/ceo.md`.
- **Never state a fact not traceable to `knowledge-base/` or the read-only Pintag listings feed.** No invented statistics, prices, or legal claims.
- **Foreign land-ownership content requires explicit founder/counsel sign-off** before publishing any new claim — see `knowledge-base/guides/foreign-ownership-rules.md`.
- **Nothing in `content-vault/` is ever deleted.** Superseded items get `superseded_by`, not removal.
- **Check Memory before creating anything new.** The Content Strategist's job (`pipeline/stages/01-plan.ts`) is to prefer update/repurpose over from-scratch duplication.
- **`pipeline/` code must stay config-driven, never hardcode Pintag specifics** — district names, languages, thresholds all come from `brain/org-config.json`, not inline constants. This is what keeps the engine reusable if it ever becomes "Pintag Studio" for other tenants.
- **Check `knowledge/` (the Knowledge Layer, `ARCHITECTURE.md` §5A) before generating content, and propose new entries for anything reusable.** Call `retrieveKnowledge()` from `pipeline/lib/knowledge.ts` rather than re-deriving something the layer already has; call `proposeKnowledgeEntry()` for insights (better wording, an objection, a cultural note) that would otherwise only live in a log line or a chat transcript. See `knowledge/README.md`. For Lao-language writing craft specifically (terminology, tone, hook patterns), see `knowledge/language/` and canonical `brain/lao/dictionary.md`.

## Current state (M0)

Pipeline stages in `pipeline/stages/*.ts` are typed stubs with `TODO(Mx)` markers pointing at the roadmap milestone that implements them for real (see `ARCHITECTURE.md` Section 11). Don't fill in a TODO out of sequence without checking whether its milestone's prerequisites (credentials, upstream stages) actually exist yet — see `SETUP.md`.

## Where things live

See the "Layout at a glance" table in `README.md`, and the full folder-structure diagram in `ARCHITECTURE.md` Section 2.
