#!/usr/bin/env node
// build-site.mjs -- builds the deployable site into a clean `_site/` directory from an explicit, reviewed allowlist (site-manifest.txt).
//
// WHY: the production deploy used to upload the whole repository root (minus five pruned pages), so docs, SQL migrations, scripts, tests and
// internal runbooks were served on the production domain. Deny-by-default: only files named in site-manifest.txt are copied.
//
//   node scripts/build-site.mjs [--out _site] [--version <sha8>] [--check-only]
//
// Manifest lines:   + path                 include (copied verbatim)
//                   - path  # reason       reviewed and deliberately NOT published (kept in the repo)
//                   = config.js <- config.prod.js   generated file: a copy of the named source
//                   ~ path  # reason       a reference that is known to dangle today (the file does not exist in the repository); tolerated, not fixed here
// The build FAILS (exit 1) on: a missing/untracked/duplicated entry, an unsafe path (absolute, "..", a dot-component), a path in a
// never-publish category (tests, scripts, supabase, docs, ops, workers, studio, markdown, SQL, shell, Python, *.test.js), an unclassified
// root web file (a new page/script/image must be added to the manifest as + or - on purpose), an unresolved reference in the output, or a
// leftover __ASSET_VERSION__ placeholder.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = path.join(ROOT, 'site-manifest.txt');

// Directories and file kinds that must never be published, whatever the manifest says.
export const NEVER_DIRS = ['tests', 'scripts', 'supabase', 'docs', 'ops', 'cloudflare-worker', 'pintag-studio', 'node_modules', '_site'];
export const NEVER_EXT = ['.md', '.sql', '.sh', '.py', '.mjs', '.ts', '.toml', '.yml', '.yaml', '.map', '.env', '.pem', '.key', '.age'];
export const NEVER_NAMES = [/\.test\.js$/, /^config\.dev\.js$/, /^config\.prod\.js$/, /^package(-lock)?\.json$/, /^site-manifest\.txt$/];
// Root files that are "web files": a tracked one that the manifest neither includes nor excludes (with a reason) fails the build.
export const WEB_EXT = ['.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.json', '.txt', '.xml', '.webmanifest'];

const lc = (s) => s.toLowerCase();
export function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
}
export function parseManifest(text) {
  const include = [], exclude = [], generated = [], knownMissing = [], errors = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = `site-manifest.txt:${i + 1}`;
    if (line[0] === '+') {
      const p = line.slice(1).split('#')[0].trim();
      if (!p) errors.push(`${at}: empty include`); else include.push({ path: p, at });
    } else if (line[0] === '-') {
      const [p, ...rest] = line.slice(1).split('#');
      const reason = rest.join('#').trim();
      if (!p.trim()) errors.push(`${at}: empty exclude`);
      else if (!reason) errors.push(`${at}: an exclusion needs a "# reason"`);
      else exclude.push({ path: p.trim(), reason, at });
    } else if (line[0] === '~') {
      const [p, ...rest] = line.slice(1).split('#');
      if (!p.trim() || !rest.join('#').trim()) errors.push(`${at}: a known-missing entry needs "path  # reason"`); else knownMissing.push({ path: p.trim(), reason: rest.join('#').trim(), at });
    } else if (line[0] === '=') {
      const m = line.slice(1).split('#')[0].trim().match(/^(\S+)\s*<-\s*(\S+)$/);
      if (!m) errors.push(`${at}: generated entry must be "= out <- source"`); else generated.push({ path: m[1], source: m[2], at });
    } else errors.push(`${at}: line must start with +, -, ~ or =`);
  });
  return { include, exclude, generated, knownMissing, errors };
}
export function unsafe(p) {
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return 'absolute or malformed path';
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '..' || s === '.')) return 'path with an empty, "." or ".." component';
  if (parts.some((s) => s.startsWith('.'))) return 'dot-file or dot-directory';
  if (NEVER_DIRS.includes(parts[0])) return `never-publish directory "${parts[0]}/"`;
  const base = parts[parts.length - 1];
  const ext = path.extname(base).toLowerCase();
  if (NEVER_EXT.includes(ext) && !(p === 'fonts/OFL.txt')) return `never-publish file type "${ext}"`;
  if (NEVER_NAMES.some((re) => re.test(base))) return 'never-publish file name';
  return null;
}
export function validate(manifestText, trackedFiles) {
  const m = parseManifest(manifestText);
  const errors = [...m.errors];
  const set = new Set(trackedFiles);
  const seen = new Map();
  for (const e of [...m.include, ...m.exclude]) {
    if (seen.has(e.path)) errors.push(`${e.at}: "${e.path}" is listed twice (also ${seen.get(e.path)})`); else seen.set(e.path, e.at);
    if (!set.has(e.path)) errors.push(`${e.at}: "${e.path}" is not a tracked file`);
  }
  for (const e of m.include) { const u = unsafe(e.path); if (u) errors.push(`${e.at}: "${e.path}" cannot be published: ${u}`); }
  for (const g of m.generated) {
    const u = unsafe(g.path); if (u) errors.push(`${g.at}: generated "${g.path}" cannot be published: ${u}`);
    if (!set.has(g.source)) errors.push(`${g.at}: generated source "${g.source}" is not a tracked file`);
    if (seen.has(g.path) && !m.exclude.some((x) => x.path === g.path)) errors.push(`${g.at}: "${g.path}" is also listed as an include`);
  }
  // every tracked root web file must be classified on purpose
  const listed = new Set([...m.include, ...m.exclude].map((e) => e.path));
  const genOut = new Set(m.generated.map((g) => g.path));
  for (const f of trackedFiles) {
    if (f.includes('/')) continue;
    const ext = path.extname(f).toLowerCase();
    if (!WEB_EXT.includes(ext)) continue;
    if (/\.test\.js$/.test(f)) continue;
    if (!listed.has(f) && !genOut.has(f)) errors.push(`unclassified root web file "${f}": add "+ ${f}" or "- ${f}  # reason" to site-manifest.txt`);
  }
  return { ...m, errors };
}

