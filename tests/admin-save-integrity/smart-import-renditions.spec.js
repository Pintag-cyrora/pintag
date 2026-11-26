// Smart Import photo preparation and failure handling, driven through the REAL admin.html in Chromium with every
// network call answered locally (nothing reaches Supabase or Gemini).
//   * the Smart Import uploader stores the same WebP renditions as the gallery uploader, BEFORE the photo is offered
//     to Generate, at the exact path the importer reads (renditions/<stem>/hero.webp);
//   * a failed rendition upload never loses or blocks the photo;
//   * a Gemini timeout (504 gemini_timeout) is shown as a readable, retryable message; it creates no listing row and
//     no extra upload, and Generate again re-sends exactly the same photo URLs;
//   * photos the AI did not analyse are listed to the user (Smart Import summary, Edit status), never dropped silently.
const { test, expect } = require('@playwright/test');

async function boot(page, { renditionStatus = 200, restHandler = null, storageHandler = null, smallPhotos = false } = {}) {
  const storage = []; const rest = []; const fn = [];
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),refreshSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}}};}};' }));
  await page.route('**/admin-auth.js*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: 'window.PintagAdminAuth={protect:function(c,cb){cb();},token:async()=>"t",requireAdminSession:async()=>true,ADMIN_EMAIL:"x"};' }));
  if (restHandler) await page.route('**/rest/v1/**', restHandler);
  else await page.route('**/rest/v1/**', (r) => { rest.push(r.request().method() + ' ' + new URL(r.request().url()).pathname); r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); });
  await page.route('**/storage/v1/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    storage.push(r.request().method() + ' ' + p);
    if (storageHandler) return storageHandler(r, p);
    const isRendition = p.includes('/renditions/');
    r.fulfill({ status: isRendition ? renditionStatus : 200, contentType: 'application/json', body: '{"Key":"x"}' });
  });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin.html');
  await page.waitForFunction(() => typeof window.handleImportImageUpload === 'function' && typeof window.runSmartImport === 'function' && typeof window.generateRenditions === 'function');
  // The watermarker returns a real, large JPEG (2400x1800 noise) so the shared generator produces renditions smaller
  // than the upload, exactly as it does for a real photo.
  await page.evaluate(async (small) => {
    WM.ready = true;
    WM.applyToFile = async () => {
      const W = small ? 64 : 2400, H = small ? 48 : 1800;   // small: many-photo tests, where only the URLs matter
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d'); const d = ctx.createImageData(W, H);
      for (let i = 0; i < d.data.length; i += 4) { d.data[i] = (i * 7) & 255; d.data[i + 1] = (i * 13) & 255; d.data[i + 2] = (i >> 9) & 255; d.data[i + 3] = 255; }
      ctx.putImageData(d, 0, 0);
      return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
    };
  }, smallPhotos);
  return { storage, rest, fn, errors };
}
const upload = (page, n = 1) => page.evaluate(async (n) => {
  await handleImportImageUpload(Array.from({ length: n }, (_, i) => new File([new Uint8Array([1, 2, 3])], `p${i}.jpg`, { type: 'image/jpeg' })));
  return { images: importImages.slice(), status: document.getElementById('import-upload-status').textContent };
}, n);

test('Smart Import stores the shared renditions BEFORE the photo is usable, at the path the importer reads', async ({ page }) => {
  const { storage, errors } = await boot(page);
  const { images, status } = await upload(page);
  expect(images).toHaveLength(1);
  expect(status).toContain('Uploaded 1 of 1');
  const name = images[0].split('/property-images/')[1];
  const posts = storage.filter((s) => s.startsWith('POST'));
  expect(posts[0]).toBe(`POST /storage/v1/object/property-images/${name}`);                 // original first
  const expectedHero = await page.evaluate((n) => renditionPath(n, 'hero'), name);
  expect(expectedHero).toBe(`renditions/${name.replace(/\.jpg$/, '')}/hero.webp`);
  expect(posts).toContain(`POST /storage/v1/object/property-images/${expectedHero}`);       // what the importer fetches
  expect(posts.filter((s) => s.includes('/renditions/')).length).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('a failed rendition upload never blocks or loses the photo', async ({ page }) => {
  const { storage, errors } = await boot(page, { renditionStatus: 500 });
  const { images, status } = await upload(page, 2);
  expect(images).toHaveLength(2);
  expect(status).toContain('Uploaded 2 of 2');
  expect(storage.filter((s) => s.startsWith('POST') && !s.includes('/renditions/'))).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('Gemini timeout: readable retryable message, no listing row, no extra upload; Generate again re-sends the same photos', async ({ page }) => {
  const { storage, rest } = await boot(page);
  const bodies = [];
  await page.route('**/functions/v1/smart-listing-importer', (r) => {
    bodies.push(JSON.parse(r.request().postData()));
    r.fulfill({ status: 504, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Gemini did not respond within the available time. Try again in a minute, or generate with fewer photos.',
        code: 'gemini_timeout', retryable: true, retry_after_seconds: 60,
        image_report: { requested: 3, sent_to_gemini: 2, omitted: [{ index: 2, url: 'x', reason: 'payload_limit' }] } }) });
  });
  const { images } = await upload(page, 3);
  const writes = () => storage.filter((s) => !s.startsWith('GET'));   // uploads only; thumbnail GETs may arrive at any time
  const writesAfterUpload = writes().length;
  await page.evaluate(() => { document.getElementById('import-description').value = 'House'; });

  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => runSmartImport());
    const msg = await page.evaluate(() => document.getElementById('import-message').textContent);
    expect(msg).toContain('Gemini did not respond within the available time');
    expect(msg).toContain('The AI analysed 2 of 3 photos. All photos are still included in the listing; only the AI analysis is affected.');
    expect(msg).toContain('Photo 3: not analysed by the AI (the request size limit was reached).');
    expect(msg).not.toContain('504:');
    expect(await page.evaluate(() => document.getElementById('import-gen-btn').disabled)).toBe(false);   // can retry
  }
  expect(bodies).toHaveLength(2);
  expect(bodies[0].image_urls).toEqual(images);
  expect(bodies[1].image_urls).toEqual(images);                     // the same photos, not re-uploaded copies
  expect(writes().length).toBe(writesAfterUpload);                  // Generate uploaded nothing
  expect(rest.filter((r) => !r.startsWith('GET'))).toEqual([]);     // and wrote no row (no POST/PATCH/DELETE)
  expect(await page.evaluate(() => importImages.slice())).toEqual(images);
});

