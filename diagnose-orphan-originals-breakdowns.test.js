// summarize.py's aggregate-only breakdowns (scripts/diagnostics/orphan-originals/summarize.py): gallery history by operation/date,
// multiple-evidence by source combination, duplicate candidates by match uniqueness and size bucket, no-history objects by upload
// month around the INFERRED provenance cutoff, and the source-health status. Pins: every table adds up to its category totals
// (which add up to the stage-2 total), a doctored table fails the run and withholds the per-object report, and the job summary
// never contains an object name, path, record id or listing id. Pure Python + node: no database needed. Run with:
//   node --test diagnose-orphan-originals-breakdowns.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SUM = path.join(ROOT, 'scripts', 'diagnostics', 'orphan-originals', 'summarize.py');
const COLS = fs.readFileSync(SUM, 'utf8').match(/COLUMNS = \[([\s\S]*?)\n\]/)[1].match(/"([a-z_]+)"/g).map((c) => c.slice(1, -1));
const SRC = ['gallery_assignments.photo_paths', 'properties_row_snapshots.row_data->images', 'import_records.raw_payload', 'listing_image_snapshots', 'import_images'];
const KB = 1024, MB = 1024 * 1024;
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

let n = 0;
const base = (o) => ({ object_name: `SECRETNAME-${++n}.jpg`, size_bytes: String(50 * KB), ref_listing: 'f', ref_unit: 'f', ref_agent: 'f', ref_registry: 'f', evidence_count: '0',
  gallery_assignment_hits: '0', deleted_snapshot_hits: '0', import_record_hits: '0', listing_snapshot_hits: '0', import_image_hits: '0', duplicate_candidate_count: '0',
  name_upload_ts: '2026-09-10 00:00:00+00', matched_sources: '', renditions_present: '', explanation: 'x', ...o });
const gallery = (op, day, rec, lst, size = 10 * KB, hits = 1) => base({ category: 'history_gallery_assignment_only', evidence_count: '1', matched_sources: 'gallery_assignment',
  gallery_assignment_hits: String(hits), gallery_assignment_op: op, gallery_assignment_last_date: `${day} 12:00:00+00`, gallery_assignment_record: rec, gallery_assignment_listing: lst,
  size_bytes: String(size), name_upload_ts: '2026-07-01 00:00:00+00' });
const HITS = { gallery_assignment: 'gallery_assignment_hits', import_record: 'import_record_hits', duplicate_candidate: 'duplicate_candidate_count' };
const multi = (sources, size = 5 * KB) => base({ category: 'multiple_evidence', evidence_count: String(sources.length), matched_sources: sources.join(','), size_bytes: String(size),
  ...Object.fromEntries(sources.map((x) => [HITS[x], '1'])) });
const dup = (count, of, size) => base({ category: 'duplicate_of_live_image_only', evidence_count: '1', matched_sources: 'duplicate_candidate', duplicate_candidate_count: String(count), duplicate_of_live_object: of, size_bytes: size });
const noev = (kind, ts, size = 20 * KB) => base({ category: `no_evidence_uploaded_${kind}_provenance`, name_upload_ts: ts, size_bytes: String(size) });

const ROWS = [
  gallery('assign', '2026-08-10', 'REC-A1', 'LST-1'), gallery('assign', '2026-08-10', 'REC-A1', 'LST-1'), gallery('assign', '2026-08-10', 'REC-A2', 'LST-2', 20 * KB, 3),
  gallery('unassign', '2026-08-11', 'REC-U1', 'LST-1'),
  multi(['gallery_assignment', 'import_record']), multi(['gallery_assignment', 'import_record']), multi(['gallery_assignment', 'duplicate_candidate'], 7 * KB),
  dup(1, 'LIVE-X', String(50 * KB)), dup(1, 'LIVE-X', String(150 * KB)), dup(1, 'LIVE-Y', String(700 * KB)), dup(2, 'LIVE-X', String(1.5 * MB)), dup(1, 'LIVE-Z', String(3 * MB)), dup(1, 'LIVE-Z', ''),
  noev('before', '2026-06-05 00:00:00+00'), noev('before', '2026-06-20 00:00:00+00'), noev('before', '2026-07-01 00:00:00+00', 30 * KB),
  noev('after', '2026-09-02 00:00:00+00'), noev('after', '2026-09-03 00:00:00+00'), noev('after', '2026-10-01 00:00:00+00', 40 * KB),
  base({ category: 'unclassifiable_no_evidence', name_upload_ts: '', size_bytes: String(9 * KB) }),
];

