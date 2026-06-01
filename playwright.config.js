import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir:        './tests',
  testMatch:      '**/*.spec.js',
  timeout:        25000,
  fullyParallel:  false,
  reporter:       'list',

  use: {
    baseURL:  'http://localhost:4321',
    headless: true,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command:             'node scripts/server.js',
    url:                 'http://localhost:4321',
    reuseExistingServer: true,
    timeout:             8000,
  },
});
