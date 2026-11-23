import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrismaClient, databaseUrl } from '../src/index.js';

const dbDir = fileURLToPath(new URL('..', import.meta.url));

function prisma(...args: string[]) {
  return spawnSync('pnpm', ['exec', 'prisma', ...args], {
    cwd: dbDir,
    env: { ...process.env, DATABASE_URL: databaseUrl(process.env) },
    encoding: 'utf8',
  });
}

// The partition's global setup (test/global-setup.ts) has applied the migrations.
describe('migrations', () => {
  const db = createPrismaClient();
  afterAll(() => db.$disconnect());

  it('the initial migration is applied and the schema is up to date in Postgres', () => {
    const result = prisma('migrate', 'status');
    expect(result.stdout + result.stderr).toContain('Database schema is up to date');
    expect(result.status).toBe(0);
  });

  it('the migrated database matches schema.prisma (the hand-finished migration SQL has not drifted)', () => {
    const result = prisma('migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code');
    expect(result.stdout + result.stderr).toContain('No difference detected');
    expect(result.status).toBe(0);
  });

  it('creates the six domain tables, the two sign-in tables (GWP#3), the three distribution tables (GWP#6), the sign-in rate windows (GWP#32), the quota windows (GWP#50) and the member profiles (GWP#99)', async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name <> '_prisma_migrations' ORDER BY table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(['Delivery', 'Export', 'Identity', 'Item', 'ItemEvent', 'LoginAttempt', 'LoginRateWindow', 'OutputSecret', 'QuotaWindow', 'Session', 'Team', 'TeamMember', 'WorkType', 'WorkTypeVersion']);
  });

  it('keeps only the stuck-item sweeper\'s partial index, valid, once the contract migration drops the unfiltered one (GWP#157, GWP#158)', async () => {
    const rows = await db.$queryRaw<{ name: string; valid: boolean; columns: string; predicate: string | null }[]>`
      SELECT c.relname AS name, i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS columns, pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = '"Item"'::regclass AND c.relname IN ('Item_status_updatedAt_idx', 'Item_status_updatedAt_waiting_null_idx')
      ORDER BY c.relname`;
    expect(rows).toEqual([
      { name: 'Item_status_updatedAt_waiting_null_idx', valid: true, columns: expect.stringContaining('(status, "updatedAt") WHERE ("waitingRole" IS NULL)'), predicate: '("waitingRole" IS NULL)' },
    ]);
  });
});