// ── reference scanning (used by the build check and by the tests) ──
const ATTR = /\b(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const META_URL = /<meta\b[^>]*\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi;
const LITERAL = /(["'`])((?:\.\/)?(?:[A-Za-z0-9_\-]+\/)*[A-Za-z0-9_\-.]+\.(?:js|mjs|css|png|jpe?g|svg|webp|gif|ico|woff2?|json|html|txt|xml|webmanifest))(?:[?#][^"'`\s]*)?\1/gi;
// the site's own absolute URLs: the production domain and the legacy GitHub Pages project URL (which redirects to it)
const SELF_PREFIX = /^https?:\/\/(?:(?:www\.)?pintag\.io|pintag-cyrora\.github\.io\/pintag)\//;
const ABS_SELF = /https?:\/\/(?:(?:www\.)?pintag\.io|pintag-cyrora\.github\.io\/pintag)\/([A-Za-z0-9_\-./]+)/g;
// Comment stripping is deliberately conservative: a block comment must start after whitespace or a delimiter, so the "/*" in "image/*" does not open one.
const stripJsLineComments = (t) => t.replace(/^[ \t]*\/\/.*$/gm, '').replace(/(^|[\s;{}(,])\/\*[\s\S]*?\*\//g, '$1');
export function localRef(raw) {
  if (!raw) return null;
  let r = raw.trim();
  if (!r || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\$|\{)/i.test(r) || r.includes('${') || r.includes('{{')) return null;
  r = r.split('#')[0].split('?')[0].replace(/^\.?\//, '');
  return r || null;
}
export function refsOf(file, text) {
  const out = new Set();
  const add = (r) => { const v = localRef(r && SELF_PREFIX.test(r) ? r.replace(SELF_PREFIX, '') : r); if (v) out.add(v); };
  if (file.endsWith('.html')) {
    for (const m of text.matchAll(ATTR)) add(m[1] ?? m[2]);
    for (const m of text.matchAll(CSS_URL)) add(m[1] ?? m[2] ?? m[3]);
    for (const m of text.matchAll(META_URL)) { const v = m[1] ?? m[2]; if (v && SELF_PREFIX.test(v)) add(v); }
    // quoted file names anywhere in the page (inline scripts build URLs from them); comments removed. A whole-file scan, not per <script>
    // block, because a page can contain the text "<script" inside a string, which breaks block matching.
    for (const m of stripJsLineComments(text.replace(/<!--[\s\S]*?-->/g, '')).matchAll(LITERAL)) add(m[2]);
  } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
    for (const m of stripJsLineComments(text).matchAll(LITERAL)) add(m[2]);
  } else if (file.endsWith('.css')) {
    for (const m of text.matchAll(CSS_URL)) add(m[1] ?? m[2] ?? m[3]);
  }
  for (const m of text.matchAll(ABS_SELF)) add(m[1]);
  return out;
}

export function build({ out = path.join(ROOT, '_site'), version = '', trackedFiles = tracked(), manifestText = fs.readFileSync(MANIFEST, 'utf8'), checkOnly = false, root = ROOT } = {}) {
  const v = validate(manifestText, trackedFiles);
  const errors = [...v.errors];
  if (errors.length) return { ok: false, errors, files: [] };
  if (!checkOnly) {
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const e of v.include) { const dest = path.join(out, e.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(root, e.path), dest); }
    for (const g of v.generated) { const dest = path.join(out, g.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(root, g.source), dest); }
    if (version) for (const e of v.include) if (e.path.endsWith('.html')) {
      const f = path.join(out, e.path); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('__ASSET_VERSION__', version));
    }
  }
  const files = checkOnly ? [...v.include.map((e) => e.path), ...v.generated.map((g) => g.path)].sort() : listFiles(out);
  if (!checkOnly) {
    // the output must be exactly the manifest
    const want = new Set([...v.include.map((e) => e.path), ...v.generated.map((g) => g.path)]);
    for (const f of files) if (!want.has(f)) errors.push(`unexpected file in output: ${f}`);
    for (const f of want) if (!files.includes(f)) errors.push(`missing from output: ${f}`);
    if (version) for (const f of files) if (f.endsWith('.html') && fs.readFileSync(path.join(out, f), 'utf8').includes('__ASSET_VERSION__')) errors.push(`placeholder left in ${f}`);
    errors.push(...unresolved(out, files, new Set(trackedFiles), new Set(v.knownMissing.map((k) => k.path))));
  }
  return { ok: errors.length === 0, errors, files, include: v.include, exclude: v.exclude, generated: v.generated };
}
export function listFiles(dir) {
  const res = [];
  const walk = (d, rel) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${n.name}` : n.name; if (n.isDirectory()) walk(path.join(d, n.name), r); else res.push(r); } };
  walk(dir, '');
  return res.sort();
}
// A reference is a problem when it names a file that EXISTS IN THE REPOSITORY but is NOT in the output (an excluded file a page still needs),
// or when an HTML src/href points at a root-style local file that exists nowhere.
export function unresolved(outDir, files, trackedSet, knownMissing = new Set()) {
  const have = new Set(files);
  const errs = [];
  for (const f of files) {
    if (!/\.(html|js|mjs|css)$/.test(f)) continue;
    const text = fs.readFileSync(path.join(outDir, f), 'utf8');
    for (const r of refsOf(f, text)) {
      const candidates = [r, path.posix.normalize(path.posix.join(path.posix.dirname(f), r))];
      if (candidates.some((c) => have.has(c)) || knownMissing.has(r)) continue;
      if (candidates.some((c) => trackedSet.has(c))) errs.push(`${f} references "${r}", which exists in the repository but is not published`);
      else if (f.endsWith('.html') && /\.(?:js|css|png|jpe?g|svg|webp|gif|ico|woff2?|html)$/i.test(r) && !r.includes('/')) errs.push(`${f} references "${r}", which does not exist`);
    }
  }
  return errs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : ''; };
  const out = path.resolve(ROOT, arg('--out') || '_site');
  const version = arg('--version') || (process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 8) : '');
  const r = build({ out, version, checkOnly: process.argv.includes('--check-only') });
  if (!r.ok) { console.error('SITE BUILD FAILED:\n' + r.errors.map((e) => '  - ' + e).join('\n')); process.exit(1); }
  console.log(`site build ok: ${r.files.length} files${process.argv.includes('--check-only') ? ' (check only)' : ` in ${path.relative(ROOT, out) || '.'}`}; ${r.exclude.length} reviewed exclusions`);
}
