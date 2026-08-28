#!/usr/bin/env node
// probe-monitor-design.mjs — validate the assumptions a monitoring fix would
// rest on, BEFORE proposing it. READ ONLY: GETs only.
//
// The naive fix is "accept 403". That is suppression: it would make the
// monitor green during a real outage too. A safe fix needs a signal that is
// (a) not challenged, (b) genuinely end-to-end through the edge to the origin,
// and (c) still able to fail. This measures whether such a signal exists.
const ts = Date.now();
const show = async (label, url, opts = {}) => {
  try {
    const r = await fetch(url, { redirect: 'manual', ...opts });
    const body = await r.text();
    console.log(`  ${label.padEnd(46)} → ${String(r.status).padEnd(4)}` +
      ` cf-mitigated=${(r.headers.get('cf-mitigated') || '-').padEnd(10)}` +
      ` cf-cache=${(r.headers.get('cf-cache-status') || '-').padEnd(8)}` +
      ` age=${r.headers.get('age') || '-'}  bytes=${body.length}`);
    return { status: r.status, body, headers: r.headers };
  } catch (e) { console.log(`  ${label.padEnd(46)} → FAILED ${e.message}`); return null; }
};

console.log('── A. is an ASSET challenged? (cache-busted, so a real origin fetch) ──');
const a1 = await show('pintag.io/config.js?mon=<ts>',       `https://pintag.io/config.js?mon=${ts}`);
await show('pintag.io/components.js?mon=<ts>',              `https://pintag.io/components.js?mon=${ts}`);
await show('pintag.io/map-location.js?mon=<ts>',            `https://pintag.io/map-location.js?mon=${ts}`);
await show('www.pintag.io/config.js?mon=<ts>',              `https://www.pintag.io/config.js?mon=${ts}`);

console.log('\n── B. does that asset prove the RIGHT build is live? ──────────────────');
if (a1 && a1.status === 200) {
  for (const marker of ["env: 'production'", 'isProduction: true', "tag: 'PROD'"]) {
    console.log(`  contains ${JSON.stringify(marker).padEnd(28)} → ${a1.body.includes(marker)}`);
  }
} else console.log('  (asset not 200 — this approach would NOT work)');

console.log('\n── C. can the edge still return a REAL error? (must stay detectable) ──');
await show('pintag.io/does-not-exist-xyz.js',               `https://pintag.io/does-not-exist-xyz-${ts}.js`);
await show('pintag.io/agent-login.html  (pruned page)',     `https://pintag.io/agent-login.html?mon=${ts}`);

console.log('\n── D. baseline: HTML is challenged ────────────────────────────────────');
await show('pintag.io/',                                    `https://pintag.io/?mon=${ts}`);
await show('pintag.io/listings.html',                       `https://pintag.io/listings.html?mon=${ts}`);

console.log('\n── E. the origin, directly (bypasses Cloudflare entirely) ─────────────');
await show('pintag-cyrora.github.io/pintag/config.js',      `https://pintag-cyrora.github.io/pintag/config.js?mon=${ts}`);
await show('pintag-cyrora.github.io/pintag/',               `https://pintag-cyrora.github.io/pintag/`);

console.log('\n── F. is cf-mitigated present on EVERY challenged response? ───────────');
let challenged = 0, withHeader = 0;
for (let i = 0; i < 5; i++) {
  const r = await fetch(`https://pintag.io/?probe=${ts}-${i}`, { redirect: 'manual' });
  const b = await r.text();
  if (r.status === 403) {
    challenged++;
    if (r.headers.get('cf-mitigated')) withHeader++;
    else console.log(`      403 WITHOUT cf-mitigated — body has "Just a moment": ${b.includes('Just a moment')}`);
  }
}
console.log(`  challenged responses: ${challenged}/5   carrying cf-mitigated: ${withHeader}/${challenged || 1}`);
