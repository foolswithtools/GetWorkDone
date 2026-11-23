import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Partition `integration`: apply the migrations to the Postgres at DATABASE_URL before any file runs.
export default function setup(): void {
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed (is Postgres up at DATABASE_URL?):\n${result.stdout}${result.stderr}`);
  }
}
