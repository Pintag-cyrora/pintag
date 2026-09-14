// Minimal static file server for the listing map-placement Playwright suite --
// serves the repo root, mirroring the other suites' zero-tooling convention.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ROOT_WITH_SEP = ROOT + path.sep;
const PORT = process.env.PW_STATIC_PORT || 8965;

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const requested = path.normalize(urlPath === '/' ? '/index.html' : urlPath);
  const filePath = path.resolve(ROOT, '.' + requested);
  // req.url is attacker-controlled input to this local dev/test server --
  // reject anything that resolves outside ROOT (e.g. "..%2f..%2fetc/passwd")
  // rather than trusting path.join to keep it contained (CWE-22).
  if (filePath !== ROOT && !filePath.startsWith(ROOT_WITH_SEP)) {
    res.writeHead(400); res.end('bad path'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`static-server listening on ${PORT}`));
