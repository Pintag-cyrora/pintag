# First Administrator Onboarding — Pintag (single-admin model)

Canonical procedure for provisioning **the one** production administrator
(`cyrora.trading@gmail.com`) end to end: auth account → authorization →
password + TOTP (AAL2) → verified re-login. Production Supabase project:
**`eoladhcljbpbhnrmmpev`**.

This is the single supported production authentication model. There is exactly
one administrator; do not provision a second. Every privileged page gates on
`admin-auth.js` (cyrora + password + TOTP/AAL2, server-validated), and
`is_pintag_admin()` is the server-side authorization boundary.

## Preconditions (do these first)

- **Project-level TOTP MFA is ENABLED** — Authentication → (Providers / Multi-Factor) → enable **TOTP / Authenticator app**. If this is off, Step 4 fails at enrollment (`admin-auth.js:176–178` returns "…MFA is required but is not enabled on this project").
- **An authenticator app is ready on your phone** (Google Authenticator, Authy, 1Password, etc.) — needed to finish Step 5 in one sitting.
- **A password manager is open** — you will save the password *and* the TOTP secret.
- The admin pages are reachable even while the site is in maintenance mode: the Cloudflare worker only 503s `/`, `/index.html`, `/listings.html`, `/listing.html`; `admin.html` and `reset-password.html` pass through.

---

## 1. Create the auth user

**Dashboard only — never via SQL.** Inserting into `auth.users` directly bypasses GoTrue (no password hash, no identity row) and produces a broken account.

- Authentication → **Users → Add user**.
- Email: `cyrora.trading@gmail.com`
- Password: generate a strong one **in your password manager** and paste it here.
- Enable **Auto Confirm User** (so no confirmation email is required).

**PASS:** the user appears in the Users list. Note its **User UID** (you'll see it referenced by `is_pintag_admin` next).

## 2. Add to `admin_accounts`

`admin_accounts` is the allow-list that `is_pintag_admin()` checks. It is written **only** from the SQL editor / service role (never through the API). Run this idempotent insert (it looks the user up by email, so you don't need to paste the UID):

```sql
INSERT INTO admin_accounts (auth_user_id, note)
SELECT id, 'Sole production administrator'
FROM auth.users
WHERE email = 'cyrora.trading@gmail.com'
ON CONFLICT (auth_user_id) DO NOTHING;
```

**PASS (verify):**
```sql
SELECT is_pintag_admin(id) AS is_admin
FROM auth.users WHERE email = 'cyrora.trading@gmail.com';   -- expect: true

SELECT count(*) AS admin_count FROM admin_accounts;         -- expect: 1
```
`is_admin = true` and `admin_count = 1`. If `admin_count > 1`, investigate — the single-admin model requires exactly one row.

## 3. First login

- Open **`https://pintag.io/admin.html`** (reachable through maintenance mode).
- Enter `cyrora.trading@gmail.com` + the password from Step 1.
- `admin-auth.js` verifies the email is the sole admin and checks the password server-side.

**PASS:** the password is accepted and the flow advances to the 2-factor step (it does **not** reject you as "not authorized for admin access"). Because no verified factor exists yet, it moves into guided enrollment (Step 4).

## 4. Enroll MFA (TOTP)

- The login overlay now shows a **QR code** and a text secret. This is `admin-auth.js` calling `mfa.enroll({ factorType: 'totp' })` (`:172`).
- **Scan the QR** with your authenticator app.
- **Save the text TOTP secret in your password manager now** (backup for a lost phone — see Recovery below).

> ⚠️ Enrollment creates the factor immediately with status **`unverified`**. If you stop here (close the tab, skip the code), a **stranded unverified factor** is left on the account and 2FA is *not* actually working. You must complete Step 5.

## 5. Verify MFA

- Enter the current **6-digit code** from the authenticator app into the overlay. This is `mfa.verify()` (`:140`); on success the factor flips to **`verified`** and the session reaches **AAL2**.

**PASS:** the login overlay disappears and the admin dashboard loads. That transition *is* the AAL2 confirmation (the panel only renders after `getAuthenticatorAssuranceLevel() === 'aal2'`).

**Optional dashboard cross-check:** Authentication → Users → cyrora → the MFA factor shows status **verified** (not unverified).

## 6. Save credentials in the password manager

Store, in the password manager, for `cyrora.trading@gmail.com`:
- the **password**, and
- the **TOTP secret** from Step 4 (or the authenticator entry itself).

Saving the TOTP seed matters: it lets you restore 2FA on a new device without dashboard surgery. Without it, a lost phone means the Recovery procedure below.

## 7. Verify a second login

Prove enrollment persists and AAL2 is enforced on a fresh session:

- Sign out (or clear the Supabase session in DevTools), then reload `admin.html`.
- Enter the password → you **must** be prompted for a 6-digit code (no auto-login from a persisted session — `admin-auth.js` re-validates server-side on every load).
- Enter the code → the dashboard loads.

**PASS:** password-only does **not** reach the panel; the code is required; the second login reaches AAL2. If it auto-logged-in without a code, stop and investigate — that would contradict the security model.

---

## Final confirmation (one administrator, fully provisioned)

- `SELECT count(*) FROM admin_accounts;` → **1**
- `is_pintag_admin(<cyrora uid>)` → **true**
- cyrora has a **verified** TOTP factor; a second login required the code.
- No legacy/test accounts remain (see `RECOVERY_RUNBOOK.md` P7).

This satisfies RECOVERY_RUNBOOK **P5** (MFA enrolled + verified).

## Recovery — lost authenticator

If the authenticator device is lost and you did **not** save the TOTP secret (Step 6):

1. Dashboard → Authentication → Users → cyrora → **Remove MFA factors** (removes verified *and* stranded-unverified factors). The account drops to AAL1 — expected, and required for re-enrollment.
2. Confirm project-level **TOTP MFA is still enabled** (Preconditions).
3. Log into `admin.html` with the password → `admin-auth.js` finds no verified factor → shows a **fresh** QR (Step 4) → scan with an authenticator you now possess → enter the code (Step 5) → AAL2 restored.

This is the standard lost-device recovery, gated by Supabase project-owner (dashboard) access. It does not weaken the model: the account returns to full AAL2 after re-enrollment. Have an authenticator app ready before you start so you don't strand another unverified factor.

## What NOT to do

- Do **not** create the auth user by inserting into `auth.users` via SQL.
- Do **not** add a second row to `admin_accounts` — the production model is single-admin.
- Do **not** disable project-level TOTP MFA — the admin login requires it.
- Do **not** rely on the built-in email sender for password recovery at volume; configure custom SMTP (its low hourly limit returns `429 over_email_send_rate_limit`). Password-recovery redirect setup lives in `docs/AUTH_URL_CONFIGURATION.md`.