test('a non-timeout error keeps the previous "<status>: <body>" message', async ({ page }) => {
  await boot(page);
  await page.route('**/functions/v1/smart-listing-importer', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Gemini API 400: bad"}' }));
  await upload(page);
  await page.evaluate(() => runSmartImport());
  expect(await page.evaluate(() => document.getElementById('import-message').textContent)).toContain('500: {"error":"Gemini API 400: bad"}');
});

test('Smart Import success lists every photo the AI did not analyse in the summary', async ({ page }) => {
  await boot(page);
  const { images } = await upload(page, 2);
  await page.route('**/functions/v1/smart-listing-importer', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    title: 'House', images: images.map((u) => ({ storageUrl: u })),
    image_report: { requested: 12, sent_to_gemini: 9, omitted: [
      { index: 4, url: 'a', reason: 'unavailable' }, { index: 10, url: 'b', reason: 'over_limit' }, { index: 11, url: 'c', reason: 'over_limit' }] } }) }));
  await page.evaluate(() => { document.getElementById('import-description').value = 'House'; });
  await page.evaluate(() => runSmartImport());
  const banner = await page.evaluate(() => document.getElementById('import-summary-banner').textContent);
  expect(banner).toContain('The AI analysed 9 of 12 photos. All photos are still included in the listing; only the AI analysis is affected.');
  expect(banner).toContain('Photos 11, 12: not analysed by the AI (it reviews at most 10 photos per request).');
  expect(banner).toContain('Photo 5: not analysed by the AI (the photo could not be loaded).');
});

test('Edit "generate" shows photo omissions and keeps the notice on screen', async ({ page }) => {
  await boot(page);
  await page.route('**/functions/v1/smart-listing-importer', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    title: 'AI Title', description_en: 'AI description', photo_conflicts: [],
    image_report: { requested: 8, sent_to_gemini: 7, omitted: [{ index: 7, url: 'x', reason: 'time_limit' }] } }) }));
  await page.evaluate(() => {
    showForm(null);
    document.getElementById('f-type').value = 'house'; renderPropertyTypeFields('house');
    document.getElementById('f-transaction').value = 'for_rent'; onTransactionChange();
  });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => generateAIContent());
  await page.waitForTimeout(5600);   // longer than the 5 s auto-hide of a plain success message
  const st = await page.evaluate(() => { const el = document.getElementById('ai-gen-status'); return { text: el.textContent, shown: el.style.display !== 'none' }; });
  expect(st.text).toContain('Not every photo was analysed');
  expect(st.text).toContain('Photo 8: not analysed by the AI (loading the photos took too long).');
  expect(st.shown).toBe(true);
});

