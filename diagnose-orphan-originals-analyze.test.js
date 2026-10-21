// scripts/diagnostics/orphan-originals/analyze_report.py -- the offline, read-only, aggregate-only analysis of the downloaded
// reconciliation artifact. SYNTHETIC data only (nothing here is a real object, listing or record). Pins: exact aggregate numbers for
// the gallery-history and duplicate-candidate groups and their overlap, the summary cross-check, that no identifier from the name /
// record / listing / live-object columns is ever printed (success AND failure paths), no network / database / write capability, and
// that no real artifact data is tracked in the repository. Run with: node --test diagnose-orphan-originals-analyze.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals');
const SCRIPT = path.join(DIR, 'analyze_report.py');
const COLS = fs.readFileSync(path.join(DIR, 'summarize.py'), 'utf8').match(/COLUMNS = \[([\s\S]*?)\n\]/)[1].match(/"([a-z_]+)"/g).map((c) => c.slice(1, -1));
const KB = 1024;
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const TOK = /SYN-OBJ|SYN-REC|SYN-LST|SYN-LIVE|SYNTH-SECRET/;   // every planted identifier carries one of these markers

const KNOWN = fs.readFileSync(path.join(DIR, 'summarize.py'), 'utf8').match(/CATEGORIES = \[([\s\S]*?)\n\]/)[1].match(/\("([a-z_]+)", (?:True|False)/g).map((m) => m.match(/"([a-z_]+)"/)[1]);
let n = 0;
const row = (o) => ({ object_name: `SYN-OBJ-${++n}.jpg`, size_bytes: String(200 * KB), storage_created_at: '2026-08-01 00:00:00+00', name_upload_ts: '2026-08-01 00:00:00+00',
  ref_listing: 'f', ref_unit: 'f', ref_agent: 'f', ref_registry: 'f', gallery_assignment_hits: '0', deleted_snapshot_hits: '0', import_record_hits: '0', listing_snapshot_hits: '0',
  import_image_hits: '0', duplicate_candidate_count: '0', evidence_count: '0', matched_sources: '', renditions_present: '', explanation: 'x', ...o });
const gal = (op, hits, rec, lst, uploaded, assigned, extra = {}) => row({ category: 'history_gallery_assignment_only', evidence_count: '1', matched_sources: 'gallery_assignment',
  gallery_assignment_hits: String(hits), gallery_assignment_op: op, gallery_assignment_record: `SYN-REC-${rec}`, gallery_assignment_listing: `SYN-LST-${lst}`,
  gallery_assignment_last_date: `${assigned} 12:00:00+00`, name_upload_ts: `${uploaded} 00:00:00+00`, ...extra });
const multiGD = (rec, lst, live, uploaded = '2026-08-04', assigned = '2026-08-06') => row({ category: 'multiple_evidence', evidence_count: '2', matched_sources: 'gallery_assignment,duplicate_candidate',
  gallery_assignment_hits: '1', gallery_assignment_op: 'assign', gallery_assignment_record: `SYN-REC-${rec}`, gallery_assignment_listing: `SYN-LST-${lst}`, gallery_assignment_last_date: `${assigned} 00:00:00+00`,
  name_upload_ts: `${uploaded} 00:00:00+00`, duplicate_candidate_count: '1', duplicate_of_live_object: `SYN-LIVE-${live}` });
const dup = (count, live, size = 200 * KB, extra = {}) => row({ category: 'duplicate_of_live_image_only', evidence_count: '1', matched_sources: 'duplicate_candidate', duplicate_candidate_count: String(count),
  duplicate_of_live_object: `SYN-LIVE-${live}`, size_bytes: String(size), ...extra });

const ROWS = [
  // gallery history: 4 assign/1 hit, listing 1 (uploaded 2 days before the record); 3 assign/3 hits, listing 2; 2 unassign/2 hits, listing 3; 1 unassign/5 hits, listing 4 (uploaded AFTER its record)
  ...[1, 2, 3, 4].map(() => gal('assign', 1, 1, 1, '2026-08-04', '2026-08-06')),
  ...[1, 2, 3].map(() => gal('assign', 3, 2, 2, '2026-07-01', '2026-08-07')),
  ...[1, 2].map(() => gal('unassign', 2, 3, 3, '2026-06-01', '2026-08-08')),
  gal('unassign', 5, 4, 4, '2026-08-10', '2026-08-08', { size_bytes: String(600 * KB) }),
  // overlap rows: gallery + duplicate; and a Smart Import record + duplicate
  multiGD(5, 5, 1), multiGD(5, 5, 3),
  row({ category: 'multiple_evidence', evidence_count: '2', matched_sources: 'import_record,duplicate_candidate', import_record_hits: '1', duplicate_candidate_count: '1', duplicate_of_live_object: 'SYN-LIVE-4' }),
  // duplicate only: three unique matches (LIVE-1 x2, LIVE-2) and three ambiguous (2, 4, 7 live matches)
  dup(1, 1), dup(1, 1, 50 * KB), dup(1, 2, 2000 * KB), dup(2, 9, 700 * KB), dup(4, 9), dup(7, 9),
  row({ category: 'no_evidence_uploaded_after_provenance' }), row({ category: 'no_evidence_uploaded_before_provenance' }),
];

function csv(rows, header = COLS) { return [header.join(','), ...rows.map((o) => header.map((c) => esc(o[c] ?? '')).join(','))].join('\n') + '\n'; }
function tmp(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'an-'));
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t);
  return d;
}
const run = (args, cwd) => spawnSync('python3', ['-I', '-B', SCRIPT, ...args], { encoding: 'utf8', cwd });
function analyze(rows = ROWS, extraFiles = {}, extraArgs = []) {
  const d = tmp({ 'o.csv': csv(rows), ...extraFiles });
  const r = run(['--objects', path.join(d, 'o.csv'), ...extraArgs.map((a) => (a.startsWith('@') ? path.join(d, a.slice(1)) : a))], d);
  return { r, d, out: r.stdout };
}
const line = (out, startsWith) => out.split('\n').find((l) => l.trim().startsWith(startsWith));

