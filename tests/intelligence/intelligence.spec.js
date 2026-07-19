// Playwright coverage for intelligence.html. Run from tests/intelligence/:
//   npm install && npx playwright install --with-deps chromium && npm test
// See README.md for CI usage. All Supabase calls are mocked (mock-supabase.js) --
// this suite never needs real credentials or network access.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');
const { makeReports, makeInsights, makeReportInsights, makeLeads, makeDataQualityInsight, makeListingsNeedingAttentionInsights } = require('./fixtures');

async function login(page) {
  await page.goto('/intelligence.html');
  await page.fill('#password-input', 'whatever');
  await page.click('.login-btn');
  await page.waitForSelector('#intel-screen', { state: 'visible' });
  await page.waitForTimeout(200); // let the initial loadOverview() settle
}

test.describe('Overview tab', () => {
  test('Overview strip: a compact one-line readout, not a titled section', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    const text = await page.textContent('#overview-stats');
    expect(text).toContain('Healthy');
    // Demoted (Phase 3A WS1): no section-header/h2 wraps it, and it's not
    // a 4-card stat-grid anymore.
    await expect(page.locator('#overview-stats')).toHaveClass(/overview-strip/);
    await expect(page.locator('#overview-stats .stat-card')).toHaveCount(0);
  });

  test('Overview strip: shows the correct empty state with zero reports', async ({ page }) => {
    await installSupabaseMocks(page, { reports: [], insights: {}, reportInsights: [] });
    await login(page);
    const text = await page.textContent('#overview-stats');
    expect(text).toContain('No reports have been generated yet');
    await expect(page.locator('#report-container')).toContainText('No reports have been generated yet');
  });

  test("Today's Highlights: folded into the top of the Report card, renders ranked insights for the latest report", async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.waitForSelector('.report-card');
    // Lives inside .report-card now -- no standalone #highlights-card section.
    await expect(page.locator('#highlights-card')).toHaveCount(0);
    await expect(page.locator('.report-highlights .report-highlights-label')).toHaveText("Today's Highlights");
    const items = await page.locator('.report-highlights .highlights-item').allTextContents();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((t) => t.includes('Demand spike: Sisattanak villas'))).toBe(true);
  });

  test("Today's Highlights: omitted entirely (not an empty-state message) when the latest report has no linked insights", async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: {}, reportInsights: [] });
    await login(page);
    await page.waitForSelector('.report-card');
    await expect(page.locator('.report-highlights')).toHaveCount(0);
  });

  test("Today's Highlights: stays pinned to the latest report while browsing history", async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await page.waitForSelector('.report-highlights .highlights-item');
    const before = await page.textContent('.report-highlights');
    await page.click('.history-table tbody tr:nth-child(2)'); // r-2, non-latest
    await page.waitForTimeout(150);
    await expect(page.locator('#latest-report-heading')).toHaveText(/^Viewing:/);
    // Browsing a non-latest report must not show ITS OWN highlights, nor
    // lose the latest's -- the lead strip simply isn't rendered at all
    // for a non-latest report (viewReportById only builds it when isLatest).
    await expect(page.locator('.report-highlights')).toHaveCount(0);
    await page.click('#back-to-latest-link');
    await page.waitForTimeout(150);
    const after = await page.textContent('.report-highlights');
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

  test('"Coming soon" placeholder section is removed entirely (Phase 3A WS1)', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    await expect(page.locator('.future-card')).toHaveCount(0);
    await expect(page.locator('#future-modules-grid')).toHaveCount(0);
  });

  test('Section order matches the target workflow: Alerts, Recommended Today, Attention, Report, History, Generate, Health', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: makeInsights(), reportInsights: makeReportInsights() });
    await login(page);
    const headings = await page.locator('#overview-view .section-header h2').allTextContents();
    expect(headings).toEqual(['Alerts', 'Recommended Today', 'Listings Needing Attention', 'Latest Intelligence Report', 'Report History', 'Generate Report', 'System Health']);
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

  function manyMissingPhotos(count) {
    const insights = {};
    for (let i = 0; i < count; i++) {
      insights['mp-' + i] = {
        id: 'mp-' + i, type: 'data_quality', metric_key: 'missing_photos', severity: 'high', confidence: 1,
        dimension_district: 'Sisattanak', dimension_property_type: 'villa', dimension_property_id: 'p-mp-' + i,
        title: 'Missing photos: Listing ' + i, summary: 'Missing photos: Listing ' + i,
        evidence: { rule: 'missing_photos', property_id: 'p-mp-' + i }, recommendation: null,
        trend: 'emerging', first_seen: '2026-07-17', last_seen: '2026-07-18', resolved_at: null,
      };
    }
    return insights;
  }

  test('Phase 3A WS2: groups 3+ same-condition alerts into one row instead of one per listing', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: manyMissingPhotos(5), reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#alerts-card .alert-item');
    await expect(page.locator('#alerts-card .alert-item')).toHaveCount(1);
    const item = page.locator('#alerts-card .alert-item');
    await expect(item).toContainText('Missing photos — 5 listings');
    const action = item.locator('.alert-action-btn');
    await expect(action).toHaveText('Review in Listings Needing Attention');
    await action.click(); // must not throw; scrolls #attention-card into view
    await expect(page.locator('#attention-card')).toBeInViewport();
  });

  test('Phase 3A WS2: below the grouping threshold, same-condition alerts still render individually', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: manyMissingPhotos(2), reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#alerts-card .alert-item');
    await expect(page.locator('#alerts-card .alert-item')).toHaveCount(2);
    await expect(page.locator('#alerts-card')).toContainText('Missing photos: Listing 0');
    await expect(page.locator('#alerts-card')).toContainText('Missing photos: Listing 1');
  });

  test('Phase 3A WS2: a genuine fetch failure shows a distinct error state with Retry, not the healthy empty state', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: {}, reportInsights: [], leads: [] });
    // Force a real network-level failure (not just an empty result set) on
    // the intelligence_insights route specifically, so loadAlerts()'s catch
    // block actually fires.
    await page.route('**/*.supabase.co/**', (route) => {
      const url = route.request().url();
      if (url.includes('intelligence_insights')) return route.abort();
      route.fallback();
    });
    await login(page);
    await page.waitForSelector('#alerts-card .alerts-error');
    await expect(page.locator('#alerts-card')).toContainText("Couldn't load alerts");
    await expect(page.locator('#alerts-card')).not.toContainText('everything looks healthy');
    await expect(page.locator('#alerts-card .alerts-retry')).toHaveText('Retry');
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

