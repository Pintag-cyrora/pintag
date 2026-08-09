// Agent soft-hide — ADMIN surfaces.
//
//   * buildAgentOptions (admin.html assignment picker): hidden agents are not
//     offered, EXCEPT the one already assigned to the listing being edited —
//     dropping that option would blank the dropdown and wipe managed_by_party_id
//     on save. The REAL function is extracted from admin.html and run against a
//     real <select> so option parsing / value-sticking behave as in production.
//   * agent-setup.html Hide/Show control writes ONLY parties.is_active (no
//     listing/relationship change), booted with auth + supabase-js stubbed.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

// Pull a top-level `function <name>(...) { ... }` out of a file by brace-matching.
function extractFn(file, name) {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found in ' + file);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

test.describe('admin.html assignment picker filtering (real buildAgentOptions)', () => {
  const buildAgentOptions = extractFn('admin.html', 'buildAgentOptions');

  async function setup(page) {
    await page.setContent('<select id="f-agent-id"></select><input id="f-agent-search">');
    await page.evaluate((fnSrc) => {
      window.esc = (s) => (s == null ? '' : String(s));
      window._agentsAll = [
        { id: 'a-visible', name_en: 'Visible Agent', name_lo: 'ເຫັນ', agency_name: 'Pintag', is_active: true },
        { id: 'a-hidden',  name_en: 'Hidden Agent',  name_lo: 'ເຊື່ອງ', agency_name: 'Pintag', is_active: false },
      ];
      // eslint-disable-next-line no-eval
      (0, eval)(fnSrc); // defines global buildAgentOptions
    }, buildAgentOptions);
  }

  test('a new listing offers active agents and omits hidden ones', async ({ page }) => {
    await setup(page);
    const opts = await page.evaluate(() => {
      buildAgentOptions('');
      return Array.from(document.getElementById('f-agent-id').options).map(o => ({ v: o.value, t: o.textContent }));
    });
    const values = opts.map(o => o.v);
    expect(values).toContain('a-visible');
    expect(values).not.toContain('a-hidden');
  });

  test('editing a listing managed by a hidden agent keeps that agent selectable and selected', async ({ page }) => {
    await setup(page);
    const res = await page.evaluate(() => {
      // ensureId = the assigned (hidden) agent — mirrors editListing().
      buildAgentOptions('', 'a-hidden');
      const sel = document.getElementById('f-agent-id');
      const opt = Array.from(sel.options).find(o => o.value === 'a-hidden');
      return { value: sel.value, hasOption: !!opt, label: opt ? opt.textContent : null };
    });
    // The link must survive: the option exists, is selected, and is marked hidden.
    expect(res.hasOption).toBe(true);
    expect(res.value).toBe('a-hidden');
    expect(res.label).toContain('(hidden)');
  });

  test('a search that matches nothing yields only the empty option', async ({ page }) => {
    await setup(page);
    const values = await page.evaluate(() => {
      buildAgentOptions('zzzzz');
      return Array.from(document.getElementById('f-agent-id').options).map(o => o.value);
    });
    expect(values).toEqual(['']);
  });
});

test.describe('agent-setup.html Hide/Show control', () => {
  const AGENT = {
    id: 'agent-daeng', type: 'agent', slug: 'daeng', name_en: 'Daeng Somphone',
    name_lo: 'ແດງ', agency_name: 'Pintag', whatsapp: '02055500000', is_verified: true,
    bio_en: 'Advisor.', bio_lo: 'ທີ່ປຶກສາ', is_active: true,
  };

  // Boot the auth-gated page without real auth or the supabase-js CDN.
  async function stub(page, patched) {
    await page.route('**/cdn.jsdelivr.net/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript',
        body: 'window.supabase={createClient:function(){return {auth:{getSession:async()=>({data:{session:null}}),refreshSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{}}})},storage:{from:function(){return {upload:async()=>({}),getPublicUrl:function(){return {data:{publicUrl:""}};}};}}};}};' }));
    await page.route('**/admin-auth.js*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript',
        body: 'window.PintagAdminAuth={protect:function(c,cb){cb();},token:async()=>"test-token",requireAdminSession:async()=>true,ADMIN_EMAIL:"x"};' }));
    await page.route('**/rest/v1/**', (route) => {
      const req = route.request();
      const url = req.url();
      if (req.method() === 'PATCH' && url.indexOf('/parties?id=eq.') !== -1) {
        patched.url = url;
        patched.body = req.postDataJSON();
        return route.fulfill({ status: 204, body: '' });
      }
      if (url.indexOf('/parties') !== -1 && req.method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([AGENT]) });
      }
      if (url.indexOf('/properties') !== -1 && req.method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
  }

  test('Hide writes only is_active=false and flips the button to Show', async ({ page }) => {
    const patched = {};
    await stub(page, patched);
    page.on('dialog', d => d.accept()); // confirm() on hide
    await page.goto('/agent-setup.html');
    await expect(page.locator('#form-wrap')).toBeVisible();
    // Select the agent -> summary + visibility toggle appear.
    await page.selectOption('#f-agent-select', 'agent-daeng');
    await expect(page.locator('#visibility-toggle')).toBeVisible();
    await expect(page.locator('#visibility-toggle')).toHaveText('Hide agent');
    await page.click('#visibility-toggle');
    await expect(page.locator('#visibility-toggle')).toHaveText('Show agent');
    expect(patched.body, 'the PATCH must set is_active=false').toEqual({ is_active: false });
    // Only the is_active key — no listing/relationship fields touched.
    expect(Object.keys(patched.body)).toEqual(['is_active']);
    expect(patched.url).toContain('parties?id=eq.agent-daeng');
  });

  test('Show re-activates a hidden agent (is_active=true)', async ({ page }) => {
    const patched = {};
    await stub(page, { get url() {}, set url(v) {} }); // ignore first
    // Re-stub with a hidden agent so the button starts as "Show agent".
    await page.unroute('**/rest/v1/**');
    await page.route('**/rest/v1/**', (route) => {
      const req = route.request();
      const url = req.url();
      if (req.method() === 'PATCH' && url.indexOf('/parties?id=eq.') !== -1) {
        patched.body = req.postDataJSON();
        return route.fulfill({ status: 204, body: '' });
      }
      if (url.indexOf('/parties') !== -1 && req.method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([Object.assign({}, AGENT, { is_active: false })]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/agent-setup.html');
    await expect(page.locator('#form-wrap')).toBeVisible();
    await page.selectOption('#f-agent-select', 'agent-daeng');
    await expect(page.locator('#visibility-toggle')).toHaveText('Show agent');
    await page.click('#visibility-toggle'); // no confirm on show
    await expect(page.locator('#visibility-toggle')).toHaveText('Hide agent');
    expect(patched.body).toEqual({ is_active: true });
  });
});