// ── Correction 1: every uploaded photo reaches the listing, even past the AI's 10-photo limit ────────────────
// The importer response below has the shape the real handler now returns for n photos (pinned by
// smart-listing-importer-handler.test.js): all n in images[], the AI's order for the 10 it analysed, then the
// rest in upload order; photos 11..n reported as over_limit. The form, #f-images and the saved row must keep all n.
const { fakeBackend, FILL_NEW_LISTING, SAVE } = require('./fixtures');
for (const n of [12, 15]) {
  test(`${n} uploaded photos (10 analysed): all ${n} populate the form, reach #f-images and are saved, in order`, async ({ page }) => {
    const backend = fakeBackend();
    await boot(page, { restHandler: backend.handle, smallPhotos: true });
    const { images } = await upload(page, n);
    expect(images).toHaveLength(n);
    const aiOrder = [3, 0, 1, 2, 4, 5, 6, 7, 8, 9];
    const expected = [...aiOrder, ...Array.from({ length: n - 10 }, (_, k) => 10 + k)].map((i) => images[i]);
    const sent = [];
    await page.route('**/functions/v1/smart-listing-importer', (r) => {
      sent.push(JSON.parse(r.request().postData()).image_urls);
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        title: 'House', property_type: { value: 'house' }, transaction_type: { value: 'for_rent' },
        images: expected.map((u, k) => ({ storageUrl: u, primary: k === 0, source: 'manual' })),
        recommended_order: aiOrder,
        image_report: { requested: n, sent_to_gemini: 10,
          omitted: Array.from({ length: n - 10 }, (_, k) => ({ index: 10 + k, url: images[10 + k], reason: 'over_limit' })) } }) });
    });
    await page.evaluate(() => { document.getElementById('import-description').value = 'House'; });
    await page.evaluate(() => runSmartImport());
    expect(sent).toEqual([images]);                                            // Generate sent every photo
    const form = await page.evaluate(() => JSON.parse(document.getElementById('f-images').value));
    expect(form).toEqual(expected);                                            // the save field holds all n, in order
    expect(await page.evaluate(() => importImageModel.length)).toBe(n);
    const banner = await page.evaluate(() => document.getElementById('import-summary-banner').textContent);
    expect(banner).toContain(`The AI analysed 10 of ${n} photos. All photos are still included in the listing; only the AI analysis is affected.`);
    expect(banner).toContain(`Photos ${Array.from({ length: n - 10 }, (_, k) => 11 + k).join(', ')}: not analysed by the AI (it reviews at most 10 photos per request).`);

    await page.evaluate(FILL_NEW_LISTING);                                     // required fields only; images untouched
    await page.evaluate(SAVE);
    const inserts = backend.state.requests.filter((q) => q.method === 'POST' && q.table === 'properties');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].body.images).toEqual(expected);                          // the saved row keeps all n
  });
}

// ── Correction 2: Generate is unavailable while any photo upload is in progress ───────────────────────────────
// Original uploads (not renditions) are held until the test releases them, so an upload can be kept "in progress".
function heldStorage() {
  const held = [];
  let mode = 'hold';          // 'hold' | 'pass'
  const handler = (r, p) => {
    if (r.request().method() === 'POST' && !p.includes('/renditions/') && mode === 'hold') { held.push(r); return; }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' });
  };
  return { held, handler, pass: () => { mode = 'pass'; } };
}
const files = (tag, n = 1) => `Array.from({ length: ${n} }, (_, i) => new File([new Uint8Array([1])], '${tag}' + i + '.jpg', { type: 'image/jpeg' }))`;
const startUpload = (page, tag, n = 1) => page.evaluate(`(window.__up = window.__up || {}, window.__done = window.__done || [],
  window.__up['${tag}'] = handleImportImageUpload(${files(tag, n)}).then(() => window.__done.push('${tag}'), (e) => window.__done.push('${tag}:threw:' + e.message)), true)`);
const button = (page) => page.evaluate(() => { const b = document.getElementById('import-gen-btn'); return { disabled: b.disabled, label: b.textContent.trim() }; });
const WAITING = { disabled: true, label: '⌛ Waiting for photo uploads…' };
const READY = { disabled: false, label: '⚡ Generate Listing' };

async function expectGenerateRefused(page, calls) {
  await page.evaluate(() => { document.getElementById('import-description').value = 'House'; });
  await page.evaluate(() => runSmartImport());
  expect(calls.length).toBe(0);                                                // no importer request was made
  expect(await page.evaluate(() => document.getElementById('import-message').textContent))
    .toBe('Photos are still uploading — Generate will be available when every upload has finished.');
}
async function importerCalls(page) {
  const calls = [];
  await page.route('**/functions/v1/smart-listing-importer', (r) => { calls.push(r.request().postData());
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ title: 'House', images: [] }) }); });
  return calls;
}

test('one upload: Generate is disabled (and refuses to run) until it finishes, then is available again', async ({ page }) => {
  const st = heldStorage();
  const { errors } = await boot(page, { storageHandler: st.handler, smallPhotos: true });
  const calls = await importerCalls(page);
  expect(await button(page)).toEqual(READY);
  await startUpload(page, 'a');
  await expect.poll(() => st.held.length).toBe(1);
  expect(await button(page)).toEqual(WAITING);
  expect(await page.locator('#import-gen-btn').isDisabled()).toBe(true);       // a real click cannot start Generate
  await expectGenerateRefused(page, calls);
  st.pass(); st.held.shift().fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' });
  await page.waitForFunction(() => window.__done.length === 1);
  expect(await page.evaluate(() => window.__done)).toEqual(['a']);
  expect(await button(page)).toEqual(READY);
  expect(await page.evaluate(() => importImages.length)).toBe(1);
  await page.evaluate(() => runSmartImport());
  expect(calls.length).toBe(1);                                                // and now Generate runs
  expect(errors).toEqual([]);
});

