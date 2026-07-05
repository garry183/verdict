import { defineConfig, devices } from '@playwright/test';

// Playwright config for the stageshop login demo. Tuned so its output feeds Verdict:
// the JSON reporter is what `verdict triage` ingests, and traces/screenshots on
// failure are what `verdict heal` reads. Keep the json reporter.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }], // ← Verdict ingests this
  ],
  use: {
    baseURL: 'https://stageshop.livguard.com/',
    trace: 'retain-on-failure',       // heal reads the trace.zip DOM snapshot
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
