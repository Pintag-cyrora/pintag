// Where is pintag.io actually serving from? deploy-prod reported success, but
// the live config.js is the repo's dev template rather than the built
// config.prod.js. Compare the Cloudflare-fronted hostnames against the GitHub
// Pages origin, which bypasses Cloudflare entirely. Read-only GETs.
const targets = [
  ['pintag.io          ', 'https://pintag.io/config.js'],
  ['www.pintag.io      ', 'https://www.pintag.io/config.js'],
  ['pages origin       ', 'https://pintag-cyrora.github.io/config.js'],
];
for (const [label, url] of targets) {
  try {
    const r = await fetch(`${url}?cb=${Date.now()}${Math.random()}`, { cache: 'no-store', redirect: 'follow' });
    const body = await r.text();
    const built = /renditionsEnabled:\s*true/.test(body);
    const isProdFile = /isProduction:\s*true/.test(body);
    console.log(`${label} ${r.status}  final=${new URL(r.url).host}`);
    console.log(`    server=${r.headers.get('server')}  cf-cache-status=${r.headers.get('cf-cache-status')}  age=${r.headers.get('age')}`);
    console.log(`    last-modified=${r.headers.get('last-modified')}  etag=${r.headers.get('etag')}`);
    console.log(`    looks like config.prod.js: ${isProdFile}   has renditionsEnabled:true: ${built}`);
    console.log(`    first line: ${body.split('\n')[0].slice(0, 90)}`);
  } catch (e) { console.log(`${label} ERROR ${e.message}`); }
}
// And the HTML: does it carry the deploy's ?v=<sha> stamp, or the raw placeholder?
for (const [label, url] of [['pintag.io  ', 'https://pintag.io/listings.html'],
                            ['pages origin', 'https://pintag-cyrora.github.io/listings.html']]) {
  const h = await (await fetch(`${url}?cb=${Date.now()}`, { cache: 'no-store' })).text();
  const m = /config\.js\?v=([^"']+)/.exec(h);
  console.log(`${label} listings.html config.js stamp: ${m ? m[1] : '(no ?v= at all)'}`);
}
