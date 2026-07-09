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

Known gap: `properties` and `agents`/`parties` can't be recreated by `supabase db push` (or by running `supabase/migrations/*.sql` in order) on a brand-new/empty project — those two tables were created by hand in the Supabase dashboard before migrations were tracked, so the earliest tracked migration already assumes they exist and fails immediately against an empty schema. Tracked in [#37](https://github.com/Pintag-cyrora/pintag/issues/37) — once fixed, provisioning a fresh dev/staging project becomes a single `supabase db push`.

**If `pintag-dev`'s `public` schema is ever empty** (fresh project, or recovering from a wipe), bootstrap it first with `scripts/bootstrap-dev-db.sh` (see below) before applying any migrations — confirmed necessary in practice (2026-07-09): the dev project's schema had never actually been populated, so testing frontend behavior alone didn't surface it until an actual save was attempted.

## Bootstrapping a fresh/empty pintag-dev schema

`scripts/bootstrap-dev-db.sh` takes a schema-only `pg_dump` of production's *current* structure and restores it into `pintag-dev`, sidestepping the untracked-base-schema gap above entirely — it reflects what the tables look like today, regardless of which migration (tracked or not) created them. Run it from a machine with normal network access (not a sandboxed session):

```
PINTAG_PROD_DB_URL="<production Session Pooler connection string>" \
PINTAG_DEV_DB_URL="<pintag-dev Session Pooler connection string>" \
./scripts/bootstrap-dev-db.sh
```

Notes:
- Schema only — zero rows. Run `scripts/seed-dev-from-prod.sh` afterward for realistic sample data.
- Only reflects migrations already live in production. Anything newer (e.g. a migration still pending review) needs applying on top separately, the same as you'd apply it to production.
- Not destructive — it doesn't drop or truncate anything, so if `pintag-dev` already has tables, it fails loudly (and safely) on the first "already exists" rather than silently double-applying.
- The one edit this makes to the raw `pg_dump` output: it strips the unconditional `CREATE SCHEMA public;` line, since every Supabase project already has a `public` schema (with its own default grants) and that line otherwise fails with "schema already exists." Nothing else is touched — deliberately not using `pg_dump --clean --if-exists`, since that would `DROP SCHEMA public CASCADE` and, combined with `--no-privileges`, permanently lose Supabase's default `anon`/`authenticated`/`service_role` grants on the schema.

## Refreshing dev data from production

`scripts/seed-dev-from-prod.sh` copies a redacted, representative snapshot of production listings into `pintag-dev` — real properties/parties/contacts for realistic UI testing, with `lead_events`/`listing_events` (analytics, buyer behavior) never copied and phone/WhatsApp numbers replaced with an obvious placeholder. Run it from a machine with normal network access (not a sandboxed session):

```
PINTAG_PROD_DB_URL="<production Session Pooler connection string>" \
PINTAG_DEV_DB_URL="<pintag-dev Session Pooler connection string>" \
./scripts/seed-dev-from-prod.sh
```

It's destructive to `pintag-dev`'s current `properties`/`parties`/`contacts` (asks for confirmation first) and hard-refuses to run against anything that isn't `pintag-dev`. See the script's header comment for exactly what's copied, redacted, and excluded.

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