test('concurrent uploads: one finishing does not re-enable Generate while another (multi-photo) batch is still running', async ({ page }) => {
  const st = heldStorage();
  await boot(page, { storageHandler: st.handler, smallPhotos: true });
  const calls = await importerCalls(page);
  await startUpload(page, 'a');
  await expect.poll(() => st.held.length).toBe(1);
  await startUpload(page, 'b', 2);
  await expect.poll(() => st.held.length).toBe(2);                            // both batches are mid-upload
  expect(await button(page)).toEqual(WAITING);
  st.held.shift().fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' });   // batch 'a' (held first)
  await page.waitForFunction(() => window.__done.length === 1);
  expect(await page.evaluate(() => window.__done)).toEqual(['a']);
  expect(await button(page)).toEqual(WAITING);                                // 'b' is still running
  await expectGenerateRefused(page, calls);
  st.held.shift().fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' });   // b's first photo
  await expect.poll(() => st.held.length).toBe(1);                            // b's second photo is now uploading
  expect(await page.evaluate(() => window.__done.length)).toBe(1);
  expect(await button(page)).toEqual(WAITING);
  st.pass(); st.held.shift().fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' });
  await page.waitForFunction(() => window.__done.length === 2);
  expect(await page.evaluate(() => window.__done)).toEqual(['a', 'b']);
  expect(await button(page)).toEqual(READY);
  expect(await page.evaluate(() => importImages.length)).toBe(3);
  await page.evaluate(() => runSmartImport());
  expect(calls.length).toBe(1);
});

for (const [name, fail] of [
  ['an HTTP 500 from Storage', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' })],
  ['a network failure', (r) => r.abort('failed')],
]) {
  test(`failed upload (${name}): Generate is available again once it has failed, not before`, async ({ page }) => {
    const st = heldStorage();
    await boot(page, { storageHandler: st.handler, smallPhotos: true });
    await startUpload(page, 'bad');
    await expect.poll(() => st.held.length).toBe(1);
    expect(await button(page)).toEqual(WAITING);
    st.pass(); await fail(st.held.shift());
    await page.waitForFunction(() => window.__done.length === 1);
    expect(await page.evaluate(() => window.__done)).toEqual(['bad']);
    expect(await page.evaluate(() => document.getElementById('import-upload-status').textContent)).toMatch(/Upload error 500|Network error/);
    expect(await button(page)).toEqual(READY);
    expect(await page.evaluate(() => importImages.length)).toBe(0);
  });
}

test('a failed upload alongside one still running keeps Generate disabled until the running one finishes', async ({ page }) => {
  const st = heldStorage();
  await boot(page, { storageHandler: st.handler, smallPhotos: true });
  await startUpload(page, 'bad');
  await expect.poll(() => st.held.length).toBe(1);
  await startUpload(page, 'good');
  await expect.poll(() => st.held.length).toBe(2);
  await st.held.shift().fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
  await page.waitForFunction(() => window.__done.length === 1);
  expect(await button(page)).toEqual(WAITING);
  st.pass(); st.held.shift().fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' });
  await page.waitForFunction(() => window.__done.length === 2);
  expect(await button(page)).toEqual(READY);
  expect(await page.evaluate(() => importImages.length)).toBe(1);
});

test('a watermark refusal or an unexpected exception during upload still restores Generate', async ({ page }) => {
  await boot(page, { smallPhotos: true });
  await page.evaluate(() => { WM.applyToFile = async () => { throw new Error('watermark refused'); }; });
  await startUpload(page, 'wm');
  await page.waitForFunction(() => window.__done.length === 1);
  expect(await button(page)).toEqual(READY);
  // An exception escaping the upload body (here: the progress element is missing) must not leave the button stuck.
  await page.evaluate(() => document.getElementById('import-upload-progress').remove());
  await startUpload(page, 'boom');
  await page.waitForFunction(() => window.__done.length === 2);
  expect(await page.evaluate(() => window.__done[1])).toMatch(/^boom:threw:/);
  expect(await button(page)).toEqual(READY);
  expect(await page.evaluate(() => _importUploadsInFlight)).toBe(0);
});

test('an upload started while Generate runs keeps Generate disabled after Generate ends, until the upload finishes', async ({ page }) => {
  const st = heldStorage(); st.pass();
  await boot(page, { storageHandler: st.handler, smallPhotos: true });
  await upload(page, 1);
  let releaseImporter; const importerHeld = new Promise((res) => { releaseImporter = res; });
  await page.route('**/functions/v1/smart-listing-importer', async (r) => { await importerHeld;
    r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }); });
  await page.evaluate(() => { document.getElementById('import-description').value = 'House'; window.__gen = runSmartImport(); });
  await expect.poll(() => button(page)).toEqual({ disabled: true, label: '⌛ Processing...' });
  const st2 = heldStorage(); await page.unroute('**/storage/v1/**');
  await page.route('**/storage/v1/**', (r) => st2.handler(r, new URL(r.request().url()).pathname));
  await startUpload(page, 'late');
  await expect.poll(() => st2.held.length).toBe(1);
  expect(await button(page)).toEqual({ disabled: true, label: '⌛ Processing...' });   // Generate still owns the button
  releaseImporter();
  await page.evaluate(() => window.__gen);
  expect(await button(page)).toEqual(WAITING);                                // Generate ended, the upload has not
  st2.pass(); st2.held.shift().fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' });
  await page.waitForFunction(() => window.__done.length === 1);
  expect(await button(page)).toEqual(READY);
});

