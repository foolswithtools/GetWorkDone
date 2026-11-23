import { defineConfig, mergeConfig } from 'vitest/config';
import { shared } from './vitest.shared.ts';

// Partition `unit`: every *.test.ts except *.integration.test.ts; no network beyond loopback, no
// database. Coverage is enforced here (lines and branches 80): `pnpm test:unit` fails below it,
// which the exemplar-shop only claimed (apps/backend/vitest.config.ts:3-5 @ 12a071e).
// The JSON report feeds scripts/coverage-status.ts, which derives the coverage manifest's status (GWP#7).
// The SPA's component tests, apps/web/src/**/*.test.tsx, run here too, each under jsdom by its first
// line `// @vitest-environment jsdom`; coverage still measures .ts only, so no component counts towards
// the floor until a later issue measures them (GWP#59). Agent worktrees under .claude/ are other
// checkouts, never collected.
export default mergeConfig(shared, defineConfig({
  test: {
    include: ['**/*.test.ts', 'apps/web/src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/*.integration.test.ts', 'tests/e2e/**'],
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest-unit.json' },
    // Tells timing tests whether coverage is on, so the few it slows scale their budgets (GWP#46).
    globalSetup: ['packages/contracts/test/time-budget.setup.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      reporter: ['text-summary', 'json-summary'],
      include: ['apps/api/src/**/*.ts', 'apps/web/src/**/*.ts', 'packages/*/src/**/*.ts', 'scripts/**/*.ts', 'observability/**/*.ts'],
      // Process entrypoints only wire modules together; the smoke and e2e suites boot them.
      exclude: ['**/*.test.ts', '**/test-support/**', 'observability/test/**', 'apps/api/src/main.ts', 'packages/db/src/generated/**'],
      thresholds: { lines: 80, branches: 80 },
    },
  },
}));
