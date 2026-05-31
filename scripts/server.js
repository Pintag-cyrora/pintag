#!/usr/bin/env node
/**
 * Minimal static file server for Playwright end-to-end tests.
 * Serves all files from the project root directory.
 * Usage: node scripts/server.js
 */
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT) || 4321;
const ROOT = process.cwd();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  const safePath = req.url.split('?')[0].replace(/\.\./g, '');
  const filePath = path.join(ROOT, safePath === '/' ? 'index.html' : safePath);
  try {
    const data = fs.readFileSync(filePath);
    const ext  = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Static server on http://localhost:${PORT}\n`);
});
