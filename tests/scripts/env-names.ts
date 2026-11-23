import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The environment variables the API and the packages read: every `env.NAME` and `process.env.NAME`, and
 * every quoted UPPER_SNAKE literal (the names behind `env[key]`, such as OIDC_* and QUOTA_*) except one
 * that only ever names a Nest injection token, `Symbol('NAME')`. Source files only, tests excluded.
 */
export function envNamesReadByCode(): Set<string> {
  const files = execFileSync('git', ['-C', root, 'ls-files', '--', 'apps/api/src', 'packages'], { encoding: 'utf8' })
    .split('\n')
    .filter((path) => path.includes('/src/') && path.endsWith('.ts') && !path.endsWith('.test.ts'));
  const names = new Set<string>();
  const literal = new Map<string, boolean>(); // name -> seen outside Symbol(...)
  for (const path of files) {
    const text = readFileSync(join(root, path), 'utf8');
    for (const m of text.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)\b/g)) names.add(m[1]!);
    for (const m of text.matchAll(/(Symbol\(\s*)?['"`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"`]/g)) {
      literal.set(m[2]!, (literal.get(m[2]!) ?? false) || m[1] === undefined);
    }
  }
  for (const [name, outsideSymbol] of literal) if (outsideSymbol) names.add(name);
  return names;
}
