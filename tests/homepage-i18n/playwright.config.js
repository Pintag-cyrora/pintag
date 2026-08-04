// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: 'http://localhost:8961',
    trace: 'retain-on-failure',
    // lang.js's resolvePintagLang() correctly falls back to the browser's
    // detected language (navigator.languages) when there's no ?lang= param
    // or persisted preference -- real, intentional behavior, not something
    // this suite should fight. Pinning to a locale that matches none of
    // en/zh/lo's prefixes makes _pintagLangFromBrowser() return null, so
    // "no explicit language" tests deterministically exercise
    // PINTAG_DEFAULT_LANG ('lo') instead of whatever locale the runner's
    // default Chromium build happens to ship with (en-US locally, which
    // would otherwise make "default load" tests flake between lo and en).
    locale: 'fr-FR',
  },
  webServer: {
    command: 'node static-server.js',
    url: "http://localhost:8961/index.html",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {},
      },
    },
  ],
});