test('exact aggregates for the gallery-history group (counts, operations, hits, records, listings, gaps)', () => {
  const { r, out } = analyze();
  assert.equal(r.status, 0, r.stderr);
  assert.match(out, /objects named in gallery assignment history: 12 objects, .* \(of which gallery-history only: 10\)/);
  assert.match(out, /assign: 9 \(9 objects/);          // 4 + 3 + 2 overlap rows
  assert.match(out, /unassign: 3 \(3 objects/);
  assert.match(out, /once: 6\n {4}2-3 times: 5\n {4}4 or more times: 1/);   // hits: 4+2 once, 3+2 twice/thrice, 1 with five
  assert.match(out, /distinct latest assignment records: 5; distinct listings behind them: 5/);
  assert.match(out, /the largest single listing accounts for 4 of 12 objects/);
  assert.match(out, /most recent matching record dates: 2026-08-06 to 2026-08-08 across 3 distinct days/);
  assert.match(out, /NEGATIVE .*: 1\b/);                // the unassign object uploaded after its record
  assert.match(out, /renditions: 0 have at least one, 12 have none/);
});

test('exact aggregates for the duplicate-candidate group (unique vs ambiguous, copies per live object, sizes)', () => {
  const { out } = analyze();
  assert.match(out, /objects with a duplicate candidate: 9 objects, .* \(duplicate-only: 6, also in other history: 3\)/);
  assert.match(out, /exactly one live object matches: 6 objects/);
  assert.match(out, /more than one live object matches \(ambiguous\): 3 objects/);
  assert.match(out, /\n {4}2: 1\n {4}3-5: 1\n {4}6 or more: 1\n/);
  assert.match(out, /the unique matches point at 4 distinct live objects/);
  assert.match(out, /1 copy: 3\n {4}2 copies: 0\n {4}3 or more copies: 1/);
  assert.match(out, /under 100 KB: 1\n {4}100-500 KB: 6\n {4}500 KB-1 MB: 1\n {4}1 MB and over: 1/);
});

test('overlap and evidence strength: both groups, one-only sets, source combinations', () => {
  const { out } = analyze();
  assert.match(out, /in both groups \(gallery history AND duplicate candidate\): 2 objects/);
  assert.match(out, /gallery history only \(no duplicate candidate\): 10/);
  assert.match(out, /duplicate candidate only \(no gallery history\): 7/);
  assert.match(out, /multiple_evidence rows outside both groups \(other source combinations\): 0/);
  assert.match(out, /gallery_assignment,duplicate_candidate: 2/);
  assert.match(out, /import_record,duplicate_candidate: 1/);
  assert.match(out, /last operation 'assign' \(9 objects\)/);
  assert.match(out, /last operation 'unassign' \(3 objects\)/);
});

test('uncertainties and recommendations are present, and nothing is called safe to delete', () => {
  const { out } = analyze();
  assert.match(out, /== Unresolved uncertainties/);
  assert.match(out, /Whether the listing behind each latest assignment record still exists/);
  assert.match(out, /Only the MOST RECENT matching record per object is kept/);
  assert.match(out, /== Recommended review steps/);
  assert.match(out, /independent copy of the bucket/);
  assert.match(out, /nothing here shows an object is safe to delete/);
  assert.doesNotMatch(out.replace(/nothing here shows an object is safe to delete/, ''), /safe to delete|can be deleted|should be deleted/i);
});

test('privacy: no object name, record id, listing id or live-object name is ever printed (stdout, stderr, --out file)', () => {
  const { r, d, out } = analyze(ROWS, {}, ['--out', '@out.txt']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(out + r.stderr, TOK);
  assert.doesNotMatch(out, /\.jpe?g/);
  const written = fs.readFileSync(path.join(d, 'out.txt'), 'utf8');
  assert.equal(written, out);
});

test('values outside the expected vocabulary are never echoed (operation and source columns)', () => {
  const rows = [gal('SYNTH-SECRET-op', 1, 1, 1, '2026-08-01', '2026-08-02'), row({ category: 'multiple_evidence', evidence_count: '2', matched_sources: 'SYNTH-SECRET-src,duplicate_candidate', duplicate_candidate_count: '1', duplicate_of_live_object: 'SYN-LIVE-1' })];
  const { r, out } = analyze(rows);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(out + r.stderr, /SYNTH-SECRET/);
  assert.match(out, /\(other\)/);
});

test('summary cross-check: a matching reconcile-summary.md passes, a different one fails closed', () => {
  const counts = Object.fromEntries(KNOWN.map((k) => [k, 0])); for (const r of ROWS) counts[r.category] += 1;   // the real summary lists every category, zeros included
  const md = (c, total) => Object.entries(c).map(([k, v]) => `| \`${k}\` | ${v} | 1.0 MB |  |`).join('\n') + `\n| **total** | **${total}** | **1 MB** | |\n`;
  const ok = analyze(ROWS, { 's.md': md(counts, ROWS.length) }, ['--summary', '@s.md']);
  assert.equal(ok.r.status, 0, ok.r.stderr);
  const bad = analyze(ROWS, { 's.md': md({ ...counts, duplicate_of_live_image_only: counts.duplicate_of_live_image_only + 1 }, ROWS.length) }, ['--summary', '@s.md']);
  assert.equal(bad.r.status, 1);
  assert.match(bad.r.stderr, /CSV and summary disagree - duplicate_of_live_image_only: summary 7, CSV 6/);
  assert.equal(bad.out, '');
  const wrongTotal = analyze(ROWS, { 's.md': md(counts, 999) }, ['--summary', '@s.md']);
  assert.equal(wrongTotal.r.status, 1);
  assert.match(wrongTotal.r.stderr, /total: summary 999/);
});

test('failure paths fail closed with no identifier in any output: wrong columns, ragged rows, garbage numbers, unknown category, duplicates, empty, missing, bad UTF-8', () => {
  const good = row({ category: 'unclassifiable_no_evidence' });
  const T = 'SYNTH-SECRET-leak';
  const line1 = (o) => COLS.map((c) => esc(o[c] ?? '')).join(',');
  const cases = {
    'wrong header (another file)': `object_name,${T}\nSYN-OBJ-1,x\n`,
    'ragged short row': COLS.join(',') + `\nSYN-OBJ-9,${T}\n`,
    'ragged long row': COLS.join(',') + '\n' + line1(good) + `,${T},${T}\n`,
    'garbage size': csv([{ ...good, size_bytes: T }]),
    'garbage hits': csv([{ ...good, gallery_assignment_hits: T }]),
    'unknown category': csv([{ ...good, category: T }]),
    'empty file': '',
  };
  for (const [label, text] of Object.entries(cases)) {
    const d = tmp({ 'o.csv': text });
    const r = run(['--objects', path.join(d, 'o.csv')], d);
    assert.equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', `${label}: no partial analysis`);
    assert.doesNotMatch(r.stderr, new RegExp(`${T}|SYN-OBJ|Traceback`), label);
  }
  const dup2 = tmp({ 'o.csv': csv([{ ...good }, { ...good }]) });
  const rd = run(['--objects', path.join(dup2, 'o.csv')], dup2);
  assert.equal(rd.status, 1);
  assert.match(rd.stderr, /duplicate object rows/);
  assert.doesNotMatch(rd.stderr + rd.stdout, /SYN-OBJ/);
  const secretDir = tmp({});
  const missing = run(['--objects', path.join(secretDir, 'SYNTH-SECRET-dir', 'o.csv')], secretDir);
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stderr, /SYNTH-SECRET|Traceback/);
  assert.match(missing.stderr, /FileNotFoundError/);
  const bad = tmp({}); fs.writeFileSync(path.join(bad, 'o.csv'), Buffer.concat([Buffer.from(COLS.join(',') + '\n'), Buffer.from([0xff, 0xfe, 0x0a])]));
  const u = run(['--objects', path.join(bad, 'o.csv')], bad);
  assert.equal(u.status, 1);
  assert.doesNotMatch(u.stderr, /Traceback/);
});

test('read-only and offline: nothing is written unless --out is given; the source has no network, database, subprocess or delete capability', () => {
  const { r, d } = analyze();
  assert.equal(r.status, 0);
  assert.deepEqual(fs.readdirSync(d).sort(), ['o.csv']);
  const src = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(src, /\b(import|from)\s+(socket|ssl|http|urllib|requests|subprocess|psycopg2?|sqlite3|ftplib|smtplib|shutil|boto3)\b/);
  assert.doesNotMatch(src, /os\.(remove|unlink|rename|system|popen|rmdir)|rmtree/);
  assert.equal((src.match(/open\(/g) || []).length, 2);   // reading the summary, and the one write that exists only for --out
  assert.match(src, /open\(a\.out, "w" if a\.overwrite else "x"/);   // exclusive create unless --overwrite
  const before = fs.statSync(path.join(d, 'o.csv')).mtimeMs;
  run(['--objects', path.join(d, 'o.csv')], d);
  assert.equal(fs.statSync(path.join(d, 'o.csv')).mtimeMs, before);
});

test('repository hygiene: no real artifact data is tracked, downloaded reports are gitignored anywhere, and the README documents the local run', () => {
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n');
  assert.deepEqual(tracked.filter((f) => /(^|\/)(reconcile-objects\.csv|reconcile-summary\.md|reconcile\.csv|source-health\.csv)$/.test(f)), []);
  const ig = spawnSync('git', ['check-ignore', '-q', 'some/dir/reconcile-objects.csv'], { cwd: ROOT });
  assert.equal(ig.status, 0, 'reconcile-objects.csv is ignored wherever it is placed');
  const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
  for (const must of ['gh api repos/Pintag-cyrora/pintag/actions/artifacts/12313874351/zip', 'sha256sum', 'shasum -a 256', '26a60cf742f5c8a0a45e16e1db4ffdb8ae10bace691b1f25cffb2895d5605afa',
    'python3 -I -B scripts/diagnostics/orphan-originals/analyze_report.py', '--objects', '--summary', 'outside the repository', '2026-10-28'])
    assert.ok(readme.includes(must), `README mentions ${must}`);
});

// ── --out safeguards: never an input file, never an existing file by default ──
const sha = (f) => spawnSync('python3', ['-I', '-B', '-c', 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())', f], { encoding: 'utf8' }).stdout.trim();
function withSummary() {
  const counts = Object.fromEntries(KNOWN.map((k) => [k, 0])); for (const r of ROWS) counts[r.category] += 1;
  const md = Object.entries(counts).map(([k, v]) => `| \`${k}\` | ${v} | 1.0 MB |  |`).join('\n') + `\n| **total** | **${ROWS.length}** | **1 MB** | |\n`;
  return tmp({ 'o.csv': csv(ROWS), 's.md': md });
}

test('--out equal to the objects CSV or the summary is refused, and both inputs are byte-for-byte unchanged', () => {
  const d = withSummary();
  const before = { o: sha(path.join(d, 'o.csv')), s: sha(path.join(d, 's.md')) };
  fs.symlinkSync(path.join(d, 'o.csv'), path.join(d, 'link-to-o.csv'));
  fs.linkSync(path.join(d, 's.md'), path.join(d, 'hardlink-to-s.md'));
  fs.mkdirSync(path.join(d, 'sub'));
  for (const out of ['o.csv', 's.md', './o.csv', 'sub/../o.csv', 'link-to-o.csv', 'hardlink-to-s.md', path.join(d, 'o.csv')]) {
    for (const extra of [[], ['--overwrite']]) {
      const r = run(['--objects', path.join(d, 'o.csv'), '--summary', path.join(d, 's.md'), '--out', out, ...extra], d);
      assert.equal(r.status, 1, `${out} ${extra}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /same file as an input/);
      assert.equal(r.stdout, '', 'nothing is analyzed or printed when the output path is refused');
    }
  }
  assert.equal(sha(path.join(d, 'o.csv')), before.o);
  assert.equal(sha(path.join(d, 's.md')), before.s);
});

test('--out refuses an existing file by default (content untouched); a new file is created; --overwrite replaces a plain existing file only', () => {
  const d = withSummary();
  fs.writeFileSync(path.join(d, 'precious.txt'), 'DO NOT CLOBBER');
  const args = ['--objects', path.join(d, 'o.csv'), '--summary', path.join(d, 's.md')];
  const refused = run([...args, '--out', 'precious.txt'], d);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists; refusing to overwrite/);
  assert.equal(refused.stdout, '');
  assert.equal(fs.readFileSync(path.join(d, 'precious.txt'), 'utf8'), 'DO NOT CLOBBER');
  const fresh = run([...args, '--out', 'new-analysis.txt'], d);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fs.readFileSync(path.join(d, 'new-analysis.txt'), 'utf8'), fresh.stdout);
  const again = run([...args, '--out', 'new-analysis.txt'], d);   // a second run must not silently replace it either
  assert.equal(again.status, 1);
  const forced = run([...args, '--out', 'precious.txt', '--overwrite'], d);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(fs.readFileSync(path.join(d, 'precious.txt'), 'utf8'), /== Report ==/);
});

test('--overwrite never follows a symlink or replaces a directory, and a dangling symlink is not a free name', () => {
  const d = withSummary();
  fs.writeFileSync(path.join(d, 'target.txt'), 'TARGET');
  fs.symlinkSync(path.join(d, 'target.txt'), path.join(d, 'sym.txt'));
  fs.symlinkSync(path.join(d, 'nowhere'), path.join(d, 'dangling.txt'));
  fs.mkdirSync(path.join(d, 'adir'));
  const args = ['--objects', path.join(d, 'o.csv')];
  for (const out of ['sym.txt', 'adir']) {
    const r = run([...args, '--out', out, '--overwrite'], d);
    assert.equal(r.status, 1, out);
    assert.match(r.stderr, /not a plain file/);
  }
  assert.equal(fs.readFileSync(path.join(d, 'target.txt'), 'utf8'), 'TARGET');
  const dang = run([...args, '--out', 'dangling.txt'], d);
  assert.equal(dang.status, 1);
  assert.ok(!fs.existsSync(path.join(d, 'nowhere')), 'nothing was created through the dangling symlink');
});

test('refused --out paths do not leak identifiers and happen before the input is even read (a bad CSV plus a bad --out reports only the output problem)', () => {
  const d = tmp({ 'o.csv': 'not,the,report\nSYNTH-SECRET-leak,1,2\n' });
  const r = run(['--objects', path.join(d, 'o.csv'), '--out', 'o.csv'], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /same file as an input/);
  assert.doesNotMatch(r.stderr + r.stdout, /SYNTH-SECRET/);
  assert.equal(fs.readFileSync(path.join(d, 'o.csv'), 'utf8'), 'not,the,report\nSYNTH-SECRET-leak,1,2\n');
});

test('a failed analysis writes no --out file', () => {
  const d = tmp({ 'o.csv': 'wrong,header\n1,2\n' });
  const r = run(['--objects', path.join(d, 'o.csv'), '--out', 'result.txt'], d);
  assert.equal(r.status, 1);
  assert.ok(!fs.existsSync(path.join(d, 'result.txt')));
});