function summarize(rows, { healthRows, expected = rows.length } = {}) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
  fs.writeFileSync(path.join(w, 'in.csv'), [COLS.join(','), ...rows.map((o) => COLS.map((c) => esc(o[c] ?? '')).join(','))].join('\n') + '\n');
  const hs = healthRows ?? SRC.map((x) => [x, 10, 10, 0, x === 'listing_image_snapshots' ? '2026-08-07' : '2026-08-06']);
  fs.writeFileSync(path.join(w, 'h.csv'), 'source,rows_total,rows_usable,rows_unusable,first_date,last_date\n' + hs.map(([x, t, u, nn, f]) => `${x},${t},${u},${nn},${f} 00:00:00+00,2026-10-20 00:00:00+00`).join('\n') + '\n');
  const r = spawnSync('python3', ['-I', SUM, '--objects', path.join(w, 'in.csv'), '--health', path.join(w, 'h.csv'), '--expected', String(expected),
    '--out-objects', path.join(w, 'o.csv'), '--out-summary', path.join(w, 's.md')], { encoding: 'utf8' });
  return { r, md: fs.readFileSync(path.join(w, 's.md'), 'utf8'), csv: fs.existsSync(path.join(w, 'o.csv')) };
}
const rowOf = (md, startsWith) => md.split('\n').find((l) => l.startsWith(startsWith));

test('breakdowns: every table is produced, the run passes and still reconciles to the total', () => {
  const { r, md } = summarize(ROWS);
  assert.equal(r.status, 0, r.stderr);
  assert.match(md, /Counts reconcile to the stage-2 total \(20\)/);
  for (const h of ['#### 1. `history_gallery_assignment_only` (4 objects)', '#### 2. `multiple_evidence` (3 objects, FLAGGED)', '#### 3. `duplicate_of_live_image_only` (6 objects)', '#### 4. No-history objects (7)']) assert.ok(md.includes(h), h);
});

test('1. gallery history: counts, sizes and distinct-record/listing COUNTS per operation and date', () => {
  const { md } = summarize(ROWS);
  assert.equal(rowOf(md, '| assign | 2026-08-10 |'), '| assign | 2026-08-10 | 3 | 40.0 KB | 2 | 2 |');
  assert.equal(rowOf(md, '| unassign | 2026-08-11 |'), '| unassign | 2026-08-11 | 1 | 10.0 KB | 1 | 1 |');
  assert.match(md, /Overall: 3 distinct latest assignment records and 2 distinct listings\. 1 of 4 objects are named more than once/);
});

test('2. multiple evidence: one row per combination of sources', () => {
  const { md } = summarize(ROWS);
  assert.equal(rowOf(md, '| `gallery_assignment,import_record` |'), '| `gallery_assignment,import_record` | 2 | 10.0 KB |');
  assert.equal(rowOf(md, '| `gallery_assignment,duplicate_candidate` |'), '| `gallery_assignment,duplicate_candidate` | 1 | 7.0 KB |');
});

test('3. duplicate candidates: unique vs ambiguous, distinct live objects, size buckets; never "safe to delete"', () => {
  const { md } = summarize(ROWS);
  assert.match(md, /\| unique \(exactly one live object matches\) \| 5 \| /);
  assert.match(md, /\| ambiguous \(more than one live object matches\) \| 1 \| 1\.5 MB \|/);
  assert.match(md, /The 5 unique candidates point at 3 distinct live objects/);
  assert.equal(rowOf(md, '| under 100 KB |'), '| under 100 KB | 1 | 50.0 KB |');
  assert.equal(rowOf(md, '| 100-500 KB |'), '| 100-500 KB | 1 | 150.0 KB |');
  assert.equal(rowOf(md, '| 500 KB-1 MB |'), '| 500 KB-1 MB | 1 | 700.0 KB |');
  assert.equal(rowOf(md, '| 1-2 MB |'), '| 1-2 MB | 1 | 1.5 MB |');
  assert.equal(rowOf(md, '| 2 MB and over |'), '| 2 MB and over | 1 | 3.0 MB |');
  assert.equal(rowOf(md, '| unknown size |'), '| unknown size | 1 | 0 bytes (+1 unknown size) |');
  assert.match(md, /does not show an object is unused, abandoned or safe to remove/);
  assert.doesNotMatch(md.replace(/does not show an object is unused, abandoned or safe to remove/, '').replace(/never proof that an object is safe to remove/, ''), /safe to (delete|remove)|can be (deleted|removed)/i);
});

test('4. no-history objects: by upload month, before vs after the INFERRED cutoff (date taken from the source-health table)', () => {
  const { md } = summarize(ROWS);
  assert.match(md, /Inferred cutoff: 2026-08-07 \(earliest `listing_image_snapshots` row\)\. It is an inference/);
  assert.equal(rowOf(md, '| 2026-06 |'), '| 2026-06 | 2 | 40.0 KB | 0 | 0 bytes |');
  assert.equal(rowOf(md, '| 2026-07 |'), '| 2026-07 | 1 | 30.0 KB | 0 | 0 bytes |');
  assert.equal(rowOf(md, '| 2026-09 |'), '| 2026-09 | 0 | 0 bytes | 2 | 40.0 KB |');
  assert.equal(rowOf(md, '| 2026-10 |'), '| 2026-10 | 0 | 0 bytes | 1 | 40.0 KB |');
  assert.match(md, /`unclassifiable_no_evidence` \(no usable upload time or no cutoff\): 1 \| 9\.0 KB\./);
});

