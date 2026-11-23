// Databases for the e2e partition (GWP#26, docs/outputs.md "Test isolation"). The e2e API runs in
// production mode, so its delivery worker claims every due pending Delivery row in the database it is
// given; on the integration partition's database that means another suite's rows. A scratch database
// is created and migrated beside the one at DATABASE_URL, and dropped after the run.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrismaClient, databaseUrl, type PrismaClient } from '@getworkdone/db';

export interface ScratchDatabase {
  url: string;
  drop(): Promise<void>;
}

/** Set by tests/e2e/support/global-setup.ts: the database at DATABASE_URL before the e2e run swapped it. */
export const SHARED_DATABASE_ENV = 'E2E_SHARED_DATABASE_URL';

/** The database other suites use: the one at DATABASE_URL, unless the e2e global setup moved it aside. */
export function sharedDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env[SHARED_DATABASE_ENV] || databaseUrl(env);
}

/** `base` with its database name swapped for `name`. */
export function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function onServer<T>(base: string, run: (client: PrismaClient) => Promise<T>): Promise<T> {
  const client = createPrismaClient(base);
  try {
    return await run(client);
  } finally {
    await client.$disconnect();
  }
}

/** Applies the migrations to the database at `url`, as packages/db/test/global-setup.ts does. */
export function migrate(url: string): void {
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: fileURLToPath(new URL('../../../../packages/db', import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`prisma migrate deploy failed on ${new URL(url).pathname.slice(1)}:\n${result.stdout}${result.stderr}`);
}

/**
 * Creates `<base name>_<label>_<random>` on the server at `base` and applies the migrations to it, unless
 * `migrated` is false (an instance's first deploy, before its migration: GWP#101).
 */
export async function createScratchDatabase(label: string, base: string = databaseUrl(process.env), { migrated = true }: { migrated?: boolean } = {}): Promise<ScratchDatabase> {
  const name = `${new URL(base).pathname.slice(1)}_${label}_${randomUUID().slice(0, 8)}`;
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`not a usable database name: ${name}`);
  await onServer(base, (client) => client.$executeRawUnsafe(`CREATE DATABASE "${name}"`));
  const url = withDatabase(base, name);
  const drop = () => onServer(base, (client) => client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => undefined);
  try {
    if (migrated) migrate(url);
  } catch (error) {
    await drop();
    throw error;
  }
  return { url, drop };
}

/**
 * A completed item whose one webhook output has a due pending Delivery row aimed at `webhookUrl`,
 * written straight to the database at `url`; resolves with the row's id. With `webhookSecret` the
 * output's OutputSecret is written in the same transaction, before the row, so a running worker
 * cannot claim the row while the secret is missing (GWP#145).
 */
export async function seedPendingDelivery(url: string, webhookUrl: string, { webhookSecret }: { webhookSecret?: string } = {}): Promise<string> {
  return onServer(url, (client) => client.$transaction(async (tx) => {
    const team = await tx.team.create({ data: { name: `Seed ${randomUUID().slice(0, 8)}` } });
    const workType = await tx.workType.create({ data: { teamId: team.id, slug: 'seed' } });
    const output = { id: 'hook', kind: 'webhook', config: { url: webhookUrl } };
    const fields = [{ key: 'title', label: 'Title', type: 'text', required: true }];
    const version = await tx.workTypeVersion.create({ data: { teamId: team.id, workTypeId: workType.id, version: 1, definition: { fields, steps: [], outputs: [output] } } });
    const item = await tx.item.create({ data: { teamId: team.id, workTypeVersionId: version.id, data: { title: 'Seeded' }, status: 'completed' } });
    if (webhookSecret !== undefined) await tx.outputSecret.create({ data: { teamId: team.id, workTypeId: workType.id, outputId: output.id, secret: webhookSecret } });
    const delivery = await tx.delivery.create({ data: { teamId: team.id, itemId: item.id, outputId: output.id, kind: 'webhook', idempotencyKey: `${item.id}:${output.id}` } });
    return delivery.id;
  }));
}

/** A Delivery row's status and attempts, read from the database at `url`. */
export function readDelivery(url: string, id: string): Promise<{ status: string; attempts: number; itemId: string }> {
  return onServer(url, (client) => client.delivery.findUniqueOrThrow({ where: { id }, select: { status: true, attempts: true, itemId: true } }));
}

/**
 * Ends a seeded row `failed`, so it is never left pending in a database another suite uses. The seed
 * itself stays: work type versions and item events cannot be deleted (docs/domain.md).
 */
export async function endDelivery(url: string, id: string): Promise<void> {
  await onServer(url, (client) => client.delivery.updateMany({ where: { id, status: 'pending' }, data: { status: 'failed', lastError: 'test_ended' } }));
}
