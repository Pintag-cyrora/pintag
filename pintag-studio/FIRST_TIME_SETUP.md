# First-Time Setup

*Written for a founder, not a developer. If you're reading this six months from now and have forgotten everything about how this was built — that's fine, that's what this document is for. Just follow the steps in order.*

This is a one-time setup. It takes about 10 minutes. After it's done, your daily routine is just [Section 4](#4-daily-usage) — one double-click.

---

## 1. Create `.env.local`

This is your personal settings file — it holds your own private keys, and only you have it. It's never shared or uploaded anywhere.

1. Open the **TextEdit** app (it's already on your Mac — press `Cmd + Space`, type `TextEdit`, press Enter).
2. In TextEdit's menu bar, click **File → Open**.
3. Press `Cmd + Shift + G` — a small "Go to Folder" box appears. Type or paste the path to your `pintag-studio` folder and press Enter.
4. You're looking for a file called `.env.example`. Files that start with a dot are hidden by default — if you don't see it, press `Cmd + Shift + .` (period) while the Open window is open to reveal it.
5. Select `.env.example` and click **Open**.
6. In the menu bar, click **File → Save As...**. Change the name to exactly:
   ```
   .env.local
   ```
   (the dot at the start matters). Make sure it's still saving into the same `pintag-studio` folder, then click **Save**.

That's it — you now have your own `.env.local` file. **You only do this once.** The next section fills in two values inside it.

---

## 2. Connect to Supabase

Supabase is the database Marketing OS uses to remember things like which posts are waiting for your approval. You already created this project during the original setup — this step just tells Marketing OS how to find it.

> I can't include a real screenshot of your project here since I don't have access to it — but Supabase's dashboard uses these exact labels, so follow the text below. If it ever looks different because Supabase has redesigned something, their own help site ([supabase.com/docs](https://supabase.com/docs)) will always have the current version.

1. Go to [supabase.com](https://supabase.com) in your browser and log in. Open your Pintag project.
2. In the left sidebar, click the gear icon ⚙️ labeled **Project Settings**.
3. Click **API Keys** (older versions of Supabase label this just **API**).
4. Near the top, find a field called **Project URL**. It looks like `https://xxxxxxxxxxxx.supabase.co`. Click the copy icon next to it.
5. Supabase has two "eras" of keys. If you see tabs, click the one labeled **Legacy API Keys** — Marketing OS needs the older-style key, called **service_role**. (Do **not** use the one called `anon` or `public` — that one is intentionally limited and won't work here.) Click the copy icon next to **service_role**. Treat this like a password — anyone with it can read and change everything in your database.
6. Switch back to TextEdit, where `.env.local` is open. You'll see two lines near the top:
   ```
   SUPABASE_URL=
   SUPABASE_SERVICE_ROLE_KEY=
   ```
   Paste your **Project URL** right after `SUPABASE_URL=`, and your **service_role** key right after `SUPABASE_SERVICE_ROLE_KEY=` — no spaces, no quotation marks.
7. Save the file: `Cmd + S`.

You can leave every other line in `.env.local` blank for now — they're optional, for things you haven't set up yet (like TikTok — see [Section 5](#5-connect-tiktok-optional)).

---

## 3. Start Marketing OS

1. In Finder, open the `pintag-studio` folder.
2. Double-click **`Start Marketing OS.command`**.
3. The first time only: macOS may show a warning that it can't verify the developer. Right-click (or Control-click) the file instead, choose **Open**, then confirm. You won't see this warning again after that.
4. A small window opens — that's normal, that's Marketing OS starting up. A couple of seconds later, your web browser opens automatically to your **Founder Workspace**. You're in.

---

## 4. Daily Usage

Once the one-time setup above is done, this is your entire daily routine:

1. Double-click **`Start Marketing OS.command`**.
2. Wait a couple of seconds for your browser to open.
3. Click **Generate Morning Briefing**.
4. Click **Open CEO Workspace** and read it.
5. Click **Teach Marketing OS** if there's something you'd have done differently.
6. Click **Review Knowledge** if anything is waiting for a decision.
7. When you're done for the day, close the window that opened in step 1 — that stops Marketing OS, the same way closing any other app would.

That's the whole thing. No commands to type, no files to find, no code to read.

---

## 5. Connect TikTok (optional)

This step is what lets Marketing OS talk about your actual TikTok performance in the morning briefing — real view counts, not just internal knowledge. Everything in Sections 1–4 works fine without it; do this whenever you're ready, not before.

**Honest heads-up:** step 10 below needs Terminal, once. Every other capability in this guide works entirely from your browser — this is the one exception, because TikTok itself requires you to personally approve access in a login screen, which isn't something a web page here can do on its own yet. Making this a real one-click browser button instead is a reasonable future improvement, just not built yet.

> Same note as the Supabase section: I can't screenshot TikTok's own Developer site since I don't have access to it. Two things below have been confirmed against the real site (thank you for testing and reporting back): "Configure for Desktop" on a normal app leads straight to a review process, and "URL Properties" is a different feature entirely. One thing is still unconfirmed — exactly where the redirect URI field appears inside Sandbox mode — flagged below rather than guessed at. If anything still doesn't match what you see, tell me exactly what's on your screen and this gets corrected precisely, not guessed at again.

1. Go to [developers.tiktok.com](https://developers.tiktok.com) and create a Developer app.
2. Find **Login Kit** among the available products and add it to your app. **Don't go looking in a section called "URL Properties"** — that's for a different TikTok feature (publishing content directly, which Marketing OS doesn't do).
3. **Don't click "Configure for Desktop" yet either** — on a normal app that leads straight into a review process asking for demo videos, which isn't what you want for testing. Instead, look for a **Production/Sandbox switch near your app's name**, and switch it to **Sandbox**. Click **Create Sandbox**, give it any name.
4. Under **Target users**, click **Add account** and log in with the Pintag TikTok account — this authorizes that account to test with this sandbox.
5. On the Sandbox app's page, find the **Client Key** and **Client Secret** — there should be an eye icon to reveal them. **These are different from any production app's Client Key/Secret** — TikTok treats them as two separate pairs, and using the wrong one is the most common reason the connection gets rejected. Use the Sandbox app's own values.
6. Somewhere in this Sandbox/Login Kit setup, TikTok will ask for a **Redirect URI** — exactly where isn't confirmed yet, so look around the Login Kit configuration for this sandbox specifically. Enter this exactly, including `http://`:
   ```
   http://127.0.0.1:4322/callback
   ```
   This value is fixed — Marketing OS is already built around it, so there's nothing to decide here. It won't open a real page if you visit it; that's expected. If TikTok also asks what **type** of app/platform this redirect URI is for, choose **Desktop**, not Web.
7. Switch to TextEdit, where `.env.local` is open, and find these two lines near the bottom:
   ```
   TIKTOK_CLIENT_KEY=
   TIKTOK_CLIENT_SECRET=
   ```
   Paste the **Sandbox app's** Client Key and Client Secret (from step 5) after each `=`. Leave the `TIKTOK_REDIRECT_URI=` line beneath them exactly as it already is. Save the file (`Cmd + S`).
8. Restart Marketing OS if it's currently running (close the window, double-click `Start Marketing OS.command` again).
9. Marketing OS needs one more thing from Supabase before it can remember your TikTok connection between runs — a small table to hold the login token. This is a one-time step, still entirely in your browser: go to your Supabase project (same one from Section 2), click **SQL Editor** in the left sidebar, then **New query**. In TextEdit (or Finder's Quick Look), open the file `supabase/migrations/0004_observation_sources.sql` inside your `pintag-studio` folder, select all its contents, and paste them into the SQL Editor. Click **Run**. You should see a success message at the bottom — that's it, this never needs to be done again.
10. This last step needs Terminal, just this once — everything else in this guide doesn't. Open the **Terminal** app (`Cmd + Space`, type `Terminal`, press Enter), type:
   ```
   cd
   ```
   then drag your `pintag-studio` folder from Finder into the Terminal window and press Enter — that moves Terminal into the right folder without you having to type a path. Then type:
   ```
   npm run tiktok:connect
   ```
   and press Enter. It'll print a link — open it, log into TikTok as the Pintag account, and approve it. Your browser will land on a page that looks broken (`127.0.0.1 refused to connect` or similar) — that's expected, nothing is supposed to load there. Copy the entire address from your browser's address bar and paste it back into Terminal when it asks, then press Enter.

You should see "✓ Connected to TikTok" along with your account's username, follower count, and video count — that's Marketing OS confirming it actually reached your real account, not just that it saved something. Close Terminal — you're done, and won't need to open it again for this. From tomorrow's briefing onward, "Generate Morning Briefing" will include real TikTok data.

---

## If something doesn't work

- **Nothing happens when you double-click `Start Marketing OS.command`.** Make sure you completed Section 1 and 2 first — Marketing OS can't start without a valid `.env.local`.
- **Your browser shows an error page instead of the Founder Workspace.** Wait a few seconds and refresh — it can take a moment to start the first time.
- **You're not sure if it's already running.** Just double-click `Start Marketing OS.command` again — it detects that and opens your browser instead of starting a second copy.
- **Anything else.** See `SETUP.md` for the fuller, more technical reference this document is a friendlier front door to.
