// Static protection against the 2026-08 contact-tracking regression: an
// audit found real WhatsApp/Call contact buttons (listing.html's mobile
// sticky CTA bar, agents.html's WhatsApp button) that completed a genuine
// contact while posting zero analytics rows anywhere. This test scans every
// tracked HTML file in the repo for a WhatsApp/Call URL construction site
// and fails if it isn't wired to tracking -- so a *future* untracked
// contact button fails CI the moment it's added, instead of silently
// shipping.
//
// Method: source-level regex, not a browser crawl. This is deliberate --
// enforcing "every wa.me/tel: URL site is near a tracking call" at the
// source works for pages this suite has never even loaded (no fixture/mock
// setup needed per page), which is what makes it a durable regression
// guard rather than something that has to be hand-extended every time a
// new page gains a contact button. The heuristic: a real URL construction
// site (`https://wa.me/...` or a quoted `tel:...`) must have either
// `ptContactClick(` (full ui_events + lead_events tracking, the shared
// helper in components.js) or `data-track=` (ui_events only, correct for a
// general/non-listing contact CTA -- see the per-file rationale below)
// within a generous character window of the same statement. This will
// never be a perfect parser (no real JS/HTML AST), but it matches this
// codebase's actual style closely enough to be a reliable regression net,
// not just a one-time audit record.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Every HTML page actually served to a browser (deploy targets), scanned
// for contact URL construction. Test/tooling HTML (Playwright reports,
// etc.) is out of scope by construction -- this list is hand-picked, not
// glob('**/*.html'), so a stray report file can never affect this suite.
const PAGES = [
  'index.html', 'listing.html', 'listings.html', 'agent.html', 'agents.html',
  'for-agents.html', 'admin.html', 'dashboard.html', 'add-property.html',
  'edit-listing.html', 'agent-setup.html', 'agent-login.html',
];

// A real wa.me/tel: URL construction site -- NOT a bare mention of "wa.me"
// in prose (this codebase's own comments say things like "reusing the same
// wa.me channel", which must not false-positive here).
const URL_SITE_RE = /(https:\/\/wa\.me\/)|(['"]tel:)/g;

// Explicit, documented exclusions -- every one of these was individually
// reviewed, not silently skipped. Anything NOT listed here must satisfy the
// tracking heuristic or this test fails.
const ALLOWLIST = [
  {
    file: 'listing.html',
    match: /function ptSelectContact\(/,
    reason:
      'Not a CTA — an attribute update on CTAs that are already tracked. ' +
      'ptSelectContact() runs when a buyer picks one of a listing\'s several ' +
      'phone numbers; it rewrites the href of #pt-wa-primary and ' +
      '#pt-call-primary, both of which carry ptContactClick() in their own ' +
      'onclick and are audited at those sites. It also rewrites their ' +
      'data-contact-id, which is precisely what makes lead_events attribute ' +
      'the inquiry to the number the buyer actually chose. Adding a second ' +
      'ptContactClick() call here would double-count every selection as an ' +
      'inquiry the buyer never made.',
  },
  {
    file: 'admin.html',
    match: /renderOwnerPhoneCell/,
    reason:
      'Staff-only internal tool: admin.html is gated behind Supabase Auth ' +
      '(is_pintag_staff), and renderOwnerPhoneCell() lets logged-in staff ' +
      'call/WhatsApp a property OWNER directly from the internal listings ' +
      'table -- not a public lead-generation path, and not a "contact the ' +
      'agent" action a real site visitor can reach. Firing lead_events for ' +
      'a staff action would misrepresent it as a buyer inquiry.',
  },
  {
    file: 'listing.html',
    match: /handleNotifyMeClick[\s\S]*postEvent\(\s*['"]listing_events['"]/,
    reason:
      'Tracked via a different, deliberate mechanism: the Rented Listings ' +
      'v2 "Notify Me About Similar Properties" waitlist button posts ' +
      "listing_events (event_type='contact', source='waitlist_notify_me') " +
      'instead of lead_events -- an unavailable listing\'s waitlist ping is ' +
      'not a live property inquiry, so it deliberately never creates a ' +
      'leads CRM row (matches the desktop/mobile status-CTA WhatsApp ' +
      'buttons\' recordLead:false elsewhere in this file). The regex ' +
      'requires the actual postEvent(\'listing_events\'...) call to be ' +
      'present, not just the function name, so this stays a precise, ' +
      'verifiable exemption rather than a blanket one.',
  },
];

function isAllowlisted(file, windowText) {
  return ALLOWLIST.some((entry) => entry.file === file && entry.match.test(windowText));
}

test.describe('Contact CTA tracking audit (static)', () => {
  for (const file of PAGES) {
    test(`${file}: every WhatsApp/Call URL site is tracked`, async () => {
      const filePath = path.join(REPO_ROOT, file);
      if (!fs.existsSync(filePath)) {
        test.skip(true, `${file} does not exist in this checkout`);
        return;
      }
      const src = fs.readFileSync(filePath, 'utf8');
      const WINDOW = 900; // chars each side -- generous enough to span one <a> construction statement in this codebase's string-concat style, small enough not to accidentally see the NEXT button's tracking call.

      const findings = [];
      let m;
      URL_SITE_RE.lastIndex = 0;
      while ((m = URL_SITE_RE.exec(src)) !== null) {
        const start = Math.max(0, m.index - WINDOW);
        const end = Math.min(src.length, m.index + WINDOW);
        const windowText = src.slice(start, end);
        const lineNum = src.slice(0, m.index).split('\n').length;

        if (isAllowlisted(file, windowText)) {
          findings.push({ line: lineNum, status: 'allowlisted', match: m[0] });
          continue;
        }

        const hasFullTracking = windowText.includes('ptContactClick(');
        const hasUiTracking = /data-track(-type|-label|-meta)?=/.test(windowText);

        if (hasFullTracking || hasUiTracking) {
          findings.push({ line: lineNum, status: hasFullTracking ? 'tracked (lead_events + ui_events)' : 'tracked (ui_events only)', match: m[0] });
        } else {
          findings.push({ line: lineNum, status: 'UNTRACKED', match: m[0] });
        }
      }

      const untracked = findings.filter((f) => f.status === 'UNTRACKED');
      if (untracked.length) {
        const detail = untracked.map((f) => `  ${file}:${f.line} -- "${f.match}" has neither ptContactClick( nor data-track= nearby`).join('\n');
        throw new Error(
          `Found ${untracked.length} untracked contact CTA(s) in ${file}:\n${detail}\n\n` +
          `Every WhatsApp/Call button must call components.js's ptContactClick() ` +
          `(for a real property/agent inquiry) or carry a data-track attribute ` +
          `(for a general, non-listing contact link) -- see this file's header ` +
          `comment. If this is a legitimate exception (e.g. a staff-only ` +
          `internal tool), add it to the ALLOWLIST in this test with a reason.`
        );
      }

      // Not asserting findings.length > 0 globally (some pages legitimately
      // have zero contact CTAs, e.g. add-property.html) -- the meaningful
      // assertion already happened above (no UNTRACKED entries survived).
      expect(untracked.length).toBe(0);
    });
  }
});
