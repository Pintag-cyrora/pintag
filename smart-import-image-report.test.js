// Smart Import client: how a Gemini timeout and the importer's image_report reach the user.
//   node --test smart-import-image-report.test.js
// Runs the REAL describeImageReport / importerErrorFromResponse / describeAiGenFailure, extracted from admin.html.
// The browser flows that use them are covered by tests/admin-save-integrity/smart-import-renditions.spec.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const admin = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}
const ctx = vm.createContext({});
for (const n of ['describeImageReport', 'importerErrorFromResponse', 'describeAiGenFailure']) vm.runInContext(extractFn(admin, n), ctx);
const { describeImageReport, importerErrorFromResponse, describeAiGenFailure } = ctx;

test('no omission, no report, or a malformed report produces no lines', () => {
  assert.deepEqual([...describeImageReport({ requested: 4, sent_to_gemini: 4, omitted: [] })], []);
  for (const r of [null, undefined, {}, { omitted: 'x' }]) assert.deepEqual([...describeImageReport(r)], []);
});

test('every omission reason is named, with 1-based photo numbers', () => {
  const lines = [...describeImageReport({ requested: 13, sent_to_gemini: 8, omitted: [
    { index: 2, reason: 'unavailable' }, { index: 5, reason: 'payload_limit' }, { index: 6, reason: 'payload_limit' },
    { index: 9, reason: 'time_limit' }, { index: 10, reason: 'over_limit' }, { index: 11, reason: 'over_limit' }, { index: 12, reason: 'over_limit' }] })];
  assert.equal(lines[0], 'The AI analysed 8 of 13 photos. All photos are still included in the listing; only the AI analysis is affected.');
  assert.ok(lines.includes('Photos 11, 12, 13: not analysed by the AI (it reviews at most 10 photos per request).'));
  assert.ok(lines.includes('Photos 6, 7: not analysed by the AI (the request size limit was reached).'));
  assert.ok(lines.includes('Photo 10: not analysed by the AI (loading the photos took too long).'));
  assert.ok(lines.includes('Photo 3: not analysed by the AI (the photo could not be loaded).'));
  // Not analysed is never worded as removed: no line may suggest a photo left the listing.
  for (const l of lines) assert.doesNotMatch(l, /removed|deleted|not (added|included|saved)|excluded|check that they are still/i, l);
  assert.equal(lines.length, 5);
});

test('a 504 gemini_timeout becomes a readable, coded, retryable error that lists omitted photos', () => {
  const body = JSON.stringify({ error: 'Gemini did not respond within the available time. Try again in a minute, or generate with fewer photos.',
    code: 'gemini_timeout', retryable: true, retry_after_seconds: 60, image_report: { requested: 3, sent_to_gemini: 2, omitted: [{ index: 2, reason: 'payload_limit' }] } });
  const err = importerErrorFromResponse(504, body);
  assert.equal(err.code, 'gemini_timeout');
  assert.equal(err.retryable, true);
  assert.equal(err.status, 504);
  assert.match(err.message, /^Gemini did not respond within the available time\. Try again in a minute, or generate with fewer photos\. The AI analysed 2 of 3 photos\. All photos are still included in the listing; only the AI analysis is affected\. Photo 3: not analysed by the AI/);
  assert.equal(describeAiGenFailure(err), err.message, 'the Edit flow shows the message as-is, no generic suffix');
});

test('every other failure keeps the previous "<status>: <body>" message exactly', () => {
  assert.equal(importerErrorFromResponse(500, '{"error":"Gemini API 400: bad"}').message, '500: {"error":"Gemini API 400: bad"}');
  assert.equal(importerErrorFromResponse(403, '{"error":"Admin only"}').message, '403: {"error":"Admin only"}');
  assert.equal(importerErrorFromResponse(502, 'x'.repeat(300)).message, '502: ' + 'x'.repeat(200));
  assert.equal(importerErrorFromResponse(504, '<html>gateway</html>').code, undefined, 'a platform 504 without the code is not mistaken for a Gemini timeout');
});

test('both callers use the parser, and both show the image report', () => {
  assert.equal((admin.match(/throw importerErrorFromResponse\(res\.status, err\);/g) || []).length, 2);
  assert.match(admin, /renderImportSummary\(aiResult, importImages, fbWarnings\.concat\(describeImageReport\(aiResult\.image_report\)\)\)/);
  assert.ok((admin.match(/describeImageReport\(result\.image_report\)/g) || []).length >= 2, 'Edit shows omissions in both success branches');
});

test('the Smart Import uploader makes renditions with the shared helper before the photo becomes usable', () => {
  const up = extractFn(admin, '_handleImportImageUploadBatch');
  const iR = up.indexOf('await _uploadRenditionsBestEffort(uploadBlob, fileName);');
  const iPush = up.indexOf('importImages.push(publicUrl);');
  assert.ok(iR > 0 && iPush > iR, 'renditions are attempted before the URL is added to importImages');
  const gallery = extractFn(admin, 'uploadImageFileToStorage');
  assert.match(gallery, /await _uploadRenditionsBestEffort\(uploadBlob, fileName\);/, 'the gallery uploader uses the same helper');
  const helper = extractFn(admin, '_uploadRenditionsBestEffort');
  assert.match(helper, /uploadRenditions\(uploadBlob, fileName, \{/);
  assert.match(helper, /catch \(renditionErr\)/, 'never throws');
});

test('Generate itself uploads nothing and writes no row: uploads happen only when photos are added', () => {
  const run = extractFn(admin, 'runSmartImport');
  assert.equal(/storage\/v1\/object/.test(run), false, 'no Storage call inside runSmartImport');
  assert.equal(/\/rest\/v1\//.test(run), false, 'no database call inside runSmartImport');
  assert.equal(/importImages\s*=\s*\[\]|importImages\.length\s*=\s*0/.test(run), false, 'a failure does not clear the uploaded photos');
});
