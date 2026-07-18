// Playwright coverage for intelligence.html. Run from tests/intelligence/:
//   npm install && npx playwright install --with-deps chromium && npm test
// See README.md for CI usage. All Supabase calls are mocked (mock-supabase.js) --
// this suite never needs real credentials or network access.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');
const { makeReports, makeInsights, makeReportInsights, makeLeads, makeDataQualityInsight } = require('./fixtures');

async function login(page) {
  await page.goto('/intelligence.html');
  await page.fill('#password-input', 'whatever');
  await page.click('.login-btn');
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
    await page.waitForSelector('.supporting-toggle');
    await page.click('.supporting-toggle');
    await expect(page.locator('.supporting-panel')).toHaveClass(/open/);
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
  test('renders a data-quality alert with icon, title, and a "Fix now" action link to admin.html', async ({ page }) => {
    const insights = { ...makeInsights(), ...makeDataQualityInsight() };
    await installSupabaseMocks(page, { reports: makeReports(), insights, reportInsights: makeReportInsights(), leads: [] });
    await login(page);
    await page.waitForSelector('#alerts-card .alert-item');
    const item = page.locator('#alerts-card .alert-item', { hasText: 'Missing photos: Riverside Condo' });
    await expect(item).toBeVisible();
    await expect(item.locator('.alert-icon')).toHaveText('📷');
    await expect(item.locator('.alert-reason')).toHaveText('Data quality issue');
    const action = item.locator('.alert-action');
    await expect(action).toHaveText('Fix now');
    await expect(action).toHaveAttribute('href', 'admin.html?edit=p-2');
  });

  test('renders a failed-report alert derived from report history', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: {}, reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#alerts-card .alert-item');
    const item = page.locator('#alerts-card .alert-item', { hasText: 'Report generation failed' });
    await expect(item).toBeVisible();
    await expect(item.locator('.alert-reason')).toContainText('Gemini request timed out');
  });

  test('renders a new-lead alert with a relative time reason', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: {}, reportInsights: [], leads: makeLeads() });
    await login(page);
    await page.waitForSelector('#alerts-card .alert-item');
    const item = page.locator('#alerts-card .alert-item', { hasText: 'New lead: Riverside Villa' });
    await expect(item).toBeVisible();
    await expect(item.locator('.alert-icon')).toHaveText('📞');
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