test('after a successful Generate the button is restored', async ({ page }) => {
  await boot(page, { smallPhotos: true });
  const { images } = await upload(page, 1);
  await page.route('**/functions/v1/smart-listing-importer', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ title: 'House', images: images.map((u) => ({ storageUrl: u })) }) }));
  await page.evaluate(() => { document.getElementById('import-description').value = 'House'; });
  await page.evaluate(() => runSmartImport());
  expect(await button(page)).toEqual(READY);
});

// ── 15-photo listing limit: uploads, Facebook and concurrent batches counted together ─────────────────────────
const OK = { status: 200, contentType: 'application/json', body: '{"Key":"x"}' };
const originals = (storage) => storage.filter((s) => s.startsWith('POST') && !s.includes('/renditions/'));
const statusText = (page) => page.evaluate(() => document.getElementById('import-upload-status').textContent);
const photos = (page) => page.evaluate(() => importImages.slice());
const LIMIT_REACHED = 'The listing has reached the maximum of 15 photos — remove a photo to add another.';
// The limit note has its own line, outside the upload progress box (which hides itself after a batch).
const note = (page) => page.evaluate(() => { const el = document.getElementById('import-limit-note');
  return { text: el.textContent, visible: el.style.display !== 'none' && !el.closest('#import-upload-progress') }; });

test('one batch of 18: 15 are uploaded, the 3 others are named as not added and never uploaded', async ({ page }) => {
  const { storage } = await boot(page, { smallPhotos: true });
  await page.evaluate(() => showImportPanel());                               // the panel as the user sees it
  await upload(page, 18);
  expect(await photos(page)).toHaveLength(15);
  expect(originals(storage)).toHaveLength(15);                                 // the extra 3 never reach Storage
  expect(await statusText(page)).toBe(`Uploaded 15 of 15. ${LIMIT_REACHED}`);
  expect(await note(page)).toEqual({ text: `3 photos not added (p15.jpg, p16.jpg, p17.jpg): a listing can have at most 15 photos. ${LIMIT_REACHED}`, visible: true });
  await page.waitForTimeout(2800);                                             // the progress box hides itself…
  expect((await note(page)).visible).toBe(true);                               // …the limit note stays
  expect(await page.locator('#import-limit-note').isVisible()).toBe(true);     // really on screen
  expect(await page.locator('#import-upload-progress').isVisible()).toBe(false);
});

test('below the limit the status says how many more can be added; at the limit a further upload adds nothing and says so', async ({ page }) => {
  const { storage } = await boot(page, { smallPhotos: true });
  await upload(page, 4);
  expect(await statusText(page)).toBe('Uploaded 4 of 4. You can add 11 more (maximum 15 per listing).');
  expect((await note(page)).visible).toBe(false);                              // nothing refused yet
  await upload(page, 11);
  expect(await statusText(page)).toBe(`Uploaded 11 of 11. ${LIMIT_REACHED}`);
  await page.waitForTimeout(2800);                                             // progress box (and its status) hidden now
  await upload(page, 2);
  expect(await photos(page)).toHaveLength(15);
  expect(originals(storage)).toHaveLength(15);
  expect(await note(page)).toEqual({ text: `2 photos not added (p0.jpg, p1.jpg): a listing can have at most 15 photos. ${LIMIT_REACHED}`, visible: true });
  expect(await button(page)).toEqual(READY);
  await page.evaluate(() => removeImportImage(importImages[0]));               // removing one frees exactly one slot
  expect((await note(page)).text).toMatch(/You can add 1 more \(maximum 15 per listing\)\.$/);
  await upload(page, 2);
  expect(await photos(page)).toHaveLength(15);
  expect((await note(page)).text).toBe(`2 photos not added (p0.jpg, p1.jpg): a listing can have at most 15 photos. 1 photo not added (p1.jpg): a listing can have at most 15 photos. ${LIMIT_REACHED}`);
});

test('concurrent batches share the remaining room: 10 + 10 started together give exactly 15, with the overflow named', async ({ page }) => {
  const st = heldStorage();
  const { storage } = await boot(page, { storageHandler: st.handler, smallPhotos: true });
  await startUpload(page, 'a', 10);
  await expect.poll(() => st.held.length).toBe(1);                            // 'a' reserved 10 slots, first photo in flight
  await startUpload(page, 'b', 10);
  await expect.poll(() => st.held.length).toBe(2);                            // 'b' got only the 5 that were left
  const B_NOTE = '5 photos not added (b5.jpg, b6.jpg, b7.jpg, b8.jpg, b9.jpg): a listing can have at most 15 photos.';
  expect((await note(page)).text).toContain(B_NOTE);
  // Let 'b' finish first, then 'a': the batch that ends last must not hide b's note.
  st.pass();
  st.held.splice(1, 1)[0].fulfill(OK);                                         // b's first photo; b's others pass
  await page.waitForFunction(() => window.__done.includes('b'));
  st.held.shift().fulfill(OK);                                                 // now a's
  await page.waitForFunction(() => window.__done.length === 2);
  expect(await page.evaluate(() => window.__done)).toEqual(['b', 'a']);
  expect(await note(page)).toEqual({ text: `${B_NOTE} ${LIMIT_REACHED}`, visible: true });
  const got = await photos(page);
  expect(got).toHaveLength(15);
  expect(originals(storage)).toHaveLength(15);
  expect(await page.evaluate(() => _importSlotsReserved)).toBe(0);
});

