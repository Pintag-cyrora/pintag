// Playwright coverage for intelligence.html. Run from tests/intelligence/:
//   npm install && npx playwright install --with-deps chromium && npm test
// See README.md for CI usage. All Supabase calls are mocked (mock-supabase.js) --
// this suite never needs real credentials or network access.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');
const { makeReports, makeInsights, makeReportInsights, makeLeads, makeDataQualityInsight, makeListingsNeedingAttentionInsights, makeValidationFallbackReport, makeIntelligenceV2Insights, makeIntelligenceV2ReportInsights } = require('./fixtures');

async function login(page) {
  // Privileged pages now gate on the shared admin-auth.js module (single admin,
  // AAL2 2FA), which injects its own overlay and reveals #intel-screen only
  // after it verifies an AAL2 cyrora session server-side. installSupabaseMocks()
  // pre-seeds exactly such a persisted session, so the real module boots the
  // page on its own — there is no inline #password-input/.login-btn to drive.
  await page.goto('/intelligence.html');
  await page.waitForSelector('#intel-screen', { state: 'visible' });
  await page.waitForTimeout(200); // let the initial loadOverview() settle
}

test.describe('Overview tab', () => {
  test('Section 1: overview stats show the latest report', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    const text = await page.textContent('#overview-stats');
    expect(text).toContain('Healthy');
  });

  test('Section 1: shows the correct empty state with zero reports', async ({ page }) => {
    await installSupabaseMocks(page, { reports: [], insights: {}, reportInsights: [] });
    await login(page);
    const text = await page.textContent('#overview-stats');
    expect(text).toContain('No reports yet');
    await expect(page.locator('#report-container')).toContainText('No reports have been generated yet');
  });

  test("Today's Highlights: renders ranked insights for the latest report", async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.waitForSelector('#highlights-card .highlights-item, #highlights-card .highlights-empty');
    const items = await page.locator('#highlights-card .highlights-item').allTextContents();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((t) => t.includes('Demand spike: Sisattanak villas'))).toBe(true);
  });

  test("Today's Highlights: shows the empty message when the latest report has no linked insights", async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: {}, reportInsights: [] });
    await login(page);
    await expect(page.locator('#highlights-card')).toContainText('No major highlights today.');
  });

  test("Today's Highlights: stays pinned to the latest report while browsing history", async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.waitForSelector('#highlights-card .highlights-item');
    const before = await page.textContent('#highlights-card');
    await page.click('.history-table tbody tr:nth-child(2)'); // r-2, non-latest
    await page.waitForTimeout(150);
    await expect(page.locator('#latest-report-heading')).toHaveText(/^Viewing:/);
    const after = await page.textContent('#highlights-card');
    expect(after).toBe(before);
  });

  test('Section 2: renders the report card with markdown and chips', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.waitForSelector('.report-card');
    // r-3 is the true latest by generated_at (2h ago vs r-2's 26h ago),
    // even though r-2 sorts second in the fixture array.
    await expect(page.locator('.report-title')).toHaveText('Quiet day, nothing notable');
    const bodyHtml = await page.locator('.report-body').innerHTML();
    expect(bodyHtml).toContain('<h1>');
    expect(bodyHtml).toContain('<p>');
    await expect(page.locator('.chip-row')).toBeVisible();
  });

  test('Section 2: Advanced toggle reveals date/type/Delete controls', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.click('button:has-text("⚙ Advanced")');
    await expect(page.locator('#advanced-controls')).toBeVisible();
    await expect(page.locator('#delete-btn')).toBeEnabled();
  });

  test('Section 2: supporting data panel toggles open', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    // Scoped to the "Supporting data" toggle specifically: the report card
    // can render more than one .supporting-toggle/.supporting-panel pair
    // (e.g. Version metadata, below), so an unscoped '.supporting-panel'
    // locator is no longer unique.
    const toggle = page.locator('.supporting-toggle', { hasText: 'Supporting data' });
    await toggle.waitFor();
    await toggle.click();
    const panel = toggle.locator('xpath=following-sibling::*[1]');
    await expect(panel).toHaveClass(/open/);
  });

  test('Section 3: history table lists all reports, newest first, and rows are clickable', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    const rows = page.locator('.history-table tbody tr');
    await expect(rows).toHaveCount(3);
    // Newest first by generated_at: r-3 (2h ago), r-2 (26h ago), r-1 (70h ago).
    await expect(rows.nth(0)).toContainText('Quiet day, nothing notable');

    await rows.nth(2).click(); // the failed weekly report
    await page.waitForTimeout(150);
    await expect(page.locator('.report-card')).toContainText('Gemini request timed out');

    await page.click('#back-to-latest-link');
    await page.waitForTimeout(150);
    await expect(page.locator('#latest-report-heading')).toHaveText('Latest Intelligence Report');
  });

  test('Data Accuracy: confidence badge and data-quality panel render for a report that has them', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    // r-2 ("Demand spike in Sisattanak") is the second history row and
    // carries data_confidence/validation in the fixture.
    await page.click('.history-table tbody tr:nth-child(2)');
    await page.waitForTimeout(150);
    await expect(page.locator('.confidence-pill')).toHaveText('High confidence');
    await expect(page.locator('.confidence-pill')).toHaveClass(/high/);
    await expect(page.locator('.dq-fallback-banner')).toHaveCount(0);

    const dqToggles = page.locator('.supporting-toggle', { hasText: 'Data quality' });
    await dqToggles.click();
    const dqPanel = dqToggles.locator('xpath=following-sibling::*[1]');
    await expect(dqPanel).toHaveClass(/open/);
    await expect(dqPanel).toContainText('Snapshot finalized');
    await expect(dqPanel).toContainText('No conflicting insights detected');
    await expect(dqPanel).toContainText('sample size: 45');

    const verToggle = page.locator('.supporting-toggle', { hasText: 'Version metadata' });
    await verToggle.click();
    const verPanel = verToggle.locator('xpath=following-sibling::*[1]');
    await expect(verPanel).toHaveClass(/open/);
    await expect(verPanel).toContainText('Snapshot version: 1.1.0');
    await expect(verPanel).toContainText('Report version: 1.1.0');
    await expect(verPanel).toContainText('Prompt version: 1.1.0');
    await expect(verPanel).toContainText('Validator version: 1.0.0');
    await expect(verPanel).toContainText('AI model version: gemini-2.5-flash');
  });

  test('Data Accuracy: a report with no data_confidence/validation (e.g. generated before this feature) renders with no badge or panel, no crash', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    // r-3 (the true latest, shown by default) has neither field set.
    await expect(page.locator('.report-title')).toHaveText('Quiet day, nothing notable');
    await expect(page.locator('.confidence-pill')).toHaveCount(0);
    await expect(page.locator('.dq-fallback-banner')).toHaveCount(0);
    await expect(page.locator('.supporting-toggle', { hasText: 'Data quality' })).toHaveCount(0);

    // Version metadata panel still renders (generated_at/model_used are
    // core columns present on every report), but the four version-tracking
    // columns this report predates correctly show "n/a", not a crash or a
    // fabricated version.
    const verToggle = page.locator('.supporting-toggle', { hasText: 'Version metadata' });
    await expect(verToggle).toHaveCount(1);
    await verToggle.click();
    const verPanel = verToggle.locator('xpath=following-sibling::*[1]');
    await expect(verPanel).toContainText('Snapshot version: n/a');
    await expect(verPanel).toContainText('Prompt version: n/a');
  });

  test('Data Accuracy: narrative_fallback_used shows the validation-failure banner with the contradiction reason', async ({ page }) => {
    const reports = [...makeReports(), makeValidationFallbackReport()];
    await installSupabaseMocks(page, { reports, insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    const row = page.locator('.history-table tbody tr', { hasText: 'verified data only' });
    await row.click();
    await page.waitForTimeout(150);
    await expect(page.locator('.dq-fallback-banner')).toBeVisible();
    await expect(page.locator('.dq-fallback-banner')).toContainText('AI narrative failed validation');
    await expect(page.locator('.dq-fallback-banner')).toContainText('baseline');
    await expect(page.locator('.confidence-pill')).toHaveText('Low confidence');
  });

  test('Intelligence V2: Customer Intent panel renders the segment leaderboard', async ({ page }) => {
    const insights = { ...makeInsights(), ...makeIntelligenceV2Insights() };
    const reportInsights = [...makeReportInsights(), ...makeIntelligenceV2ReportInsights()];
    await installSupabaseMocks(page, { reports: makeReports(), insights, reportInsights });
    await login(page);
    await page.click('.history-table tbody tr:nth-child(2)'); // r-2, carries customer_intent_segments
    await page.waitForTimeout(150);

    const toggle = page.locator('.supporting-toggle', { hasText: 'Customer Intent' });
    await expect(toggle).toHaveText('▸ Customer Intent (2 segments)');
    await toggle.click();
    const panel = toggle.locator('xpath=following-sibling::*[1]');
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator('table.intent-table tbody tr')).toHaveCount(2);
    await expect(panel).toContainText('sale · villa · Sisattanak');
    await expect(panel).toContainText('$150000–$250000');
    await expect(panel).toContainText('rent · apartment · Chanthabouly');
    await expect(panel).toContainText('under $500');
  });

  test('Intelligence V2: Unmet Demand & Inventory Opportunities panel lists supply_shortage insights linked to this report', async ({ page }) => {
    const insights = { ...makeInsights(), ...makeIntelligenceV2Insights() };
    const reportInsights = [...makeReportInsights(), ...makeIntelligenceV2ReportInsights()];
    await installSupabaseMocks(page, { reports: makeReports(), insights, reportInsights });
    await login(page);
    await page.click('.history-table tbody tr:nth-child(2)'); // r-2

    const toggle = page.locator('.supporting-toggle', { hasText: 'Unmet Demand' });
    await expect(toggle).toHaveText('▸ Unmet Demand & Inventory Opportunities (1)');
    await toggle.click();
    const panel = toggle.locator('xpath=following-sibling::*[1]');
    await expect(panel).toHaveClass(/open/);
    await expect(panel).toContainText('Unmet demand: sale villa in Sisattanak');
    await expect(panel).toContainText('most-searched around $150000–$250000');
  });

  test('Intelligence V2: Listings To Fix panel lists low/high performing insights, with an Edit link only for low-performing', async ({ page }) => {
    const insights = { ...makeInsights(), ...makeIntelligenceV2Insights() };
    const reportInsights = [...makeReportInsights(), ...makeIntelligenceV2ReportInsights()];
    await installSupabaseMocks(page, { reports: makeReports(), insights, reportInsights });
    await login(page);
    await page.click('.history-table tbody tr:nth-child(2)'); // r-2

    const toggle = page.locator('.supporting-toggle', { hasText: 'Listings To Fix' });
    await expect(toggle).toHaveText('▸ Listings To Fix (2)');
    await toggle.click();
    const panel = toggle.locator('xpath=following-sibling::*[1]');
    await expect(panel).toHaveClass(/open/);
    await expect(panel).toContainText('Low performing: Hillside Villa');
    await expect(panel).toContainText('High performing: Riverside Condo');

    const items = panel.locator('.attention-item');
    await expect(items).toHaveCount(2);
    const lowItem = panel.locator('.attention-item', { hasText: 'Low performing' });
    await expect(lowItem.locator('a.alert-action')).toHaveText('Edit listing');
    await expect(lowItem.locator('a.alert-action')).toHaveAttribute('href', 'admin.html?edit=p-6');
    const highItem = panel.locator('.attention-item', { hasText: 'High performing' });
    await expect(highItem.locator('a.alert-action')).toHaveCount(0);
  });

  test('Intelligence V2: panels are absent (no crash) for a report with no customer-intent data or linked V2 insights', async ({ page }) => {
    const insights = { ...makeInsights(), ...makeIntelligenceV2Insights() };
    const reportInsights = [...makeReportInsights(), ...makeIntelligenceV2ReportInsights()];
    await installSupabaseMocks(page, { reports: makeReports(), insights, reportInsights });
    await login(page);
    // r-3 (the default latest report) has neither customer_intent_segments
    // nor any linked supply_shortage/low_performing_listing/high_performing_listing insight.
    await expect(page.locator('.report-title')).toHaveText('Quiet day, nothing notable');
    await expect(page.locator('.supporting-toggle', { hasText: 'Customer Intent' })).toHaveCount(0);
    await expect(page.locator('.supporting-toggle', { hasText: 'Unmet Demand' })).toHaveCount(0);
    await expect(page.locator('.supporting-toggle', { hasText: 'Listings To Fix' })).toHaveCount(0);
  });

  test('Section 4: Generate Daily shows loading then success and refreshes the page', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.click('#gen-btn-daily');
    await expect(page.locator('#gen-status-daily')).toContainText('Generated', { timeout: 5000 });
  });

  test('Section 5: System Health reflects last success/execution/error honestly, including "Not tracked" duration', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    const health = await page.textContent('#health-stats');
    expect(health).toContain('Last Successful Run');
    expect(health).toContain('Not tracked'); // no fabricated duration
    expect(health).toContain('Gemini request timed out');
  });

  test('Future modules: renders all 9 reserved placeholders', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await expect(page.locator('.future-card')).toHaveCount(9);
  });

  test('Delete: removes the report from history and falls back to a new latest (or empty state)', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.click('button:has-text("⚙ Advanced")'); // Delete lives behind the Advanced toggle
    page.once('dialog', (d) => d.accept());
    const before = await page.locator('.history-table tbody tr').count();
    await page.click('#delete-btn');
    await page.waitForTimeout(300);
    await expect(page.locator('.history-table tbody tr')).toHaveCount(before - 1);
  });
});

