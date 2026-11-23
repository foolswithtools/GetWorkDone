import { defineConfig, devices } from '@playwright/test';

// Partition `e2e`: Playwright against the built app (`pnpm build` first). Each spec starts the API
// itself, with its own telemetry environment, so CI's OTEL_SDK_DISABLED=true does not reach it.
// The JSON report feeds scripts/coverage-status.ts (GWP#7). The run gets its own database, created and
// migrated beside the one at DATABASE_URL by the global setup and dropped after it (GWP#26).
// In CI a failed test runs once more (GWP#59); a serial group re-runs whole. One that passes on the retry
// is reported flaky by the list reporter and counts as passing in scripts/coverage-status.ts (spec.ok).
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/support/global-setup.ts',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ...(process.env.CI ? [['github'] as const] : []), ['json', { outputFile: 'reports/playwright-e2e.json' }]],
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