test('a failed upload gives its slot back: 15 attempted with one failure leaves room for exactly one more', async ({ page }) => {
  let n = 0;
  await boot(page, { smallPhotos: true, storageHandler: (r, p) => {
    if (r.request().method() === 'POST' && !p.includes('/renditions/') && ++n === 3) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
    return r.fulfill(OK);
  } });
  await upload(page, 15);
  expect(await photos(page)).toHaveLength(14);
  expect(await page.evaluate(() => _importSlotsReserved)).toBe(0);
  await upload(page, 3);
  expect(await photos(page)).toHaveLength(15);
  expect((await note(page)).text).toContain('2 photos not added (p1.jpg, p2.jpg)');
});

async function routeFacebook(page, count, { hold } = {}) {
  const fbUrls = Array.from({ length: count }, (_, i) => `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/property-images/fb-${i}.jpg`);
  await page.route('**/functions/v1/facebook-listing-fetcher', async (r) => {
    if (hold) await hold;
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ title: 'FB House',
      images: fbUrls.map((u, i) => ({ storageUrl: u, originalUrl: `https://scontent.example/fb-${i}.jpg` })), metadata: {} }) });
  });
  return fbUrls;
}
async function routeImporter(page) {
  const sent = [];
  await page.route('**/functions/v1/smart-listing-importer', (r) => {
    const urls = JSON.parse(r.request().postData()).image_urls; sent.push(urls);
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ title: 'House', images: urls.map((u) => ({ storageUrl: u })) }) });
  });
  return sent;
}

test('Facebook photos count toward the same limit: 12 uploaded + 6 from Facebook gives 15, and the 3 left out are reported', async ({ page }) => {
  await boot(page, { smallPhotos: true });
  const { images } = await upload(page, 12);
  const fb = await routeFacebook(page, 6);
  const sent = await routeImporter(page);
  await page.evaluate(() => { document.getElementById('import-fb-url').value = 'https://www.facebook.com/marketplace/item/1'; });
  await page.evaluate(() => runSmartImport());
  expect(sent).toEqual([[...images, ...fb.slice(0, 3)]]);                      // 15 sent, uploads first
  expect(await photos(page)).toHaveLength(15);
  expect(await page.evaluate(() => JSON.parse(document.getElementById('f-images').value))).toHaveLength(15);
  const banner = await page.evaluate(() => document.getElementById('import-summary-banner').textContent);
  expect(banner).toContain('3 of the 6 photos from Facebook were not added: a listing can have at most 15 photos and 12 were already added or uploading.');
});

test('an upload started while Facebook photos are being fetched is counted too: the two together never exceed 15', async ({ page }) => {
  const st = heldStorage();
  await boot(page, { storageHandler: st.handler, smallPhotos: true });
  let releaseFb; const fbHeld = new Promise((res) => { releaseFb = res; });
  const fb = await routeFacebook(page, 12, { hold: fbHeld });
  const sent = await routeImporter(page);
  await page.evaluate(() => { document.getElementById('import-fb-url').value = 'https://www.facebook.com/marketplace/item/2'; window.__gen = runSmartImport(); });
  await startUpload(page, 'u', 5);                                             // reserves 5 while Facebook is fetched
  await expect.poll(() => st.held.length).toBe(1);
  releaseFb();
  await page.evaluate(() => window.__gen);
  expect(sent[0]).toEqual(fb.slice(0, 10));                                    // 15 - 5 reserved = 10 Facebook photos
  const banner = await page.evaluate(() => document.getElementById('import-summary-banner').textContent);
  expect(banner).toContain('2 of the 12 photos from Facebook were not added: a listing can have at most 15 photos and 5 were already added or uploading.');
  st.pass(); while (st.held.length) st.held.shift().fulfill(OK);
  await page.waitForFunction(() => window.__done.length === 1);
  expect(await photos(page)).toHaveLength(15);
});

// ── Stale uploads: an upload from an earlier import session never touches a newly opened one ───────────────────
test('reopening the panel detaches a running upload: it adds no photo, uploads no further file, and leaves the new session alone', async ({ page }) => {
  const st = heldStorage();
  const { storage } = await boot(page, { storageHandler: st.handler, smallPhotos: true });
  await startUpload(page, 'old', 3);
  await expect.poll(() => st.held.length).toBe(1);
  expect(await button(page)).toEqual(WAITING);
  await page.evaluate(() => showImportPanel());                               // new session
  expect(await button(page)).toEqual(READY);                                   // the old upload no longer blocks Generate
  expect(await photos(page)).toEqual([]);
  expect(await statusText(page)).toBe('');
  st.pass(); st.held.shift().fulfill(OK);                                      // the old upload's first photo lands now
  await page.waitForFunction(() => window.__done.length === 1);
  expect(await photos(page)).toEqual([]);                                      // never added to the new session
  expect(originals(storage)).toHaveLength(1);                                  // its 2 remaining files were not uploaded
  expect(await statusText(page)).toBe('');                                     // and it wrote nothing on the new status line
  expect((await note(page)).visible).toBe(false);
  expect(await page.evaluate(() => ({ inFlight: _importUploadsInFlight, reserved: _importSlotsReserved }))).toEqual({ inFlight: 0, reserved: 0 });
  expect(await button(page)).toEqual(READY);
});