test.describe('XSS safety', () => {
  test('a malicious report title/markdown is escaped, never executed', async ({ page }) => {
    const reports = makeReports();
    reports.unshift({
      id: 'r-xss', report_type: 'daily', title: '<img src=x onerror=alert(1)>',
      period_start: '2026-07-18', period_end: '2026-07-18', generated_at: '2026-07-18T09:00:00Z',
      status: 'generated', error_message: null,
      executive_summary: '<script>alert(2)</script>', body_markdown: '# <script>alert(3)</script>\nHello',
      metrics_snapshot: {}, mentioned_districts: [], mentioned_property_types: [],
    });
    let alertFired = false;
    await installSupabaseMocks(page, { reports, insights: {}, reportInsights: [] });
    const page2Errors = [];
    page.on('dialog', () => { alertFired = true; });
    await login(page);
    await page.waitForSelector('.report-title');
    const titleHtml = await page.locator('.report-title').innerHTML();
    expect(titleHtml).toContain('&lt;img');
    expect(titleHtml).not.toContain('<img');
    expect(alertFired).toBe(false);
  });
});

test.describe('Alerts (Phase 2A)', () => {
  test('renders a data-quality alert with icon, title, reason, and an "Edit listing" action link to admin.html', async ({ page }) => {
    const insights = { ...makeInsights(), ...makeDataQualityInsight() };
    await installSupabaseMocks(page, { reports: makeReports(), insights, reportInsights: makeReportInsights(), leads: [] });
    await login(page);
    await page.waitForSelector('#alerts-card .alert-item');
    const item = page.locator('#alerts-card .alert-item', { hasText: 'Missing photos: Riverside Condo' });
    await expect(item).toBeVisible();
    await expect(item.locator('.alert-icon')).toHaveText('📷');
    await expect(item.locator('.alert-reason')).toContainText("buyers can't preview");
    const action = item.locator('.alert-action');
    await expect(action).toHaveText('Edit listing');
    await expect(action).toHaveAttribute('href', 'admin.html?edit=p-2');
  });

  test('renders a failed-report alert with a "Regenerate report" button that triggers Section 4\'s generate action', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: {}, reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#alerts-card .alert-item');
    const item = page.locator('#alerts-card .alert-item', { hasText: 'Report generation failed' });
    await expect(item).toBeVisible();
    await expect(item.locator('.alert-reason')).toContainText('Gemini request timed out');
    const action = item.locator('.alert-action-btn');
    await expect(action).toHaveText('Regenerate report');
    await action.click();
    await expect(page.locator('#gen-status-weekly')).toContainText('Generated', { timeout: 10000 });
  });

  test('renders a new-lead alert with a relative time reason and a "View listing" action', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: {}, reportInsights: [], leads: makeLeads() });
    await login(page);
    await page.waitForSelector('#alerts-card .alert-item');
    const item = page.locator('#alerts-card .alert-item', { hasText: 'New lead: Riverside Villa' });
    await expect(item).toBeVisible();
    await expect(item.locator('.alert-icon')).toHaveText('📞');
    const action = item.locator('.alert-action');
    await expect(action).toHaveText('View listing');
    await expect(action).toHaveAttribute('href', 'admin.html?edit=p-1');
  });

  test('shows the empty state when there is nothing to act on', async ({ page }) => {
    await installSupabaseMocks(page, {
      reports: makeReports().filter((r) => r.status !== 'failed'),
      insights: {}, reportInsights: [], leads: [],
    });
    await login(page);
    await expect(page.locator('#alerts-card')).toContainText('No alerts — everything looks healthy.');
  });

  test('sorts alerts by severity, highest first', async ({ page }) => {
    const insights = { ...makeDataQualityInsight() }; // severity: high
    await installSupabaseMocks(page, { reports: makeReports(), insights, reportInsights: [], leads: makeLeads() }); // leads are medium severity
    await login(page);
    await page.waitForSelector('#alerts-card .alert-item');
    const dots = await page.locator('#alerts-card .alert-severity-dot').evaluateAll(
      (els) => els.map((el) => (el.classList.contains('high') || el.classList.contains('critical') ? 'high' : el.className.split(' ')[1]))
    );
    const lastHighIndex = dots.lastIndexOf('high');
    const firstMediumIndex = dots.indexOf('medium');
    expect(firstMediumIndex).toBeGreaterThan(lastHighIndex);
  });

  test('data-quality conditions outside the 3-item allow-list do not appear in Alerts, even at high severity', async ({ page }) => {
    // Only the 3 conditions in DATA_QUALITY_PRESENTATION (missing_photos,
    // missing_ai_description, stale_listing) surface as Alerts -- the rest
    // (including missing_price, itself "high" severity) belong to Listings
    // Needing Attention instead, so the two sections never show the same
    // items twice. This fixture's insights are all metric_keys outside that
    // allow-list, so Alerts should render its empty state.
    const insights = { ...makeListingsNeedingAttentionInsights() };
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights, reportInsights: [], leads: [] });
    await login(page);
    await expect(page.locator('#alerts-card')).toContainText('No alerts — everything looks healthy.');
  });
});