test('privacy: the job summary contains no object name, record id or listing id', () => {
  const { md } = summarize(ROWS);
  assert.doesNotMatch(md, /SECRETNAME|REC-[AU]\d|LST-\d|LIVE-[XYZ]|\.jpg/);
});

test('consistency: every breakdown table sums to its category row in the main table (and the main table to the total)', () => {
  const { md } = summarize(ROWS);
  const num = (s) => Number(s.trim());
  const sec = (a, b) => md.slice(md.indexOf(a), md.indexOf(b));
  const sumCol = (text, col) => text.split('\n').filter((l) => /^\| [^|]+ \|/.test(l) && !/---|Operation|Evidence|Matching|Size bucket|Upload month/.test(l)).reduce((t, l) => t + num(l.split('|')[col]), 0);
  assert.equal(sumCol(sec('#### 1.', '#### 2.'), 3), 4);
  assert.equal(sumCol(sec('#### 2.', '#### 3.'), 2), 3);
  const dupSec = sec('#### 3.', '#### 4.');
  assert.equal(sumCol(dupSec.slice(0, dupSec.indexOf('| Size bucket')), 2), 6);
  assert.equal(sumCol(dupSec.slice(dupSec.indexOf('| Size bucket')), 2), 6);
  const mo = sec('#### 4.', '`unclassifiable_no_evidence` (no usable');
  assert.equal(sumCol(mo, 2), 3);
  assert.equal(sumCol(mo, 4), 3);
  assert.match(md, /\| `history_gallery_assignment_only` \| 4 \|/);
  assert.match(md, /\| \*\*total\*\* \| \*\*20\*\* \|/);
});

test('a row whose upload date contradicts the cutoff split fails the run and withholds the per-object report', () => {
  for (const bad of [noev('after', '2026-08-01 00:00:00+00'), noev('before', '2026-09-01 00:00:00+00')]) {
    const { r, md, csv } = summarize([...ROWS, bad]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cutoff/);
    assert.match(md, /RECONCILIATION FAILED/);
    assert.equal(csv, false);
  }
});

test('source health: OK / PARTIAL / UNREADABLE status per source, with a visible warning for partial ones', () => {
  const hs = SRC.map((x, i) => [x, 10, i === 2 ? 9 : 10, i === 2 ? 1 : 0, '2026-08-07']);
  const { r, md } = summarize(ROWS, { healthRows: hs });
  assert.equal(r.status, 0, r.stderr);
  assert.match(md, /\| `import_records\.raw_payload` \| 10 \| 9 \| 1 \| PARTIAL \(1 unreadable\) \|/);
  assert.match(md, /\| `import_images` \| 10 \| 10 \| 0 \| OK \|/);
  assert.match(md, /WARNING: 1 of 10 `import_records\.raw_payload` rows hold no readable path/);
  const bad = summarize(ROWS, { healthRows: SRC.map((x, i) => [x, 10, i === 1 ? 0 : 10, i === 1 ? 10 : 0, '2026-08-07']) });
  assert.equal(bad.r.status, 1);
  assert.equal(bad.csv, false);
});

test('empty groups render as zero rows, not as errors (a category with no objects)', () => {
  const { r, md } = summarize([base({ category: 'unclassifiable_no_evidence', name_upload_ts: '' })]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(md, /#### 1\. `history_gallery_assignment_only` \(0 objects\)/);
  assert.match(md, /Overall: 0 distinct latest assignment records and 0 distinct listings/);
});

test('privacy of failures: error messages (workflow log) name a row number, never an object name', () => {
  const { r } = summarize([...ROWS, { ...ROWS[0] }, { ...ROWS[0], ref_unit: 't', object_name: 'SECRETNAME-dupe.jpg' }]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /duplicate object name at row 21/);
  assert.doesNotMatch(r.stderr, /SECRETNAME|\.jpg/);
});

test('a breakdown that does not add up to its category totals is reported as an error (guard against a table drifting from the main numbers)', () => {
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.dirname(SUM))})
import summarize as s
rows = [{**{c: '' for c in s.COLUMNS}, 'category': 'history_gallery_assignment_only', 'size_bytes': '10', 'gallery_assignment_op': 'assign',
         'gallery_assignment_last_date': '2026-08-10 00:00:00+00', 'gallery_assignment_hits': '1'}]
totals = {c[0]: [0, 0, 0] for c in s.CATEGORIES}
totals['history_gallery_assignment_only'] = [2, 20, 0]   # main table claims 2 objects / 20 bytes; the breakdown sees 1 / 10
errors = []
s.breakdowns(rows, totals, '2026-08-07', errors)
print(json.dumps(errors))`;
  const r = spawnSync('python3', ['-I', '-B', '-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /breakdown 'gallery by operation\/date' does not add up/);
});
