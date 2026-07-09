import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config (docs/10 §14). The e2e stack (API :3010 + web :3011 against gemplots_e2e)
 * is provisioned and torn down by e2e/run-e2e.sh, which sets E2E_BASE_URL. When Playwright is run
 * directly (CI), a `webServer`-free config is used and the harness boots the servers.
 *
 * Ports are deliberately 3010/3011 so a running dev stack on 3000/3001 is never touched.
 */
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3011';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/playwright-report' }]],
  outputDir: 'e2e/test-results',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Customer face is mobile-first; run the whole smoke on a phone viewport.
    ...devices['Pixel 5'],
  },
});