test('a stale upload finishing while a new-session upload runs does not re-enable Generate or change the new photos', async ({ page }) => {
  const st = heldStorage();
  await boot(page, { storageHandler: st.handler, smallPhotos: true });
  await startUpload(page, 'old');
  await expect.poll(() => st.held.length).toBe(1);
  await page.evaluate(() => showImportPanel());
  await startUpload(page, 'new', 2);
  await expect.poll(() => st.held.length).toBe(2);
  expect(await button(page)).toEqual(WAITING);
  st.held.shift().fulfill(OK);                                                 // the OLD upload completes
  await page.waitForFunction(() => window.__done.includes('old'));
  expect(await button(page)).toEqual(WAITING);                                 // still waiting for the new one
  expect(await photos(page)).toEqual([]);
  expect(await page.evaluate(() => _importUploadsInFlight)).toBe(1);
  st.pass(); st.held.shift().fulfill(OK);
  await page.waitForFunction(() => window.__done.includes('new'));
  const got = await photos(page);
  expect(got).toHaveLength(2);
  expect(got.every((u) => /property-images\/\d+-[a-z0-9]+\.jpg$/.test(u))).toBe(true);
  expect(await button(page)).toEqual(READY);
  expect(await statusText(page)).toBe('Uploaded 2 of 2. You can add 13 more (maximum 15 per listing).');
});

test('a stale upload that FAILS after reopening changes nothing in the new session', async ({ page }) => {
  const st = heldStorage();
  await boot(page, { storageHandler: st.handler, smallPhotos: true });
  await startUpload(page, 'old');
  await expect.poll(() => st.held.length).toBe(1);
  await page.evaluate(() => showImportPanel());
  await startUpload(page, 'new');                                             // held too
  await expect.poll(() => st.held.length).toBe(2);
  st.pass();
  st.held.shift().fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });   // old fails
  await page.waitForFunction(() => window.__done.includes('old'));
  expect(await statusText(page)).not.toContain('Upload error');
  expect(await button(page)).toEqual(WAITING);
  st.held.shift().fulfill(OK);
  await page.waitForFunction(() => window.__done.includes('new'));
  expect(await button(page)).toEqual(READY);
  expect(await photos(page)).toHaveLength(1);
});

test("a stale upload's reserved slots are not counted against the new session: it can take all 15", async ({ page }) => {
  const st = heldStorage();
  const { storage } = await boot(page, { storageHandler: st.handler, smallPhotos: true });
  await startUpload(page, 'old', 10);
  await expect.poll(() => st.held.length).toBe(1);
  await page.evaluate(() => showImportPanel());
  st.pass();
  await upload(page, 15);
  expect(await photos(page)).toHaveLength(15);
  st.held.shift().fulfill(OK);                                                 // release the old one last
  await page.waitForFunction(() => window.__done.includes('old'));
  expect(await photos(page)).toHaveLength(15);
  expect(originals(storage)).toHaveLength(16);                                 // 15 new + the 1 old file already in flight
  expect(await page.evaluate(() => ({ inFlight: _importUploadsInFlight, reserved: _importSlotsReserved }))).toEqual({ inFlight: 0, reserved: 0 });
});

// ── Stale Generate: a Facebook or importer answer arriving after the panel was reopened is ignored ─────────────
// Snapshot of everything a stale answer could touch in the new session.
const sessionView = (page) => page.evaluate(() => ({
  photos: importImages.slice(),
  limitNote: document.getElementById('import-limit-note').textContent,
  importMessage: { shown: document.getElementById('import-message').style.display !== 'none', text: document.getElementById('import-message').textContent },
  steps: { shown: document.getElementById('import-progress-steps').style.display !== 'none',
           errors: document.querySelectorAll('#import-progress-steps .error, #import-progress-steps [class*="error"]').length },
  importPanelShown: document.getElementById('import-panel').style.display === 'block',
  formPanelShown: document.getElementById('form-panel').style.display !== 'none',
  title: document.getElementById('f-title-en').value,
  fImages: document.getElementById('f-images').value,
  fbData: window._importFbData || null,
  running: _smartImportRunning,
  button: (() => { const b = document.getElementById('import-gen-btn'); return { disabled: b.disabled, label: b.textContent.trim() }; })(),
}));
async function heldRoute(page, pattern) {
  let release; const gate = new Promise((res) => { release = res; });
  const hits = [];
  await page.route(pattern, async (r) => { hits.push(r.request().postData()); const answer = await gate; answer(r); });
  return { hits, answer: (fn) => release(fn) };
}
const FB_URL = 'https://www.facebook.com/marketplace/item/9';
const fbAnswer = (n) => (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ title: 'STALE FB HOUSE', description: 'stale',
  images: Array.from({ length: n }, (_, i) => ({ storageUrl: `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/property-images/stale-${i}.jpg`, originalUrl: 'https://scontent.example/x.jpg' })),
  metadata: { sourceUrl: FB_URL, warnings: ['stale warning'] } }) });
