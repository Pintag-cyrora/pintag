// Minimal static file server for the Playwright suite to serve the repo
// root against (intelligence.html, config.js, dev-banner.js, etc. are all
// plain files with no build step). No new runtime dependency -- just
// Node's built-in http/fs, matching the rest of this project's
// zero-tooling convention for the app itself.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = process.env.PW_STATIC_PORT || 8934;

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(ROOT, urlPath === '/' ? '/intelligence.html' : urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`static-server listening on ${PORT}`));
