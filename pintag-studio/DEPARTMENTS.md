# Departments — Department-Driven Development

*This is the index for `departments/` and the explanation of Marketing OS's execution methodology. It is not a technical spec (`ARCHITECTURE.md`), a strategy document (`MARKETING_OS_ROADMAP.md`), or a constitution (`FOUNDING_PRINCIPLES.md`) — it explains how work actually gets built, department by department.*

## Not to be confused with `DEPARTMENT.md`

`DEPARTMENT.md` (singular, existing) is **Pintag's own operations manual** — the org chart of 11 AI employees serving one brand, its approval workflow, its KPIs. It answers "how does Pintag's marketing team run day to day?"

`departments/` (plural, this file's subject) is **Marketing OS's own internal functional structure** — Intelligence, Research, Strategy, Creation, Distribution, Performance, Learning, Brand, Business, Platform. It's cross-brand: it describes how the *company* organizes its work, not how any one brand's team is organized. These are two different axes that happen to share a name root. Neither supersedes the other.

## The methodology: Department-Driven Development

We no longer build Marketing OS feature-first. We build it department-first:

```
Define the department
        ↓
Write the Department Playbook
        ↓
Build only the software that Playbook specifies
        ↓
Operate it ourselves, every day
        ↓
Improve the workflow from real usage
        ↓
Standardize it
        ↓
Lock the department
        ↓
Move to the next department
```

**A Department Playbook is not documentation. It is the specification software gets built from.** Old workflow: Idea → Software. New workflow: Department → Playbook → Workflow → Software → Daily Operation → Improvement → Standard → Next Department. Software is always an implementation of a Playbook — never the reverse. If something doesn't trace back to a line in some department's Playbook, it isn't yet justified to build.

No department is considered complete until it has actually been operated, by us, not just specified.

Every department advances through the Department Maturity model using the same [`departments/_GRADUATION_CHECKLIST.md`](./departments/_GRADUATION_CHECKLIST.md) — copied into that department's own Playbook and checked off with evidence, not assumed from software existing. **Department maturity is measured by operation, not implementation.**

## Department Maturity model

The standard way to answer "how mature is this department?" — used consistently across every Playbook's final section:

| Level | Name | Meaning |
|---|---|---|
| 0 | Not Defined | No Playbook exists yet. |
| 1 | Playbook Complete | The Playbook is written and real, but no software exists to support it. |
| 2 | Software Exists | The software described in the Playbook's Required Software section has been built. |
| 3 | Operated Daily | The department is actually running, end to end, on a real cadence — not just tested once. |
| 4 | Standardized | The workflow is stable, documented as SOPs precisely enough to automate, and consistent run to run. |
| 5 | Self-Improving | The department contributes back to the Intelligence Layer as a matter of course, and that contribution measurably improves its own or another department's output over time. |

This replaces "how complete is Marketing OS?" (a single, misleading number) with "how mature is each department?" (a real, checkable answer per department).

## Department index

| Department | Playbook | Maturity |
|---|---|---|
| **Intelligence** | [`departments/intelligence/PLAYBOOK.md`](./departments/intelligence/PLAYBOOK.md) | **2 — Software Exists** |
| Research | not yet written — see [`departments/_TEMPLATE.md`](./departments/_TEMPLATE.md) | 0 — Not Defined |
| Strategy | not yet written | 0 — Not Defined |
| Creation | not yet written | 0 — Not Defined |
| Distribution | not yet written | 0 — Not Defined |
| Performance | not yet written | 0 — Not Defined |
| Learning | not yet written | 0 — Not Defined |
| Brand | not yet written | 0 — Not Defined |
| Business | not yet written | 0 — Not Defined |
| Platform | not yet written | 0 — Not Defined |

Only Intelligence has a real folder and Playbook today. The other nine are intentionally not scaffolded — no empty folders, no placeholder files — until we deliberately work through them one at a time, per the methodology above. When it's time for the next one, copy `departments/_TEMPLATE.md` to `departments/<name>/PLAYBOOK.md` and fill it in against reality, the same way Intelligence's was.

## Recommended build order

**Intelligence → Research → Creation → Strategy → Distribution → Performance → Learning → Brand → Platform → Business.**

This is a recommendation, not a locked sequence — reorder it if reality argues otherwise. The reasoning: it follows how much real, operating software already exists behind each department today.

- **Intelligence** and **Research** already have live code (the Knowledge Layer; Stage 02) — natural first and second.
- **Creation** has four working agents from Phase 1 (Writer, Graphic Designer, Video Producer, Brand Guardian) — real, if not yet fully proven.
- **Strategy** and **Distribution** exist (Content Strategist, CMO, Publisher) but are less proven end to end.
- **Performance** is still largely stub scope (Marketing Analyst, M5 on the execution roadmap).
- **Learning** is cross-cutting and is best defined once Research, Creation, and Performance are real enough to learn from.
- **Brand** becomes load-bearing once a second proof-of-concept brand (`MARKETING_OS_ROADMAP.md` Phase 5) actually exists — premature before that.
- **Platform** becomes its own department once cross-department software debt genuinely warrants a dedicated owner, not before — per `FOUNDING_PRINCIPLES.md`'s "simplicity scales."
- **Business** is last, deliberately — both the roadmap's phase ordering and the Founding Principles' Decision Filter agree B2B commercialization shouldn't be prioritized ahead of the Intelligence Layer actually being real.
