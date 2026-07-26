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

> **No agent can log into your TikTok Developer account** — everything below is from TikTok's own published documentation, cross-checked across multiple independent sources, not the live portal itself. Two things below are confirmed with real portal behavior (thank you): "Configure for Desktop" under a **production** app routes straight to App Review — that's real, observed, not a guess. Where exactly the redirect URI field appears *inside Sandbox mode specifically* is still unconfirmed — flagged below rather than guessed at. Tell me what you actually see and this gets corrected precisely.

1. Create a TikTok Developer app at [developers.tiktok.com](https://developers.tiktok.com).
2. Add the **Login Kit** product to the app (not "URL Properties" — that's domain verification for the Content Posting API, a different, unrelated feature Marketing OS doesn't use at all).
3. **Before submitting for App Review, switch the app to Sandbox mode** — there's a Production/Sandbox toggle near the app's name. Click **Create Sandbox**, name it, then under **Target users** click **Add account** and log in with the Pintag TikTok account to authorize it as a tester (up to 10 target users per sandbox). This is the path that doesn't require App Review; "Configure for Desktop" under the production app does (confirmed).
4. **The Sandbox app has its own Client Key and Client Secret — separate from any production app's.** Reveal them via the eye icon on the Sandbox app's page. **This is the most common reason TikTok rejects the client_key**: using the production app's credentials while testing through Sandbox (or vice versa) — the OAuth URL is otherwise correctly formed, but TikTok treats these as two distinct credential pairs and rejects a mismatched one. Use the Sandbox app's own Client Key/Secret in `.env.local` while testing.
5. **Where the redirect URI itself is entered within this Sandbox/Login Kit flow is not yet confirmed against the live portal** — TikTok's docs describe Login Kit becoming configurable once a target user is added, but the exact field/button wasn't observable through documentation alone. If you find it, tell me exactly what it's called and where, and this step gets corrected with certainty. Whatever field you find, the value is fixed either way — it's not something you choose:
   ```
   http://127.0.0.1:4322/callback
   ```
   It doesn't need to be a live server — TikTok redirects the browser there with an authorization code in the query string, which you paste back into the CLI even if the page itself 404s. Already filled in for you in `.env.example`'s `TIKTOK_REDIRECT_URI` — leave that line as-is when you copy it to `.env.local`. Wherever TikTok asks for a platform/app type for this specifically, choose **Desktop, not Web** — Web-platform redirect URIs must be a real `https://` domain you own; Desktop-platform ones allow this local loopback address with no domain needed, which is what this tool (a local CLI script, not a hosted server) actually requires.
6. Request these scopes: `user.info.basic`, `user.info.stats`, `video.list`.
7. Set as GitHub Actions secrets (and locally, in `.env.local` — see `FIRST_TIME_SETUP.md`): `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` (the Sandbox app's — see step 4), `TIKTOK_REDIRECT_URI` (the value above).
8. Run migration `0004_observation_sources.sql` if you haven't already (step 1 above).
9. Run `npm run tiktok:connect` once — it prints the exact redirect URI and a reminder to double-check your credentials are the Sandbox app's, then an authorization URL. Approve it as the Pintag TikTok account (the one added as a Target user in step 3), and paste back the resulting redirect URL (or just the `code` from it). This stores the access/refresh token pair in Supabase (`observation_source_tokens`); the pipeline refreshes it automatically after that. If `TIKTOK_REDIRECT_URI` in `.env.local` doesn't match the value above, or `TIKTOK_CLIENT_KEY`/`SECRET` are missing, `npm run tiktok:connect` says so plainly rather than failing partway through.

**Moving to production later** (once genuinely publishing/reading beyond your own test account): submit the sandbox-tested integration for App Review from the production app — that's the "Configure for Desktop" flow you already found, now with a working, sandbox-verified integration behind it rather than an untested one.

Not needed until you want real TikTok data in the Daily Briefing — everything else in this repo works without it (`collectObservations()` degrades gracefully and says so honestly if TikTok isn't connected).

## 9. Marketing OS Morning Brief on your phone — reading it (read-only)

> **Note:** this section covers *reading* the brief on your phone with no backend at all. To also **generate** a brief from your phone, do section 10 as well.


Lets you read the latest Morning Brief from your phone (`marketing-os.html`, repo root, on the live site) without your machine needing to be on. Generation stays exactly as it already is — local, on the Claude Code CLI, via `npm run daily-briefing` (or the "Generate Today's Briefing" button in `founder-server.ts`) — nothing runs in the cloud. `marketing-os.html` is a **read-only client**: it doesn't run Marketing OS, it just displays whatever `daily-briefing.ts` last published. See `ARCHITECTURE.md` §0 for the generation-vs-publication distinction this rests on.

Deliberately uses a **separate Supabase Auth login from `admin.html`'s** — same project as everything else in this file (pintag-studio's), not the main site's — so this stays fully self-contained and movable to a future `marketingos.ai` deployment without a data migration, just a hosting change.

1. Run migration `0005_morning_brief_publish.sql` if you haven't already (step 1 above, same project).
2. Create one real Supabase Auth user in the pintag-studio project for this page (Supabase Dashboard → Authentication → Users → Add user). Any email/password works; `marketing-os.html`'s `FOUNDER_EMAIL` constant defaults to `admin@pintag.io` to match `admin.html`'s convention — change it there if you use a different address.
3. Open `marketing-os.html` and replace `SUPABASE_URL`/`SUPABASE_ANON` (currently placeholders, same convention as `dashboard/index.html`) with pintag-studio's real project URL and anon key (Supabase Dashboard → Project Settings → API).
4. Run `npm run daily-briefing` once (same command as always — this now also syncs to Supabase as its last step, logging a warning rather than failing if that sync doesn't succeed).
5. Visit `marketing-os.html` on the live site and sign in with the account from step 2.

No GitHub Actions secrets, no workflow to run, no `ANTHROPIC_API_KEY` — there's nothing running in CI for this feature.

Optional, unrelated nicety while you're in there: step 2's new user also works to finally wire up `dashboard/index.html`'s Auth client (its `SUPABASE_URL`/`SUPABASE_ANON` are the same still-unfilled placeholders as `marketing-os.html`'s were) — not required for this feature, just a loose end you're already touching.

## 10. Generating the Morning Brief from your phone (deployed Founder Workspace, M2.11)

Section 9 makes the brief *readable* anywhere. This section makes it *generatable* anywhere — a **Generate New Brief** button on `marketing-os.html` that runs the real pipeline, so you never need to be at your machine.

**What this deploys.** `pipeline/founder-server.ts`, unchanged in behavior, running as a small always-on service. The generate endpoint calls `generateDailyBriefing()` — the exact same function `npm run daily-briefing` calls. Same collection, same agents, same validation, same Supabase publish.

**Read this before you start — two honest caveats:**

1. **The LLM provider changes.** The default provider shells out to the `claude` CLI, which needs an interactive login that can't happen in a container. A deployed instance runs `LLM_PROVIDER=anthropic-api` with an `ANTHROPIC_API_KEY` instead (`pipeline/lib/llm.ts`). Identical prompts and parsing, but a different provider path — so wording can differ slightly between a phone-generated brief and a locally-generated one. This is a property of the runtime, not a change to the pipeline. It also means **generation now costs API credits directly** rather than going through your Claude subscription.
2. **This is a real internet-facing service.** Almost every route on this server mutates state (approving knowledge, saving campaign reviews, regenerating departments) or spends LLM budget. It is therefore protected by mandatory auth on **every** route, and `founder-server.ts` **refuses to start** if you ask it to bind a public address without auth properly configured. Don't work around that check.

**Steps:**

1. Get an Anthropic API key (console.anthropic.com → API Keys). Set a spend limit on it — this key is what a Generate tap actually spends.
2. Deploy. Fly.io is pre-configured (`fly.toml`, `Dockerfile` in this directory):
   ```bash
   cd pintag-studio
   fly launch --no-deploy --name marketing-os     # pick your own app name
   fly secrets set \
     SUPABASE_URL='https://<project>.supabase.co' \
     SUPABASE_ANON_KEY='<anon key>' \
     SUPABASE_SERVICE_ROLE_KEY='<service role key>' \
     MARKETING_OS_FOUNDER_EMAIL='ninee@pintag.io' \
     MARKETING_OS_ALLOWED_ORIGINS='https://pintag.io' \
     ANTHROPIC_API_KEY='<your key>'
   fly deploy
   ```
   Any host that runs a container works the same way (Render, Railway, a VPS) — the env vars are what matter, not the platform.
3. Confirm it's up and in the right mode: `curl https://<your-app>/healthz` should return `{"ok":true,"authRequired":true}`. If `authRequired` is `false`, stop — auth isn't on.
4. In `marketing-os.html` (repo root), set `MARKETING_OS_API` to your deployed origin, e.g. `'https://marketing-os.fly.dev'`, and add that same origin to the file's `Content-Security-Policy` → `connect-src`. Commit and let GitHub Pages redeploy.
5. Open `https://pintag.io/marketing-os.html` on your phone, sign in (same account as section 9 — one login, not a second one), and tap **Generate New Brief**.

**What the env vars do:**

| Variable | Purpose |
|---|---|
| `HOST` | `0.0.0.0` to accept outside traffic. Unset/loopback = local mode, no auth. |
| `MARKETING_OS_REQUIRE_AUTH` | Must be `true` for any public deployment. Enforces auth on every route. |
| `SUPABASE_URL` | Also used to verify access tokens against Supabase Auth. |
| `SUPABASE_ANON_KEY` | Used to *verify* the founder's token. Not the service role key — deliberately. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side pipeline writes (publishing the brief). Never sent to a browser. |
| `MARKETING_OS_FOUNDER_EMAIL` | Only this account may use the workspace; any other valid Supabase user is rejected. |
| `MARKETING_OS_ALLOWED_ORIGINS` | CORS allowlist for browser calls. Never `*` — a wildcard plus bearer tokens would let any site you visit drive Marketing OS. |
| `ANTHROPIC_API_KEY` | Required because the container can't use the interactive `claude` CLI. |

**Troubleshooting:**

- *Button doesn't appear* → `MARKETING_OS_API` is still empty in `marketing-os.html`. That's the intended read-only state.
- *401 Unauthorized* → the signed-in email doesn't match `MARKETING_OS_FOUNDER_EMAIL`, or the session expired (reload and sign in).
- *Origin not allowed (403)* → add your site's exact origin to `MARKETING_OS_ALLOWED_ORIGINS`.
- *Server won't start* → read the boot log; the fail-closed guard names exactly which variable is missing.
- *"Generation failed: ... ANTHROPIC_API_KEY"* → the key isn't set, or `LLM_PROVIDER` isn't `anthropic-api`.

For where this is heading beyond an always-on process, see [`EXECUTION_ARCHITECTURE.md`](./EXECUTION_ARCHITECTURE.md).

## 11. Run history (autonomy roadmap step 1)

Apply migration `0006_pipeline_runs.sql` (same project, same way as the others — step 1 of section 1). Then every Morning Brief generation and campaign execution is recorded durably, and **Runs** appears in the Founder Workspace with what ran, when, how long it took, what it produced, what failed, and what it cost.

**This is optional to apply and safe to defer.** The ledger degrades to a no-op if the migration isn't there: runs still execute normally, the workspace logs one warning, and the Runs page tells you history may be incomplete. Nothing breaks — recording work must never be able to prevent work.

Why it matters beyond convenience: run state used to live in memory and die with the process. Durable records are what let the Morning Brief eventually *report on completed work* instead of generating it on demand — see `EXECUTION_ARCHITECTURE.md` §7 and §8.1.

## Daily use — starting Marketing OS (no Terminal needed)

Once step 1 (Supabase) is done, this is the everyday way to open Marketing OS — the Founder Workspace (`npm run founder-ui`) is the browser front end for everything else in this file.

1. **One-time only:** copy `.env.example` to `.env.local` (same folder, `pintag-studio/`) and fill in `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from step 1. Any text editor works — no Terminal needed for this either.
2. **Every day:** double-click `Start Marketing OS.command` in Finder. A window opens showing it starting up, and your browser opens automatically to the Founder Workspace a couple seconds later. **Closing that window stops Marketing OS** — the same as closing any other app.

If macOS says it can't verify the developer the first time you double-click it, right-click the file and choose "Open" once instead — after that it opens normally.

`PORT` defaults to 4321 if you ever need a different one (`PORT=5000` before the command, same as any other env var here; e.g. `PORT=3000 npm run founder-ui` if you're running the server directly rather than via the `.command` launcher).

**The Morning Brief (M2.9)** — `GET /morning` is the primary daily screen (Executive Summary, Market Intelligence, Company Health, Department Updates, Recommended Action, Today's Priorities, Risks, Opportunities), replacing `dashboard/morning.html` as the default destination from the Founder Workspace home page. It renders instantly from the last-generated briefing and regenerates in the background when stale (see `morning_brief` in `brain/org-config.json`) — never a blank page waiting on an LLM call. `npm run daily-briefing` (the terminal path) still works unchanged for development, and still writes `dashboard/morning.html` for backward compatibility.

**Restarting after a `git pull`:** this is a plain long-running Node process with no hot-reload — if `Start Marketing OS.command` finds a server already responding, it just reopens your browser to it rather than restarting it. After pulling code changes, fully quit the running server (close its window / `Ctrl+C`) before relaunching, or it'll keep serving the old code.

**Production deploy** (`https://marketingos.ai` or similar) is intentionally not set up yet — this stays a stateful Node process (not a static site), so it will eventually need a persistent-process host (e.g. Fly.io, Render, or a VPS you manage) plus DNS/TLS for a real domain. Nothing here blocks that later; it just isn't built in this pass.

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
