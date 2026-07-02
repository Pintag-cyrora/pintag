# Setup — manual steps only the founder can do

Everything in this repo is scaffolded to run once these are in place. None of it can be automated on your behalf since each step needs your own accounts/credentials.

## 1. Supabase project

1. Create a **new, separate** Supabase project (do not reuse the production pintag.io project — see `ARCHITECTURE.md` Section 1 for why).
2. Run the migration: `supabase/migrations/0001_init_control_plane.sql` (via the Supabase SQL editor, or the Supabase CLI once linked).
3. Create one Supabase Auth user for yourself (email + password) — this is the account the Dashboard signs in as.
4. Collect these values:
   - Project URL and anon key → paste into `dashboard/index.html` (`SUPABASE_URL`, `SUPABASE_ANON`)
   - Project URL and **service role** key → set as GitHub Actions secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (used by the headless pipeline; never put the service role key in the dashboard)

## 2. Meta (Facebook + Instagram)

1. Create a Meta Developer app at developers.facebook.com.
2. Link your Pintag Facebook Page and its connected Instagram Business account.
3. Generate a long-lived Page access token with `pages_manage_posts`, `pages_read_engagement`, and `instagram_content_publish` permissions.
4. Set the token as a GitHub Actions secret (`META_PAGE_ACCESS_TOKEN`) once `pipeline/stages/08-publish.ts` is implemented (M2).

## 3. Canva

Confirm your Canva account has Connect API / Brand Template access. Create the Brand Templates listed in `brand-assets/canva-templates.json` (currently placeholders with `canva_template_id: null`) and fill in their real template IDs once created.

## 4. Text-to-speech

Default recommendation is Google Cloud TTS (free tier covers this volume — see `ARCHITECTURE.md` Section 6). Create a Google Cloud project, enable the Text-to-Speech API, and set the resulting credentials as a GitHub Actions secret when `pipeline/stages/05-video.ts` is implemented (M4).

## 5. Read-only listings feed (main `pintag` repo)

The main repo's `supabase/functions/public-listings-feed` edge function (added alongside this scaffold) needs to be deployed to the **production** pintag.io Supabase project. It's read-only and returns only already-public listing fields — deploy it the same way as the repo's other edge functions.

## 6. Dashboard hosting

`dashboard/index.html` is a single static file — host it anywhere static (GitHub Pages, Vercel, Netlify, or just open it locally). No build step required. Bookmark it; per the architecture, it's meant to be your daily homepage.

## What's NOT needed yet

Nothing above needs to happen before you're ready to start M1 (see `ARCHITECTURE.md` Section 11) — steps 3-4 (Canva, TTS) aren't required until M2/M4. Start with step 1 (Supabase) and step 6 (host the dashboard, even empty) so you get in the habit of checking it daily from day one, per your own instruction.
