// Regression for the "Required before publishing" error that named fields nobody could see.
//
// Reported: with an agent selected, Save Listing showed
//   Required before publishing: Buyer Contact phone, Unit Type #1 (1 Bedroom): Bathrooms, Unit Type #1 (1 Bedroom): Price,
//   Unit Type #2: Name, Unit Type #2: Bedrooms, Unit Type #2: Bathrooms, Unit Type #2: Price.
// The validation itself was right (nothing was written): Buyer Contact is a separate section that selecting an agent does
// NOT fill (the agent card only previews the agent's WhatsApp number), "1 Bedroom" infers Bedrooms but never Bathrooms,
// and unit-type cards start collapsed, so the empty fields were hidden. The fix keeps every rule and makes the failure
// actionable: the cards that need input are opened, the empty inputs are outlined and the first one is focused, and the
// Buyer Contact message says how to use the selected agent's number.
//
// Drives the REAL admin.html against the in-memory Supabase fake (same harness as save-integrity.spec.js).

const { test, expect } = require('@playwright/test');
const { fakeBackend, boot, FORM_STATE } = require('./fixtures');

const AGENT = { id: 'agent-keomany', name_en: 'Keomany', whatsapp: '+85620 5551234', agency_name: 'Pintag', is_active: true };
const SAVE_BTN = '#submit-btn';

