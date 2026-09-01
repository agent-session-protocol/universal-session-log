import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm exec next dev -H 127.0.0.1 -p 4173',
    url: 'http://127.0.0.1:4173/universal-session-log/console',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  outputDir: '../output/playwright',
});
