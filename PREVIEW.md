# Pintag Dev/Prod Deployment

Two live websites, kept isolated by construction:

| | Branch | Repo | Website | Supabase project |
|---|---|---|---|---|
| **Production** | `main` (`pintag`) | `Pintag-cyrora/pintag` | `pintag.io` | `eoladhcljbpbhnrmmpev` |
| **Development** | `dev` (`pintag`) | mirrored into `Pintag-cyrora/pintag-dev` | `pintag-cyrora.github.io/pintag-dev/` | `ebtgoqrywdywuqrvudcp` |

`config.js` is never committed — it's generated at deploy time from `config.prod.js` or `config.dev.js` (both committed, identical on every branch). A dev deploy can never contain production's key, and vice versa, because the file that would need to be wrong simply doesn't exist until the correct deploy step creates it.

## Everyday workflow

1. Branch off `dev` (or commit directly to `dev` for small changes).
2. Push to `dev` → **`deploy-dev.yml`** runs automatically → the `pintag-dev` repo's site updates within ~1–2 minutes.
3. Open `https://pintag-cyrora.github.io/pintag-dev/` on your phone. Confirm the orange **DEV** banner is visible — that's the ground-truth check that you're on the dev database, not production, regardless of what the URL says.
4. Test the feature for real, against the live `ebtgoqrywdywuqrvudcp` Supabase project.
5. **Verify production isolation** (required before every merge):
   - [ ] the change/test data appears on the dev site
   - [ ] it does **not** appear on `pintag.io`
   - [ ] it does **not** exist in the production Supabase project's tables
6. Open a PR merging `dev` → `main`. On merge, **`deploy-prod.yml`** runs automatically and `pintag.io` updates within ~1–2 minutes.

No Codespace, no port-forwarding, no manual server-starting — the dev site is always on, the same way production is.

## If a branch adds new database schema

Deploying the *website* is fully automatic (above). Getting new tables/columns onto the `pintag-dev` **database** is a separate, manual step for now:

- [ ] Apply any new `supabase/migrations/*.sql` files to `pintag-dev` (`supabase link --project-ref ebtgoqrywdywuqrvudcp` + `supabase db push`, run from a machine with normal network access — see the repo's earlier bootstrap notes for why this can't run from a sandboxed session)
- [ ] Deploy any new/changed edge functions (`supabase functions deploy <name> --project-ref ebtgoqrywdywuqrvudcp`)

Known gap: the base schema (`properties`, `parties`, `contacts`, `lead_events`, `listing_events`) can't be fully recreated by `supabase db push` alone on a brand-new project, since the original tables predate tracked migrations. Tracked in [#37](https://github.com/Pintag-cyrora/pintag/issues/37) — once fixed, provisioning a fresh dev/staging project becomes a single command.

## One-time setup (reference — already done unless noted)

- [ ] `pintag-dev` Supabase project created
- [ ] `pintag-dev` GitHub repo created (empty; the first `deploy-dev.yml` run populates it)
- [ ] Fine-grained PAT created, scoped to `pintag-dev` only, `Contents: Read and write`, stored as the `PINTAG_DEV_DEPLOY_TOKEN` secret in the `pintag` repo
- [ ] GitHub Pages enabled on `pintag-dev` (source: branch `main`, root) — do this *after* the first successful `deploy-dev.yml` run, once there's something to serve
- [ ] `pintag`'s Pages source flipped from "Deploy from a branch" to **"GitHub Actions"** (Settings → Pages) — do this only after dry-running `deploy-prod.yml` via `workflow_dispatch` and confirming the build artifact looks right, to avoid a breakage window
- [ ] `config.dev.js` / `config.prod.js` contain real values (not placeholders)

## Notes

- There is no hostname-detection logic anymore — which environment a page uses is decided entirely by which deploy pipeline generated its `config.js`, not by guessing from `window.location.hostname`. This is deliberately stronger than the earlier approach: a dev deploy is structurally incapable of shipping production's key.
- The DEV banner (`dev-banner.js`) reads `window.PINTAG.tag`/`.label` and is the human-facing ground-truth check — if it's missing, you're looking at production.
- `main` = stable production. `dev` = ongoing integration/testing. Short-lived feature branches are created from `dev`, not from `main`.
- Fallback: a GitHub Codespace with `python3 -m http.server` + port forwarding still works for one-off testing of a branch that hasn't been merged into `dev` yet, if you want to preview something before it's ready for the shared dev site. Point `config.js` at `config.dev.js`'s content locally (`cp config.dev.js config.js`, never commit that copy) to test against the dev database this way.
