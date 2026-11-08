import { defineConfig, devices } from '@playwright/test';

/**
 * Browser journeys for the console. Runs the production build (`next start`), so build first:
 * `bun run build` then `bun run test:e2e`. API calls are answered by e2e/fake-api.ts.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  // Each journey runs several full-page axe scans; bound parallelism so timings stay stable.
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  // channel 'chromium': full Chromium in new headless mode (closer to real Chrome than the
  // headless shell, and one download fewer).
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
    // Phone-sized viewport on the same engine: layouts must work at 412px wide.
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chromium' } },
  ],
  webServer: {
    command: 'bun run start',
    url: 'http://localhost:3000/sign-in',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
