// Regression tests for tests/listing-map-placement/static-server.js's path
// containment -- run with `node --test static-server-security.test.js`.
//
// WHY THIS FILE EXISTS: CodeQL flagged path.join(ROOT, urlPath) (req.url is
// attacker-controlled input) as CWE-22 path traversal. The fix is
// resolveSafePath(): decode the request path, reject any ".." segment (so
// an encoded traversal like "%2e%2e/" is caught too, not just a literal
// "../"), then resolve it under ROOT with path.resolve() and explicitly
// verify the result is still contained within ROOT as defense in depth.
//
// Two layers of coverage, same discipline as this repo's other CodeQL-audit
// test files (see xss-inline-handlers.test.js): the pure function in
// isolation, AND the real running server end-to-end via a raw socket --
// a normal HTTP client (curl, Node's http.get, browsers) normalizes ".."
// out of a URL before it ever reaches the wire, so only a raw,
// non-normalizing request actually proves the SERVER (not just the
// client) is what's stopping the traversal.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { resolveSafePath, ROOT } = await import('./static-server.js');

// ── Layer 1: resolveSafePath() in isolation ─────────────────────────────
test('resolveSafePath: ordinary requests resolve under ROOT, "/" maps to index.html', () => {
  assert.equal(resolveSafePath('/listing.html'), path.join(ROOT, 'listing.html'));
  assert.equal(resolveSafePath('/'), path.join(ROOT, 'index.html'));
  assert.equal(resolveSafePath('/tests/listing-map-placement/static-server.js'),
    path.join(ROOT, 'tests/listing-map-placement/static-server.js'));
});

test('resolveSafePath: a literal ".." traversal is rejected (returns null), never resolved', () => {
  assert.equal(resolveSafePath('/../../../etc/passwd'), null);
  assert.equal(resolveSafePath('/foo/../../../../etc/passwd'), null);
  assert.equal(resolveSafePath('/..'), null);
});

test('resolveSafePath: a percent-encoded traversal is decoded and still rejected', () => {
  assert.equal(resolveSafePath('/%2e%2e/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(resolveSafePath('/%2e%2e%2fetc%2fpasswd'), null);
});

test('resolveSafePath: malformed percent-encoding is rejected rather than throwing', () => {
  assert.equal(resolveSafePath('/%'), null);
  assert.equal(resolveSafePath('/%zz'), null);
});

test('resolveSafePath: every resolved (non-null) path is actually contained within ROOT', () => {
  const ROOT_WITH_SEP = ROOT + path.sep;
  for (const p of ['/listing.html', '/', '/tests/listing-map-placement/package.json', '/fonts/OFL.txt']) {
    const resolved = resolveSafePath(p);
    if (resolved === null) continue; // fine if the file doesn't exist under ROOT; only check containment when resolved
    assert.ok(resolved === ROOT || resolved.startsWith(ROOT_WITH_SEP), `${p} resolved to ${resolved}, outside ROOT`);
  }
});

// ── Layer 2: the REAL running server, via a raw (non-normalizing) socket ──
// A normal HTTP client collapses "../" out of a URL before sending it, so
// this sends the raw, unencoded request line directly over a TCP socket --
// the only way to actually prove the traversal reaches the server at all
// and that the SERVER (not the client) is what rejects it.
function rawRequest(port, rawPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.on('data', (c) => { raw += c; });
    socket.on('end', () => {
      const [head, ...rest] = raw.split('\r\n\r\n');
      const status = parseInt(head.split(' ')[1], 10);
      // Body may be chunked ("8\r\nbad path\r\n0\r\n\r\n"); strip chunk
      // framing loosely enough for these short, fixed test responses.
      const body = rest.join('\r\n\r\n').replace(/[0-9a-f]+\r\n/gi, '').replace(/\r\n0\r\n\r\n$/, '').trim();
      resolve({ status, body });
    });
    socket.on('error', reject);
    setTimeout(() => reject(new Error('timeout waiting for response')), 5000);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const port = 8990 + Math.floor(Math.random() * 500);
    const child = fork(path.join(__dirname, 'static-server.js'), {
      env: Object.assign({}, process.env, { PW_STATIC_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      silent: true,
    });
    const onData = () => { clearTimeout(timer); resolve({ port, child }); };
    child.stdout.once('data', onData);
    child.once('error', reject);
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 5000);
  });
}

test('the running server: a raw traversal request never reaches outside ROOT (400, not the file\'s content)', async () => {
  const { port, child } = await startServer();
  try {
    const res = await rawRequest(port, '/../../../etc/passwd');
    assert.equal(res.status, 400, `expected 400, got ${res.status} with body ${JSON.stringify(res.body)}`);
    assert.doesNotMatch(res.body, /root:.*:0:0:/, 'response must never contain /etc/passwd content');
  } finally {
    child.kill();
  }
});

test('the running server: an encoded traversal request is equally rejected', async () => {
  const { port, child } = await startServer();
  try {
    const res = await rawRequest(port, '/%2e%2e/%2e%2e/%2e%2e/etc/passwd');
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.body, /root:.*:0:0:/);
  } finally {
    child.kill();
  }
});

test('the running server: ordinary requests, "/", and a query string all still work normally', async () => {
  const { port, child } = await startServer();
  try {
    const r1 = await rawRequest(port, '/listing.html');
    assert.equal(r1.status, 200);
    const r2 = await rawRequest(port, '/');
    assert.equal(r2.status, 200);
    const r3 = await rawRequest(port, '/listing.html?slug=a1&lang=en');
    assert.equal(r3.status, 200);
  } finally {
    child.kill();
  }
});
