// The migrate task's command (#8, #57; deploy/sandbox/migrate.sh): `prisma migrate deploy`, then
// app-role.sql through `prisma db execute --stdin`, both as DATABASE_CREDENTIALS (RDS's master secret in
// the sandbox) over prisma.config.ts's URL. The role's password is DATABASE_APP_CREDENTIALS, the
// getworkdone/<instance>/db-app secret; it goes to the CLI on stdin, never on its command line or in a file.
//   node node_modules/@getworkdone/db/dist/migrate-task.js
import { spawnSync, type StdioOptions } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { APP_ROLE_NAME, APP_ROLE_SQL, appRoleCredentials, renderAppRoleSql } from './app-role.js';

/** Runs the Prisma CLI with these arguments (and the script on stdin when given); its exit status. */
export type RunPrisma = (args: string[], input?: string) => { status: number | null };

/** The package's own Prisma CLI, with the package's prisma.config.ts, output to this process's. */
export function prismaRunner({ stdio = 'inherit' }: { stdio?: 'inherit' | 'pipe' } = {}): RunPrisma {
  const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const config = fileURLToPath(new URL('../prisma.config.ts', import.meta.url));
  return (args, input) => {
    const io: StdioOptions = [input === undefined ? 'ignore' : 'pipe', stdio, stdio];
    const result = spawnSync(process.execPath, [cli, ...args, '--config', config], { input, stdio: io });
    return { status: result.status };
  };
}

/** The migrations, then the app role when DATABASE_APP_CREDENTIALS is set; 0 when every step succeeded. */
export function migrateTask(env: NodeJS.ProcessEnv, prisma: RunPrisma, log: (line: string) => void): number {
  if (prisma(['migrate', 'deploy']).status !== 0) return 1;
  if (!env.DATABASE_APP_CREDENTIALS) {
    // migrate.sh leaves it out only while the service still binds the master secret (the first deploy of #57).
    log(`app role ${APP_ROLE_NAME}: skipped, DATABASE_APP_CREDENTIALS is not set`);
    return 0;
  }
  const { password } = appRoleCredentials(env);
  const sql = renderAppRoleSql(readFileSync(APP_ROLE_SQL, 'utf8'), password);
  if (prisma(['db', 'execute', '--stdin'], sql).status !== 0) {
    log(`app role ${APP_ROLE_NAME}: prisma db execute failed`);
    return 1;
  }
  log(`app role ${APP_ROLE_NAME}: created or updated, with table DML in schema public`);
  return 0;
}

/**
 * Whether the script node was started with (argv[1]) is this module. Compared as real paths: in the
 * image @getworkdone/db is a symlink into node_modules/.pnpm, so import.meta.url never equals the path
 * as typed, and a plain comparison would exit 0 having run nothing.
 */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  process.exitCode = migrateTask(process.env, prismaRunner(), (line) => console.log(line));
}
