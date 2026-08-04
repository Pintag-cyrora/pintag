# Supabase Authentication URL Configuration (authoritative)

Single source of truth for the **Site URL** and **Redirect URLs** of each Pintag
Supabase project. If a recovery / magic-link email ever redirects to
`localhost` again, the fix is here — not in application code.

## Why this document exists

The password-reset flow was redirecting to `http://localhost:3000`. Root cause
(verified from the codebase, 2026-08-04):

1. **The application never overrode the redirect.** There is no
   `resetPasswordForEmail`, `signInWithOtp`, magic-link, `redirectTo`, or
   `emailRedirectTo` call anywhere in the app — the four auth entry points
   (`admin-auth.js`, `agent-login.html`, `marketing-os.html`,
   `pintag-studio/dashboard/index.html`) all use `signInWithPassword` only.
2. **So recovery used the project's Site URL.** With no `redirectTo`, Supabase
   GoTrue falls back to the dashboard **Site URL**.
3. **`localhost:3000` came from the dashboard, not the repo.** It is Supabase's
   factory-default Site URL that was never changed for the hosted project.
4. **The only `3000` in the repo is `supabase/config.toml`** (lines 159/163),
   which configures the **local Supabase CLI emulator** (`supabase start`). It
   **must not** be used as the hosted production configuration and must not be
   pushed to the hosted project.

As of the same date the app now **also** sets an explicit `redirectTo` for
password recovery (see "What the code now does" below), so future resets are
deterministic even if a Site URL is ever misconfigured again. The dashboard
values below are still required — they are the allow-list GoTrue checks the
`redirectTo` against, and the Site URL is the fallback for any dashboard-
initiated recovery email.

## Environments (from `PREVIEW.md` and `config.js`)

| | Website (canonical) | Supabase project ref |
|---|---|---|
| **Production**  | `https://pintag.io` | `eoladhcljbpbhnrmmpev` |
| **Development** | `https://pintag-cyrora.github.io/pintag-dev/` | `ebtgoqrywdywuqrvudcp` |

Production and development are **separate Supabase projects.** The dev website
authenticates against the dev project, so the production project never
legitimately redirects to a dev URL — keep each project's allow-list to its own
environment. (This is why the dev URLs below live on the dev project, not on
production.)

---

## Production project — `eoladhcljbpbhnrmmpev`

**Authentication → URL Configuration**

- **Site URL:**
  ```
  https://pintag.io
  ```
- **Redirect URLs (allow-list):**
  ```
  https://pintag.io/reset-password.html
  ```

That single exact URL is the only post-auth redirect the application produces in
production (the recovery handler — see below). Nothing else is needed; do not
add wildcards or dev URLs here.

> If you prefer future-proofing over strict minimalism, `https://pintag.io/**`
> is an acceptable substitute for the exact URL — but the exact URL is all the
> current auth flows require.

---

## Development project — `ebtgoqrywdywuqrvudcp`

**Authentication → URL Configuration**

- **Site URL:**
  ```
  https://pintag-cyrora.github.io/pintag-dev/
  ```
- **Redirect URLs (allow-list):**
  ```
  https://pintag-cyrora.github.io/pintag-dev/reset-password.html
  http://localhost:8000/reset-password.html
  http://127.0.0.1:8000/reset-password.html
  ```

The GitHub Pages subpath entry is the live dev site. The two `:8000` entries are
the local-fallback flow from `PREVIEW.md` (`python3 -m http.server`, default port
8000) — include them only if you actually run that local flow; drop them if you
don't. `8000` is deliberate: `3000` is unrelated to how this app is ever served.

---

## What the code now does (deterministic redirect)

`admin-auth.js` initiates recovery with an **explicit** `redirectTo` derived from
the current page's own origin+path, so the link always returns to the exact site
the admin started from — no environment constant to drift:

```js
// admin-auth.js — resetRedirectUrl()
return new URL('reset-password.html', window.location.href).href;
// pintag.io/admin.html            -> https://pintag.io/reset-password.html
// …/pintag-dev/admin.html         -> https://pintag-cyrora.github.io/pintag-dev/reset-password.html
// localhost:8000/admin.html       -> http://localhost:8000/reset-password.html
```

- Initiation: the **Forgot password?** link on the admin sign-in overlay calls
  `resetPasswordForEmail(email, { redirectTo })`, gated to the sole admin email
  (`cyrora.trading@gmail.com`) so the panel can't relay recovery mail to
  arbitrary addresses.
- Handler: **`reset-password.html`** consumes the recovery token, lets the admin
  set a new password via `auth.updateUser`, signs the recovery session out, and
  bounces to `admin.html` for a normal AAL2 sign-in. It does **not** grant admin
  access — the AAL2 gate in `admin-auth.js` is unchanged.
- The exact URL this resolves to per environment is precisely what each
  project's Redirect URL allow-list above must contain.

## Maintenance-mode note

`reset-password.html` is **not** one of the four routes the Cloudflare
maintenance worker intercepts (`listing.html`, `listings.html`, `/`,
`index.html`), so it passes straight through to GitHub Pages and is reachable
while maintenance mode is on — same as `admin.html`.

## The other three login pages

`agent-login.html`, `marketing-os.html`, and `pintag-studio/dashboard/index.html`
are password-login only and have **no** recovery/magic-link flow, so they need no
Redirect URL entries today. If a recovery flow is ever added to any of them, add
its handler URL to the relevant project's allow-list and pass an explicit
`redirectTo` the same way `admin-auth.js` does — never rely on the Site URL.
