// Every static wa.me / tel: link hard-coded in the public pages must be a
// number WhatsApp will accept, and the two GLOBAL Pintag contact links (the
// site footer in index.html and the "Contact Pintag" CTA in for-agents.html)
// must point at the official Pintag TEAM WhatsApp number, never at an
// individual owner's or agent's number. Listing-, owner- and agent-specific
// buttons are built from their resolved contact at runtime and are covered
// by ptNormalizePhoneDigits' own tests; this pins the hard-coded links.
//   node --test static-contact-links.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PAGES = fs.readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.html'));
const LAO_E164 = /^856(20|30)[0-9]{8}$/;   // the shape components.js's normaliser encodes
const PINTAG_TEAM_WHATSAPP = '8562055546963';   // official Pintag team / global number

test('every hard-coded wa.me link on a public page is a valid Lao E.164 mobile number', () => {
  const seen = [];
  for (const page of PAGES) {
    const src = fs.readFileSync(new URL('./' + page, import.meta.url), 'utf8');
    for (const m of src.matchAll(/href="https:\/\/wa\.me\/([0-9]+)/g)) {
      seen.push({ page, digits: m[1] });
      assert.match(m[1], LAO_E164, `${page}: wa.me/${m[1]} is not 856 + 20/30 + 8 digits`);
    }
  }
  assert.ok(seen.length >= 2, 'the footer and for-agents links must still be present: ' + JSON.stringify(seen));
  assert.ok(seen.every((s) => s.digits === PINTAG_TEAM_WHATSAPP), 'every hard-coded (global) link is the Pintag team number: ' + JSON.stringify(seen));
});