async function startStaleGenerate(page) {
  await page.evaluate((u) => { showImportPanel(); document.getElementById('import-fb-url').value = u; window.__gen = runSmartImport(); }, FB_URL);
}

for (const [label, answer] of [
  ['a successful Facebook answer (12 photos)', fbAnswer(12)],
  ['a failed Facebook answer (HTTP 500)', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"fetch failed"}' })],
  ['a Facebook network failure', (r) => r.abort('failed')],
]) {
  test(`stale Generate: ${label} arriving after the panel was reopened changes nothing in the new session`, async ({ page }) => {
    const { errors } = await boot(page, { smallPhotos: true });
    const fb = await heldRoute(page, '**/functions/v1/facebook-listing-fetcher');
    const importer = await routeImporter(page);
    await startStaleGenerate(page);
    await expect.poll(() => fb.hits.length).toBe(1);                         // Facebook request in flight
    await page.evaluate(() => showImportPanel());                             // the user starts over
    const fresh = await sessionView(page);
    expect(fresh.button).toEqual(READY);                                      // the old Generate no longer owns the button
    expect(fresh.running).toBe(false);
    fb.answer(answer);                                                         // the old answer lands now
    await page.evaluate(() => window.__gen);
    expect(await sessionView(page)).toEqual(fresh);                           // nothing at all changed
    expect(importer).toEqual([]);                                             // and the importer was never called
    expect(errors).toEqual([]);
  });
}

test('stale Generate: the new session can Generate meanwhile, and the old Facebook answer cannot overwrite its result', async ({ page }) => {
  await boot(page, { smallPhotos: true });
  const fb = await heldRoute(page, '**/functions/v1/facebook-listing-fetcher');
  const importer = await routeImporter(page);
  await startStaleGenerate(page);
  await expect.poll(() => fb.hits.length).toBe(1);
  await page.evaluate(() => showImportPanel());
  const { images } = await upload(page, 2);                                   // new session: own photos, own Generate
  await page.evaluate(() => { document.getElementById('import-description').value = 'New house'; });
  await page.evaluate(() => runSmartImport());
  expect(importer).toEqual([images]);                                         // only the new session's photos were sent
  const after = await sessionView(page);
  expect(after.formPanelShown).toBe(true);
  expect(JSON.parse(after.fImages)).toEqual(images);
  fb.answer(fbAnswer(12));                                                    // the old Facebook answer finally arrives
  await page.evaluate(() => window.__gen);
  expect(await sessionView(page)).toEqual(after);                             // the new result is untouched
  expect(importer).toHaveLength(1);
});

test('stale Generate: an importer answer arriving after the panel was reopened does not populate the form', async ({ page }) => {
  await boot(page, { smallPhotos: true });
  const { images } = await upload(page, 1);
  const importer = await heldRoute(page, '**/functions/v1/smart-listing-importer');
  await page.evaluate(() => { document.getElementById('import-description').value = 'Old house'; window.__gen = runSmartImport(); });
  await expect.poll(() => importer.hits.length).toBe(1);
  await page.evaluate(() => showImportPanel());
  const fresh = await sessionView(page);
  importer.answer((r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ title: 'STALE TITLE', images: images.map((u) => ({ storageUrl: u })), image_report: { requested: 1, sent_to_gemini: 1, omitted: [] } }) }));
  await page.evaluate(() => window.__gen);
  expect(await sessionView(page)).toEqual(fresh);
  expect(fresh.formPanelShown).toBe(false);
});

test('stale Generate: a failed importer answer after reopening shows no error in the new session', async ({ page }) => {
  await boot(page, { smallPhotos: true });
  await upload(page, 1);
  const importer = await heldRoute(page, '**/functions/v1/smart-listing-importer');
  await page.evaluate(() => { document.getElementById('import-description').value = 'Old house'; window.__gen = runSmartImport(); });
  await expect.poll(() => importer.hits.length).toBe(1);
  await page.evaluate(() => showImportPanel());
  const fresh = await sessionView(page);
  importer.answer((r) => r.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ error: 'slow', code: 'gemini_timeout', retryable: true }) }));
  await page.evaluate(() => window.__gen);
  expect(await sessionView(page)).toEqual(fresh);
});

test('control: a Facebook answer in the SAME session is still applied (the guard only blocks stale answers)', async ({ page }) => {
  await boot(page, { smallPhotos: true });
  const fb = await heldRoute(page, '**/functions/v1/facebook-listing-fetcher');
  const importer = await routeImporter(page);
  await startStaleGenerate(page);                                             // same helper, but no reopen this time
  await expect.poll(() => fb.hits.length).toBe(1);
  fb.answer(fbAnswer(3));
  await page.evaluate(() => window.__gen);
  expect(importer).toHaveLength(1);
  expect(importer[0]).toHaveLength(3);
  const v = await sessionView(page);
  expect(v.formPanelShown).toBe(true);
  expect(v.button).toEqual(READY);
});
