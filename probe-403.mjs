#!/usr/bin/env node
// probe-403.mjs — why does Production Monitoring get 403 from pintag.io?
// STRICTLY READ ONLY: GETs only.
//
// The monitor uses plain `curl` (User-Agent: curl/8.x) and gets 403. Browser
// probes from the same runner infrastructure got 200 hours earlier. That is
// the signature of edge bot filtering, not an outage — but "signature of" is
// not proof, so this varies ONE THING AT A TIME and reports the edge's own
// error codes.
const TARGETS = ['https://pintag.io/', 'https://www.pintag.io/',
                 'https://pintag.io/index.html', 'https://pintag.io/admin.html',
                 'https://pintag-cyrora.github.io/pintag/'];

const UAS = {
  'curl (what the monitor sends)': 'curl/8.5.0',
  'no User-Agent header at all'  : null,
  'GitHub Actions style'         : 'GitHub-Actions-Monitoring/1.0',
  'real Chrome desktop'          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'real Safari iPhone'           : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

const CF_CODES = {
  1020: 'Access denied — WAF / Firewall Rule',
  1010: 'Browser signature banned — Bot Fight Mode',
  1015: 'Rate limited',
  1012: 'Access denied — country/ASN block',
};

console.log('── 1. same URL, different User-Agent ───────────────────────────');
for (const [label, ua] of Object.entries(UAS)) {
  const headers = ua ? { 'User-Agent': ua } : {};
  try {
    const r = await fetch('https://pintag.io/', { headers, redirect: 'manual' });
    const body = await r.text();
    const cfErr = (body.match(/Error\s*(\d{4})/) || body.match(/"?errorCode"?[:=]\s*"?(\d{4})/) || [])[1];
    const title = (body.match(/<title[^>]*>([^<]{0,80})/i) || [])[1] || '';
    console.log(`  ${label.padEnd(32)} → ${r.status}` +
      `  cf-ray=${(r.headers.get('cf-ray') || '-').slice(0, 20)}` +
      `  cf-mitigated=${r.headers.get('cf-mitigated') || '-'}`);
    if (r.status >= 400) {
      console.log(`      title: ${title.trim()}`);
      if (cfErr) console.log(`      Cloudflare error ${cfErr}: ${CF_CODES[cfErr] || 'unknown'}`);
      console.log(`      server=${r.headers.get('server')}  bytes=${body.length}`);
    }
  } catch (e) { console.log(`  ${label.padEnd(32)} → FETCH FAILED: ${e.message}`); }
}

console.log('\n── 2. every monitored endpoint, with the monitor\'s own UA ──────');
for (const t of TARGETS) {
  try {
    const r = await fetch(t, { headers: { 'User-Agent': 'curl/8.5.0' }, redirect: 'manual' });
    console.log(`  ${t.padEnd(46)} → ${r.status}  server=${r.headers.get('server') || '-'}`);
  } catch (e) { console.log(`  ${t.padEnd(46)} → FAILED ${e.message}`); }
}

console.log('\n── 3. the SAME endpoints in a real browser (is the site up?) ───');
const { chromium } = await import('@playwright/test');
const b = await chromium.launch();
const page = await (await b.newContext()).newPage();
for (const t of ['https://pintag.io/', 'https://www.pintag.io/', 'https://pintag.io/listings.html']) {
  try {
    const resp = await page.goto(t, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title();
    console.log(`  ${t.padEnd(40)} → ${resp.status()}  title="${title.slice(0, 60)}"`);
  } catch (e) { console.log(`  ${t.padEnd(40)} → FAILED ${e.message.slice(0, 80)}`); }
}
// Does the site actually work for a visitor — real listings, not just a 200?
try {
  await page.goto('https://pintag.io/listings.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#listings-container a.pt-card[href*="listing.html"]', { timeout: 30000 });
  const n = await page.locator('#listings-container a.pt-card[href*="listing.html"]').count();
  console.log(`  real listing cards rendered for a visitor: ${n}`);
} catch (e) { console.log(`  listing render check FAILED: ${e.message.slice(0, 100)}`); }
await b.close();
