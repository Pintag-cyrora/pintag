# Setup — manual steps only the founder can do

Everything in this repo is scaffolded to run once these are in place. None of it can be automated on your behalf since each step needs your own accounts/credentials.

## 1. Supabase project

1. Create a **new, separate** Supabase project (do not reuse the production pintag.io project — see `ARCHITECTURE.md` Section 1 for why).
2. Run the migrations in order: `supabase/migrations/0001_init_control_plane.sql`, `0002_agent_health.sql`, `0003_publish_simulation.sql`, then `0004_observation_sources.sql` (via the Supabase SQL editor, or the Supabase CLI once linked).
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

## 8. TikTok (Observation Source, M2.2)

Read-only — no posting. Lets the Daily Briefing report what actually happened on TikTok (account stats, recent-video performance) instead of relying only on internal knowledge. See `pipeline/lib/observation-sources/tiktok.ts` and `ARCHITECTURE.md`'s Observation Sources section.

> **Verified against TikTok's current published Login Kit documentation** (not the live authenticated portal itself — no agent can log into your TikTok Developer account; if what you see still doesn't match, tell me exactly what's on screen and this gets corrected again). Confirmed independently via TikTok's own docs: **"URL Properties" is a different feature entirely** — it's domain-ownership verification for the Content Posting API (publishing), unrelated to Login Kit. **Marketing OS doesn't use the Content Posting API (read-only, no posting) — skip URL Properties completely.** That's the real reason it had no redirect URI field: you were on the wrong screen, not missing a step.

1. Create a TikTok Developer app at [developers.tiktok.com](https://developers.tiktok.com).
2. Add the **Login Kit** product to the app (not "URL Properties" — ignore that section entirely for this setup).
3. **Adding Login Kit is what reveals the redirect URI field** — per TikTok's docs, adding the product itself prompts you to provide one directly, rather than it living in a separate general settings page. Wherever TikTok asks for a platform/app type for this — either for the whole app or specifically for this redirect URI — **choose Desktop, not Web.** This matters: Web-platform redirect URIs must be a real `https://` domain you own; Desktop-platform redirect URIs allow a local `http://127.0.0.1` loopback address with no domain needed at all, which is what this tool (a local CLI script, not a hosted server) actually requires.
4. **Redirect URI — use exactly this value, it's not something you choose:**
   ```
   http://127.0.0.1:4322/callback
   ```
   It doesn't need to be a live server — TikTok redirects the browser there with an authorization code in the query string, which you paste back into the CLI even if the page itself 404s. Already filled in for you in `.env.example`'s `TIKTOK_REDIRECT_URI` — leave that line as-is when you copy it to `.env.local`.
5. Request these scopes: `user.info.basic`, `user.info.stats`, `video.list`. New apps start in sandbox mode (unaudited) — reading your own account's data should work there, but this hasn't been confirmed against a live app yet; if it turns out reads also need a full audit first, that's a review submission (functional demo + business verification), not a code change.
6. Set as GitHub Actions secrets (and locally, in `.env.local` — see `FIRST_TIME_SETUP.md`): `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` (the value above).
7. Run migration `0004_observation_sources.sql` if you haven't already (step 1 above).
8. Run `npm run tiktok:connect` once — it prints the exact redirect URI to double-check against your Developer app, then an authorization URL. Approve it as the Pintag TikTok account, and paste back the resulting redirect URL (or just the `code` from it). This stores the access/refresh token pair in Supabase (`observation_source_tokens`); the pipeline refreshes it automatically after that (TikTok refresh tokens last about a year, so this is a rare step, not a daily one). If `TIKTOK_REDIRECT_URI` in `.env.local` is ever missing or doesn't match the value above, `npm run tiktok:connect` says so plainly and tells you exactly what to fix, rather than failing partway through.

Not needed until you want real TikTok data in the Daily Briefing — everything else in this repo works without it (`gatherObservations()` degrades gracefully and says so honestly if TikTok isn't connected).

## Daily use — starting Marketing OS (no Terminal needed)

Once step 1 (Supabase) is done, this is the everyday way to open Marketing OS — the Founder Workspace (`npm run founder-ui`) is the browser front end for everything else in this file.

1. **One-time only:** copy `.env.example` to `.env.local` (same folder, `pintag-studio/`) and fill in `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from step 1. Any text editor works — no Terminal needed for this either.
2. **Every day:** double-click `Start Marketing OS.command` in Finder. A window opens showing it starting up, and your browser opens automatically to the Founder Workspace a couple seconds later. **Closing that window stops Marketing OS** — the same as closing any other app.

If macOS says it can't verify the developer the first time you double-click it, right-click the file and choose "Open" once instead — after that it opens normally.

`PORT` defaults to 4321 if you ever need a different one (`PORT=5000` before the command, same as any other env var here).

## Running M1 locally (no cloud project needed yet)

M1 was built and verified against a **local, ephemeral Supabase stack** (Docker + the Supabase CLI), not the real cloud project above — that's still yours to create before this runs in production, but proving the code is correct doesn't need to wait on it.

```bash
cd pintag-studio
supabase start                     # prints local API URL + keys; applies 0001-0004 automatically
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

Steps 4-5 (Canva, TTS) aren't required until M2/M4. Step 3 (Meta) isn't required until you're ready to flip `META_PUBLISH_MODE` to `live` — M1 runs entirely in simulate mode. Step 6 (listings feed) isn't needed until M3/M4. Step 8 (TikTok) is optional at any point — the Daily Briefing works without it. Start with step 1 (Supabase) and step 2 (LLM provider) to run M1 for real against your own cloud project instead of the local stack.
