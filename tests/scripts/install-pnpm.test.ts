import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// scripts/install-pnpm.sh (#51): downloads the pnpm tarball, checks it against the sha512 committed in
// the script and only then installs it, so a substituted tarball fails before npm sees it. The test
// stubs curl (which copies a fixture tarball to its -o path) and npm (which records its arguments) on
// PATH in a temp dir.
const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/install-pnpm.sh');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'install-pnpm-'));
  mkdirSync(join(dir, 'bin'));
  const tarball = join(dir, 'fixture.tgz');
  writeFileSync(tarball, 'not really pnpm\n');
  writeFileSync(
    join(dir, 'bin/curl'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$STUB_DIR/curl.log"
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac
done
cp "$STUB_DIR/fixture.tgz" "$out"
`,
  );
  writeFileSync(join(dir, 'bin/npm'), '#!/usr/bin/env bash\necho "$*" >> "$STUB_DIR/npm.log"\n');
  chmodSync(join(dir, 'bin/curl'), 0o755);
  chmodSync(join(dir, 'bin/npm'), 0o755);
  writeFileSync(join(dir, 'curl.log'), '');
  writeFileSync(join(dir, 'npm.log'), '');
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  const run = (args: string[]) =>
    spawnSync('bash', [script, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, HOME: dir, STUB_DIR: dir },
    });
  const log = (name: string) => readFileSync(join(dir, `${name}.log`), 'utf8').split('\n').filter(Boolean);
  return { integrity, run, log };
}

describe('scripts/install-pnpm.sh', () => {
  it('installs the tarball once when its sha512 matches', () => {
    const s = setup();
    const r = s.run(['9.9.9', s.integrity]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(s.log('curl')).toHaveLength(1);
    expect(s.log('curl')[0]).toContain('https://registry.npmjs.org/pnpm/-/pnpm-9.9.9.tgz');
    const npm = s.log('npm');
    expect(npm).toHaveLength(1);
    expect(npm[0]).toMatch(/^install --global \/\S+\/pnpm-9\.9\.9\.tgz$/);
  });

  it('exits 1 before npm install when the sha512 is wrong', () => {
    const s = setup();
    const wrong = `sha512-${createHash('sha512').update('something else').digest('base64')}`;
    const r = s.run(['9.9.9', wrong]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('::error::');
    expect(s.log('curl')).toHaveLength(1);
    expect(s.log('npm')).toEqual([]);
  });

  it('refuses a hash that is not an sha512 integrity string', () => {
    const s = setup();
    const r = s.run(['9.9.9', 'deadbeef']);
    expect(r.status).toBe(1);
    expect(s.log('curl')).toEqual([]);
    expect(s.log('npm')).toEqual([]);
  });

  it('defaults to the committed version and hash', () => {
    const s = setup();
    const r = s.run([]);
    // The fixture is not the real tarball, so the committed hash refuses it.
    expect(r.status).toBe(1);
    const version = /^default_version=(\S+)$/m.exec(readFileSync(script, 'utf8'))?.[1];
    expect(s.log('curl')[0]).toContain(`https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`);
    expect(s.log('npm')).toEqual([]);
  });
});
