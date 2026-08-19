// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: 'http://localhost:8952',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node static-server.js',
    url: 'http://localhost:8952/listings.html',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        // Mobile emulation spelled out rather than spreading devices['iPhone 13']:
        // that descriptor carries defaultBrowserType 'webkit', which collides
        // with a Chromium executable and fails to launch at all. These are the
        // iPhone 13 metrics, driven by Chromium.
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        // iPhone 13 viewport: requirement 10 is explicitly about the MOBILE
        // public page, which is where the missing price was reported.
        launchOptions: {
          // Chromium refuses to start as root without this; CI images and some
          // container sandboxes both run that way.
          args: ['--no-sandbox'],
          ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
            : {}),
        },
      },
    },
  ],
});
