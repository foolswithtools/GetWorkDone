import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/branch-protection.sh sends D-021's protection, amended by D-080, with `ci` required.
// A stub `gh` first on PATH records its arguments and the body it reads from stdin.
const script = resolve(import.meta.dirname, '..', 'scripts', 'branch-protection.sh');

describe('branch-protection.sh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'branch-protection-'));
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/body"\n`);
    chmodSync(gh, 0o755);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  }

  it('PUTs the protection body to main of the named repo', () => {
    const r = run('example/repo');
    expect(r.status).toBe(0);
    const args = readFileSync(join(dir, 'args'), 'utf8').split('\n');
    expect(args).toContain('PUT');
    expect(args).toContain('repos/example/repo/branches/main/protection');
    expect(JSON.parse(readFileSync(join(dir, 'body'), 'utf8'))).toEqual({
      required_status_checks: { strict: true, contexts: ['ci'] },
      enforce_admins: true,
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        require_code_owner_reviews: true,
        dismiss_stale_reviews: true,
        require_last_push_approval: true,
      },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
  });

  it.each([[[]], [['not-a-repo']], [['a/b', 'extra']]])('exits 2 without calling gh for args %j', (args) => {
    const r = run(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage');
    expect(() => readFileSync(join(dir, 'body'))).toThrow();
  });
});
