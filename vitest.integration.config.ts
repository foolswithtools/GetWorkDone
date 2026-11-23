import { defineConfig, mergeConfig } from 'vitest/config';
import { shared } from './vitest.shared.ts';

// Partition `integration`: *.integration.test.ts against a real Postgres at DATABASE_URL (the CI
// service container; locally see README). The global setup applies the migrations first. Files share
// one database, so they run one at a time. The JSON report feeds scripts/coverage-status.ts (GWP#7).
// The sign-in rate limit is counted in that database (GWP#32), so every file's sign-ins from 127.0.0.1
// share one count: it is raised here, and the rate-limit tests set it back to 20.
export default mergeConfig(shared, defineConfig({
  test: {
    env: { LOGIN_RATE_LIMIT: '100000' },
    include: ['**/*.integration.test.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest-integration.json' },
    // Agent worktrees under .claude/ are other checkouts, never collected (GWP#59).
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    globalSetup: ['packages/db/test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
}));
