# Pintag Studio

Pintag's internal AI marketing department — a small team of specialized Claude Code agents that research, write, design, produce video, schedule, publish, and analyze content on Pintag's behalf, with minimal founder involvement.

This is **not** a Pintag customer-facing feature. It's an internal tool used only by the founder, via `dashboard/index.html`.

- **Read first:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the full approved design (why every folder here exists).
- **Read second:** [`DEPARTMENT.md`](./DEPARTMENT.md) — the operations manual: why the department exists, the org chart, handoffs, KPIs, approval workflow, and how success is actually measured.
- **Setting up for real:** [`SETUP.md`](./SETUP.md) — the manual steps only the founder can do (Supabase project, Meta app, Canva, TTS credentials).
- **Working in this repo as an AI agent:** [`CLAUDE.md`](./CLAUDE.md).

## Status

**M0 — Foundation.** The folder structure, knowledge base, agent definitions, Supabase schema, dashboard skeleton, and pipeline stage interfaces exist. Nothing is wired to live credentials yet — see `SETUP.md` for what's needed before M1 can start producing real content.

## Layout at a glance

| Folder | What it is |
|---|---|
| `brain/` | The department's shared operating system — brand voice, posting rules, org config, and `ceo.md` (the founder's current priorities, read by every agent first) |
| `knowledge-base/` | Curated facts about Pintag, Vientiane neighborhoods, and Laos real estate |
| `content-vault/` | Every piece of content ever produced — permanent, nothing deleted |
| `.claude/agents/` | The 11 AI "employees," each a subagent definition doubling as its own job description |
| `pipeline/` | The orchestration engine wiring the employees together |
| `dashboard/` | The founder's daily homepage — the only interface meant for human use |
| `supabase/` | The control-plane database schema |
