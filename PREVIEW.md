# Pintag Preview Checklist

Run through this every time a feature branch needs phone testing before merge.
Everything stays within GitHub + Supabase — no third-party hosting platform.

## One-time setup (already done, kept here for reference)

- [ ] `pintag-dev` Supabase project created and reachable
- [ ] `config.js` has the real `pintag-dev` project URL and anon key filled in (not the `PINTAG_DEV_PROJECT_REF` / `PINTAG_DEV_ANON_KEY` placeholders)

## Every branch, before merge

- [ ] **Update `pintag-dev` schema** — apply any new `supabase/migrations/*.sql` files this branch adds
- [ ] **Apply migrations** — `supabase link --project-ref <pintag-dev-ref>` + `supabase db push`, or run new files directly with `psql`
- [ ] **Deploy required edge functions** — `supabase functions deploy <name> --project-ref <pintag-dev-ref>` for any function this branch touches
- [ ] **Open Codespace** — GitHub → Code → Codespaces → Create codespace on branch
- [ ] **Forward port 8080** — run `python3 -m http.server 8080` from the repo root, then in the Codespace's Ports panel forward port 8080 and set visibility to **Public**
- [ ] **Test Admin** — log into `admin.html`, confirm the orange DEV banner is visible on every page
- [ ] **Test Buyer Contact** — create a listing with a Contact and no Agent selected
- [ ] **Test Listing** — confirm the contact band renders on `listing.html`, and no Agent Profile card appears when no agent is linked
- [ ] **Test Search** — confirm `listings.html` shows the correct role label, with no "Pintag Agent" badge unless a real agent is linked
- [ ] **Verify production is unchanged** (required before every merge):
  - [ ] the test listing appears in `pintag-dev` (`listings.html`/`listing.html` on the preview URL)
  - [ ] the same listing does **not** appear on the live production site (`pintag.io`)
  - [ ] the same listing does **not** exist in the production Supabase project's `properties` table
- [ ] **Stop Codespace**

## Notes

- Hostname detection lives in one place: `detectEnvironment()` in `config.js`. It defaults to development for any unrecognized host, and only treats `pintag.io`, `www.pintag.io`, and `pintag-cyrora.github.io` as production. Add a new domain there only when Pintag genuinely adds one — never add preview/dev hosts, they're supposed to fall through to the default.
- The DEV banner (`dev-banner.js`) is the ground-truth check — if it's missing, you're on production, whatever the URL says.
- Known gap: the base schema (`properties`, `parties`, `contacts`, `lead_events`, `listing_events`) can't be fully recreated by `supabase db push` alone on a brand-new project, since the original tables predate tracked migrations. Tracked in [#37](https://github.com/Pintag-cyrora/pintag/issues/37).