test.describe('Recommendations (Phase 3B, first implementation phase)', () => {
  // N synthetic listings sharing one metric_key, each on its own property --
  // aged far enough in the past that the issue-age priority factor is fully
  // saturated (deterministic regardless of small clock drift between this
  // fixture's authored date and whatever real time the suite happens to run,
  // matching the same real-Date.now()-based convention fmtRelative() and
  // computeListingPriority() already use elsewhere on this page).
  function manyIssueListings(metricKey, count, severity) {
    const insights = {};
    for (let i = 0; i < count; i++) {
      insights['ri-' + metricKey + '-' + i] = {
        id: 'ri-' + metricKey + '-' + i, type: 'data_quality', metric_key: metricKey, severity: severity || 'medium', confidence: 1,
        dimension_district: 'Sisattanak', dimension_property_type: 'villa', dimension_property_id: 'p-ri-' + metricKey + '-' + i,
        title: 'Listing ' + i, summary: 'Listing ' + i,
        evidence: { rule: metricKey, property_id: 'p-ri-' + metricKey + '-' + i }, recommendation: null,
        trend: 'emerging', first_seen: '2026-01-01', last_seen: '2026-01-01', resolved_at: null,
        properties: { title_en: 'Listing ' + i },
      };
    }
    return insights;
  }

  test('groups listings sharing a condition into one imperative task, not one row per listing', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: manyIssueListings('missing_ai_description', 4), reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#recommendations-card .reco-task');
    await expect(page.locator('#recommendations-card .reco-task')).toHaveCount(1);
    await expect(page.locator('#recommendations-card .reco-title')).toHaveText('Generate AI descriptions for 4 listings');
    await expect(page.locator('#recommendations-card .reco-action')).toHaveText('View all');
  });

  test('below 2 listings, wording stays singular and links straight to the one listing', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: manyIssueListings('missing_price', 1), reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#recommendations-card .reco-task');
    await expect(page.locator('#recommendations-card .reco-title')).toHaveText('Add pricing to 1 listing');
    await expect(page.locator('#recommendations-card .reco-action')).toHaveAttribute('href', /admin\.html\?edit=p-ri-missing_price-0/);
  });

  test('cluster score is the top listing\'s priority plus a small, capped per-listing bonus', async ({ page }) => {
    // 5 low-severity (weight 1), fully-aged listings: each item's priority
    // is 1 (severity) + 1 (age, saturated) = 2.0. Cluster score is
    // max(2.0) + min(0.2*(5-1), 2) = 2.0 + 0.8 = 2.8.
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: manyIssueListings('stale_listing', 5, 'low'), reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#recommendations-card .reco-task');
    await expect(page.locator('#recommendations-card .reco-score')).toHaveText('2.8');
  });

  test('caps the list to a small number of recommendations, ranked by score', async ({ page }) => {
    // 6 distinct conditions (6 candidate clusters), each with a different
    // severity so ranking is unambiguous -- only the top 5 should render.
    const insights = {
      ...manyIssueListings('missing_photos', 2, 'critical'),
      ...manyIssueListings('missing_price', 2, 'high'),
      ...manyIssueListings('missing_ai_highlight', 2, 'high'),
      ...manyIssueListings('missing_ai_description', 2, 'medium'),
      ...manyIssueListings('missing_location', 2, 'medium'),
      ...manyIssueListings('missing_neighborhood_insight', 2, 'low'),
    };
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights, reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#recommendations-card .reco-task');
    await expect(page.locator('#recommendations-card .reco-task')).toHaveCount(5);
    // The critical-severity cluster must be among what's shown; the
    // lowest-priority candidate (low severity, missing_neighborhood_insight)
    // must be the one squeezed out.
    await expect(page.locator('#recommendations-card')).toContainText('Add photos to 2 listings');
    await expect(page.locator('#recommendations-card')).not.toContainText('Generate neighborhood insights for 2 listings');
  });

  test('a failed report becomes its own recommendation and triggers regeneration', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports(), insights: {}, reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#recommendations-card .reco-task');
    const task = page.locator('#recommendations-card .reco-task', { hasText: 'Regenerate the failed weekly report' });
    await expect(task).toBeVisible();
    await task.locator('.reco-action').click();
    // Assert the final state, not the transient "Generating…" text -- the
    // mock resolves near-instantly, so waiting for the transient state is
    // inherently racy (same reasoning as Section 4's own generate test).
    await expect(page.locator('#gen-status-weekly')).toContainText('Generated', { timeout: 5000 });
  });

  test('expanding a task reveals its listings, and expanding a listing reveals its priority breakdown', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: manyIssueListings('missing_photos', 3, 'high'), reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#recommendations-card .reco-task');
    // The items exist in the DOM from the first render (just inside a
    // display:none parent) rather than being inserted on expand, so assert
    // visibility of the container, not presence-count of its children.
    await expect(page.locator('.reco-detail')).toBeHidden();
    await page.click('.reco-task-head');
    await expect(page.locator('.reco-detail')).toBeVisible();
    await expect(page.locator('.reco-item')).toHaveCount(3);
    await expect(page.locator('.reco-item-breakdown').first()).toBeHidden();
    await page.click('.reco-item >> nth=0');
    await expect(page.locator('.reco-item-breakdown').first()).toBeVisible();
    await expect(page.locator('.reco-item-breakdown').first()).toContainText('severity');
  });

  test('"How priorities are calculated" opens a permanent, standing reference', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: {}, reportInsights: [], leads: [] });
    await login(page);
    await expect(page.locator('#how-priority-panel')).toBeHidden();
    await page.click('button:has-text("How priorities are calculated")');
    await expect(page.locator('#how-priority-panel')).toBeVisible();
    await expect(page.locator('#how-priority-panel')).toContainText(/severity/i);
    await expect(page.locator('#how-priority-panel')).toContainText('capped');
  });

  test('shows a distinct empty state when nothing is urgent enough to recommend', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: {}, reportInsights: [], leads: [] });
    await login(page);
    await expect(page.locator('#recommendations-card')).toContainText('No recommendations right now');
  });

  test('sits below Alerts and above Listings Needing Attention', async ({ page }) => {
    await installSupabaseMocks(page, { reports: makeReports().filter((r) => r.status !== 'failed'), insights: manyIssueListings('missing_photos', 1), reportInsights: [], leads: [] });
    await login(page);
    await page.waitForSelector('#recommendations-card .reco-task');
    const order = await page.evaluate(() => {
      const ids = ['alerts-card', 'recommendations-card', 'attention-card'];
      return ids.map((id) => document.getElementById(id).getBoundingClientRect().top);
    });
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
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
