import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/ci-guard.sh enforces D-024: no workflow may reference the secrets context,
// request an OIDC token or run on the privileged pull-request trigger.
const root = resolve(import.meta.dirname, '..');
const guard = join(root, 'scripts', 'ci-guard.sh');

function runGuard(...args: string[]) {
  return spawnSync('bash', [guard, ...args], { cwd: root, encoding: 'utf8' });
}

const header = 'name: x\non:\n  push:\n';
const job = 'jobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';

describe('ci-guard.sh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-guard-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails on id-token and names the line', () => {
    writeFileSync(join(dir, 'oidc.yml'), `${header}permissions:\n  id-token: write\n${job}`);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${join(dir, 'oidc.yml')}:5:`);
  });

  it('fails on a secrets reference and names the line', () => {
    writeFileSync(join(dir, 'secret.yaml'), `${header}${job}        env:\n          T: \${{ secrets.X }}\n`);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${join(dir, 'secret.yaml')}:10:`);
  });

  it('fails on a secrets reference written in upper case', () => {
    writeFileSync(join(dir, 'upper.yml'), `${header}${job}        env:\n          T: \${{ SECRETS.X }}\n`);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${join(dir, 'upper.yml')}:10:`);
  });

  it('fails on pull_request_target and names the line', () => {
    writeFileSync(join(dir, 'target.yml'), `name: x\non:\n  pull_request_target:\n${job}`);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${join(dir, 'target.yml')}:3:`);
  });

  it('reports every offending file in one run', () => {
    writeFileSync(join(dir, 'a.yml'), `${header}permissions:\n  id-token: write\n${job}`);
    writeFileSync(join(dir, 'b.yml'), `name: x\non:\n  pull_request_target:\n${job}`);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${join(dir, 'a.yml')}:5:`);
    expect(r.stdout).toContain(`${join(dir, 'b.yml')}:3:`);
  });

  it('ignores files that are not yml or yaml', () => {
    writeFileSync(join(dir, 'notes.md'), 'id-token secrets.X pull_request_target\n');
    expect(runGuard(dir).status).toBe(0);
  });

  it('passes a clean copy of ci.yml', () => {
    copyFileSync(join(root, '.github', 'workflows', 'ci.yml'), join(dir, 'ci.yml'));
    const r = runGuard(dir);
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });

  it("passes the repo's own .github/workflows by default", () => {
    const r = runGuard();
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails with status 2 when the directory does not exist', () => {
    const r = runGuard(join(dir, 'missing'));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing');
  });
});
