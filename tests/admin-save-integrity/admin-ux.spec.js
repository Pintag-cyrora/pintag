// Admin UX regressions from the 2026-09-02 QA audit:
//   * photos are NEVER uploaded unwatermarked -- if the watermark logo is not
//     ready (or a file cannot be processed) the upload is refused with a
//     visible reason, for the building uploader, unit uploaders and Smart
//     Import alike;
//   * AI content generation never silently replaces text the operator already
//     wrote -- one confirm lists the occupied fields; Cancel keeps them and
//     fills only the empty ones.
const { test, expect } = require('@playwright/test');

async function boot(page) {
  const storage = [];
  await page.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),refreshSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}}),onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};}},storage:{from:function(){return {upload:async()=>({}),getPublicUrl:function(){return {data:{publicUrl:""}};}};}}};}};' }));
  await page.route('**/admin-auth.js*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: 'window.PintagAdminAuth={protect:function(c,cb){cb();},token:async()=>"t",requireAdminSession:async()=>true,ADMIN_EMAIL:"x"};' }));
  await page.route('**/rest/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/storage/v1/**', (r) => { storage.push(r.request().method() + ' ' + new URL(r.request().url()).pathname); r.fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' }); });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin.html');
  await page.waitForFunction(() => typeof window.uploadImageFileToStorage === 'function' && typeof window.handleImportImageUpload === 'function' && typeof window.generateAIContent === 'function');
  return { storage, errors };
}
const FAKE_FILE = () => new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });

test.describe('watermark gate', () => {
  test('logo failed to load -> upload refused with a visible reason, nothing reaches storage', async ({ page }) => {
    const { storage } = await boot(page);
    const msg = await page.evaluate(async () => {
      WM.ready = false; WM.initPromise = Promise.resolve(false);
      try { await uploadImageFileToStorage(new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' })); return 'RESOLVED'; }
      catch (e) { return e.message; }
    });
    expect(msg).toContain('NOT uploaded');
    expect(msg).toContain('watermark');
    expect(storage.filter((s) => s.startsWith('POST'))).toHaveLength(0);
  });

  test('logo still loading -> the uploader WAITS for it, then uploads the watermarked blob', async ({ page }) => {
    const { storage } = await boot(page);
    const url = await page.evaluate(async () => {
      WM.ready = false;
      WM.initPromise = new Promise((res) => setTimeout(() => { WM.ready = true; res(true); }, 300));
      WM.applyToFile = async () => new Blob(['wm'], { type: 'image/jpeg' });
      return uploadImageFileToStorage(new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }));
    });
    expect(url).toMatch(/\/storage\/v1\/object\/public\/property-images\/.+\.jpg$/);
    expect(storage.filter((s) => s.startsWith('POST') && !s.includes('renditions/'))).toHaveLength(1);
  });

  test('a file the canvas cannot process is refused, not uploaded raw', async ({ page }) => {
    const { storage } = await boot(page);
    const msg = await page.evaluate(async () => {
      WM.ready = true; WM.applyToFile = async () => null;
      try { await uploadImageFileToStorage(new File([new Uint8Array([1])], 'broken.heic', { type: 'image/heic' })); return 'RESOLVED'; }
      catch (e) { return e.message; }
    });
    expect(msg).toContain('broken.heic NOT uploaded');
    expect(storage.filter((s) => s.startsWith('POST'))).toHaveLength(0);
  });

  test('Smart Import uploader shows the same refusal inline and uploads nothing', async ({ page }) => {
    const { storage } = await boot(page);
    const status = await page.evaluate(async () => {
      WM.ready = false; WM.initPromise = Promise.resolve(false);
      await handleImportImageUpload([new File([new Uint8Array([1, 2, 3])], 'fb.jpg', { type: 'image/jpeg' })]);
      return document.getElementById('import-upload-status').textContent;
    });
    expect(status).toContain('fb.jpg NOT uploaded');
    expect(storage.filter((s) => s.startsWith('POST'))).toHaveLength(0);
    expect(await page.evaluate(() => importImages.length)).toBe(0);
  });
});

test.describe('AI generation never silently overwrites', () => {
  const AI = { title: 'AI Title', title_lo: 'AI ຫົວຂໍ້', description_en: 'AI description', description_lo: 'AI ລາຍລະອຽດ', property_highlight_en: 'AI highlight' };
  async function bootWithAi(page) {
    const ctx = await boot(page);
    await page.route('**/functions/v1/smart-listing-importer', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AI) }));
    await page.evaluate(() => {
      showForm(null);
      document.getElementById('f-type').value = 'house'; renderPropertyTypeFields('house');
      document.getElementById('f-transaction').value = 'for_rent'; onTransactionChange();
      document.getElementById('f-desc-en').value = 'Human-written description';
      document.getElementById('f-title-en').value = '';
      document.getElementById('f-highlight-en').value = '';
    });
    return ctx;
  }
  const FIELDS = () => ({ title: document.getElementById('f-title-en').value, titleLo: document.getElementById('f-title-lo').value, desc: document.getElementById('f-desc-en').value, descLo: document.getElementById('f-desc-lo').value, hl: document.getElementById('f-highlight-en').value });

  test('Cancel keeps the operator text and fills only the empty fields', async ({ page }) => {
    const { errors } = await bootWithAi(page);
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await page.evaluate(() => generateAIContent());
    await page.waitForTimeout(500);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain('Description (EN)');
    expect(dialogs[0]).not.toContain('Title (EN)');
    const f = await page.evaluate(FIELDS);
    expect(f.desc).toBe('Human-written description');
    expect(f.title).toContain('AI Title');
    expect(f.hl).toBe('AI highlight');
    expect(f.descLo).toBe('AI ລາຍລະອຽດ');
    expect(errors).toEqual([]);
  });

  test('OK replaces the listed fields', async ({ page }) => {
    await bootWithAi(page);
    page.on('dialog', (d) => d.accept());
    await page.evaluate(() => generateAIContent());
    await page.waitForTimeout(500);
    const f = await page.evaluate(FIELDS);
    expect(f.desc).toBe('AI description');
    expect(f.title).toContain('AI Title');
  });

  test('no confirm at all when every target field is empty', async ({ page }) => {
    await bootWithAi(page);
    await page.evaluate(() => { document.getElementById('f-desc-en').value = ''; });
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await page.evaluate(() => generateAIContent());
    await page.waitForTimeout(500);
    expect(dialogs).toHaveLength(0);
    expect((await page.evaluate(FIELDS)).desc).toBe('AI description');
  });
});
