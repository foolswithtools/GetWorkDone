import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main, parseRoadmap, syncState } from '../../scripts/state-sync.js';
import { runMain } from './support.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/state-sync.ts');

const ROADMAP = `# Roadmap

| Issue | Slice | Status |
|---|---|---|
| [#1](https://github.com/o/r/issues/1) | chore(bootstrap): scaffold | in-progress |
| [#2](https://github.com/o/r/issues/2) | feat(model): add the model | planned |
`;

const STATE = `# State

Decisions and links only.

<!-- state-sync:begin -->
stale
<!-- state-sync:end -->

After.
`;

function files(state = STATE, roadmap = ROADMAP) {
  const dir = mkdtempSync(join(tmpdir(), 'state-'));
  writeFileSync(join(dir, 'STATE.md'), state);
  writeFileSync(join(dir, 'ROADMAP.md'), roadmap);
  const run = (...args: string[]) => runMain(main, ['--state', join(dir, 'STATE.md'), '--roadmap', join(dir, 'ROADMAP.md'), ...args]);
  return { dir, run, state: () => readFileSync(join(dir, 'STATE.md'), 'utf8') };
}

describe('state-sync', () => {
  it('the repo STATE.md block matches docs/ROADMAP.md', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--check'], { cwd: root, encoding: 'utf8' });
    expect(result.stdout + result.stderr).toContain('state-sync: in sync');
    expect(result.status).toBe(0);
  });

  it('reads the roadmap rows', () => {
    expect(parseRoadmap(ROADMAP)).toEqual([
      { issue: 1, url: 'https://github.com/o/r/issues/1', title: 'chore(bootstrap): scaffold', status: 'in-progress' },
      { issue: 2, url: 'https://github.com/o/r/issues/2', title: 'feat(model): add the model', status: 'planned' },
    ]);
  });

  it('--check exits 1 when the generated block drifts from the roadmap, and names the fix', () => {
    const f = files();
    const result = f.run('--check');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pnpm exec tsx scripts/state-sync.ts');
    expect(f.state()).toBe(STATE);
  });

  it('without --check it rewrites only the block, then --check passes', () => {
    const f = files();
    expect(f.run().stdout).toContain('state-sync: rewrote');
    expect(f.run().stdout).toContain('state-sync: in sync');
    const text = f.state();
    expect(text).toContain('| [#1](https://github.com/o/r/issues/1) | in-progress |');
    expect(text).toContain('Decisions and links only.');
    expect(text).toContain('After.');
    expect(text).not.toContain('stale');
    expect(f.run('--check').status).toBe(0);
    expect(syncState(text, ROADMAP)).toBe(text);
  });

  it('fails on missing markers, an unknown status or an empty roadmap', () => {
    expect(() => syncState('# no markers\n', ROADMAP)).toThrow('markers');
    expect(() => syncState(STATE, ROADMAP.replace('| planned |', '| maybe |'))).toThrow('#2: unknown status "maybe"');
    expect(() => syncState(STATE, '# Roadmap\n')).toThrow('no slice rows');
    const missing = files('# none\n').run('--check');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('markers');
    expect(runMain(main, ['--check']).status).toBe(0);
  });
});
