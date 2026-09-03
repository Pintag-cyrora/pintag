// Every static wa.me / tel: link hard-coded in the public pages must be a
// number WhatsApp will accept. The footer link in index.html and the
// for-agents.html CTA carried 85620542966655 -- 14 digits, one more than a
// Lao mobile in E.164 (856 + 20 + 8 digits) -- so WhatsApp rejected it on
// both pages. Dynamic links (built from contacts at runtime) are covered by
// ptNormalizePhoneDigits' own tests; this pins the hard-coded ones.
//   node --test static-contact-links.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PAGES = fs.readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.html'));
const LAO_E164 = /^856(20|30)[0-9]{8}$/;   // the shape components.js's normaliser encodes

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
  assert.ok(seen.every((s) => s.digits === '8562054296665'), 'both Pintag contact links point at the same number');
});
