// One-time production change, explicitly authorised: switch GitHub Pages from
// "Deploy from a branch" (build_type: legacy) to "GitHub Actions"
// (build_type: workflow), and enable HTTPS enforcement.
//
// Why it must be done here and not in code: build_type is a REPOSITORY setting,
// not a workflow input. deploy-prod.yml has always produced the correct
// artifact; Pages was ignoring it.
const OWNER = 'Pintag-cyrora', REPO = 'pintag';
const api = async (method, path, body) => {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`,
               Accept: 'application/vnd.github+json',
               'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

const show = (label, p) => {
  console.log(`  ${label}`);
  console.log(`    build_type=${p.build_type}  source=${JSON.stringify(p.source)}`);
  console.log(`    https_enforced=${p.https_enforced}  status=${p.status}  html_url=${p.html_url}`);
};

console.log('── BEFORE ────────────────────────────────────────────');
const before = await api('GET', '/pages');
if (before.status !== 200) { console.log(`  GET /pages -> ${before.status}`); process.exit(1); }
show('current', before.json);

let failed = 0;

console.log('\n── 1. source: branch -> GitHub Actions ───────────────');
const a = await api('PUT', '/pages', { build_type: 'workflow' });
console.log(`  PUT build_type=workflow -> ${a.status}${a.status >= 300 ? '  ' + a.text.slice(0, 300) : ''}`);
if (a.status >= 300) failed++;

console.log('\n── 2. HTTPS enforcement on ──────────────────────────');
// Separate call: https_enforced is rejected while a cert is still being
// provisioned, and mixing it with the source switch would make one failure
// look like the other.
const b = await api('PUT', '/pages', { https_enforced: true });
console.log(`  PUT https_enforced=true -> ${b.status}${b.status >= 300 ? '  ' + b.text.slice(0, 300) : ''}`);
if (b.status >= 300) failed++;

console.log('\n── AFTER ─────────────────────────────────────────────');
const after = await api('GET', '/pages');
show('now', after.json);
const p = after.json;
p.build_type === 'workflow'
  ? console.log('  ok   source is GitHub Actions')
  : (failed++, console.log(`  FAIL source is still ${p.build_type}`));
p.https_enforced === true
  ? console.log('  ok   HTTPS enforcement is ON')
  : (failed++, console.log(`  FAIL https_enforced is ${p.https_enforced}`));

console.log(failed === 0 ? '\nPAGES SETTINGS UPDATED' : `\nPAGES SETTINGS NOT FULLY UPDATED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
