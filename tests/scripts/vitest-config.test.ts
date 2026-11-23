import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';
import integration from '../../vitest.integration.config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

// The exemplar claimed an 80% floor but its vitest config had no thresholds (apps/backend/vitest.config.ts:3-5 @ 12a071e).
describe('unit coverage floor', () => {
  it('pnpm test:unit always measures coverage and fails under 80% lines or branches', () => {
    const coverage = config.test?.coverage as { enabled?: boolean; thresholds?: Record<string, number> } | undefined;
    expect(coverage?.enabled).toBe(true);
    expect(coverage?.thresholds).toMatchObject({ lines: 80, branches: 80 });
  });
});

// GWP#59: the SPA's component tests run in the unit partition under jsdom, outside the coverage floor
// until a later issue measures them; neither partition collects the checkouts under .claude/worktrees/.
describe('the unit partition and the SPA component tests', () => {
  it('collects apps/web/src/**/*.test.tsx but measures no .tsx file', () => {
    expect(config.test?.include).toContain('apps/web/src/**/*.test.tsx');
    const coverage = config.test?.coverage as { include?: string[] } | undefined;
    expect(coverage?.include?.filter((glob) => glob.includes('.tsx'))).toEqual([]);
  });

  it('runs every component test under jsdom', () => {
    // Split, or vitest would read the directive as this file's own environment.
    const directive = ['// @vitest', 'environment jsdom'].join('-');
    const files = globSync('apps/web/src/**/*.test.tsx', { cwd: root });
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(join(root, file), 'utf8').split('\n')[0], file).toBe(directive);
  });

  it('neither partition collects files under .claude/', () => {
    expect(config.test?.exclude).toContain('**/.claude/**');
    expect(integration.test?.exclude).toContain('**/.claude/**');
  });
});
