// Minimal static file server for the listing map-placement Playwright suite --
// serves the repo root, mirroring the other suites' zero-tooling convention.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = process.env.PW_STATIC_PORT || 8965;

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const requested = path.normalize(urlPath === '/' ? '/index.html' : urlPath);
  const filePath = path.resolve(ROOT, '.' + requested);
  // req.url is attacker-controlled input to this local dev/test server.
  // path.relative() + checking for a ".." prefix / an absolute result is
  // the standard recognized guard against it resolving outside ROOT
  // (CWE-22) -- a plain startsWith() prefix check on the resolved path is
  // not reliably recognized as a sanitizing barrier by static analysis.
  const rel = path.relative(ROOT, filePath);
  if (rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(400); res.end('bad path'); return;
  }
  fs.readFile(filePath, (err, data) => {
    // Never echo the requested path back in the response body (CWE-79,
    // reflected XSS) -- a generic message carries no attacker-controlled
    // data at all.
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`static-server listening on ${PORT}`));