test.describe('Listings Needing Attention (Phase 2B)', () => {
  test('groups multiple issues on the same listing into one card, all reasons listed', async ({ page }) => {
    const insights = { ...makeListingsNeedingAttentionInsights() };
    await installSupabaseMocks(page, { reports: makeReports(), insights, reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#attention-card .attention-item');
    const card = page.locator('#attention-card .attention-item', { hasText: 'Sunset Apartment' });
    await expect(card).toBeVisible();
    await expect(card.locator('.attention-issue')).toHaveCount(3);
    await expect(card.locator('.attention-issue').nth(0)).toContainText('Missing price');
    await expect(card.locator('.attention-issue').nth(1)).toContainText('Missing AI highlight');
    await expect(card.locator('.attention-issue').nth(2)).toContainText('Missing location');
    await expect(card.locator('.alert-action')).toHaveAttribute('href', 'admin.html?edit=p-4');
  });

  test('ranks by summed impact, not by listing id or recency', async ({ page }) => {
    // p-4 has 3 issues (high+medium+medium); p-5 has 1 (low) -- p-4 must rank first.
    const insights = { ...makeListingsNeedingAttentionInsights() };
    await installSupabaseMocks(page, { reports: makeReports(), insights, reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#attention-card .attention-item');
    const titles = await page.locator('#attention-card .attention-title').allTextContents();
    expect(titles.indexOf('Sunset Apartment')).toBeLessThan(titles.indexOf('Quiet House'));
  });

  test('shows the empty state when no listings need attention', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: {}, reportInsights: [], leads: [] });
    await login(page);
    await expect(page.locator('#attention-card')).toContainText('No listings need attention right now.');
  });
});

test.describe('Insights Archive + Timeline', () => {
  test('Archive tab renders the insight table and supports opening a timeline', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.click('button[data-tab="archive"]');
    await expect(page.locator('.archive-table tbody tr')).toHaveCount(1);

    await page.click('.archive-table tbody tr:first-child');
    await expect(page.locator('#timeline-view')).toBeVisible();
    // ins-1 is linked to both r-2 and r-3 (makeReportInsights) -- events are
    // First detected, Discussed in r-2, Discussed in r-3, Still active.
    await expect(page.locator('.timeline-item')).toHaveCount(4, { timeout: 5000 });
  });

  test('Timeline "discussed in report" link jumps back to Overview and loads that report', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.click('button[data-tab="archive"]');
    await page.click('.archive-table tbody tr:first-child');
    await page.waitForSelector('.timeline-text a');
    await page.click('.timeline-text a');
    await page.waitForTimeout(200);
    await expect(page.locator('#overview-view')).toBeVisible();
  });

  test('Back to Insights Archive link returns from the timeline', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.click('button[data-tab="archive"]');
    await page.click('.archive-table tbody tr:first-child');
    await page.click('text=← Back to Insights Archive');
    await expect(page.locator('#archive-view')).toBeVisible();
  });
});
