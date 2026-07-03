# Setup — manual steps only the founder can do

Everything in this repo is scaffolded to run once these are in place. None of it can be automated on your behalf since each step needs your own accounts/credentials.

## 1. Supabase project

1. Create a **new, separate** Supabase project (do not reuse the production pintag.io project — see `ARCHITECTURE.md` Section 1 for why).
2. Run the migrations in order: `supabase/migrations/0001_init_control_plane.sql`, `0002_agent_health.sql`, then `0003_publish_simulation.sql` (via the Supabase SQL editor, or the Supabase CLI once linked).
3. Create one Supabase Auth user for yourself (email + password) — this is the account the Dashboard signs in as.
4. Collect these values:
   - Project URL and anon key → paste into `dashboard/index.html` (`SUPABASE_URL`, `SUPABASE_ANON`)
   - Project URL and **service role** key → set as GitHub Actions secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (used by the headless pipeline; never put the service role key in the dashboard)

## 2. LLM provider (needed from M1 onward)

Research, Write, and Brand Guardian all call an LLM via `pipeline/lib/llm.ts`'s `LlmProvider` abstraction. Set `LLM_PROVIDER` to choose which implementation runs:

- **`claude-cli`** (works with zero setup in an interactive Claude Code session — this is what M1 was verified against) shells out to the `claude` CLI. It needs the CLI installed and authenticated in whatever environment runs it. This is realistic for local development but not recommended for GitHub Actions runners, which start from a clean environment each run.
- **`anthropic-api`** (the GitHub Actions default) calls the Anthropic Messages API directly and only needs one secret: `ANTHROPIC_API_KEY` (from console.anthropic.com). Set this as a GitHub Actions secret.

Both workflows (`daily-content-pipeline.yml`, `publish-queue.yml`) default to `anthropic-api` in CI. You can override per-repo via a GitHub Actions variable (`vars.LLM_PROVIDER`) if you'd rather run `claude-cli` there instead — but you'll need to handle installing and authenticating the CLI on the runner yourself.

## 3. Meta (Facebook + Instagram)

1. Create a Meta Developer app at developers.facebook.com.
2. Link your Pintag Facebook Page and its connected Instagram Business account.
3. Generate a long-lived Page access token with `pages_manage_posts`, `pages_read_engagement`, and `instagram_content_publish` permissions.
4. Set the token as a GitHub Actions secret (`META_PAGE_ACCESS_TOKEN`).
5. Set `META_PUBLISH_MODE=live` (as a GitHub Actions variable) once the above is done — it defaults to `simulate`, which is what M1 runs in today (Publisher goes through every real decision and writes a clearly-marked simulated post, but never calls the actual Graph API). Flipping this is a config change, not a code change.

## 4. Canva

Confirm your Canva account has Connect API / Brand Template access. Create the Brand Templates listed in `brand-assets/canva-templates.json` (currently placeholders with `canva_template_id: null`) and fill in their real template IDs once created. Not needed until M2 (Graphic Designer).

## 5. Text-to-speech

Default recommendation is Google Cloud TTS (free tier covers this volume — see `ARCHITECTURE.md` Section 6). Create a Google Cloud project, enable the Text-to-Speech API, and set the resulting credentials as a GitHub Actions secret when `pipeline/stages/05-video.ts` is implemented (M4).

## 6. Read-only listings feed (main `pintag` repo)

The main repo's `supabase/functions/public-listings-feed` edge function (added alongside this scaffold) needs to be deployed to the **production** pintag.io Supabase project. It's read-only and returns only already-public listing fields — deploy it the same way as the repo's other edge functions. Not needed for educational posts (M1); needed once neighborhood guides or property videos are wired up (M3/M4).

## 7. Dashboard hosting

`dashboard/index.html` is a single static file — host it anywhere static (GitHub Pages, Vercel, Netlify, or just open it locally). No build step required. Bookmark it; per the architecture, it's meant to be your daily homepage. Until it's hosted, local Supabase Studio (see below) is the stand-in for approving items.

## Running M1 locally (no cloud project needed yet)

M1 was built and verified against a **local, ephemeral Supabase stack** (Docker + the Supabase CLI), not the real cloud project above — that's still yours to create before this runs in production, but proving the code is correct doesn't need to wait on it.

```bash
cd pintag-studio
supabase start                     # prints local API URL + keys; applies 0001-0003 automatically
export SUPABASE_URL=...            # from the `supabase start` output
export SUPABASE_SERVICE_ROLE_KEY=...
npm run pipeline                   # Plan -> Research -> Write -> Guardian -> Schedule -> Publish-decision
```

Since Approval Phase 1 is active by default, that run lands the item in `approvals_queue` awaiting a real decision. Open local Supabase Studio (URL also printed by `supabase start`), find the row in `approvals_queue`, and set `decision='approved'`, `decided_at=now()` — then:

```bash
npm run pipeline:publish-queue     # Publish (simulated) -> Analyze -> Memory Update
```

`supabase stop` when done. Nothing here is committed or persisted beyond your local Docker containers.

## What's NOT needed yet

Steps 4-5 (Canva, TTS) aren't required until M2/M4. Step 3 (Meta) isn't required until you're ready to flip `META_PUBLISH_MODE` to `live` — M1 runs entirely in simulate mode. Step 6 (listings feed) isn't needed until M3/M4. Start with step 1 (Supabase) and step 2 (LLM provider) to run M1 for real against your own cloud project instead of the local stack.
