// Minimal static file server for the lease-pricing-placement Playwright suite --
// serves the repo root, mirroring the other suites' zero-tooling convention.
// (Same vetted implementation as tests/listing-map-placement/static-server.js.)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ROOT_WITH_SEP = ROOT + path.sep;
const PORT = process.env.PW_STATIC_PORT || 8980;

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

// req.url is attacker-controlled input to this local dev/test server
// (CWE-22, path traversal). Two independent layers, both required:
//   1. Reject any ".." segment in the DECODED request path (so an encoded
//      traversal like "%2e%2e/" is caught too, not just a literal "../"),
//      before it is ever combined with ROOT -- the canonical, statically-
//      recognized guard for this exact source-to-sink pattern.
//   2. Resolve the request under ROOT with path.resolve() and explicitly
//      verify the result is still contained within ROOT, as defense in
//      depth beyond (1) -- e.g. it would still catch a future change to
//      the check above.
// Returns null if the path is invalid/out-of-root, otherwise the resolved,
// contained absolute path.
function resolveSafePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (e) {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('..')) return null;
  const requested = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.resolve(ROOT, '.' + requested);
  if (filePath !== ROOT && !filePath.startsWith(ROOT_WITH_SEP)) return null;
  return filePath;
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0]; // query-string stripped before resolution
  const filePath = resolveSafePath(urlPath);
  if (!filePath) { res.writeHead(400); res.end('bad path'); return; }
  fs.readFile(filePath, (err, data) => {
    // Never echo the requested path back in the response body (CWE-79,
    // reflected XSS) -- a generic message carries no attacker-controlled
    // data at all.
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

// Guarded so this file can be `require()`d by a test (to exercise
// resolveSafePath()/ROOT directly) without starting a real listener as a
// side effect -- only listen when run directly (`node static-server.js`),
// exactly as Playwright's webServer command does.
if (require.main === module) {
  server.listen(PORT, () => console.log(`static-server listening on ${PORT}`));
}

module.exports = { resolveSafePath, ROOT, server };
