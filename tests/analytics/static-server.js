// Minimal static file server for the analytics Playwright suite -- serves the
// repo root, mirroring the other suites' zero-tooling convention.
//
// Hardened anyway (a test server is still a server): the request path is
// decoded and resolved, must stay inside the repo root, must name an allowed
// static file type, and the 404 body never echoes the request.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = process.env.PW_STATIC_PORT || 8977;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};

function resolveSafe(rawUrl) {
  let urlPath;
  try { urlPath = decodeURIComponent(String(rawUrl).split('?')[0].split('#')[0]); } catch (_) { return null; }
  if (urlPath.includes('\0')) return null;
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return null;
  if (!Object.prototype.hasOwnProperty.call(CONTENT_TYPES, path.extname(filePath).toLowerCase())) return null;
  return filePath;
}

const server = http.createServer((req, res) => {
  const filePath = resolveSafe(req.url);
  if (!filePath) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`static-server listening on ${PORT}`));
