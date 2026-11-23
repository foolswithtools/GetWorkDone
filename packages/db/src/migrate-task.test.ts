import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_ROLE_NAME, APP_ROLE_SQL, appRoleCredentials, renderAppRoleSql, scramSha256Verifier } from './app-role.js';
import { isEntry, migrateTask, prismaRunner, type RunPrisma } from './migrate-task.js';

// #57: the migrate task applies the migrations, then creates or updates the API's role with the password
// from getworkdone/<instance>/db-app (DATABASE_APP_CREDENTIALS). The role SQL itself runs against
// Postgres in test/app-role.integration.test.ts.
const password = `it's a \\ "test" $$ password`;
const appSecret = JSON.stringify({ username: 'getworkdone_app', password });

describe('scramSha256Verifier', () => {
  const salt = Buffer.alloc(16, 7);

  it('is Postgres\'s SCRAM-SHA-256 verifier format, salted and iterated', () => {
    expect(scramSha256Verifier('pw', salt)).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(scramSha256Verifier('pw', salt)).toBe(scramSha256Verifier('pw', salt));
    expect(scramSha256Verifier('pw')).not.toBe(scramSha256Verifier('pw'));
    expect(scramSha256Verifier('pw', salt)).not.toContain('pw');
  });
});

describe('renderAppRoleSql', () => {
  const sql = readFileSync(APP_ROLE_SQL, 'utf8');

  // #57 review: the plaintext would show in pg_stat_activity, a statement log or an error's CONTEXT.
  it('replaces the one psql variable with the password\'s SCRAM verifier, never the password', () => {
    const rendered = renderAppRoleSql(sql, password);
    expect(rendered).not.toContain(":'password'");
    expect(rendered).not.toContain('test');
    const literal = /set_config\('getworkdone\.app_role_password', '([^']+)', false\)/.exec(rendered)?.[1];
    expect(literal).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(rendered.replace(`'${literal}'`, ":'password'")).toBe(sql);
  });

  it('refuses a script without exactly one psql password variable', () => {
    expect(() => renderAppRoleSql('SELECT 1;', password)).toThrow(/exactly one/);
    expect(() => renderAppRoleSql(":'password' :'password'", password)).toThrow(/exactly one/);
  });

  it('refuses an empty password or one outside printable ASCII (SASLprep would change it), never quoting it', () => {
    expect(() => renderAppRoleSql(sql, '')).toThrow(/password/);
    expect(() => renderAppRoleSql(sql, 'caf\u00e9')).toThrow(/printable ASCII/);
    const error = (() => {
      try {
        renderAppRoleSql(sql, 'secret\0value');
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a throw');
    })();
    expect(error.message).not.toContain('secret');
  });
});

describe('appRoleCredentials', () => {
  it('reads the db-app secret from DATABASE_APP_CREDENTIALS', () => {
    expect(appRoleCredentials({ DATABASE_APP_CREDENTIALS: appSecret })).toEqual({ username: APP_ROLE_NAME, password });
  });

  it('names DATABASE_APP_CREDENTIALS for malformed JSON, never echoing it', () => {
    expect(() => appRoleCredentials({ DATABASE_APP_CREDENTIALS: `{"password":"${password}"` })).toThrow(/^DATABASE_APP_CREDENTIALS is not valid JSON/);
    expect(() => appRoleCredentials({ DATABASE_APP_CREDENTIALS: '{}' })).toThrow(/^DATABASE_APP_CREDENTIALS must be/);
  });

  it(`refuses a user name other than ${APP_ROLE_NAME}, which the SQL creates`, () => {
    expect(() => appRoleCredentials({ DATABASE_APP_CREDENTIALS: JSON.stringify({ username: 'getworkdone_admin', password }) })).toThrow(
      /DATABASE_APP_CREDENTIALS's username must be getworkdone_app/,
    );
  });
});

function fake(statuses: number[] = []): { run: RunPrisma; calls: { args: string[]; input?: string }[] } {
  const calls: { args: string[]; input?: string }[] = [];
  return {
    calls,
    run: (args, input) => {
      calls.push(input === undefined ? { args } : { args, input });
      return { status: statuses[calls.length - 1] ?? 0 };
    },
  };
}

describe('migrateTask', () => {
  it('runs prisma migrate deploy, then the role SQL through prisma db execute --stdin', () => {
    const prisma = fake();
    const lines: string[] = [];
    expect(migrateTask({ DATABASE_APP_CREDENTIALS: appSecret }, prisma.run, (l) => lines.push(l))).toBe(0);
    expect(prisma.calls.map((c) => c.args)).toEqual([
      ['migrate', 'deploy'],
      ['db', 'execute', '--stdin'],
    ]);
    expect(prisma.calls[1]!.input).toMatch(/set_config\('getworkdone\.app_role_password', 'SCRAM-SHA-256\$4096:/);
    expect(prisma.calls[1]!.input).not.toContain(password);
    expect(lines.join('\n')).toContain('getworkdone_app');
    expect(lines.join('\n')).not.toContain(password);
  });

  it('stops with 1 when the migrations fail, before the role step', () => {
    const prisma = fake([1]);
    expect(migrateTask({ DATABASE_APP_CREDENTIALS: appSecret }, prisma.run, () => undefined)).toBe(1);
    expect(prisma.calls).toHaveLength(1);
  });

  it('exits 1 when the role SQL fails', () => {
    const prisma = fake([0, 1]);
    const lines: string[] = [];
    expect(migrateTask({ DATABASE_APP_CREDENTIALS: appSecret }, prisma.run, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toMatch(/app role.*failed/);
  });

  it('skips the role step, saying so, when DATABASE_APP_CREDENTIALS is not set', () => {
    const prisma = fake();
    const lines: string[] = [];
    expect(migrateTask({}, prisma.run, (l) => lines.push(l))).toBe(0);
    expect(prisma.calls.map((c) => c.args)).toEqual([['migrate', 'deploy']]);
    expect(lines.join('\n')).toContain('DATABASE_APP_CREDENTIALS is not set');
  });
});

describe('prismaRunner', () => {
  it('runs the package\'s Prisma CLI with its config', () => {
    expect(prismaRunner({ stdio: 'pipe' })(['--version']).status).toBe(0);
  });
});

// The image runs node node_modules/@getworkdone/db/dist/migrate-task.js, where @getworkdone/db is a
// symlink into node_modules/.pnpm: import.meta.url is the real path, process.argv[1] the link's. A plain
// comparison never matched there, so the task exited 0 having run nothing (found running the image, #57).
describe('isEntry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gwp57-entry-'));
  const real = join(dir, 'migrate-task.js');
  writeFileSync(real, '');
  symlinkSync(dir, join(dir, 'linked'));
  const url = pathToFileURL(real).href;

  it('is true for the module itself and through a symlinked directory', () => {
    expect(isEntry(real, url)).toBe(true);
    expect(isEntry(join(dir, 'linked', 'migrate-task.js'), url)).toBe(true);
  });

  it('is false for another script, a missing path or none', () => {
    expect(isEntry(join(dir, 'other.js'), url)).toBe(false);
    expect(isEntry(undefined, url)).toBe(false);
  });
});
