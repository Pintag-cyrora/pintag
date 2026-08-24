// Which origin is actually behind pintag.io?
//
// deploy-pages@v4 succeeded, which it cannot do when Pages is set to
// "Deploy from a branch" -- so GitHub's side looks correct. Yet the live site
// serves the raw repository tree. This asks GitHub what it thinks it is
// serving, and then uses a discriminator that does not depend on caching or
// timing: the build PRUNES five surfaces from the artifact
// (deploy-prod.yml "Prune non-production surfaces"). If those pages are live,
// the bytes reaching visitors did not come from the artifact.
//
// READ ONLY: GETs only.
const OWNER = 'Pintag-cyrora', REPO = 'pintag';
const gh = async (path) => {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`,
               Accept: 'application/vnd.github+json' } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('── what GitHub says it is serving ────────────────────');
const pages = await gh('/pages');
if (pages.status !== 200) {
  console.log(`  GET /pages -> ${pages.status} ${JSON.stringify(pages.body).slice(0, 200)}`);
} else {
  const p = pages.body;
  console.log(`  build_type : ${p.build_type}      <-- "workflow" = Actions artifact, "legacy" = branch`);
  console.log(`  source     : ${JSON.stringify(p.source)}`);
  console.log(`  status     : ${p.status}`);
  console.log(`  html_url   : ${p.html_url}`);
  console.log(`  cname      : ${p.cname}   https_enforced=${p.https_enforced}`);
}
const build = await gh('/pages/builds/latest');
if (build.status === 200) {
  const b = build.body;
  console.log(`  latest build: status=${b.status} commit=${(b.commit || '').slice(0, 8)} created=${b.created_at}`);
  if (b.error && b.error.message) console.log(`  build error : ${b.error.message}`);
}

console.log('\n── discriminator: pages the BUILD deletes from the artifact ──');
// rm -f agent-login.html dashboard.html edit-listing.html add-property.html marketing-os.html
const pruned = ['add-property.html', 'edit-listing.html', 'dashboard.html',
                'agent-login.html', 'marketing-os.html'];
let live = 0;
for (const f of pruned) {
  const r = await fetch(`https://pintag.io/${f}?cb=${Date.now()}${Math.random()}`, { cache: 'no-store' });
  const isHtmlPage = r.status === 200 && (await r.text()).includes('<html');
  if (isHtmlPage) live++;
  console.log(`  ${f.padEnd(20)} ${r.status}${isHtmlPage ? '  <-- LIVE, so not the pruned artifact' : ''}`);
}
console.log(live > 0
  ? `\n  ${live}/5 pruned surfaces are LIVE -> pintag.io is NOT serving the built artifact.`
  : `\n  none of the pruned surfaces are live -> pintag.io IS serving the built artifact.`);

console.log('\n── the GitHub Pages URL itself, bypassing the custom domain ──');
for (const u of [`https://${OWNER.toLowerCase()}.github.io/${REPO}/config.js`,
                 `https://${OWNER.toLowerCase()}.github.io/config.js`]) {
  try {
    const r = await fetch(`${u}?cb=${Date.now()}`, { redirect: 'manual' });
    const loc = r.headers.get('location');
    console.log(`  ${u}\n      ${r.status}${loc ? `  -> ${loc}` : ''}  server=${r.headers.get('server')}`);
  } catch (e) { console.log(`  ${u}  ERROR ${e.message}`); }
}
