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

## Password recovery flow (end to end)

1. On the admin sign-in overlay (`admin-auth.js`), the operator enters the admin
   email and taps **Forgot password?**.
2. `resetPasswordForEmail(email, { redirectTo })` is called with
   `redirectTo = new URL('reset-password.html', location.href).href` and gated to
   `cyrora.trading@gmail.com`. Supabase sends the recovery email.
3. The email link goes to GoTrue's `/auth/v1/verify?...&redirect_to=<redirectTo>`.
   GoTrue verifies the token, then redirects to `<redirectTo>` **only because that
   URL is on the Redirect URL allow-list** (otherwise it silently falls back to
   the Site URL — this is the whole reason the allow-list entry is required).
4. The browser lands on `reset-password.html` with the recovery tokens in the URL
   hash. supabase-js (`detectSessionInUrl`, on by default) parses them, establishes
   a short-lived recovery session, and fires `onAuthStateChange('PASSWORD_RECOVERY')`.
5. The page shows the new-password + confirm form and calls
   `auth.updateUser({ password })`.
6. On success it **signs the recovery session out** and redirects to `admin.html`,
   where the operator must complete a full **password + TOTP (AAL2)** sign-in.
   The recovery page never grants admin access — it only rotates the password.

## Auth flow audit (every email/redirect auth flow)

Verified across the whole repo (app + edge functions). Every flow that can emit a
link email is accounted for; none relies on implicit Site URL behavior:

| Flow | Present in app? | Emits a link email? | `redirectTo` |
|---|---|---|---|
| **Password recovery** (`resetPasswordForEmail`) | ✅ `admin-auth.js` | Yes | ✅ explicit → `reset-password.html` |
| **Magic link / email OTP** (`signInWithOtp`) | ❌ not used | — | n/a (add explicit `redirectTo` if ever introduced) |
| **Email verification** (`signUp` confirmation) | ❌ no `signUp` in app (removed, `SECURITY.md:126`) | — | n/a — accounts are provisioned in the Supabase dashboard |
| **Invite** (`inviteUserByEmail` / `generateLink`) | ❌ not used (no edge fn provisions users) | — | n/a (dashboard-only; add explicit `redirectTo` if ever automated) |
| **Reauthentication / email change** | ❌ not used | — | n/a |
| Password sign-in (`signInWithPassword`) | ✅ `admin-auth.js`, `agent-login.html`, `marketing-os.html`, `pintag-studio/dashboard/index.html` | No (no email/redirect) | n/a — pure credential exchange |
| Admin gate — TOTP/AAL2 (`mfa.*`) | ✅ `admin-auth.js` | No | n/a |

**Standing rule:** if any magic-link, invite, email-verification, or email-change
flow is ever added, it MUST pass an explicit `redirectTo` to a dedicated handler
page and that URL MUST be added to the relevant project's Redirect URL allow-list.
Never rely on the Site URL.

## The three non-admin login pages

`agent-login.html`, `marketing-os.html`, and `pintag-studio/dashboard/index.html`
are password-login only, with no recovery/magic-link flow, so they need no
Redirect URL entries today. Their post-login `window.location.href` navigations
(e.g. → `dashboard.html`) are ordinary in-app page loads, **not** Supabase auth
redirects, and are unaffected by the URL Configuration.

## Local development behavior

- **Where dev auth runs:** the dev website (`https://pintag-cyrora.github.io/pintag-dev/`)
  authenticates against the **dev** Supabase project `ebtgoqrywdywuqrvudcp`, never
  production. So the dev project owns the dev/localhost Redirect URLs above; the
  production project's allow-list stays production-only.
- **`redirectTo` is origin-relative,** so local testing needs no code change: served
  from `http://localhost:8000/admin.html`, the reset link resolves to
  `http://localhost:8000/reset-password.html` automatically. Add that URL (and the
  `127.0.0.1` form) to the **dev** project's allow-list if you exercise recovery locally.
- **`supabase/config.toml` is the local CLI emulator only** (`supabase start`). Its
  `site_url = "http://127.0.0.1:3000"` / `additional_redirect_urls` and its
  `enable_signup = true` / `enable_confirmations = false` apply to that local stack
  and **must not** be pushed to, or copied into, either hosted project. Hosted Site
  URL / Redirect URLs / signup policy are configured only in each project's
  dashboard. (Per the single-admin model, keep public signup **disabled** on the
  hosted production project.)

## Maintenance-mode note

`reset-password.html` is **not** one of the four routes the Cloudflare maintenance
worker intercepts — it 503s only `/`, `/index.html`, `/listings.html`,
`/listing.html` (`cloudflare-worker/og-listing-preview.js:419-424`); "every other
path … passes straight through untouched." So the recovery page is reachable while
maintenance mode is on, exactly like `admin.html` — password resets keep working
during the incident.

## Test plan (run after applying the dashboard values)

Prerequisites: production project Site URL + Redirect URL set as above; TOTP MFA
enabled; maintenance mode still ON.

1. **Email lands on the reset page.** Admin sign-in → **Forgot password?** with
   `cyrora.trading@gmail.com` → open the email → the link opens
   `https://pintag.io/reset-password.html#...type=recovery...` (NOT localhost, NOT
   the Site URL root). ✅ if the URL host+path is exactly the reset page.
2. **Recovery token accepted.** The page shows the new-password form (not the
   "invalid or expired link" error). ✅ = form visible.
3. **Password can be changed.** Enter a new password twice → **Update password** →
   "Password updated" → auto-redirect to `admin.html`. ✅ = success message + redirect.
4. **Old password no longer works.** On `admin.html`, sign in with the OLD password
   → "Incorrect email or password." ✅ = rejected.
5. **New password works.** Sign in with the NEW password → proceeds to the TOTP step.
   ✅ = password accepted.
6. **Admin login still requires TOTP.** After the new password, access is granted
   only after a valid 6-digit code (AAL2). Password-only never reaches the admin UI.
   ✅ = code required; wrong/absent code blocks entry.
7. **Reachable under maintenance.** With `MAINTENANCE_MODE = true`, `curl -I
   https://pintag.io/reset-password.html` returns 200 (not 503), while
   `https://pintag.io/listings.html` returns 503. ✅ = reset page passes through.
8. **Negative — stale link.** Reopen an already-used or expired reset link → the
   page shows the invalid/expired message and offers the sign-in page; no session is
   granted. ✅ = no password change possible.
