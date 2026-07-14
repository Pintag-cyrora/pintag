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

**Honest heads-up:** step 6 below needs Terminal, once. Every other capability in this guide works entirely from your browser — this is the one exception, because TikTok itself requires you to personally approve access in a login screen, which isn't something a web page here can do on its own yet. Making this a real one-click browser button instead is a reasonable future improvement, just not built yet.

> Same note as the Supabase section: I can't screenshot TikTok's own Developer site since I don't have access to it. The value below is exact and won't change — that part doesn't depend on what TikTok's page looks like.

1. Go to [developers.tiktok.com](https://developers.tiktok.com) and create a Developer app. TikTok will ask what **type** of app this is — choose **Desktop**, not Web.
2. Add the **Login Kit** product to your app.
3. TikTok will ask for a **Redirect URI**. Enter this exactly, including `http://`:
   ```
   http://127.0.0.1:4322/callback
   ```
   This is fixed — Marketing OS is already built around this exact value, so there's nothing to decide here. It won't open a real page if you visit it; that's expected.
4. TikTok will give you a **Client Key** and a **Client Secret**. Switch to TextEdit, where `.env.local` is open, and find these two lines near the bottom:
   ```
   TIKTOK_CLIENT_KEY=
   TIKTOK_CLIENT_SECRET=
   ```
   Paste your Client Key and Client Secret after each `=`. Leave the `TIKTOK_REDIRECT_URI=` line beneath them exactly as it already is — it's already set to the value from step 3. Save the file (`Cmd + S`).
5. Restart Marketing OS if it's currently running (close the window, double-click `Start Marketing OS.command` again).
6. This last step needs Terminal, just this once — everything else in this guide doesn't. Open the **Terminal** app (`Cmd + Space`, type `Terminal`, press Enter), type:
   ```
   cd
   ```
   then drag your `pintag-studio` folder from Finder into the Terminal window and press Enter — that moves Terminal into the right folder without you having to type a path. Then type:
   ```
   npm run tiktok:connect
   ```
   and press Enter. It'll print a link — open it, log into TikTok as the Pintag account, and approve it. Your browser will land on a page that looks broken (`127.0.0.1 refused to connect` or similar) — that's expected, nothing is supposed to load there. Copy the entire address from your browser's address bar and paste it back into Terminal when it asks, then press Enter.

You should see "Connected." Close Terminal — you're done, and won't need to open it again for this. From tomorrow's briefing onward, "Generate Morning Briefing" will include real TikTok data.

---

## If something doesn't work

- **Nothing happens when you double-click `Start Marketing OS.command`.** Make sure you completed Section 1 and 2 first — Marketing OS can't start without a valid `.env.local`.
- **Your browser shows an error page instead of the Founder Workspace.** Wait a few seconds and refresh — it can take a moment to start the first time.
- **You're not sure if it's already running.** Just double-click `Start Marketing OS.command` again — it detects that and opens your browser instead of starting a second copy.
- **Anything else.** See `SETUP.md` for the fuller, more technical reference this document is a friendlier front door to.
