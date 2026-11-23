import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Known issue 2026-10-31-live-spec-csp-and-evaluate-hang: page.waitForFunction with a string
// predicate re-evaluates the string with eval inside the page while it polls, and the API's CSP
// (script-src 'self', no 'unsafe-eval', docs/security.md) refuses it with an EvalError. It passes
// only when the condition is already true on the first check, so the e2e run hid it and the
// owner-run live spec failed on a deployed instance. The specs poll page.evaluate instead, which
// Playwright runs through DevTools, outside the page's CSP.
const root = fileURLToPath(new URL('../../', import.meta.url));
// tests/live/ is never published (publish/allowlist.txt), so on the public twin only tests/e2e exists.
const scanned = ['tests/e2e', 'tests/live'].filter((dir) => existsSync(join(root, dir)));

function specs(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? specs(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

function stringPredicates(source: string): number[] {
  const lines: number[] = [];
  const re = /\.waitForFunction\(\s*['"`]/g;
  for (const m of source.matchAll(re)) lines.push(source.slice(0, m.index).split('\n').length);
  return lines;
}

describe('Playwright specs under the API CSP', () => {
  it('finds a string predicate, and not a function one', () => {
    expect(stringPredicates(`await page.waitForFunction("customElements.get('x') !== undefined");`)).toEqual([1]);
    expect(stringPredicates("a\nawait page.waitForFunction(\n  'x'\n)")).toEqual([2]);
    expect(stringPredicates('await page.waitForFunction(() => true);')).toEqual([]);
  });

  it('no spec passes page.waitForFunction a string, which the CSP refuses once it polls', () => {
    expect(scanned).toContain('tests/e2e');
    const found = scanned.flatMap(specs).flatMap((file) =>
      stringPredicates(readFileSync(join(root, file), 'utf8')).map((line) => `${file}:${line}`),
    );
    expect(found).toEqual([]);
  });
});