async function openNewListingWithAgent(page, backend, propertyType) {
  propertyType = propertyType || 'condo';
  await boot(page, backend);
  // Serve the agent through the real loader (loadAgentsForDropdown) rather than poking _agentsAll,
  // which that async load would otherwise overwrite.
  await page.route('**/rest/v1/parties*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([AGENT]) }));
  await page.evaluate((propertyType) => {
    showForm();
    document.getElementById('f-type').value = propertyType; renderPropertyTypeFields(propertyType);
    document.getElementById('f-transaction').value = 'for_sale'; onTransactionChange();
    document.getElementById('f-workflow-status').value = 'active';
    document.getElementById('f-title-en').value = 'Visibility Test Listing';
  }, propertyType);
  await page.waitForFunction((id) => !!document.querySelector('#f-agent-id option[value="' + id + '"]'), AGENT.id);
}
const writes = (backend) => backend.state.requests.filter((r) => r.method !== 'GET').map((r) => r.method + ' ' + r.table);

test.describe('publish validation is visible and actionable', () => {
  test('the reported state: blocked, nothing written, collapsed cards opened, empty inputs outlined, Buyer Contact hint shown', async ({ page }) => {
    const backend = fakeBackend();
    await openNewListingWithAgent(page, backend);
    await page.selectOption('#f-agent-id', AGENT.id);
    // Selecting an agent previews the number but does not fill the Buyer Contact (a separate, deliberate field).
    await expect(page.locator('#agent-preview-contact')).toHaveText('WhatsApp: ' + AGENT.whatsapp);
    expect(await page.inputValue('#f-contact-phone')).toBe('');

    const add = page.locator('.btn-add-row', { hasText: 'Add Unit Type' });
    await add.click(); await add.click();
    expect(await page.locator('.ut-card.expanded').count()).toBe(0);            // cards start collapsed
    await page.locator('.ut-card').first().locator('.ut-head').click();
    await page.locator('.ut-card').first().locator('.ut-name-en').fill('1 Bedroom');
    await page.locator('.ut-card').first().locator('.ut-head').click();          // collapse it again, as a user would

    await page.click(SAVE_BTN);
    const s = await page.evaluate(FORM_STATE);

    // Validation, not a failed write.
    expect(s.msgClass).toContain('error');
    expect(s.msg).toContain('Required before publishing: Buyer Contact phone, Unit Type #1 (1 Bedroom): Bathrooms, Unit Type #1 (1 Bedroom): Price, Unit Type #2: Name, Unit Type #2: Bedrooms, Unit Type #2: Bathrooms, Unit Type #2: Price.');
    expect(writes(backend)).toEqual([]);

    // The rules are unchanged, but the fields are now reachable.
    expect(s.msg).toContain('Same as selected agent');
    expect(await page.locator('.ut-card.expanded').count()).toBe(2);
    await expect(page.locator('#f-contact-phone')).toHaveClass(/field-missing/);
    await expect(page.locator('.ut-card').first().locator('.ut-bathrooms')).toHaveClass(/field-missing/);
    await expect(page.locator('.ut-card').first().locator('.ut-price-amount')).toHaveClass(/field-missing/);
    await expect(page.locator('.ut-card').nth(1).locator('.ut-name-en')).toHaveClass(/field-missing/);
    await expect(page.locator('.ut-card').first().locator('.ut-name-en')).not.toHaveClass(/field-missing/);   // filled
    await expect(page.locator('.ut-card').first().locator('.ut-bedrooms')).not.toHaveClass(/field-missing/);  // inferred
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('f-contact-phone');

    // Editing a flagged field clears only its own outline.
    await page.fill('#f-contact-phone', '02055512345');
    await expect(page.locator('#f-contact-phone')).not.toHaveClass(/field-missing/);
    await expect(page.locator('.ut-card').first().locator('.ut-bathrooms')).toHaveClass(/field-missing/);
  });

  test('no agent selected: same validation, no agent hint', async ({ page }) => {
    const backend = fakeBackend();
    await openNewListingWithAgent(page, backend);
    await page.click(SAVE_BTN);
    const s = await page.evaluate(FORM_STATE);
    expect(s.msg).toContain('Required before publishing: Buyer Contact phone.');
    expect(s.msg).not.toContain('Same as selected agent');
    expect(writes(backend)).toEqual([]);
  });

  test('following the guidance saves exactly once: "Same as selected agent" + completing the one real card (and removing the blank one)', async ({ page }) => {
    const backend = fakeBackend();
    await openNewListingWithAgent(page, backend);
    await page.selectOption('#f-agent-id', AGENT.id);
    const add = page.locator('.btn-add-row', { hasText: 'Add Unit Type' });
    await add.click(); await add.click();
    await page.locator('.ut-card').first().locator('.ut-head').click();
    await page.locator('.ut-card').first().locator('.ut-name-en').fill('1 Bedroom');
    await page.click(SAVE_BTN);
    expect(writes(backend)).toEqual([]);

    await page.click('text=Same as selected agent');
    expect(await page.inputValue('#f-contact-phone')).toBe(AGENT.whatsapp);
    await page.locator('.ut-card').first().locator('.ut-bathrooms').fill('1');
    await page.locator('.ut-card').first().locator('.ut-price-amount').fill('250000');
    await page.locator('.ut-card').nth(1).locator('.btn-remove').click();

    await page.click(SAVE_BTN);
    await expect.poll(async () => (await page.evaluate(FORM_STATE)).msgClass).toContain('success');
    expect(backend.count('POST', 'properties')).toBe(1);
    expect(backend.count('POST', 'unit_types')).toBe(1);
    expect(backend.count('POST', 'contacts')).toBe(1);
    // Exactly the records of one listing exist -- no duplicate listing, contact or unit type.
    expect(Object.keys(backend.state.properties)).toHaveLength(1);
    expect(Object.keys(backend.state.unitTypes)).toHaveLength(1);
    expect(Object.keys(backend.state.contacts)).toHaveLength(1);
    // A second tap on Save after success edits that listing instead of creating another.
    await page.evaluate(() => saveListing({ preventDefault() {} }));
    expect(Object.keys(backend.state.properties)).toHaveLength(1);
    expect(Object.keys(backend.state.unitTypes)).toHaveLength(1);
    expect(backend.count('POST', 'properties')).toBe(1);
  });
});

// The report came from a phone: touch taps, a ~390px viewport, and the failing fields below the fold.
test.describe('publish validation on a phone-sized touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tapping through the reported state: first missing field is scrolled into view, outlined, nothing overflows sideways', async ({ page }) => {
    const backend = fakeBackend();
    // 'land' on purpose: house/condo currently widen the whole page past a 390px phone (the property-details
    // check-grid), a separate pre-existing layout issue that is not what this spec is about.
    await openNewListingWithAgent(page, backend, 'land');
    await page.selectOption('#f-agent-id', AGENT.id);
    const add = page.locator('.btn-add-row', { hasText: 'Add Unit Type' });
    await add.tap(); await add.tap();
    await page.locator('.ut-card').first().locator('.ut-head').tap();
    await page.locator('.ut-card').first().locator('.ut-name-en').fill('1 Bedroom');
    await page.locator('.ut-card').first().locator('.ut-head').tap();

    await page.locator(SAVE_BTN).tap();
    const s = await page.evaluate(FORM_STATE);
    expect(s.msg).toContain('Required before publishing');
    expect(writes(backend)).toEqual([]);

    // Smooth scrolling: wait for the focused field to settle inside the viewport.
    await expect.poll(() => page.evaluate(() => {
      const el = document.getElementById('f-contact-phone'); const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    })).toBe(true);
    await expect(page.locator('#f-contact-phone')).toHaveClass(/field-missing/);

    // Every unit-type field named in the error is now reachable, and the page is not wider than the phone.
    expect(await page.locator('.ut-card.expanded').count()).toBe(2);
    const dims = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth, winW: window.innerWidth,
      fields: [...document.querySelectorAll('.field-missing')].map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, right: r.right }; }),
    }));
    expect(dims.docW).toBeLessThanOrEqual(dims.winW);
    expect(dims.fields.length).toBe(7);                       // phone + 6 unit-type fields
    dims.fields.forEach((f) => { expect(f.w).toBeGreaterThan(0); expect(f.right).toBeLessThanOrEqual(dims.winW); });
  });
});
