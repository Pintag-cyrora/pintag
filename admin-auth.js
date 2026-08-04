// ============================================================================
// admin-auth.js — the ONE administrator authentication flow for Pintag.
// ============================================================================
// Every privileged page (admin.html and every admin tool / internal dashboard /
// utility) uses this single module. There is no other admin auth logic anywhere
// — this replaces every legacy password-only login and hardcoded-admin-email check.
//
// Guarantees:
//   * Only cyrora.trading@gmail.com may enter (any other account is rejected).
//   * email + password + TOTP two-factor (Authenticator Assurance Level 2).
//   * The session is validated SERVER-SIDE (auth.getUser) on every page load —
//     no auto-login from a persisted localStorage session.
//   * PintagAdminAuth.requireAdminSession() re-validates before any privileged
//     operation.
//   * is_pintag_admin() (RLS) remains the server-side authorization boundary;
//     this module is the client gate in front of it.
//
// Usage on a page:
//   <script src="config.prod.js"></script>            <!-- window.PINTAG -->
//   <script src="…/@supabase/supabase-js@2"></script> <!-- page provides -->
//   <script src="admin-auth.js"></script>
//   <script>
//     const sb = supabase.createClient(window.PINTAG.supabaseUrl, window.PINTAG.anonKey);
//     PintagAdminAuth.protect(sb, function () { /* boot the page here */ });
//     // before a destructive action: await PintagAdminAuth.requireAdminSession();
//   </script>
// The module injects its own full-screen login overlay, so pages need no login
// markup of their own. The page's own content should live in the DOM and simply
// be initialised by the onReady callback (the overlay covers the page until an
// AAL2 cyrora session is verified, then is removed).
// ============================================================================
(function () {
  'use strict';
  var ADMIN_EMAIL = 'cyrora.trading@gmail.com';
  var _client = null;
  var _onReady = null;
  var _mfaPending = null;    // { factorId } while awaiting a 6-digit code
  var _booted = false;

  // ── the injected login overlay ────────────────────────────────────────────
  function buildOverlay() {
    if (document.getElementById('pintag-admin-auth')) return;
    var style = document.createElement('style');
    style.textContent =
      '#pintag-admin-auth{position:fixed;inset:0;z-index:2147483647;background:#1A2428;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif}' +
      '#pintag-admin-auth .box{width:100%;max-width:22rem;text-align:center;color:#E8EDF0}' +
      '#pintag-admin-auth .logo{font-weight:800;font-size:1.5rem;color:#2D8C8C;letter-spacing:-.02em}' +
      '#pintag-admin-auth .sub{color:#9AA7B0;font-size:.85rem;margin:.15rem 0 1.25rem}' +
      '#pintag-admin-auth input{width:100%;box-sizing:border-box;padding:.7rem .8rem;margin:.3rem 0;' +
      'border:1px solid rgba(232,237,240,.18);border-radius:8px;background:#0F1418;color:#E8EDF0;font-size:1rem}' +
      '#pintag-admin-auth button{width:100%;padding:.7rem;margin-top:.6rem;border:0;border-radius:8px;' +
      'background:#2D8C8C;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}' +
      '#pintag-admin-auth button:disabled{opacity:.6;cursor:default}' +
      '#pintag-admin-auth .forgot{display:inline-block;margin-top:.8rem;color:#9AA7B0;font-size:.8rem;text-decoration:none}' +
      '#pintag-admin-auth .forgot:hover{color:#2D8C8C}' +
      '#pintag-admin-auth .err{color:#F2837B;font-size:.85rem;margin-top:.6rem;display:none}' +
      '#pintag-admin-auth .note{color:#9AA7B0;font-size:.85rem;margin-top:.6rem;line-height:1.5;display:none}' +
      '#pintag-admin-auth #paa-qr{width:168px;height:168px;margin:.6rem auto;display:block;background:#fff;border-radius:10px;padding:8px}' +
      '#pintag-admin-auth #paa-secret{font-family:ui-monospace,monospace;font-size:.72rem;word-break:break-all;color:#9AA7B0}';
    document.head.appendChild(style);
    var wrap = document.createElement('div');
    wrap.id = 'pintag-admin-auth';
    wrap.innerHTML =
      '<div class="box">' +
      '<div class="logo">Pintag</div><div class="sub">Administrator sign-in</div>' +
      '<input type="email" id="paa-email" placeholder="Admin email" autocomplete="username" autocapitalize="none" spellcheck="false">' +
      '<input type="password" id="paa-pw" placeholder="Password" autocomplete="current-password">' +
      '<div id="paa-enroll" style="display:none">' +
        '<div class="sub" style="margin:.5rem 0">Set up two-factor authentication</div>' +
        '<div class="note" style="display:block">Scan with Google Authenticator or Authy, then enter the 6-digit code.</div>' +
        '<img id="paa-qr" alt="2FA QR code"><div id="paa-secret"></div>' +
      '</div>' +
      '<input type="text" id="paa-code" placeholder="6-digit code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="display:none">' +
      '<button id="paa-btn">Sign In</button>' +
      '<a href="#" id="paa-forgot" class="forgot">Forgot password?</a>' +
      '<div class="err" id="paa-err"></div><div class="note" id="paa-note"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    var onEnter = function (e) { if (e.key === 'Enter') doLogin(); };
    document.getElementById('paa-email').addEventListener('keydown', onEnter);
    document.getElementById('paa-pw').addEventListener('keydown', onEnter);
    document.getElementById('paa-code').addEventListener('keydown', onEnter);
    document.getElementById('paa-btn').addEventListener('click', doLogin);
    document.getElementById('paa-forgot').addEventListener('click', function (e) { e.preventDefault(); requestPasswordReset(); });
  }
  function showOverlay() { buildOverlay(); var o = document.getElementById('pintag-admin-auth'); if (o) o.style.display = 'flex'; }
  function removeOverlay() { var o = document.getElementById('pintag-admin-auth'); if (o) o.remove(); }
  function msg(text, isErr) {
    var err = document.getElementById('paa-err'), note = document.getElementById('paa-note');
    (isErr ? note : err).style.display = 'none';
    var el = isErr ? err : note; el.textContent = text || ''; el.style.display = text ? 'block' : 'none';
  }

  // ── server-side session validation (never trusts localStorage alone) ───────
  async function isVerifiedAdminSession() {
    try {
      var u = await _client.auth.getUser();
      if (u.error || !u.data.user) return false;
      if ((u.data.user.email || '').toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return false;
      var a = await _client.auth.mfa.getAuthenticatorAssuranceLevel();
      return !a.error && a.data && a.data.currentLevel === 'aal2';
    } catch (_) { return false; }
  }
  async function requireAdminSession() {
    if (await isVerifiedAdminSession()) return true;
    alert('Your secure admin session has expired or is no longer valid. Please sign in again.');
    await forceLogout();
    throw new Error('admin session invalid');
  }
  async function forceLogout() {
    _mfaPending = null;
    try { await _client.auth.signOut(); } catch (_) {}
    location.reload();
  }

  async function enterAdmin() {
    if (!(await isVerifiedAdminSession())) { await forceLogout(); return; }
    removeOverlay();
    if (!_booted) { _booted = true; try { if (_onReady) _onReady(); } catch (e) { console.error(e); } }
  }

  function revealCodeStep() {
    document.getElementById('paa-email').style.display = 'none';
    document.getElementById('paa-pw').style.display = 'none';
    var c = document.getElementById('paa-code'); c.style.display = 'block'; c.focus();
  }

  async function doLogin() {
    var btn = document.getElementById('paa-btn');
    btn.disabled = true;

    // Step 2 — a 6-digit code is expected (existing 2FA or new enrollment).
    if (_mfaPending) {
      var code = (document.getElementById('paa-code').value || '').trim();
      try {
        var ch = await _client.auth.mfa.challenge({ factorId: _mfaPending.factorId });
        if (ch.error) throw ch.error;
        var v = await _client.auth.mfa.verify({ factorId: _mfaPending.factorId, challengeId: ch.data.id, code: code });
        if (v.error) throw v.error;
      } catch (e) { btn.disabled = false; msg('Invalid or expired code. Please try again.', true); return; }
      _mfaPending = null; await enterAdmin(); return;
    }

    // Step 1 — email + password.
    var email = (document.getElementById('paa-email').value || '').trim();
    var pw = document.getElementById('paa-pw').value;
    var r = await _client.auth.signInWithPassword({ email: email, password: pw });
    if (r.error) { btn.disabled = false; msg('Incorrect email or password.', true); return; }
    if ((r.data.user.email || '').toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      await _client.auth.signOut(); btn.disabled = false;
      msg('This account is not authorized for admin access.', true); return;
    }

    var aal = await _client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.data && aal.data.currentLevel === 'aal2') { await enterAdmin(); return; }

    var factors = await _client.auth.mfa.listFactors();
    if (factors.error) {
      await _client.auth.signOut(); btn.disabled = false;
      msg('Two-factor authentication is required but is not enabled on this project. Enable TOTP MFA in the Supabase dashboard, then sign in again.', true); return;
    }
    var verified = (factors.data && factors.data.totp || []).filter(function (f) { return f.status === 'verified'; });
    if (verified.length > 0) {
      _mfaPending = { factorId: verified[0].id };
      revealCodeStep(); msg('Enter the 6-digit code from your authenticator app.', false);
      btn.disabled = false; btn.textContent = 'Verify code'; return;
    }
    // No factor — guided enrollment. Access stays denied until it succeeds.
    try {
      var enr = await _client.auth.mfa.enroll({ factorType: 'totp' });
      if (enr.error) throw enr.error;
      _mfaPending = { factorId: enr.data.id };
      if (enr.data.totp && enr.data.totp.qr_code) document.getElementById('paa-qr').src = enr.data.totp.qr_code;
      if (enr.data.totp && enr.data.totp.secret) document.getElementById('paa-secret').textContent = enr.data.totp.secret;
      document.getElementById('paa-enroll').style.display = 'block';
      revealCodeStep(); msg('Two-factor authentication is required. Scan the code above, then enter the 6-digit code to finish setup.', false);
      btn.disabled = false; btn.textContent = 'Activate 2FA';
    } catch (e) {
      await _client.auth.signOut(); btn.disabled = false;
      msg('Could not start two-factor setup. Ensure TOTP MFA is enabled for this project in Supabase, then try again.', true);
    }
  }

  // ── password recovery (deterministic redirect, never the Site URL) ─────────
  // The app NEVER relies on the Supabase project's Site URL for the recovery
  // link target — that default is 'http://localhost:3000' and is the wrong
  // destination for production. We pass an explicit redirectTo built from the
  // CURRENT page's own origin+path, so the reset link always returns to the
  // exact site the admin initiated from: pintag.io in production, the dev
  // GitHub Pages subpath in development, localhost when testing locally — with
  // no environment-specific constant to drift. The one URL this resolves to per
  // environment is what must be on the Supabase "Redirect URLs" allowlist (see
  // docs/AUTH_URL_CONFIGURATION.md). resetPasswordForEmail is gated to the sole
  // admin email so the admin panel can't be used to send recovery mail to
  // arbitrary addresses.
  function resetRedirectUrl() {
    // Resolve reset-password.html relative to the current page so the /pintag-dev/
    // subpath (dev GitHub Pages) is preserved automatically.
    return new URL('reset-password.html', window.location.href).href;
  }
  async function requestPasswordReset() {
    var email = (document.getElementById('paa-email').value || '').trim();
    if (email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      msg('Enter the administrator email above first, then tap "Forgot password?".', true);
      return;
    }
    try {
      var r = await _client.auth.resetPasswordForEmail(email, { redirectTo: resetRedirectUrl() });
      if (r.error) throw r.error;
    } catch (e) {
      msg('Could not send the reset email right now. Please try again in a moment.', true);
      return;
    }
    msg('Password reset email sent to ' + email + '. Open it on this device and follow the link to set a new password.', false);
  }

  // ── public API ─────────────────────────────────────────────────────────────
  // protect(client, onReady): gate the page. Shows the login overlay until an
  // AAL2 cyrora session is verified server-side, then removes it and calls
  // onReady() exactly once. Validates on every page load.
  function protect(client, onReady) {
    _client = client; _onReady = onReady;
    client.auth.onAuthStateChange(function (event, session) {
      if (!session && _booted) forceLogout();
    });
    function start() {
      buildOverlay(); showOverlay();
      isVerifiedAdminSession().then(function (ok) { if (ok) enterAdmin(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
  async function token() {
    try { var s = await _client.auth.getSession(); return s.data.session ? s.data.session.access_token : null; }
    catch (_) { return null; }
  }

  window.PintagAdminAuth = {
    protect: protect,
    requireAdminSession: requireAdminSession,
    logout: forceLogout,
    token: token,
    isVerifiedAdminSession: isVerifiedAdminSession,
    requestPasswordReset: requestPasswordReset,
    ADMIN_EMAIL: ADMIN_EMAIL
  };
})();
